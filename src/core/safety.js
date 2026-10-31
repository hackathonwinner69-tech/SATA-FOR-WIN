// Guards for a local server that is allowed to move real files and mail.
import { timingSafeEqual } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Resolve `target` and refuse anything that escapes `root`. */
export function within(root, target) {
  const base = resolve(root);
  const full = resolve(base, target);
  const rel = relative(base, full);
  if (rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))) return full;
  throw new Error(`refusing to touch ${full}: it is outside ${base}`);
}

/**
 * `within`, but following symlinks: a folder inside the root that is really a
 * link to somewhere else is refused. A path that does not exist yet is checked
 * through its nearest existing parent.
 */
export async function withinReal(root, target) {
  const full = within(root, target);
  const base = await realpath(resolve(root));
  let probe = full;
  for (;;) {
    try {
      within(base, join(await realpath(probe), relative(probe, full)));
      return full;
    } catch (err) {
      if (err.code !== 'ENOENT' || dirname(probe) === probe) throw err;
      probe = dirname(probe);
    }
  }
}

/** Refuse symlinks so a link inside the sandbox cannot point a move elsewhere. */
export async function assertPlainFile(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`refusing to move symlink ${path}`);
  if (!info.isFile()) throw new Error(`${path} is not a regular file`);
  return info;
}

/** Refuse to write through a symlink. A path that does not exist yet is fine. */
export async function assertNotSymlink(path) {
  let info;
  try {
    info = await lstat(path);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  if (info.isSymbolicLink()) throw new Error(`refusing to write through symlink ${path}`);
  return info;
}

/** Untrusted text (a sender, a file name) as one line: no line breaks or control characters. */
export function cleanLine(text, max = 300) {
  const line = String(text ?? '')
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** `cleanLine`, escaped so Markdown cannot turn it into a link, an image or HTML. */
export function mdText(text, max) {
  return cleanLine(text, max).replace(/[\\[\]<>]/g, '\\$&');
}

/**
 * Only answer requests addressed to this machine by name. Without this, a web
 * page could rebind its own domain to 127.0.0.1 and drive the arcade.
 */
export function hostGuard(port) {
  const allowed = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  return (req, res, next) => {
    if (!allowed.has(req.headers.host)) return res.status(421).send('Misdirected request');
    const origin = req.headers.origin;
    if (origin && !allowed.has(origin.replace(/^https?:\/\//, ''))) {
      return res.status(403).send('Cross-origin requests are not allowed');
    }
    next();
  };
}

/** Compare a secret in constant time. */
export function sameToken(sent, token) {
  if (typeof sent !== 'string' || typeof token !== 'string') return false;
  const a = Buffer.from(sent);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Every API call must carry the token the page was served with, in a header.
 * EventSource cannot set headers, so only the event stream may send it in the URL.
 */
export function tokenGuard(token) {
  return (req, res, next) => {
    const sent = req.headers['x-chorecade-token'] ?? (req.method === 'GET' && req.path === '/events' ? req.query.token : undefined);
    if (!sameToken(sent, token)) return res.status(401).json({ error: 'missing or wrong session token' });
    next();
  };
}
