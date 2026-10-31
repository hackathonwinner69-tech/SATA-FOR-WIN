import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttp } from 'node:net';
import { Arcade } from '../src/arcade.js';
import { createServer } from '../src/server.js';
import { GoogleAuth } from '../src/google/auth.js';

let dir, server, base, token, port;

const freePort = () =>
  new Promise((resolve) => {
    const s = createHttp().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'chorecade-gr-'));
  port = await freePort();
  const arcade = new Arcade({ chores: [], journalFile: join(dir, 'journal.jsonl'), mode: 'demo' });
  const auth = new GoogleAuth({ clientId: 'cid.apps.googleusercontent.com', clientSecret: 's', tokenFile: join(dir, 'token.json'), fetchImpl: async () => new Response('{}', { status: 500 }) });
  const made = createServer(arcade, { port, google: { auth, options: { dataDir: dir } } });
  token = made.token;
  await new Promise((resolve) => (server = made.app.listen(port, '127.0.0.1', resolve)));
  base = `http://127.0.0.1:${port}`;
});
after(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

const api = (path, opts = {}) => fetch(base + path, { ...opts, headers: { 'x-chorecade-token': token, ...opts.headers } });

test('Google status and connect are behind the session token', async () => {
  assert.equal((await fetch(`${base}/api/google`)).status, 401);
  assert.deepEqual(await (await api('/api/google')).json(), { configured: true, connected: false, email: null });
  const { url } = await (await api('/api/google/connect', { method: 'POST' })).json();
  const u = new URL(url);
  assert.equal(u.origin, 'https://accounts.google.com');
  assert.equal(u.searchParams.get('redirect_uri'), `http://127.0.0.1:${port}/oauth/google/callback`);
});

test('the OAuth callback refuses a state it never issued', async () => {
  const res = await fetch(`${base}/oauth/google/callback?code=x&state=forged`, { redirect: 'manual' });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /not started here/);
});

test('a cancelled consent screen just returns to the arcade', async () => {
  const res = await fetch(`${base}/oauth/google/callback?error=access_denied`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/?google=cancelled');
});

test('Sheets export needs a signed-in Google account', async () => {
  const res = await api('/api/chores/nope/export/sheets', { method: 'POST' });
  assert.equal(res.status, 404);
});
