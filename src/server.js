// HTTP front of the arcade. Binds to loopback only, answers only to
// localhost by name and wants the session token on every API call.
import express from 'express';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostGuard, sameToken, tokenGuard } from './core/safety.js';
import { mountGoogle } from './google/index.js';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const FONTS = fileURLToPath(new URL('../node_modules/@fontsource/', import.meta.url));

function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

const lockedPage = (port) => `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>ChoreCade is locked</title>
<main style="max-width: 34rem; margin: 15vh auto; padding: 0 1.5rem; font: 1.1rem/1.5 system-ui, sans-serif">
  <h1>ChoreCade is locked</h1>
  <p>Open the link printed in the terminal where you started ChoreCade. It looks like
  <code>http://localhost:${port}/?token=…</code> and works until that run stops.</p>
</main>
</html>
`;

export function createServer(arcade, { port, token = randomBytes(24).toString('hex'), google = null }) {
  const app = express();
  // Browsers share cookies across ports, so each port gets its own name and two runs never lock each other out.
  const sessionCookie = `chorecade_session_${port}`;
  app.disable('x-powered-by');
  app.use(hostGuard(port));
  app.use((req, res, next) => {
    res.set({
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
    });
    next();
  });

  // The page carries the token. Other origins cannot read it, and it is only
  // served to a browser that opened the link printed in the terminal (which
  // leaves a cookie), so another account or app on this machine cannot fetch it.
  app.get(['/', '/index.html'], async (req, res) => {
    res.set('cache-control', 'no-store');
    if (typeof req.query.token === 'string' && sameToken(req.query.token, token)) {
      res.cookie(sessionCookie, token, { httpOnly: true, sameSite: 'lax', path: '/' });
      return res.redirect(303, '/');
    }
    if (!sameToken(readCookie(req, sessionCookie), token)) return res.status(401).type('html').send(lockedPage(port));
    const html = await readFile(join(PUBLIC, 'index.html'), 'utf8');
    res.type('html').send(html.replace('__CHORECADE_TOKEN__', token));
  });
  app.use(express.static(PUBLIC, { index: false }));
  // Self-hosted Google Fonts (Silkscreen, IBM Plex): no third-party requests, works offline.
  for (const family of ['silkscreen', 'ibm-plex-sans', 'ibm-plex-mono']) {
    app.use(`/fonts/${family}`, express.static(join(FONTS, family, 'files'), { maxAge: '30d', immutable: true }));
  }

  const api = express.Router();
  api.use(tokenGuard(token));
  api.use(express.json({ limit: '64kb' }));

  const wrap = (fn) => async (req, res) => {
    try {
      res.json(await fn(req, res));
    } catch (err) {
      res.status(err.status ?? 500).json({ error: err.message });
    }
  };

  api.get('/state', wrap(() => arcade.summary()));
  api.post('/chores/:id/scan', wrap((req) => arcade.scan(req.params.id)));
  api.post(
    '/chores/:id/act',
    wrap((req, res) => {
      const { groupId, action } = req.body ?? {};
      if (typeof groupId !== 'string' || typeof action !== 'string') throw Object.assign(new Error('groupId and action are required'), { status: 400 });
      res.status(202);
      return arcade.act(req.params.id, groupId, action);
    }),
  );
  api.get(
    '/journal',
    wrap(async () => {
      await arcade.journal.load();
      return arcade.journal.recent(100);
    }),
  );
  api.post(
    '/journal/:id/undo',
    wrap(async (req, res) => {
      res.status(202);
      return arcade.undo(req.params.id);
    }),
  );

  api.get('/events', (req, res) => {
    res.set({ 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.flushHeaders();
    const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    send({ type: 'hello', state: arcade.summary() });
    arcade.on('event', send);
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(ping);
      arcade.off('event', send);
    });
  });

  if (google) mountGoogle({ app, api, arcade, port, ...google });
  app.use('/api', api);
  return { app, token };
}
