// Small filesystem helpers shared by chores that move things around.
import { access, mkdir, rename } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

export async function exists(path) {
  try {
    await access(path);
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
  for (let n = 2; await exists(candidate); n++) candidate = join(dir, `${stem} (${n})${ext}`);
  return candidate;
}

/** Move a file without ever overwriting what is already at the destination. */
export async function safeMove(from, toDir, name = basename(from)) {
  await mkdir(toDir, { recursive: true });
  const to = await freeName(toDir, name);
  await rename(from, to);
  return to;
}

/** Undo a batch of moves only if every one of them can still be undone. */
export async function moveAllBack(moved) {
  for (const { from, to } of moved) {
    if (!(await exists(to))) throw new Error(`${to} is gone; nothing was restored`);
    if (await exists(from)) throw new Error(`${from} is taken again; nothing was restored`);
  }
  for (const { from, to } of [...moved].reverse()) await moveBack(to, from);
  return moved.length;
}

/** Put a file back where it came from, refusing if something now sits there. */
export async function moveBack(current, original) {
  if (await exists(original)) throw new Error(`${original} already exists; not overwriting it`);
  await mkdir(dirname(original), { recursive: true });
  await rename(current, original);
}
