// Small filesystem helpers shared by chores that move things around.
import { access, constants, copyFile, link, lstat, mkdir, stat, unlink, utimes } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

export async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** True if anything at all sits at `path`, even a broken symlink. */
async function taken(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** Pick `dir/name`, or `dir/name (2)` and so on if that is taken. */
export async function freeName(dir, name) {
  const ext = extname(name);
  const stem = basename(name, ext);
  let candidate = join(dir, name);
  for (let n = 2; await taken(candidate); n++) candidate = join(dir, `${stem} (${n})${ext}`);
  return candidate;
}

// link() errors that mean "this volume cannot hard-link here", so copy instead.
const NO_LINKS = new Set(['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EMLINK']);

/**
 * Move one file, failing with EEXIST instead of replacing whatever is at `to`.
 * rename() would silently overwrite a file that appeared there after we looked.
 */
async function moveNoClobber(from, to) {
  if ((await lstat(from)).isSymbolicLink()) throw new Error(`refusing to move symlink ${from}`);
  try {
    await link(from, to);
  } catch (err) {
    if (!NO_LINKS.has(err.code)) throw err;
    const info = await stat(from);
    await copyFile(from, to, constants.COPYFILE_EXCL);
    await utimes(to, info.atime, info.mtime).catch(() => {});
  }
  try {
    await unlink(from);
  } catch (err) {
    await unlink(to).catch(() => {});
    throw err;
  }
}

/** Move a file without ever overwriting what is already at the destination. */
export async function safeMove(from, toDir, name = basename(from)) {
  await mkdir(toDir, { recursive: true });
  for (let tries = 0; ; tries++) {
    const to = await freeName(toDir, name);
    try {
      await moveNoClobber(from, to);
      return to;
    } catch (err) {
      if (err.code !== 'EEXIST' || tries >= 100) throw err; // taken since freeName looked: pick the next name
    }
  }
}

/** Undo a batch of moves only if every one of them can still be undone. */
export async function moveAllBack(moved) {
  for (const { from, to } of moved) {
    if (!(await exists(to))) throw new Error(`${to} is gone; nothing was restored`);
    if (await taken(from)) throw new Error(`${from} is taken again; nothing was restored`);
  }
  const restored = [];
  try {
    for (const move of [...moved].reverse()) {
      await moveBack(move.to, move.from);
      restored.push(move);
    }
  } catch (err) {
    // Keep it all-or-nothing: send back the files this undo had already restored.
    const stuck = [];
    for (const { from, to } of restored.reverse()) await moveNoClobber(from, to).catch(() => stuck.push(from));
    throw new Error(stuck.length ? `${err.message}; ${stuck.length} files were restored anyway: ${stuck.join(', ')}` : `${err.message}; nothing was restored`, { cause: err });
  }
  return moved.length;
}

/** Put a file back where it came from, refusing if something now sits there. */
export async function moveBack(current, original) {
  if (await taken(original)) throw new Error(`${original} already exists; not overwriting it`);
  await mkdir(dirname(original), { recursive: true });
  try {
    await moveNoClobber(current, original);
  } catch (err) {
    if (err.code === 'EEXIST') throw new Error(`${original} already exists; not overwriting it`, { cause: err });
    throw err;
  }
}
