import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedDemo } from '../scripts/seed-demo.js';
import { Arcade } from '../src/arcade.js';
import { createServer } from '../src/server.js';
import { createFilesChore } from '../src/chores/files/index.js';

let root, server, base, token, arcade;
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'chorecade-srv-'));
  await seedDemo(root, { emails: 10 });
  arcade = new Arcade({ chores: [createFilesChore({ root: join(root, 'Downloads') })], journalFile: join(root, 'journal.jsonl'), mode: 'demo' });
  await new Promise((resolve) => {
    const probe = createServer(arcade, { port: 0 });
    server = probe.app.listen(0, '127.0.0.1', resolve);
  });
  // Rebuild with the real port so the host guard knows it.
  const port = server.address().port;
  server.close();
  const real = createServer(arcade, { port });
  token = real.token;
  await new Promise((resolve) => (server = real.app.listen(port, '127.0.0.1', resolve)));
  base = `http://127.0.0.1:${port}`;
});
after(async () => {
  server.closeAllConnections();
  server.close();
  await rm(root, { recursive: true, force: true });
});

const api = (path, opts = {}) =>
  fetch(base + path, { ...opts, headers: { 'content-type': 'application/json', 'x-chorecade-token': token, ...opts.headers } });

test('the page and its token are only served after the terminal link is opened', async () => {
  const locked = await fetch(base + '/');
  assert.equal(locked.status, 401);
  assert.ok(!(await locked.text()).includes(token));
  assert.equal((await fetch(base + '/?token=wrong', { redirect: 'manual' })).status, 401);

  const opened = await fetch(`${base}/?token=${token}`, { redirect: 'manual' });
  assert.equal(opened.status, 303);
  const cookie = opened.headers.get('set-cookie');
  assert.match(cookie, new RegExp(`^chorecade_session_${new URL(base).port}=`));
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);

  const page = await fetch(base + '/', { headers: { cookie: cookie.split(';')[0] } });
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes(token));
});

test('only the event stream takes the token in its URL', async () => {
  assert.equal((await fetch(`${base}/api/state?token=${token}`)).status, 401);
  const events = await fetch(`${base}/api/events?token=${token}`);
  assert.equal(events.status, 200);
  await events.body.cancel();
});

test('pages are served with a strict content security policy', async () => {
  const csp = (await fetch(base + '/')).headers.get('content-security-policy');
  for (const rule of ["default-src 'self'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'", "object-src 'none'"]) assert.ok(csp.includes(rule), rule);
});

test('API calls without the token are refused', async () => {
  const res = await fetch(base + '/api/state');
  assert.equal(res.status, 401);
});

test('requests addressed to another host name are refused (DNS rebinding)', async () => {
  // fetch() will not forge a Host header, so speak HTTP directly.
  const status = await new Promise((resolve, reject) => {
    const req = request(base + '/api/state', { headers: { host: 'evil.example', 'x-chorecade-token': token } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject).end();
  });
  assert.equal(status, 421);
});

test('cross-origin requests are refused', async () => {
  const res = await api('/api/state', { headers: { origin: 'https://evil.example' } });
  assert.equal(res.status, 403);
});

test('a move runs in the background, lands in the journal and can be undone', async () => {
  const scan = await (await api('/api/chores/files/scan', { method: 'POST' })).json();
  const pack = scan.groups.find((g) => g.label.startsWith('Screenshot'));
  assert.ok(!('files' in pack), 'file lists stay on the server');

  const res = await api('/api/chores/files/act', { method: 'POST', body: JSON.stringify({ groupId: pack.id, action: 'move:Images' }) });
  assert.equal(res.status, 202);
  await arcade.queue.drain();
  assert.equal((await readdir(join(root, 'Downloads', 'Images'))).length, pack.count);
  assert.equal(arcade.impact.files.moved, pack.count);

  const again = await api('/api/chores/files/act', { method: 'POST', body: JSON.stringify({ groupId: pack.id, action: 'trash' }) });
  assert.equal(again.status, 409, 'a group is played once');

  const [entry] = await (await api('/api/journal')).json();
  assert.equal(entry.undoable, true);
  assert.equal((await api(`/api/journal/${entry.id}/undo`, { method: 'POST' })).status, 202);
  await arcade.queue.drain();
  assert.equal((await readdir(join(root, 'Downloads', 'Images'))).length, 0);
});

test('unknown actions are rejected before anything runs', async () => {
  const scan = await (await api('/api/chores/files/scan', { method: 'POST' })).json();
  const res = await api('/api/chores/files/act', { method: 'POST', body: JSON.stringify({ groupId: scan.groups[0].id, action: 'move:../../etc' }) });
  assert.equal(res.status, 400);
});
