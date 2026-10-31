// A real IMAP mailbox (Gmail, Outlook, Fastmail...). Gmail needs an app
// password: https://myaccount.google.com/apppasswords. Nothing is ever
// expunged: "trash" moves to the Trash mailbox and "archive" moves to the
// archive (Gmail: All Mail), so every move can be reversed.
import { isoDate, parseHeaders, toSender } from './headers.js';

async function loadImapFlow() {
  try {
    return (await import('imapflow')).ImapFlow;
  } catch {
    throw new Error('IMAP support needs the optional "imapflow" package: npm install imapflow');
  }
}

export class ImapMailProvider {
  constructor({ host, port = 993, user, pass, secure = true }) {
    this.options = { host, port: Number(port), secure, auth: { user, pass }, logger: false };
    this.kind = 'imap';
    this.special = null;
  }

  describe() {
    return `IMAP ${this.options.auth.user}@${this.options.host}`;
  }

  async session(fn) {
    const ImapFlow = await loadImapFlow();
    const client = new ImapFlow(this.options);
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.logout().catch(() => {});
    }
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

  async list() {
    return this.session(async (client) => {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const messages = [];
        const query = {
          uid: true,
          envelope: true,
          flags: true,
          headers: ['list-unsubscribe', 'list-unsubscribe-post'],
        };
        for await (const msg of client.fetch('1:*', query)) {
          const h = parseHeaders(msg.headers?.toString('utf8') ?? '');
          const from = msg.envelope?.from?.[0];
          messages.push({
            id: String(msg.uid),
            from: from?.address ?? '',
            // The parsed envelope, not a From line rebuilt from it: a name holding "<...>" would be re-read as the address.
            sender: from ? toSender(from.name, from.address) : undefined,
            subject: msg.envelope?.subject ?? '(no subject)',
            date: isoDate(msg.envelope?.date),
            seen: msg.flags?.has('\\Seen') ?? false,
            listUnsubscribe: h['list-unsubscribe'] ?? null,
            listUnsubscribePost: h['list-unsubscribe-post'] ?? null,
          });
        }
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
        const result = await client.messageMove(ids.join(','), destination, { uid: true });
        if (!result) throw new Error(`the IMAP server did not move the messages to ${destination}`);
        // Without UIDPLUS the server does not say where the messages went, so the move cannot be undone.
        if (!result.uidMap?.size) return null;
        return { destination, newUids: [...result.uidMap.values()] };
      } finally {
        lock.release();
      }
    });
  }

  async restore({ destination, newUids }) {
    if (!newUids?.length) throw new Error('server did not report new UIDs, so this move cannot be undone automatically');
    return this.session(async (client) => {
      const lock = await client.getMailboxLock(destination);
      try {
        // Gmail's All Mail holds a copy of everything; moving back re-adds the Inbox label.
        await client.messageMove(newUids.join(','), 'INBOX', { uid: true });
        return newUids.length;
      } finally {
        lock.release();
      }
    });
  }
}
