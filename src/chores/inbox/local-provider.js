// A mailbox kept on disk: one folder per mailbox, one .eml file per message.
// It is what the demo runs against, and what an exported Takeout/Thunderbird
// folder of .eml files looks like after unpacking.
import { open, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseHeaders } from './headers.js';
import { moveAllBack, safeMove } from '../../core/fsx.js';
import { within } from '../../core/safety.js';

const HEAD_BYTES = 16 * 1024;

async function readHead(path) {
  const handle = await open(path, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

export class LocalMailProvider {
  constructor(root, { inbox = 'INBOX', archive = 'Archive', trash = 'Trash' } = {}) {
    this.root = resolve(root);
    this.folders = { inbox, archive, trash };
    this.kind = 'local';
  }

  describe() {
    return `local mailbox at ${this.root}`;
  }

  async list() {
    const dir = within(this.root, this.folders.inbox);
    const names = (await readdir(dir)).filter((n) => n.endsWith('.eml'));
    const messages = [];
    // Read in modest batches: thousands of parallel opens trips EMFILE on Windows.
    for (let i = 0; i < names.length; i += 200) {
      const batch = names.slice(i, i + 200);
      const heads = await Promise.all(batch.map((n) => readHead(join(dir, n))));
      batch.forEach((name, j) => {
        const h = parseHeaders(heads[j]);
        messages.push({
          id: name,
          from: h.from ?? '',
          subject: h.subject ?? '(no subject)',
          date: h.date ? new Date(h.date).toISOString() : null,
          seen: /R/.test(h.status ?? ''),
          listUnsubscribe: h['list-unsubscribe'] ?? null,
          listUnsubscribePost: h['list-unsubscribe-post'] ?? null,
        });
      });
    }
    return messages;
  }

  /** Move messages out of the inbox. Returns what undo needs to put them back. */
  async move(ids, target) {
    const toDir = within(this.root, this.folders[target]);
    const fromDir = within(this.root, this.folders.inbox);
    const moved = [];
    for (const id of ids) {
      const from = within(fromDir, id);
      const to = await safeMove(from, toDir);
      moved.push({ from, to });
    }
    return { moved };
  }

  async restore({ moved }) {
    return moveAllBack(moved.map(({ from, to }) => ({ from: within(this.root, from), to: within(this.root, to) })));
  }
}
