// Inbox triage. Five thousand emails are really a couple of hundred senders,
// so the game deals in senders: one shot handles every message from one.
import { lookup as dnsLookup } from 'node:dns/promises';
import { appendFile, mkdir } from 'node:fs/promises';
import { BlockList, isIP } from 'node:net';
import { join } from 'node:path';
import { mdText } from '../../core/safety.js';
import { parseAddress, parseUnsubscribe } from './headers.js';

const NOTIFIER = /(^|[._-])(no-?reply|do-?not-?reply|notifications?|alerts?|updates?|mailer|bounce|info|news|hello|team)([._-]|@)/i;
const RECEIPT = /\b(receipt|order|invoice|payment|shipped|delivery|your purchase|statement)\b/i;

export const INBOX_ACTIONS = [
  { id: 'archive', label: 'Archive', key: 'A', color: '#38bdf8' },
  { id: 'trash', label: 'Trash', key: 'D', color: '#f43f5e' },
  { id: 'unsubscribe', label: 'Unsubscribe + archive', key: 'U', color: '#a855f7' },
  { id: 'keep', label: 'Keep in inbox', key: 'K', color: '#22c55e' },
];

// Addresses a one-click unsubscribe must never reach: this machine, the LAN, the router.
const PRIVATE = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) {
  PRIVATE.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
]) {
  PRIVATE.addSubnet(net, prefix, 'ipv6');
}

function isPrivate(address) {
  const family = isIP(address);
  // BlockList also matches IPv4-mapped IPv6 (::ffff:127.0.0.1) against the IPv4 ranges.
  return family === 0 || PRIVATE.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** Why a one-click URL must not be posted to, or null when it may. */
async function refuseOneClick(href, lookup) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return 'not a valid URL';
  }
  if (url.protocol !== 'https:' || url.port !== '') return 'not https on the default port';
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (isIP(host)) return isPrivate(host) ? 'a private address' : null;
  let addresses;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    return 'the host does not resolve';
  }
  if (!addresses?.length) return 'the host does not resolve';
  return addresses.some((a) => isPrivate(a.address)) ? 'the host resolves to a private address' : null;
}

const newestFirst = (a, b) => (b.date ?? '').localeCompare(a.date ?? '');

export function classifySender(messages, address = parseAddress(messages[0].from).address) {
  const listed = messages.filter((m) => m.listUnsubscribe).length / messages.length;
  const unsub =
    [...messages]
      .sort(newestFirst)
      .map((m) => parseUnsubscribe(m.listUnsubscribe, m.listUnsubscribePost))
      .find(Boolean) ?? null;
  const unseen = messages.filter((m) => !m.seen).length / messages.length;
  const receipts = messages.filter((m) => RECEIPT.test(m.subject)).length / messages.length;

  let kind = 'person';
  // One list mail from a friend (a forwarded newsletter, a group reply) does not make them a newsletter.
  if (listed > 0.5) kind = 'newsletter';
  else if (receipts > 0.5) kind = 'receipt';
  else if (NOTIFIER.test(address)) kind = 'notification';

  let suggestion = 'keep';
  if (kind === 'newsletter') suggestion = unseen > 0.7 ? 'unsubscribe' : 'archive';
  if (kind === 'notification' || kind === 'receipt') suggestion = 'archive';

  return { kind, suggestion, unsub, unseenShare: unseen };
}

export function groupBySender(messages) {
  const bySender = new Map();
  for (const msg of messages) {
    const sender = msg.sender ?? parseAddress(msg.from);
    if (!bySender.has(sender.address)) bySender.set(sender.address, []);
    bySender.get(sender.address).push({ msg, sender });
  }
  const groups = [];
  for (const [address, entries] of bySender) {
    entries.sort((a, b) => newestFirst(a.msg, b.msg));
    const msgs = entries.map((e) => e.msg);
    const info = classifySender(msgs, address);
    groups.push({
      id: `sender:${address}`,
      label: entries[0].sender.name,
      detail: address,
      count: msgs.length,
      kind: info.kind,
      suggestion: info.suggestion,
      // People get a gold hull in the game: zapping a human takes a second press.
      risk: info.kind === 'person' ? 'high' : 'low',
      samples: msgs.slice(0, 3).map((m) => m.subject),
      unsubscribe: info.unsub,
      unseenShare: Math.round(info.unseenShare * 100) / 100,
      newest: msgs[0].date,
      ids: msgs.map((m) => m.id),
    });
  }
  return groups.sort((a, b) => b.count - a.count);
}

export function createInboxChore({
  provider,
  dataDir,
  id = 'inbox',
  title = 'Inbox Invaders',
  remote = false,
  dryRun = false,
  oneClickUnsubscribe = false,
  fetchImpl = fetch,
  lookup = dnsLookup,
}) {
  return {
    id,
    title,
    remote,
    chore: 'Triage your inbox',
    game: 'invaders',
    unit: 'emails in the inbox',
    target: provider.describe(),
    actions: INBOX_ACTIONS,

    async scan() {
      const messages = await provider.list();
      const groups = groupBySender(messages);
      // Messages listed but not read yet (Gmail reads headers in the background) still count as left to do.
      const loading = provider.pending ?? 0;
      return { groups, stats: { messages: messages.length, senders: groups.length, loading, remaining: messages.length + loading } };
    },

    async apply(group, action) {
      const count = group.ids.length;
      if (action === 'keep') {
        return { affected: count, summary: `kept ${count} from ${group.label}`, impact: { kept: count }, undo: null };
      }
      if (dryRun) {
        const unsub = action === 'unsubscribe' ? ` (would ${this.unsubscribePlan(group)})` : '';
        return { affected: count, summary: `[dry run] would ${action} ${count} from ${group.label}${unsub}`, impact: {}, undo: null };
      }
      const target = action === 'trash' ? 'trash' : 'archive';
      const verb = action === 'trash' ? 'trashed' : 'archived';
      let unsubscribed = null;
      if (action === 'unsubscribe') unsubscribed = await this.unsubscribe(group);
      let moved;
      try {
        moved = await provider.move(group.ids, target);
      } catch (err) {
        if (err.count > 0) {
          err.partial = {
            affected: err.count,
            summary: `${verb} ${err.count} of ${count} from ${group.label} before it failed: ${err.message}`,
            impact: { [verb]: err.count },
            undo: { provider: provider.kind, moved: err.moved },
          };
        }
        throw err;
      }
      const impact = { [verb]: count };
      if (unsubscribed) impact.unsubscribed = 1;
      const notes = [unsubscribed, moved === null && "this server can't undo it"].filter(Boolean);
      return {
        affected: count,
        summary: `${verb} ${count} from ${group.label}${notes.length ? ` (${notes.join('; ')})` : ''}`,
        impact,
        // Some IMAP servers do not say where moved mail went, so there is nothing to undo against.
        undo: moved === null ? null : { provider: provider.kind, moved },
      };
    },

    unsubscribePlan(group) {
      const target = group.unsubscribe;
      if (target?.oneClick && oneClickUnsubscribe) return 'send a one-click unsubscribe';
      return target?.https || target?.mailto ? 'queue the unsubscribe link' : 'queue the sender to filter';
    },

    /**
     * Fires an RFC 8058 one-click POST only when the sender supports it and the
     * operator turned it on. Everything else lands in a list to click through.
     * Sender names, addresses and links come from the email, so the list is
     * written so Markdown cannot turn them into anything but text and plain links.
     */
    async unsubscribe(group) {
      if (dryRun) return null;
      const target = group.unsubscribe;
      await mkdir(dataDir, { recursive: true });
      const log = join(dataDir, 'unsubscribe-queue.md');
      const who = `${mdText(group.label, 120)} (${mdText(group.detail, 200)})`;
      if (target?.oneClick && oneClickUnsubscribe && !(await refuseOneClick(target.https, lookup))) {
        try {
          const res = await fetchImpl(target.https, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: 'List-Unsubscribe=One-Click',
            redirect: 'error',
            signal: AbortSignal.timeout(10_000),
          });
          if (res.ok) {
            await appendFile(log, `- [x] ${who} unsubscribed via one-click\n`);
            return 'one-click unsubscribed';
          }
        } catch {
          // Fall through to the manual list.
        }
      }
      const href = target?.https ?? target?.mailto;
      const link = href ? `<${href}>` : 'no unsubscribe link: filter it instead';
      await appendFile(log, `- [ ] ${who} ${link}\n`);
      return 'unsubscribe link queued';
    },

    async undo(undo) {
      const restored = await provider.restore(undo.moved);
      return { restored, summary: `moved ${restored} messages back to the inbox` };
    },

    /** Log out of IMAP, or stop Gmail's background read. */
    close: () => provider.close?.(),
  };
}
