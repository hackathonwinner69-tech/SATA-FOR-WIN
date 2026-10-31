import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttp } from 'node:net';
import { Arcade } from '../src/arcade.js';
import { createServer } from '../src/server.js';
import { DropboxAuth } from '../src/dropbox/auth.js';

let dir, server, base, token, port, arcade, auth;
let dropboxSays; // route -> Response, swapped per test

const freePort = () =>
  new Promise((resolve) => {
    const s = createHttp().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function listen(made) {
  let srv;
  await new Promise((resolve) => (srv = made.app.listen(port, '127.0.0.1', resolve)));
  return srv;
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'chorecade-dr-'));
  port = await freePort();
  dropboxSays = {};
  arcade = new Arcade({ chores: [], journalFile: join(dir, 'journal.jsonl'), mode: 'demo' });
  const fetchImpl = async (url) => {
    const route = String(url).replace(/^https:\/\/api\.dropboxapi\.com\/(2\/)?/, '');
    return dropboxSays[route]?.() ?? json({ error_summary: 'other/' }, 500);
  };
  auth = new DropboxAuth({ appKey: 'key', tokenFile: join(dir, 'dropbox-token.json'), fetchImpl, sleep: async () => {} });
  const made = createServer(arcade, { port, dropbox: { auth, options: { folder: '/Downloads' } } });
  token = made.token;
  server = await listen(made);
  base = `http://127.0.0.1:${port}`;
});
after(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

const api = (path, opts = {}) => fetch(base + path, { ...opts, headers: { 'x-chorecade-token': token, ...opts.headers } });

test('Dropbox status and connect are behind the session token', async () => {
  assert.equal((await fetch(`${base}/api/dropbox`)).status, 401);
  assert.equal((await fetch(`${base}/api/dropbox/connect`, { method: 'POST' })).status, 401);
  assert.deepEqual(await (await api('/api/dropbox')).json(), { configured: true, connected: false, email: null });
  const { url } = await (await api('/api/dropbox/connect', { method: 'POST' })).json();
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://www.dropbox.com/oauth2/authorize');
  assert.equal(u.searchParams.get('redirect_uri'), `http://127.0.0.1:${port}/oauth/dropbox/callback`);
});

test('the OAuth callback refuses a state it never issued', async () => {
  const res = await fetch(`${base}/oauth/dropbox/callback?code=x&state=forged`, { redirect: 'manual' });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /not started here/);
});

test('a cancelled consent screen returns to the arcade; a refused one explains what to check', async () => {
  const cancelled = await fetch(`${base}/oauth/dropbox/callback?error=access_denied&state=s`, { redirect: 'manual' });
  assert.equal(cancelled.status, 302);
  assert.equal(cancelled.headers.get('location'), `http://localhost:${port}/?dropbox=cancelled`);

  const refused = await fetch(`${base}/oauth/dropbox/callback?error=invalid_scope&error_description=${encodeURIComponent('files.content.write is not enabled\nfor this app')}`, { redirect: 'manual' });
  assert.equal(refused.status, 400);
  assert.match(refused.headers.get('content-type'), /^text\/plain/);
  assert.match(await refused.text(), /^Dropbox sign-in failed: files\.content\.write is not enabled for this app\. Check the Permissions tab/);
});

test('signing in adds the cabinet; connecting again is refused; signing out removes it and warns when Dropbox did not confirm', async () => {
  const { url } = await (await api('/api/dropbox/connect', { method: 'POST' })).json();
  const state = new URL(url).searchParams.get('state');
  dropboxSays = {
    'oauth2/token': () => json({ access_token: 'at', expires_in: 14400, refresh_token: 'rt', scope: 'account_info.read files.content.write files.metadata.read', account_id: 'dbid:1' }),
    'users/get_current_account': () => json({ account_id: 'dbid:1', email: 'p@example.com' }),
  };
  const res = await fetch(`${base}/oauth/dropbox/callback?code=c&state=${state}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), `http://localhost:${port}/?dropbox=connected`);
  const chores = (await (await api('/api/state')).json()).chores;
  assert.deepEqual(chores.map((c) => [c.id, c.title, c.target, c.remote]), [['dropbox', 'Folder Frenzy: Dropbox', 'Dropbox p@example.com:/Downloads', true]]);
  assert.deepEqual(await (await api('/api/dropbox')).json(), { configured: true, connected: true, email: 'p@example.com' });
  if (process.platform !== 'win32') assert.equal((await stat(join(dir, 'dropbox-token.json'))).mode & 0o777, 0o600);

  const again = await api('/api/dropbox/connect', { method: 'POST' });
  assert.equal(again.status, 409);
  assert.match((await again.json()).error, /disconnect first/);

  dropboxSays = {}; // the revoke fails
  const out = await (await api('/api/dropbox/disconnect', { method: 'POST' })).json();
  assert.equal(out.connected, false);
  assert.equal(out.revoked, false);
  assert.match(out.warning, /dropbox\.com\/account\/connected_apps/);
  assert.equal(arcade.chores.size, 0);
  await assert.rejects(stat(join(dir, 'dropbox-token.json')), { code: 'ENOENT' });
});

test('a saved sign-in brings the cabinet back at start-up, and a revoked one takes it away', async () => {
  const tokenFile = join(dir, 'saved-token.json');
  await writeFile(tokenFile, JSON.stringify({ refresh_token: 'rt', email: 'p@example.com', account_id: 'dbid:1' }));
  const saved = new DropboxAuth({ appKey: 'key', tokenFile, fetchImpl: async () => json({ error: 'invalid_grant', error_description: 'revoked' }, 400), log: () => {} });
  await saved.load();
  const restarted = new Arcade({ chores: [], journalFile: join(dir, 'journal-2.jsonl'), mode: 'live' });
  createServer(restarted, { port, dropbox: { auth: saved, options: {} } });
  assert.deepEqual([...restarted.chores.values()].map((c) => c.target), ['Dropbox p@example.com:/']);
  await assert.rejects(restarted.scan('dropbox'), (err) => err.status === 401 && /connect Dropbox again/.test(err.message));
  assert.equal(restarted.chores.size, 0);
});

test('without an app key, connect explains the setup', async () => {
  const unset = new DropboxAuth({ tokenFile: join(dir, 'none.json') });
  const other = new Arcade({ chores: [], journalFile: join(dir, 'journal-3.jsonl'), mode: 'demo' });
  const otherPort = await freePort();
  const made = createServer(other, { port: otherPort, dropbox: { auth: unset, options: {} } });
  let srv;
  await new Promise((resolve) => (srv = made.app.listen(otherPort, '127.0.0.1', resolve)));
  try {
    const headers = { 'x-chorecade-token': made.token };
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${otherPort}/api/dropbox`, { headers })).json(), { configured: false, connected: false, email: null });
    const res = await fetch(`http://127.0.0.1:${otherPort}/api/dropbox/connect`, { method: 'POST', headers });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /DROPBOX_APP_KEY/);
  } finally {
    srv.close();
  }
});
