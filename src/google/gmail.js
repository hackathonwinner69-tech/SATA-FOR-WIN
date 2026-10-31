// Gmail as an Inbox Invaders mailbox, through the Gmail API.
// Archive removes the INBOX label; trash moves to Trash (recoverable for 30
// days). Nothing is ever permanently deleted, and both are reversed by undo.
import { HEADER_MAX, isoDate } from '../chores/inbox/headers.js';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const HEADERS = ['From', 'Subject', 'Date', 'List-Unsubscribe', 'List-Unsubscribe-Post'];

/** Run `fn` over `items` with at most `limit` in flight. */
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

export class GmailProvider {
  constructor(auth, { max = 2000, concurrency = 10 } = {}) {
    this.auth = auth;
    this.max = max;
    this.concurrency = concurrency;
    this.kind = 'gmail';
  }

  describe() {
    return `Gmail ${this.auth.token?.email ?? ''}`.trim();
  }

  async list() {
    const ids = [];
    let pageToken;
    do {
      const page = await this.auth.api(`${API}/messages`, {
        query: { q: 'in:inbox', maxResults: String(Math.min(500, this.max - ids.length)), ...(pageToken ? { pageToken } : {}) },
      });
      for (const m of page.messages ?? []) ids.push(m.id);
      pageToken = page.nextPageToken;
    } while (pageToken && ids.length < this.max);

    // Headers only (format=metadata): bodies never leave Google.
    const metadata = new URLSearchParams({ format: 'metadata' });
    for (const h of HEADERS) metadata.append('metadataHeaders', h);
    return pool(ids, this.concurrency, async (id) => {
      const msg = await this.auth.api(`${API}/messages/${id}?${metadata}`);
      const header = (name) => msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value?.slice(0, HEADER_MAX) ?? null;
      return {
        id,
        from: header('From') ?? '',
        subject: header('Subject') ?? '(no subject)',
        date: isoDate(msg.internalDate ? Number(msg.internalDate) : null),
        seen: !(msg.labelIds ?? []).includes('UNREAD'),
        listUnsubscribe: header('List-Unsubscribe'),
        listUnsubscribePost: header('List-Unsubscribe-Post'),
      };
    });
  }

  /**
   * Moves out of the inbox. If it fails part-way, the error carries
   * `moved` (restore data for what did move) and `count`.
   */
  async move(ids, target) {
    const done = new Set();
    let failure = null;
    if (target === 'trash') {
      await pool(ids, this.concurrency, async (id) => {
        if (failure) return;
        try {
          await this.auth.api(`${API}/messages/${id}/trash`, { method: 'POST', idempotent: true });
          done.add(id);
        } catch (err) {
          failure ??= err;
        }
      });
    } else {
      for (let i = 0; i < ids.length && !failure; i += 1000) {
        const chunk = ids.slice(i, i + 1000);
        try {
          await this.auth.api(`${API}/messages/batchModify`, { method: 'POST', idempotent: true, body: { ids: chunk, removeLabelIds: ['INBOX'] } });
          for (const id of chunk) done.add(id);
        } catch (err) {
          failure = err;
        }
      }
    }
    if (failure) {
      if (done.size) throw Object.assign(failure, { moved: { target, ids: ids.filter((id) => done.has(id)) }, count: done.size });
      throw failure;
    }
    return { target, ids };
  }

  async restore({ target, ids }) {
    if (target === 'trash') await pool(ids, this.concurrency, (id) => this.auth.api(`${API}/messages/${id}/untrash`, { method: 'POST', idempotent: true }));
    for (let i = 0; i < ids.length; i += 1000) {
      await this.auth.api(`${API}/messages/batchModify`, { method: 'POST', idempotent: true, body: { ids: ids.slice(i, i + 1000), addLabelIds: ['INBOX'] } });
    }
    return ids.length;
  }
}
