import { httpError } from './core/http.js';
// The arcade: holds the chores, the last scan of each, the journal and the
// background queue, and turns a game move into a queued real-world change.
import { EventEmitter } from 'node:events';
import { Journal } from './core/journal.js';
import { JobQueue } from './core/queue.js';

/** Close a chore that is leaving the arcade; a failure to close changes nothing for the player. */
function release(chore) {
  Promise.resolve()
    .then(() => chore.close?.())
    .catch(() => {});
}

export class Arcade extends EventEmitter {
  constructor({ chores, journalFile, mode, advisor = null }) {
    super();
    this.setMaxListeners(50);
    this.chores = new Map(chores.map((c) => [c.id, c]));
    this.journal = new Journal(journalFile);
    this.queue = new JobQueue();
    this.mode = mode; // 'demo' | 'live' | 'dry-run'
    this.advisor = advisor;
    this.scans = new Map(); // chore id -> Map(group id -> group)
    this.backlog = new Map(); // chore id -> { baseline, remaining }
    this.inFlight = new Map(); // chore id -> Set of group ids whose move is queued
    this.undoing = new Set(); // journal entry ids with an undo queued
    this.impact = Object.fromEntries(chores.map((c) => [c.id, {}]));
    this.queue.on('job', (job) => this.emit('event', { type: 'job', job }));
  }

  /** Add a chore after start-up, e.g. once a Google account is connected. */
  addChore(chore) {
    const old = this.chores.get(chore.id);
    if (old && old !== chore) release(old);
    // A chore replaced under the same id (Gmail after signing in again) must not play the old one's scan.
    this.scans.delete(chore.id);
    this.backlog.delete(chore.id);
    this.chores.set(chore.id, chore);
    this.impact[chore.id] ??= {};
    this.emit('event', { type: 'state', state: this.summary() });
  }

  removeChore(id) {
    const chore = this.chores.get(id);
    if (!chore) return;
    this.chores.delete(id);
    release(chore);
    this.scans.delete(id);
    this.backlog.delete(id);
    this.emit('event', { type: 'state', state: this.summary() });
  }

  /** Let queued moves finish, then close every chore's connections. */
  async close() {
    await this.queue.drain();
    await Promise.allSettled([...this.chores.values()].map((c) => c.close?.()));
  }

  chore(id) {
    const chore = this.chores.get(id);
    if (!chore) throw httpError(404, `no chore called ${id}`);
    return chore;
  }

  summary() {
    return {
      mode: this.mode,
      ai: Boolean(this.advisor),
      chores: [...this.chores.values()].map((c) => ({
        id: c.id,
        title: c.title,
        chore: c.chore,
        target: c.target,
        game: c.game,
        unit: c.unit,
        remote: Boolean(c.remote),
        actions: c.actions,
        impact: this.impact[c.id],
        backlog: this.backlog.get(c.id) ?? null,
      })),
      pending: this.queue.pending(),
    };
  }

  /** Scan once the moves already queued for this chore have landed, so it sees their results. */
  async scan(id) {
    const chore = this.chore(id);
    return this.queue.after(id, () => this.rescan(id, chore));
  }

  async rescan(id, chore) {
    const result = await chore.scan();
    // A group whose move is queued behind this scan is already spoken for.
    const queued = this.inFlight.get(id);
    if (queued?.size) result.groups = result.groups.filter((g) => !queued.has(g.id));
    if (this.advisor) result.stats.aiAdvised = await this.advisor.advise(chore, result.groups);
    if (this.chores.get(id) !== chore) throw httpError(409, 'this chore changed during the scan; scan again');
    this.scans.set(id, new Map(result.groups.map((g) => [g.id, g])));
    // The first scan is the baseline progress is measured against.
    const remaining = result.stats.remaining ?? 0;
    const baseline = Math.max(this.backlog.get(id)?.baseline ?? 0, remaining);
    this.backlog.set(id, { baseline, remaining });
    result.stats.baseline = baseline;
    // Ids can be long lists (thousands of message ids); the page does not need them.
    const groups = result.groups.map(({ ids, rows, files, ...g }) => ({ ...g, size: (ids ?? rows ?? files ?? []).length }));
    return { ...result, groups };
  }

  /** Queue one move. Returns at once; the change happens in the background. */
  act(id, groupId, action) {
    const chore = this.chore(id);
    const scan = this.scans.get(id);
    const group = scan?.get(groupId);
    if (!group) throw httpError(409, `unknown or already handled group ${groupId}; scan again`);
    if (!chore.actions.some((a) => a.id === action)) throw httpError(400, `unknown action ${action}`);
    scan.delete(groupId); // a group is played once
    if (!this.inFlight.has(id)) this.inFlight.set(id, new Set());
    const queued = this.inFlight.get(id);
    queued.add(groupId);
    return this.queue.enqueue(id, `${action} ${group.label}`, async () => {
      try {
        let result;
        try {
          result = await chore.apply(group, action);
        } catch (err) {
          // Part of the move happened before it failed: journal that part so it can be undone.
          if (err.partial?.affected) await this.commit(id, chore, action, err.partial);
          // Nothing changed, so the group can be played again until a newer scan replaces it.
          else if (this.scans.get(id) === scan) scan.set(groupId, group);
          throw err;
        }
        const entry = await this.commit(id, chore, action, result);
        return { summary: result.summary, entry: entry.id };
      } finally {
        queued.delete(groupId);
      }
    });
  }

  async commit(id, chore, action, result) {
    const entry = await this.journal.record({
      chore: id,
      target: chore.target,
      action,
      label: result.summary,
      affected: result.affected,
      impact: result.impact,
      undo: result.undo,
      dryRun: this.mode === 'dry-run',
    });
    this.addImpact(id, result.impact);
    this.emit('event', { type: 'change', chore: id, entry: { ...entry, undo: undefined, undoable: Boolean(entry.undo) }, impact: this.impact[id] });
    return entry;
  }

  async undo(entryId) {
    await this.journal.load();
    const entry = this.journal.get(entryId);
    if (!entry) throw httpError(404, 'no such change');
    if (entry.undone) throw httpError(409, 'already undone');
    if (this.undoing.has(entry.id)) throw httpError(409, 'this undo is already on its way');
    if (!entry.undo) throw httpError(409, 'this change has nothing to undo');
    const chore = this.chore(entry.chore);
    // The journal outlives a run: an entry only undoes against the folder, file or mailbox it was made in.
    if (entry.target && chore.target && entry.target !== chore.target) {
      throw httpError(409, `this change was made in ${entry.target}, but ChoreCade is now working on ${chore.target}; nothing was undone`);
    }
    this.undoing.add(entry.id);
    return this.queue.enqueue(entry.chore, `undo ${entry.label}`, async () => {
      try {
        const result = await chore.undo(entry.undo);
        await this.journal.markUndone(entry.id);
        this.addImpact(entry.chore, Object.fromEntries(Object.entries(entry.impact ?? {}).map(([k, v]) => [k, -v])));
        this.emit('event', { type: 'undo', chore: entry.chore, entryId: entry.id, summary: result.summary, impact: this.impact[entry.chore] });
        return result;
      } finally {
        this.undoing.delete(entry.id);
      }
    });
  }

  addImpact(id, impact = {}) {
    const bucket = this.impact[id];
    for (const [k, v] of Object.entries(impact)) bucket[k] = Math.round(((bucket[k] ?? 0) + v) * 100) / 100;
  }
}
