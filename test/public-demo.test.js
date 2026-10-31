import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Arcade } from '../src/arcade.js';
import { createServer } from '../src/server.js';

async function serve(options) {
  const dir = await mkdtemp(join(tmpdir(), 'chorecade-pub-'));
  const arcade = new Arcade({ chores: [], journalFile: join(dir, 'journal.jsonl'), mode: 'demo' });
  const listener = await new Promise((resolve) => {
    const probe = createServer(arcade, { port: 0, ...options }).app.listen(0, '127.0.0.1', () => resolve(probe));
  });
  const port = listener.address().port;
  listener.close();
  const { app, token } = createServer(arcade, { port, ...options });
  const server = await new Promise((resolve) => {
    const s = app.listen(port, '127.0.0.1', () => resolve(s));
  });
  return { base: `http://127.0.0.1:${port}`, token, close: async () => (server.close(), rm(dir, { recursive: true, force: true })) };
}

test('the hosted public demo opens without the terminal link', async () => {
  const s = await serve({ token: 'demo', publicDemo: true });
  const res = await fetch(`${s.base}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<title>ChoreCade<\/title>/);
  // The API itself still wants the token the page carries.
  assert.equal((await fetch(`${s.base}/api/state`)).status, 401);
  await s.close();
});

test('a local run stays locked without the terminal link', async () => {
  const s = await serve({});
  const res = await fetch(`${s.base}/`);
  assert.equal(res.status, 401);
  assert.match(await res.text(), /ChoreCade is locked/);
  await s.close();
});
