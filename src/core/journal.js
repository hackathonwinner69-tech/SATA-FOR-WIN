// Append-only journal of every real-world change ChoreCade makes.
// Each entry carries the data its chore needs to reverse it, so any move made
// in a game can be undone afterwards, even after a restart.
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export class Journal {
  constructor(file) {
    this.file = file;
    this.entries = [];
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return;
    try {
      const text = await readFile(this.file, 'utf8');
      this.entries = text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    this.loaded = true;
  }

  async record({ chore, action, label, affected, impact = {}, undo, dryRun = false }) {
    await this.load();
    const entry = {
      id: randomUUID(),
      at: new Date().toISOString(),
      chore,
      action,
      label,
      affected,
      impact,
      dryRun,
      undo,
      undone: false,
    };
    this.entries.push(entry);
    await mkdir(dirname(this.file), { recursive: true });
    await appendFile(this.file, JSON.stringify(entry) + '\n');
    return entry;
  }

  get(id) {
    return this.entries.find((e) => e.id === id);
  }

  async markUndone(id) {
    const entry = this.get(id);
    if (!entry) return;
    entry.undone = true;
    entry.undoneAt = new Date().toISOString();
    // Rewrite rather than append so the file stays one line per change.
    await writeFile(this.file, this.entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }

  recent(limit = 50) {
    return this.entries.slice(-limit).reverse().map(({ undo, ...rest }) => ({ ...rest, undoable: Boolean(undo) }));
  }
}
