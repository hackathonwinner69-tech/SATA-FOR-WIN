// One Dropbox folder as a Folder Frenzy store. Bins are subfolders created on
// demand and Trash is one more subfolder, so nothing is ever deleted and every
// move is undone by moving back. Duplicates come from Dropbox's content_hash,
// so nothing is downloaded.
import { posix } from 'node:path';

export const TRASH_FOLDER = 'ChoreCade Trash';
const BATCH = 1000; // move_batch_v2 takes at most this many entries
const POLL_LIMIT = 120_000;

/** '' is the Dropbox root; anything else is an absolute path without a trailing slash. */
export function normaliseFolder(folder = '') {
  const trimmed = String(folder).trim().replace(/\/+$/, '');
  return !trimmed ? '' : trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/** {".tag": "relocation_error", "relocation_error": {".tag": "from_lookup", ...}} -> "relocation_error/from_lookup/..." */
function tagPath(value) {
  const tags = [];
  while (value && typeof value === 'object' && typeof value['.tag'] === 'string') {
    tags.push(value['.tag']);
    value = value[value['.tag']];
  }
  return tags.join('/') || 'unknown error';
}

function entryError(failure, path) {
  const why = tagPath(failure);
  const reason = /not_found/.test(why)
    ? 'it is no longer there; scan again'
    : /too_many_write_operations/.test(why)
      ? 'Dropbox was busy with other changes; try again in a moment'
      : /insufficient_space/.test(why)
        ? 'the Dropbox is full'
        : why;
  return Object.assign(new Error(`Dropbox could not move ${posix.basename(path)}: ${reason}`), { status: 409 });
}

export class DropboxStore {
  constructor(auth, { folder = '', sleep = (ms) => auth.sleep(ms) } = {}) {
    this.auth = auth;
    this.folder = normaliseFolder(folder);
    this.sleep = sleep;
    this.kind = 'dropbox';
    this.bins = new Set(); // bin folder paths known to exist
    this.paths = new Map(); // file id -> path at the last listing
  }

  describe() {
    return `Dropbox ${this.auth.account ?? 'account'}:${this.folder || '/'}`;
  }

  /** Every entry directly inside the folder, page by page. */
  async *entries() {
    let page;
    try {
      page = await this.auth.api('files/list_folder', { path: this.folder, recursive: false }, { idempotent: true });
    } catch (err) {
      if (/^path\/not_found/.test(err.summary ?? '')) {
        throw Object.assign(new Error(`there is no folder ${this.folder} in this Dropbox; check --dropbox-folder (an App folder app sees only /Apps/<app name>, which is its root)`, { cause: err }), { status: 404, missing: true });
      }
      throw err;
    }
    for (;;) {
      yield* page.entries ?? [];
      if (!page.has_more) return;
      page = await this.auth.api('files/list_folder/continue', { cursor: page.cursor }, { idempotent: true });
    }
  }

  async list() {
    const files = [];
    for await (const e of this.entries()) {
      if (e['.tag'] !== 'file' || e.name.startsWith('.')) continue;
      this.paths.set(e.id, e.path_display);
      files.push({ id: e.id, name: e.name, size: Number(e.size ?? 0), mtime: Date.parse(e.server_modified ?? 0), hash: e.content_hash ?? null });
    }
    return files;
  }

  async ensureFolder(path) {
    if (this.bins.has(path)) return;
    try {
      await this.auth.api('files/create_folder_v2', { path, autorename: false });
    } catch (err) {
      const summary = err.summary ?? '';
      if (/^path\/conflict\/file/.test(summary)) {
        throw Object.assign(new Error(`a file called ${posix.basename(path)} is where ChoreCade wants that bin folder; rename it and try again`, { cause: err }), { status: 409 });
      }
      // Already there (made by an earlier run, or by hand): use it.
      if (!/^path\/conflict\/folder/.test(summary)) throw err;
    }
    this.bins.add(path);
  }

  /**
   * Run one move_batch_v2 and wait for it. Small batches finish at once;
   * larger ones come back as a job to poll. Results are in request order.
   */
  async moveBatch(entries) {
    let job = await this.auth.api('files/move_batch_v2', { entries, autorename: true });
    const jobId = job?.async_job_id;
    let waited = 0;
    for (let delay = 250; job?.['.tag'] === 'async_job_id' || job?.['.tag'] === 'in_progress'; delay = Math.min(delay * 2, 4000)) {
      if (waited >= POLL_LIMIT) {
        throw Object.assign(new Error(`Dropbox is still moving the files after ${POLL_LIMIT / 1000} s; scan again in a minute to see where they are`), { status: 504 });
      }
      await this.sleep(delay);
      waited += delay;
      job = await this.auth.api('files/move_batch/check_v2', { async_job_id: jobId }, { idempotent: true });
    }
    if (job?.['.tag'] !== 'complete') throw Object.assign(new Error(`Dropbox could not move the files (${tagPath(job)})`), { status: 502 });
    return job.entries ?? [];
  }

  /**
   * Move `plan` ([{ id, path }]) to new paths, 1000 at a time. Returns the
   * results that succeeded, as { entry, path }, and the first failure, if any.
   */
  async relocate(plan, to) {
    const done = [];
    for (let i = 0; i < plan.length; i += BATCH) {
      const chunk = plan.slice(i, i + BATCH);
      let results;
      try {
        results = await this.moveBatch(chunk.map((e) => ({ from_path: e.id, to_path: to(e) })));
      } catch (failure) {
        return { done, failure };
      }
      let failure = null;
      chunk.forEach((entry, j) => {
        const r = results[j];
        if (r?.['.tag'] === 'success') done.push({ entry, path: r.success?.path_display ?? to(entry) });
        else failure ??= entryError(r?.failure, entry.from ?? to(entry));
      });
      if (failure) return { done, failure };
    }
    return { done, failure: null };
  }

  /** Move files into the `bin` subfolder, or into the ChoreCade Trash subfolder when bin is null. */
  async move(ids, bin) {
    const name = bin ?? TRASH_FOLDER;
    const dir = `${this.folder}/${name}`;
    const where = `${name}/ in Dropbox`;
    const plan = ids.map((id) => {
      const from = this.paths.get(id);
      if (!from) throw Object.assign(new Error('ChoreCade has not seen this file in a scan of the Dropbox folder; scan again'), { status: 409 });
      return { id, from };
    });
    await this.ensureFolder(dir);
    const { done, failure } = await this.relocate(plan, (e) => `${dir}/${posix.basename(e.from)}`);
    // Undo data is kept in the journal, so it carries everything needed to move each file back.
    const entries = done.map(({ entry, path }) => ({ id: entry.id, from: entry.from, to: path }));
    if (failure) {
      if (!entries.length) throw failure;
      throw Object.assign(new Error(failure.message, { cause: failure }), { moved: { entries, where }, count: entries.length, status: failure.status });
    }
    return { entries, where };
  }

  async restore({ entries }) {
    // An undo that failed part-way can be run again: files already back where they were are left alone.
    const now = new Map();
    try {
      for await (const e of this.entries()) now.set(e.id, e.path_lower);
    } catch (err) {
      if (!err.missing) throw err;
    }
    const todo = entries.filter((e) => now.get(e.id) !== e.from.toLowerCase());
    const { done, failure } = await this.relocate(todo, (e) => e.from);
    if (failure) {
      const back = entries.length - todo.length + done.length;
      throw Object.assign(new Error(`put ${back} of ${entries.length} files back before it failed: ${failure.message}`, { cause: failure }), { status: failure.status });
    }
    return entries.length;
  }
}
