// The arcade: holds the chores, the last scan of each, the journal and the
// background queue, and turns a game move into a queued real-world change.
import { EventEmitter } from 'node:events';
import { Journal } from './core/journal.js';
import { JobQueue } from './core/queue.js';

export class Arcade extends EventEmitter {
  constructor({ chores, journalFile, mode }) {
    super();
    this.setMaxListeners(50);
    this.chores = new Map(chores.map((c) => [c.id, c]));
    this.journal = new Journal(journalFile);
    this.queue = new JobQueue();
    this.mode = mode; // 'demo' | 'live' | 'dry-run'
    this.scans = new Map(); // chore id -> Map(group id -> group)
    this.impact = Object.fromEntries(chores.map((c) => [c.id, {}]));
    this.queue.on('job', (job) => this.emit('event', { type: 'job', job }));
  }

  chore(id) {
    const chore = this.chores.get(id);
    if (!chore) throw Object.assign(new Error(`no chore called ${id}`), { status: 404 });
    return chore;
  }

  summary() {
    return {
      mode: this.mode,
      chores: [...this.chores.values()].map((c) => ({
        id: c.id,
        title: c.title,
        chore: c.chore,
        target: c.target,
        actions: c.actions,
        impact: this.impact[c.id],
      })),
      pending: this.queue.pending(),
    };
  }

  async scan(id) {
    const chore = this.chore(id);
    const result = await chore.scan();
    this.scans.set(id, new Map(result.groups.map((g) => [g.id, g])));
    // Ids can be long lists (thousands of message ids); the page does not need them.
    const groups = result.groups.map(({ ids, rows, files, ...g }) => ({ ...g, size: (ids ?? rows ?? files ?? []).length }));
    return { ...result, groups };
  }

  /** Queue one move. Returns at once; the change happens in the background. */
  act(id, groupId, action) {
    const chore = this.chore(id);
    const group = this.scans.get(id)?.get(groupId);
    if (!group) throw Object.assign(new Error(`unknown or already handled group ${groupId}; scan again`), { status: 409 });
    if (!chore.actions.some((a) => a.id === action)) throw Object.assign(new Error(`unknown action ${action}`), { status: 400 });
    this.scans.get(id).delete(groupId); // a group is played once
    return this.queue.enqueue(id, `${action} ${group.label}`, async () => {
      const result = await chore.apply(group, action);
      this.addImpact(id, result.impact);
      const entry = await this.journal.record({
        chore: id,
        action,
        label: result.summary,
        affected: result.affected,
        impact: result.impact,
        undo: result.undo,
        dryRun: this.mode === 'dry-run',
      });
      this.emit('event', { type: 'change', chore: id, entry: { ...entry, undo: undefined, undoable: Boolean(entry.undo) }, impact: this.impact[id] });
      return { summary: result.summary, entry: entry.id };
    });
  }

  async undo(entryId) {
    await this.journal.load();
    const entry = this.journal.get(entryId);
    if (!entry) throw Object.assign(new Error('no such change'), { status: 404 });
    if (entry.undone) throw Object.assign(new Error('already undone'), { status: 409 });
    if (!entry.undo) throw Object.assign(new Error('this change has nothing to undo'), { status: 409 });
    const chore = this.chore(entry.chore);
    return this.queue.enqueue(entry.chore, `undo ${entry.label}`, async () => {
      const result = await chore.undo(entry.undo);
      await this.journal.markUndone(entry.id);
      this.addImpact(entry.chore, Object.fromEntries(Object.entries(entry.impact ?? {}).map(([k, v]) => [k, -v])));
      this.emit('event', { type: 'undo', chore: entry.chore, entryId: entry.id, summary: result.summary, impact: this.impact[entry.chore] });
      return result;
    });
  }

  addImpact(id, impact = {}) {
    const bucket = this.impact[id];
    for (const [k, v] of Object.entries(impact)) bucket[k] = Math.round(((bucket[k] ?? 0) + v) * 100) / 100;
  }
}
