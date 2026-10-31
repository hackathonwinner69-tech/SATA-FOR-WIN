// Gmail as an Inbox Invaders mailbox, through the Gmail API.
// Archive removes the INBOX label; trash moves to Trash (recoverable for 30
// days). Nothing is ever permanently deleted, and both are reversed by undo.
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
      const header = (name) => msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;
      return {
        id,
        from: header('From') ?? '',
        subject: header('Subject') ?? '(no subject)',
        date: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : null,
        seen: !(msg.labelIds ?? []).includes('UNREAD'),
        listUnsubscribe: header('List-Unsubscribe'),
        listUnsubscribePost: header('List-Unsubscribe-Post'),
      };
    });
  }

  async move(ids, target) {
    if (target === 'trash') {
      await pool(ids, this.concurrency, (id) => this.auth.api(`${API}/messages/${id}/trash`, { method: 'POST' }));
    } else {
      for (let i = 0; i < ids.length; i += 1000) {
        await this.auth.api(`${API}/messages/batchModify`, { method: 'POST', body: { ids: ids.slice(i, i + 1000), removeLabelIds: ['INBOX'] } });
      }
    }
    return { target, ids };
  }

  async restore({ target, ids }) {
    if (target === 'trash') await pool(ids, this.concurrency, (id) => this.auth.api(`${API}/messages/${id}/untrash`, { method: 'POST' }));
    for (let i = 0; i < ids.length; i += 1000) {
      await this.auth.api(`${API}/messages/batchModify`, { method: 'POST', body: { ids: ids.slice(i, i + 1000), addLabelIds: ['INBOX'] } });
    }
    return ids.length;
  }
}
