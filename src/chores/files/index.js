// Folder sorting. Loose files at the top of a messy folder (Downloads, Desktop)
// get dropped into bins. Similar files travel together, exact duplicates are
// spotted by hash, and "trash" is a folder you can still open.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { assertPlainFile, within } from '../../core/safety.js';
import { moveAllBack, safeMove } from '../../core/fsx.js';

export const TRASH_DIR = '.chorecade-trash';
const HASH_LIMIT = 50 * 1024 * 1024;

export const BINS = {
  Documents: ['pdf', 'doc', 'docx', 'txt', 'md', 'rtf', 'odt', 'xls', 'xlsx', 'csv', 'ppt', 'pptx', 'pages', 'numbers', 'key', 'epub'],
  Images: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'svg', 'bmp', 'tiff', 'psd', 'raw', 'ico'],
  Media: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg'],
  Code: ['js', 'ts', 'py', 'java', 'c', 'cpp', 'h', 'go', 'rs', 'rb', 'php', 'html', 'css', 'json', 'yml', 'yaml', 'sh', 'ipynb', 'sql', 'xml'],
  Archives: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz'],
  Installers: ['exe', 'msi', 'dmg', 'pkg', 'deb', 'rpm', 'apk', 'appimage', 'iso'],
};

const EXT_TO_BIN = Object.fromEntries(Object.entries(BINS).flatMap(([bin, exts]) => exts.map((e) => [e, bin])));

export const FILE_ACTIONS = [
  ...Object.keys(BINS).map((bin) => ({ id: `move:${bin}`, label: bin, bin })),
  { id: 'trash', label: 'Trash', bin: 'Trash', destructive: true },
  { id: 'keep', label: 'Leave it', bin: null },
];

export function binFor(name) {
  return EXT_TO_BIN[extname(name).slice(1).toLowerCase()] ?? null;
}

/** "Screenshot 2024-03-01 at 10.22.31 (1).png" -> "screenshot #-#-# at #.#.#" */
export function namePattern(name) {
  return name
    .slice(0, name.length - extname(name).length)
    .toLowerCase()
    .replace(/\s*\(\d+\)$/, '')
    .replace(/[\s_-]*(copy|final|v\d+)$/g, '')
    .replace(/\d+/g, '#')
    .replace(/[\s_]+/g, ' ')
    .trim();
}

function hashFile(path) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha1');
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

/** Label a pack from its first file: "WhatsApp Image 2026-01-11 at 9.10.jpeg" -> "WhatsApp Image at (*.jpeg)" */
function packLabel(name, ext) {
  const words =
    name
      .slice(0, name.length - extname(name).length)
      .replace(/\(\d+\)/g, '')
      .replace(/\d+/g, '')
      .replace(/[\s_.-]+/g, ' ')
      .trim() || 'unnamed';
  return `${words} (*.${ext || '?'})`;
}

/**
 * Turn a flat file list into game-sized groups: exact duplicates first, then
 * packs of look-alike names, then one-offs folded together per bin.
 * Each file is { id, name, size, mtime, hash?, binHint? }; groups carry ids.
 */
export function groupFiles(files) {
  const byHash = new Map();
  for (const f of files) {
    if (!f.hash) continue;
    if (!byHash.has(f.hash)) byHash.set(f.hash, []);
    byHash.get(f.hash).push(f);
  }
  const groups = [];
  const claimed = new Set();
  // Exact duplicates: keep the oldest copy, offer the rest for trashing.
  for (const copies of byHash.values()) {
    if (copies.length < 2) continue;
    copies.sort((a, b) => a.mtime - b.mtime || a.name.length - b.name.length);
    const [original, ...extras] = copies;
    extras.forEach((f) => claimed.add(f.id));
    groups.push({
      id: `dupes:${original.hash}`,
      label: `${extras.length} duplicate${extras.length > 1 ? 's' : ''} of ${original.name}`,
      detail: extras.map((f) => f.name).join(', '),
      count: extras.length,
      bytes: extras.reduce((s, f) => s + f.size, 0),
      kind: 'duplicate',
      suggestion: 'trash',
      risk: 'low',
      files: extras.map((f) => f.id),
    });
  }

  const binOf = (f) => binFor(f.name) ?? f.binHint ?? null;
  const packs = new Map();
  for (const f of files) {
    if (claimed.has(f.id)) continue;
    const ext = extname(f.name).slice(1).toLowerCase();
    const key = `${ext}|${namePattern(f.name)}`;
    if (!packs.has(key)) packs.set(key, []);
    packs.get(key).push(f);
  }
  // Fold one-off files into a pack per bin so the game is not 300 crates.
  const loose = new Map();
  for (const [key, pack] of packs) {
    if (pack.length > 1) continue;
    packs.delete(key);
    const bin = binOf(pack[0]) ?? 'unknown';
    if (!loose.has(bin)) loose.set(bin, []);
    loose.get(bin).push(pack[0]);
  }
  for (const [bin, pack] of loose) packs.set(`*|${bin}`, pack);

  for (const [key, pack] of packs) {
    const [ext, pattern] = key.split('|');
    const bin = binOf(pack[0]);
    groups.push({
      id: `pack:${key}`,
      label:
        ext === '*'
          ? pattern === 'unknown'
            ? `${pack.length} mystery file${pack.length > 1 ? 's' : ''}`
            : `${pack.length} loose ${pattern.toLowerCase()} file${pack.length > 1 ? 's' : ''}`
          : packLabel(pack[0].name, ext),
      detail: pack.slice(0, 4).map((f) => f.name).join(', ') + (pack.length > 4 ? ', ...' : ''),
      count: pack.length,
      bytes: pack.reduce((s, f) => s + f.size, 0),
      kind: bin ?? 'unknown',
      suggestion: bin ? `move:${bin}` : 'keep',
      risk: bin ? 'low' : 'medium',
      files: pack.map((f) => f.id),
    });
  }
  groups.sort((a, b) => b.count - a.count);
  return { groups, duplicates: claimed.size };
}

/** A folder on this machine. Ids are file names; trash is a folder you can open. */
export function localFolderStore(root) {
  root = resolve(root);
  return {
    kind: 'local',
    describe: () => root,
    async list() {
      const files = [];
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isFile() || entry.name.startsWith('.')) continue;
        const path = join(root, entry.name);
        const info = await stat(path);
        const file = { id: entry.name, name: entry.name, size: info.size, mtime: info.mtimeMs };
        if (info.size > 0 && info.size <= HASH_LIMIT) file.hash = await hashFile(path);
        files.push(file);
      }
      return files;
    },
    /** Move files into `bin` (a folder name), or into the trash folder when bin is null. */
    async move(ids, bin) {
      const toDir = within(root, bin ?? TRASH_DIR);
      const moved = [];
      for (const name of ids) {
        const from = within(root, name);
        await assertPlainFile(from);
        moved.push({ from, to: await safeMove(from, toDir) });
      }
      return { moved, where: bin ? `${bin}/` : TRASH_DIR };
    },
    async restore({ moved }) {
      return moveAllBack(moved.map(({ from, to }) => ({ from: within(root, from), to: within(root, to) })));
    },
  };
}

export function createFilesChore({ root, store = localFolderStore(root), id = 'files', title = 'Folder Frenzy', remote = false, dryRun = false }) {
  return {
    id,
    title,
    chore: 'Sort a messy folder',
    game: 'frenzy',
    unit: 'loose files',
    remote,
    target: store.describe(),
    actions: FILE_ACTIONS,

    async scan() {
      const files = await store.list();
      const { groups, duplicates } = groupFiles(files);
      return {
        groups,
        stats: { files: files.length, bytes: files.reduce((s, f) => s + f.size, 0), duplicates, remaining: files.length },
      };
    },

    async apply(group, action) {
      const count = group.files.length;
      if (action === 'keep') return { affected: count, summary: `left ${count} files alone`, impact: { kept: count }, undo: null };
      const bin = action === 'trash' ? null : action.replace(/^move:/, '');
      if (bin !== null && !BINS[bin]) throw new Error(`unknown bin ${bin}`);
      if (dryRun) return { affected: count, summary: `[dry run] would move ${count} files to ${bin ?? 'trash'}`, impact: {}, undo: null };
      const result = await store.move(group.files, bin);
      const verb = bin ? 'moved' : 'trashed';
      return {
        affected: count,
        summary: `${verb} ${count} files ${bin ? 'to' : 'into'} ${result.where}`,
        impact: { [verb]: count, bytes: group.bytes ?? 0 },
        undo: result,
      };
    },

    async undo(undo) {
      const restored = await store.restore(undo);
      return { restored, summary: `put ${restored} files back` };
    },
  };
}
