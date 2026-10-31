// A Google Drive folder as a Folder Frenzy store. Bins are subfolders created
// on demand; Trash is Drive's own trash (restorable for 30 days). Duplicates
// come from Drive's md5Checksum, so nothing is downloaded.
import { pool } from './gmail.js';

const API = 'https://www.googleapis.com/drive/v3/files';
const FOLDER = 'application/vnd.google-apps.folder';

/** Google's own formats have no file extension; place them by MIME type instead. */
export function binForMime(mime = '') {
  if (/google-apps\.(document|spreadsheet|presentation|form)|pdf|msword|officedocument|text\//.test(mime)) return 'Documents';
  if (mime.startsWith('image/') || mime.endsWith('google-apps.drawing')) return 'Images';
  if (mime.startsWith('video/') || mime.startsWith('audio/')) return 'Media';
  if (/zip|compressed|x-tar|x-7z|x-rar/.test(mime)) return 'Archives';
  return null;
}

// Folder ids come from Drive itself; quote them defensively for the query language anyway.
const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** A move that failed after some files went through carries what is needed to put just those back. */
function partialMove(err, moved, count) {
  if (!count) return err;
  return Object.assign(new Error(err.message, { cause: err }), { moved, count, status: err.status });
}

export class DriveStore {
  constructor(auth, { folderId = 'root', concurrency = 8 } = {}) {
    this.auth = auth;
    this.folderId = folderId;
    this.concurrency = concurrency;
    this.kind = 'drive';
    this.bins = new Map(); // bin name -> folder id
  }

  describe() {
    return `Google Drive ${this.folderId === 'root' ? 'My Drive' : `folder ${this.folderId}`}`;
  }

  async list() {
    const files = [];
    let pageToken;
    do {
      const page = await this.auth.api(API, {
        query: {
          q: `${q(this.folderId)} in parents and trashed = false and mimeType != '${FOLDER}'`,
          fields: 'nextPageToken, files(id, name, mimeType, size, md5Checksum, modifiedTime)',
          pageSize: '1000',
          ...(pageToken ? { pageToken } : {}),
        },
      });
      for (const f of page.files ?? []) {
        files.push({
          id: f.id,
          name: f.name,
          size: Number(f.size ?? 0),
          mtime: Date.parse(f.modifiedTime ?? 0),
          hash: f.md5Checksum ?? null,
          binHint: binForMime(f.mimeType),
        });
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    return files;
  }

  async binFolder(name) {
    if (this.bins.has(name)) return this.bins.get(name);
    const found = await this.auth.api(API, {
      query: { q: `${q(this.folderId)} in parents and name = ${q(name)} and mimeType = '${FOLDER}' and trashed = false`, fields: 'files(id)' },
    });
    const id = found.files?.[0]?.id ?? (await this.auth.api(API, { method: 'POST', query: { fields: 'id' }, body: { name, mimeType: FOLDER, parents: [this.folderId] } })).id;
    this.bins.set(name, id);
    return id;
  }

  /**
   * PATCH every file the same way. Setting trashed or parents is safe to repeat.
   * After the first failure no new requests start; returns the ids that went through, in order.
   */
  async patchAll(ids, request) {
    const ok = new Set();
    let failure = null;
    await pool(ids, this.concurrency, async (id) => {
      if (failure) return;
      try {
        await this.auth.api(`${API}/${id}`, { method: 'PATCH', idempotent: true, ...request });
        ok.add(id);
      } catch (err) {
        failure ??= err;
      }
    });
    return { done: ids.filter((id) => ok.has(id)), failure };
  }

  async move(ids, bin) {
    if (bin === null) {
      const { done, failure } = await this.patchAll(ids, { query: { fields: 'id' }, body: { trashed: true } });
      const result = (moved) => ({ ids: moved, trashed: true, where: 'Drive trash' });
      if (failure) throw partialMove(failure, result(done), done.length);
      return result(ids);
    }
    const to = await this.binFolder(bin);
    const { done, failure } = await this.patchAll(ids, { query: { addParents: to, removeParents: this.folderId, fields: 'id' }, body: {} });
    const result = (moved) => ({ ids: moved, to, from: this.folderId, where: `${bin}/ in Drive` });
    if (failure) throw partialMove(failure, result(done), done.length);
    return result(ids);
  }

  async restore({ ids, trashed, to, from }) {
    const request = trashed ? { query: { fields: 'id' }, body: { trashed: false } } : { query: { addParents: from, removeParents: to, fields: 'id' }, body: {} };
    const { done, failure } = await this.patchAll(ids, request);
    if (failure) {
      throw Object.assign(new Error(`put ${done.length} of ${ids.length} files back before it failed: ${failure.message}`, { cause: failure }), { status: failure.status });
    }
    return ids.length;
  }
}
