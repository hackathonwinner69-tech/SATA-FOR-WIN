// A mailbox kept on disk: one folder per mailbox, one .eml file per message.
// It is what the demo runs against, and what an exported Takeout/Thunderbird
// folder of .eml files looks like after unpacking.
import { constants, lstat, open, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isoDate, parseHeaders } from './headers.js';
import { moveAllBack, safeMove } from '../../core/fsx.js';
import { within, withinReal } from '../../core/safety.js';

const HEAD_BYTES = 16 * 1024;
const HEAD_MAX = 64 * 1024;

async function readHead(path) {
  // O_NOFOLLOW is missing on Windows; there the listing already skipped symlinks.
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    // Headers nearly always end within 16 KB; read up to 64 KB only when the blank line after them is not there yet.
    for (let size = HEAD_BYTES; ; size = HEAD_MAX) {
      const buf = Buffer.allocUnsafe(size);
      const { bytesRead } = await handle.read(buf, 0, size, 0);
      const text = buf.toString('utf8', 0, bytesRead);
      if (bytesRead < size || size === HEAD_MAX || /\r?\n\r?\n/.test(text)) return text;
    }
  } finally {
    await handle.close();
  }
}

function toMessage(id, head) {
  const h = parseHeaders(head);
  return {
    id,
    from: h.from ?? '',
    subject: h.subject ?? '(no subject)',
    date: isoDate(h.date),
    seen: /R/.test(h.status ?? ''),
    listUnsubscribe: h['list-unsubscribe'] ?? null,
    listUnsubscribePost: h['list-unsubscribe-post'] ?? null,
  };
}

export class LocalMailProvider {
  constructor(root, { inbox = 'INBOX', archive = 'Archive', trash = 'Trash' } = {}) {
    this.root = resolve(root);
    this.folders = { inbox, archive, trash };
    this.kind = 'local';
    // file name -> { size, mtimeMs, message } from the last scan, so a rescan opens only new or changed files.
    this.cache = new Map();
  }

  describe() {
    return `local mailbox at ${this.root}`;
  }

  /** A mailbox folder, refused if it is a link to somewhere outside the mail root. */
  folder(name) {
    return withinReal(this.root, this.folders[name]);
  }

  async list() {
    const dir = await this.folder('inbox');
    const names = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isFile() && d.name.endsWith('.eml')).map((d) => d.name);
    const cache = new Map();
    const read = async (name) => {
      const path = join(dir, name);
      // Stat before reading: a write that lands in between changes the mtime, so the next scan reads the file again.
      const { size, mtimeMs } = await lstat(path);
      const cached = this.cache.get(name);
      if (cached?.size === size && cached.mtimeMs === mtimeMs) return cached;
      return { size, mtimeMs, message: toMessage(name, await readHead(path)) };
    };
    // Read in modest batches: thousands of parallel opens trips EMFILE on Windows.
    for (let i = 0; i < names.length; i += 200) {
      const batch = names.slice(i, i + 200);
      const entries = await Promise.all(batch.map(read));
      batch.forEach((name, j) => cache.set(name, entries[j]));
    }
    // Messages that left the inbox are dropped here, because only the names listed this time are kept.
    this.cache = cache;
    return [...cache.values()].map((e) => ({ ...e.message }));
  }

  /** Move messages out of the inbox. Returns what undo needs to put them back. */
  async move(ids, target) {
    const toDir = await this.folder(target);
    const fromDir = await this.folder('inbox');
    const moved = [];
    for (const id of ids) {
      try {
        const from = within(fromDir, id);
        moved.push({ from, to: await safeMove(from, toDir) });
      } catch (err) {
        if (moved.length) throw Object.assign(err, { moved: { moved }, count: moved.length });
        throw err;
      }
    }
    return { moved };
  }

  async restore({ moved }) {
    const checked = await Promise.all(moved.map(async ({ from, to }) => ({ from: await withinReal(this.root, from), to: await withinReal(this.root, to) })));
    return moveAllBack(checked);
  }
}
