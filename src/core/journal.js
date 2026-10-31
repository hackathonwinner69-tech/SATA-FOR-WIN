// Append-only journal of every real-world change ChoreCade makes.
// Each entry carries the data its chore needs to reverse it, so any move made
// in a game can be undone afterwards, even after a restart. An undo is written
// as a marker line, so the file is only ever appended to.
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export class Journal {
  constructor(file) {
    this.file = file;
    this.entries = [];
    this.byId = new Map();
    this.loading = null;
    this.writes = Promise.resolve();
    this.torn = false;
  }

  load() {
    this.loading ??= this.read().catch((err) => {
      this.loading = null;
      throw err;
    });
    return this.loading;
  }

  async read() {
    let text;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    const byId = this.byId;
    for (const line of text.split('\n')) {
      let item;
      try {
        item = JSON.parse(line);
      } catch {
        continue; // blank, or cut short by a crash mid-write; the other lines are intact
      }
      if (item?.type === 'undo') {
        const entry = byId.get(item.id);
        if (entry) Object.assign(entry, { undone: true, undoneAt: item.at });
      } else if (item?.id) {
        byId.set(item.id, item);
        this.entries.push(item);
      }
    }
    // A crash mid-write leaves the last line unfinished; the next write starts a fresh one.
    this.torn = text.length > 0 && !text.endsWith('\n');
  }

  /** One write at a time, in order, so changes from different chores never interleave. */
  append(item) {
    const write = this.writes.then(async () => {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      await appendFile(this.file, `${this.torn ? '\n' : ''}${JSON.stringify(item)}\n`, { mode: 0o600 });
      this.torn = false;
    });
    this.writes = write.catch(() => {});
    return write;
  }

  async record({ chore, target, action, label, affected, impact = {}, undo, dryRun = false }) {
    await this.load();
    const entry = {
      id: randomUUID(),
      at: new Date().toISOString(),
      chore,
      target,
      action,
      label,
      affected,
      impact,
      dryRun,
      undo,
      undone: false,
    };
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    try {
      await this.append(entry);
    } catch (err) {
      this.entries.splice(this.entries.indexOf(entry), 1);
      this.byId.delete(entry.id);
      throw err;
    }
    return entry;
  }

  get(id) {
    return this.byId.get(id);
  }

  async markUndone(id) {
    await this.load();
    const entry = this.get(id);
    if (!entry) return;
    const at = new Date().toISOString();
    await this.append({ type: 'undo', id, at });
    Object.assign(entry, { undone: true, undoneAt: at });
  }

  recent(limit = 50) {
    return this.entries.slice(-limit).reverse().map(({ undo, ...rest }) => ({ ...rest, undoable: Boolean(undo) }));
  }
}
