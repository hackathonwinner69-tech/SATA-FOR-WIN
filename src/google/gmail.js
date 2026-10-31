// Gmail as an Inbox Invaders mailbox, through the Gmail API.
// Archive removes the INBOX label; trash moves to Trash (recoverable for 30
// days). Nothing is ever permanently deleted, and both are reversed by undo.
import { HEADER_MAX, isoDate } from '../chores/inbox/headers.js';
import { answerError, batch, chunks, succeeded } from './batch.js';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const BATCH = 'https://gmail.googleapis.com/batch/gmail/v1';
const PATH = '/gmail/v1/users/me';
const HEADERS = ['From', 'Subject', 'Date', 'List-Unsubscribe', 'List-Unsubscribe-Post'];
// Google advises against Gmail batches of more than 50 calls: they tend to hit rate limits.
const BATCH_SIZE = 50;
const MODIFY_MAX = 1000;
// Quota units per call, from https://developers.google.com/workspace/gmail/api/reference/quota
const UNITS = { list: 5, get: 20, batchModify: 50 };

// TRASH is a label that can be applied by hand, so one batchModify trashes up
// to 1000 messages. Removing it undoes this and the messages.trash calls that
// earlier versions made, so older journal entries restore the same way.
const MOVE = { archive: { removeLabelIds: ['INBOX'] }, trash: { addLabelIds: ['TRASH'], removeLabelIds: ['INBOX'] } };
const PUT_BACK = { archive: { addLabelIds: ['INBOX'] }, trash: { addLabelIds: ['INBOX'], removeLabelIds: ['TRASH'] } };

/**
 * A token bucket of Gmail quota units, refilling at `rate` units a second up
 * to `capacity`. Gmail allows 6,000 units per user per minute; the defaults
 * let no 60-second window spend more than 1,000 + 60 * 80 = 5,800.
 */
export class QuotaBudget {
  constructor({ rate = 80, capacity = 1000, now, sleep }) {
    Object.assign(this, { rate, capacity, now, sleep });
    this.units = capacity;
    this.at = now();
  }

  refill() {
    const t = this.now();
    this.units = Math.min(this.capacity, this.units + ((t - this.at) / 1000) * this.rate);
    this.at = t;
  }

  /** Milliseconds until `units` could be spent. */
  delay(units) {
    this.refill();
    const short = Math.min(units, this.capacity) - this.units;
    return short > 0 ? Math.ceil((short / this.rate) * 1000) : 0;
  }

  /** Wait until `units` are available, then spend them. */
  async take(units) {
    for (let ms = this.delay(units); ms > 0; ms = this.delay(units)) await this.sleep(ms);
    this.units -= Math.min(units, this.capacity);
  }
}

function headersOf(msg) {
  const header = (name) => msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value?.slice(0, HEADER_MAX) ?? null;
  return {
    from: header('From') ?? '',
    subject: header('Subject') ?? '(no subject)',
    date: isoDate(msg.internalDate ? Number(msg.internalDate) : null),
    listUnsubscribe: header('List-Unsubscribe'),
    listUnsubscribePost: header('List-Unsubscribe-Post'),
  };
}

export class GmailProvider {
  constructor(auth, { max = 2000, timeBudget = 20_000, budget } = {}) {
    this.auth = auth;
    this.max = max;
    this.timeBudget = timeBudget;
    this.budget = budget ?? new QuotaBudget({ now: () => auth.now(), sleep: (ms) => auth.sleep(ms) });
    this.kind = 'gmail';
    this.cache = new Map(); // message id -> headers, which never change for a message
    this.gone = new Set(); // listed, but deleted before its headers could be read
    this.inbox = []; // ids from the latest inbox listing, newest first
    this.unread = new Set();
    this.fill = null; // the one header read in progress, if any
    this.closed = false;
  }

  describe() {
    return `Gmail ${this.auth.token?.email ?? ''}`.trim();
  }

  /** Inbox messages whose headers have not been read yet. */
  missing() {
    return this.inbox.filter((id) => !this.cache.has(id) && !this.gone.has(id));
  }

  /** How many inbox messages are still being read in the background. */
  get pending() {
    return this.missing().length;
  }

  /** Stop reading in the background, e.g. when this provider is replaced. */
  close() {
    this.closed = true;
  }

  /** Resolves when no header read is running. */
  async settled() {
    await this.fill?.done.catch(() => {});
  }

  /** Ids of the newest `max` messages matching `q`, newest first. */
  async ids(q) {
    const ids = [];
    let pageToken;
    do {
      await this.budget.take(UNITS.list);
      const page = await this.auth.api(`${API}/messages`, {
        query: { q, maxResults: String(Math.min(500, this.max - ids.length)), fields: 'messages/id,nextPageToken', ...(pageToken ? { pageToken } : {}) },
      });
      for (const m of page.messages ?? []) ids.push(m.id);
      pageToken = page.nextPageToken;
    } while (pageToken && ids.length < this.max);
    return ids;
  }

  /**
   * The inbox messages whose headers have been read, newest first. Headers
   * not cached yet are read for up to `timeBudget` ms; the rest keep arriving
   * in the background (see `pending`) and show up in the next list().
   */
  async list() {
    // Both listings are newest first, so every unread message among the newest
    // `max` in the inbox is also among the newest `max` unread ones.
    const [ids, unread] = await Promise.all([this.ids('in:inbox'), this.ids('in:inbox is:unread')]);
    const listed = new Set(ids);
    for (const id of this.cache.keys()) if (!listed.has(id)) this.cache.delete(id);
    for (const id of this.gone) if (!listed.has(id)) this.gone.delete(id);
    this.inbox = ids;
    this.unread = new Set(unread);
    await this.read();
    return this.inbox
      .filter((id) => this.cache.has(id))
      .map((id) => {
        const { from, subject, date, listUnsubscribe, listUnsubscribePost } = this.cache.get(id);
        return { id, from, subject, date, seen: !this.unread.has(id), listUnsubscribe, listUnsubscribePost };
      });
  }

  /**
   * Wait for the header read (starting one if none is running) until it is
   * done or its next batch could not start before the time budget runs out.
   * A failure while waiting is thrown; one after that is logged.
   */
  async read() {
    const fill = this.fill ?? (this.fill = { token: this.auth.token, done: null });
    fill.deadline = this.auth.now() + this.timeBudget;
    const released = new Promise((resolve) => (fill.release = resolve));
    fill.watched = true;
    if (!fill.done) {
      fill.done = this.readAll(fill);
      fill.done.catch((err) => {
        if (!fill.watched) this.auth.log?.(`Gmail: ${err.message}`);
      });
    }
    try {
      await Promise.race([fill.done, released]);
    } finally {
      fill.watched = false;
    }
  }

  /** Read missing headers 50 at a time, paced by the quota budget, until none are left or the sign-in changes. */
  async readAll(fill) {
    const current = () => !this.closed && this.auth.token === fill.token;
    try {
      for (let next = this.missing().slice(0, BATCH_SIZE); next.length && current(); next = this.missing().slice(0, BATCH_SIZE)) {
        if (this.auth.now() + this.budget.delay(next.length * UNITS.get) > fill.deadline) fill.release();
        try {
          await this.readBatch(next);
        } catch (err) {
          if (!current()) return;
          const stop = new Error(`Gmail scan stopped with ${this.pending} messages still to read: ${err.message}. Scan again in a minute to continue from there.`, { cause: err });
          throw Object.assign(stop, { status: err.status });
        }
      }
    } finally {
      if (this.fill === fill) this.fill = null;
    }
  }

  /** Headers only (format=metadata): bodies never leave Google. */
  async readBatch(ids) {
    const query = new URLSearchParams({ format: 'metadata', fields: 'internalDate,payload/headers' });
    for (const h of HEADERS) query.append('metadataHeaders', h);
    const calls = ids.map((id) => ({ method: 'GET', path: `${PATH}/messages/${encodeURIComponent(id)}`, query }));
    const answers = await batch(this.auth, BATCH, calls, { beforeSend: (sent) => this.budget.take(sent.length * UNITS.get) });
    let failure = null;
    answers.forEach((answer, k) => {
      if (succeeded(answer)) this.cache.set(ids[k], headersOf(answer.body));
      // 404 means it was deleted after it was listed: nothing to show, nothing wrong.
      else if (answer.status === 404) this.gone.add(ids[k]);
      else failure ??= answerError('Gmail message read', answer);
    });
    if (failure) throw failure;
  }

  async modify(ids, labels) {
    await this.budget.take(UNITS.batchModify);
    return this.auth.api(`${API}/messages/batchModify`, { method: 'POST', idempotent: true, body: { ids, ...labels } });
  }

  /**
   * Moves out of the inbox, 1000 messages per request. If it fails part-way,
   * the error carries `moved` (restore data for what did move) and `count`.
   */
  async move(ids, target) {
    const labels = target === 'trash' ? MOVE.trash : MOVE.archive;
    const done = [];
    try {
      for (const chunk of chunks(ids, MODIFY_MAX)) {
        await this.modify(chunk, labels);
        done.push(...chunk);
        // No point spending quota on headers of mail that has left the inbox.
        const moved = new Set(chunk);
        this.inbox = this.inbox.filter((id) => !moved.has(id));
      }
    } catch (err) {
      if (done.length) throw Object.assign(err, { moved: { target, ids: done }, count: done.length });
      throw err;
    }
    return { target, ids };
  }

  async restore({ target, ids }) {
    const labels = target === 'trash' ? PUT_BACK.trash : PUT_BACK.archive;
    for (const chunk of chunks(ids, MODIFY_MAX)) await this.modify(chunk, labels);
    return ids.length;
  }
}
