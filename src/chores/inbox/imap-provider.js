// A real IMAP mailbox (Gmail, Outlook, Fastmail...). Gmail needs an app
// password: https://myaccount.google.com/apppasswords. Nothing is ever
// expunged: "trash" moves to the Trash mailbox and "archive" moves to the
// archive (Gmail: All Mail), so every move can be reversed.
import { isoDate, parseHeaders, toSender } from './headers.js';

const IDLE_CLOSE_MS = 5 * 60 * 1000;
// Codes ImapFlow and the socket use when the connection itself is gone, as opposed to the server refusing a command.
const CONNECTION_ERRORS = new Set(['NoConnection', 'EConnectionClosed', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ETIMEOUT', 'EHOSTUNREACH']);
const HEADERS = ['list-unsubscribe', 'list-unsubscribe-post'];

async function loadImapFlow() {
  try {
    return (await import('imapflow')).ImapFlow;
  } catch {
    throw new Error('IMAP support needs the optional "imapflow" package: npm install imapflow');
  }
}

function dropped() {
  return Object.assign(new Error('the connection to the IMAP server dropped'), { code: 'NoConnection' });
}

/** [1, 2, 3, 7, 9, 10] -> "1:3,7,9:10", so a rescan that finds thousands of new messages still sends one short command. */
export function uidRanges(uids) {
  const sorted = [...uids].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    while (sorted[i + 1] === sorted[i] + 1) i++;
    parts.push(start === sorted[i] ? String(start) : `${start}:${sorted[i]}`);
  }
  return parts.join(',');
}

function toRecord(msg) {
  const h = parseHeaders(msg.headers?.toString('utf8') ?? '');
  const from = msg.envelope?.from?.[0];
  return {
    id: String(msg.uid),
    from: from?.address ?? '',
    // The parsed envelope, not a From line rebuilt from it: a name holding "<...>" would be re-read as the address.
    sender: from ? toSender(from.name, from.address) : undefined,
    subject: msg.envelope?.subject ?? '(no subject)',
    date: isoDate(msg.envelope?.date),
    listUnsubscribe: h['list-unsubscribe'] ?? null,
    listUnsubscribePost: h['list-unsubscribe-post'] ?? null,
  };
}

export class ImapMailProvider {
  /** `ImapFlow` swaps in another client class (tests use a fake); `idleMs` is how long an unused connection stays open. */
  constructor({ host, port = 993, user, pass, secure = true, ImapFlow = null, idleMs = IDLE_CLOSE_MS }) {
    this.options = { host, port: Number(port), secure, auth: { user, pass }, logger: false };
    this.kind = 'imap';
    this.special = null;
    this.ImapFlow = ImapFlow;
    this.idleMs = idleMs;
    this.client = null;
    this.queue = Promise.resolve();
    this.idleTimer = null;
    // INBOX messages seen by earlier scans, by UID; only valid while the INBOX keeps this UIDVALIDITY.
    this.known = { uidValidity: null, records: new Map() };
  }

  describe() {
    return `IMAP ${this.options.auth.user}@${this.options.host}`;
  }

  async connect() {
    const ImapFlow = this.ImapFlow ?? (await loadImapFlow());
    const client = new ImapFlow(this.options);
    // An 'error' event with no listener would crash the server; ImapFlow closes the connection itself, and the next call reconnects.
    client.on('error', () => {});
    client.on('close', () => {
      if (this.client === client) this.client = null;
    });
    await client.connect();
    this.client = client;
    return client;
  }

  async reconnect() {
    const old = this.client;
    this.client = null;
    old?.close();
    return this.connect();
  }

  /**
   * Run `fn` with the shared logged-in client. Calls are queued so two
   * operations never hold mailbox locks at the same time. If the connection
   * drops during `fn`, it is reconnected once and `fn` runs again only after
   * `canRepeat(freshClient)` resolves; it throws when repeating could do
   * something twice.
   */
  session(fn, canRepeat = async () => {}) {
    const run = this.queue.then(() => this.run(fn, canRepeat));
    this.queue = run.catch(() => {});
    return run;
  }

  async run(fn, canRepeat) {
    clearTimeout(this.idleTimer);
    try {
      // A connection that is already known to be gone is replaced before anything is sent, so nothing can repeat.
      const client = this.client?.usable ? this.client : await this.reconnect();
      try {
        return await fn(client);
      } catch (err) {
        if (!CONNECTION_ERRORS.has(err.code) && client.usable) throw err;
        const fresh = await this.reconnect();
        await canRepeat(fresh);
        return await fn(fresh);
      }
    } finally {
      this.idleTimer = setTimeout(() => this.close(), this.idleMs);
      this.idleTimer.unref();
    }
  }

  /** Log out and drop the connection. The next call logs in again. */
  close() {
    clearTimeout(this.idleTimer);
    const run = this.queue.then(async () => {
      const client = this.client;
      this.client = null;
      if (!client) return;
      await client.logout().catch(() => client.close());
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async specialFolders(client) {
    if (this.special) return this.special;
    const boxes = await client.list();
    const find = (use, fallbacks) =>
      boxes.find((b) => b.specialUse === use)?.path ?? boxes.find((b) => fallbacks.includes(b.path))?.path;
    this.special = {
      archive: find('\\All', []) ?? find('\\Archive', ['Archive', 'Archives']) ?? 'Archive',
      trash: find('\\Trash', ['Trash', 'Deleted Items', 'Deleted Messages']) ?? 'Trash',
    };
    return this.special;
  }

  /** Which of `uids` are in `path` right now. */
  async present(client, path, uids) {
    const lock = await client.getMailboxLock(path);
    try {
      const found = [];
      for await (const msg of client.fetch(uidRanges(uids.map(Number)), { uid: true }, { uid: true })) found.push(msg.uid);
      if (!client.usable) throw dropped();
      return found;
    } finally {
      lock.release();
    }
  }

  /**
   * Repeating a move after a drop is safe only when the server has MOVE (each
   * message moves whole or not at all) and every message is still where it
   * started: then the first attempt changed nothing. Otherwise some mail may
   * already have moved, and moving it again would lose the new UIDs that undo
   * needs or, on a server that copies and then deletes, copy it twice.
   */
  untouched(path, uids) {
    return async (client) => {
      if (client.capabilities?.has('MOVE') && (await this.present(client, path, uids)).length === uids.length) return;
      throw new Error(`the connection to the IMAP server dropped during the move and some messages may already be out of ${path}, so it was not repeated: rescan to see where things stand`);
    };
  }

  async list() {
    // Reading is always safe to repeat; the cache is only replaced once a scan completes.
    return this.session(async (client) => {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const uidValidity = client.mailbox?.uidValidity ?? null;
        const known = this.known.uidValidity === uidValidity ? this.known.records : new Map();
        const full = { uid: true, envelope: true, flags: true, headers: HEADERS };
        const flags = new Map();
        const fresh = new Map();
        if (!known.size) {
          for await (const msg of client.fetch('1:*', full)) {
            flags.set(msg.uid, msg.flags);
            fresh.set(msg.uid, toRecord(msg));
          }
          // After a drop ImapFlow ends a fetch early or yields nothing; that must not pass for an empty inbox.
          if (!client.usable) throw dropped();
        } else {
          // Flags change all the time and cost a few bytes each; envelopes and headers never change for a UID.
          for await (const msg of client.fetch('1:*', { uid: true, flags: true })) flags.set(msg.uid, msg.flags);
          const missing = [...flags.keys()].filter((uid) => !known.has(uid));
          if (missing.length) {
            for await (const msg of client.fetch(uidRanges(missing), full, { uid: true })) {
              flags.set(msg.uid, msg.flags);
              fresh.set(msg.uid, toRecord(msg));
            }
          }
          if (!client.usable) throw dropped();
        }
        const records = new Map();
        const messages = [];
        for (const [uid, f] of flags) {
          const record = known.get(uid) ?? fresh.get(uid);
          // Expunged between the two fetches.
          if (!record) continue;
          records.set(uid, record);
          messages.push({ ...record, seen: f?.has('\\Seen') ?? false });
        }
        this.known = { uidValidity, records };
        return messages;
      } finally {
        lock.release();
      }
    });
  }

  async move(ids, target) {
    return this.session(async (client) => {
      const folders = await this.specialFolders(client);
      const destination = folders[target];
      const lock = await client.getMailboxLock('INBOX');
      try {
        // UIDs from a scan taken under another UIDVALIDITY name different messages now.
        if (this.known.uidValidity !== null && client.mailbox?.uidValidity !== this.known.uidValidity) {
          throw new Error('the IMAP server renumbered the inbox since the last scan, so nothing was moved: rescan and try again');
        }
        const result = await client.messageMove(ids.join(','), destination, { uid: true });
        // ImapFlow reports a dropped connection during MOVE as a plain false.
        if (!result && !client.usable) throw dropped();
        if (!result) throw new Error(`the IMAP server did not move the messages to ${destination}`);
        // Without UIDPLUS the server does not say where the messages went, so the move cannot be undone.
        if (!result.uidMap?.size) return null;
        return { destination, newUids: [...result.uidMap.values()] };
      } finally {
        lock.release();
      }
    }, this.untouched('INBOX', ids));
  }

  async restore({ destination, newUids }) {
    if (!newUids?.length) throw new Error('server did not report new UIDs, so this move cannot be undone automatically');
    return this.session(async (client) => {
      const lock = await client.getMailboxLock(destination);
      try {
        // Gmail's All Mail holds a copy of everything; moving back re-adds the Inbox label.
        const result = await client.messageMove(newUids.join(','), 'INBOX', { uid: true });
        if (!result && !client.usable) throw dropped();
        return newUids.length;
      } finally {
        lock.release();
      }
    }, this.untouched(destination, newUids));
  }
}
