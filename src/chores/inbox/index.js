// Inbox triage. Five thousand emails are really a couple of hundred senders,
// so the game deals in senders: one shot handles every message from one.
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseAddress, parseUnsubscribe } from './headers.js';

const NOTIFIER = /(^|[._-])(no-?reply|do-?not-?reply|notifications?|alerts?|updates?|mailer|bounce|info|news|hello|team)([._-]|@)/i;
const RECEIPT = /\b(receipt|order|invoice|payment|shipped|delivery|your purchase|statement)\b/i;

export const INBOX_ACTIONS = [
  { id: 'archive', label: 'Archive', key: 'A', color: '#38bdf8' },
  { id: 'trash', label: 'Trash', key: 'D', color: '#f43f5e' },
  { id: 'unsubscribe', label: 'Unsubscribe + archive', key: 'U', color: '#a855f7' },
  { id: 'keep', label: 'Keep in inbox', key: 'K', color: '#22c55e' },
];

export function classifySender(messages) {
  const { address } = parseAddress(messages[0].from);
  const unsub = messages.map((m) => parseUnsubscribe(m.listUnsubscribe, m.listUnsubscribePost)).find(Boolean) ?? null;
  const unseen = messages.filter((m) => !m.seen).length / messages.length;
  const receipts = messages.filter((m) => RECEIPT.test(m.subject)).length / messages.length;

  let kind = 'person';
  if (unsub) kind = 'newsletter';
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
    const { address } = parseAddress(msg.from);
    if (!bySender.has(address)) bySender.set(address, []);
    bySender.get(address).push(msg);
  }
  const groups = [];
  for (const [address, msgs] of bySender) {
    msgs.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
    const { name } = parseAddress(msgs[0].from);
    const info = classifySender(msgs);
    groups.push({
      id: `sender:${address}`,
      label: name,
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

export function createInboxChore({ provider, dataDir, id = 'inbox', title = 'Inbox Invaders', remote = false, dryRun = false, oneClickUnsubscribe = false, fetchImpl = fetch }) {
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
      return { groups, stats: { messages: messages.length, senders: groups.length, remaining: messages.length } };
    },

    async apply(group, action) {
      const count = group.ids.length;
      if (action === 'keep') {
        return { affected: count, summary: `kept ${count} from ${group.label}`, impact: { kept: count }, undo: null };
      }
      const target = action === 'trash' ? 'trash' : 'archive';
      let unsubscribed = null;
      if (action === 'unsubscribe') unsubscribed = await this.unsubscribe(group);
      if (dryRun) {
        return { affected: count, summary: `[dry run] would ${action} ${count} from ${group.label}`, impact: {}, undo: null };
      }
      const moved = await provider.move(group.ids, target);
      const impact = { [action === 'trash' ? 'trashed' : 'archived']: count };
      if (unsubscribed) impact.unsubscribed = 1;
      return {
        affected: count,
        summary: `${action === 'trash' ? 'trashed' : 'archived'} ${count} from ${group.label}${unsubscribed ? ` (${unsubscribed})` : ''}`,
        impact,
        undo: { provider: provider.kind, moved },
      };
    },

    /**
     * Fires an RFC 8058 one-click POST only when the sender supports it and the
     * operator turned it on. Everything else lands in a list to click through.
     */
    async unsubscribe(group) {
      const target = group.unsubscribe;
      await mkdir(dataDir, { recursive: true });
      const log = join(dataDir, 'unsubscribe-queue.md');
      if (target?.oneClick && oneClickUnsubscribe && !dryRun) {
        try {
          const res = await fetchImpl(target.https, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: 'List-Unsubscribe=One-Click',
            redirect: 'error',
            signal: AbortSignal.timeout(10_000),
          });
          if (res.ok) {
            await appendFile(log, `- [x] ${group.label} <${group.detail}> unsubscribed via one-click\n`);
            return 'one-click unsubscribed';
          }
        } catch {
          // Fall through to the manual list.
        }
      }
      const link = target?.https ?? target?.mailto ?? 'no unsubscribe link: filter it instead';
      await appendFile(log, `- [ ] ${group.label} <${group.detail}> ${link}\n`);
      return 'unsubscribe link queued';
    },

    async undo(undo) {
      const restored = await provider.restore(undo.moved);
      return { restored, summary: `moved ${restored} messages back to the inbox` };
    },
  };
}
