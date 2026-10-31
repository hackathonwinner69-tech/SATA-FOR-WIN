// Guards for a local server that is allowed to move real files and mail.
import { lstat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Resolve `target` and refuse anything that escapes `root`. */
export function within(root, target) {
  const base = resolve(root);
  const full = resolve(base, target);
  const rel = relative(base, full);
  if (rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))) return full;
  throw new Error(`refusing to touch ${full}: it is outside ${base}`);
}

/** Refuse symlinks so a link inside the sandbox cannot point a move elsewhere. */
export async function assertPlainFile(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`refusing to move symlink ${path}`);
  if (!info.isFile()) throw new Error(`${path} is not a regular file`);
  return info;
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

/** Every API call must carry the token the page was served with. */
export function tokenGuard(token) {
  return (req, res, next) => {
    const sent = req.headers['x-chorecade-token'] ?? req.query.token;
    if (sent !== token) return res.status(401).json({ error: 'missing or wrong session token' });
    next();
  };
}
