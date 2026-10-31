// HTTP front of the arcade. Binds to loopback only, answers only to
// localhost by name and wants the session token on every API call.
import express from 'express';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostGuard, tokenGuard } from './core/safety.js';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));

export function createServer(arcade, { port, token = randomBytes(24).toString('hex') }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(hostGuard(port));
  app.use((req, res, next) => {
    res.set({
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
    });
    next();
  });

  // The page carries the token; other origins cannot read it, so cannot use it.
  app.get(['/', '/index.html'], async (req, res) => {
    const html = await readFile(join(PUBLIC, 'index.html'), 'utf8');
    res.type('html').set('cache-control', 'no-store').send(html.replace('__CHORECADE_TOKEN__', token));
  });
  app.use(express.static(PUBLIC, { index: false }));

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

  app.use('/api', api);
  return { app, token };
}
