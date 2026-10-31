import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFilesChore, localFolderStore } from '../src/chores/files/index.js';
import { LocalMailProvider } from '../src/chores/inbox/local-provider.js';

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'chorecade-cache-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const T1 = new Date('2026-01-01T00:00:00Z');
const T2 = new Date('2026-01-02T00:00:00Z');

/** Write a file and pin its mtime, so a later write can keep the same size and mtime. */
async function put(path, body, mtime = T1) {
  await writeFile(path, body);
  await utimes(path, mtime, mtime);
}

const byName = (files) => Object.fromEntries(files.map((f) => [f.name, f]));

test('files: only files that share a size with another file are hashed', async (t) => {
  const root = await tempDir(t);
  await put(join(root, 'a.txt'), 'abc');
  await put(join(root, 'b.txt'), 'abc');
  await put(join(root, 'c.txt'), 'xyz');
  await put(join(root, 'unique.txt'), 'abcdef');
  await put(join(root, 'empty1.txt'), '');
  await put(join(root, 'empty2.txt'), '');
  const files = byName(await localFolderStore(root).list());
  assert.equal(files['a.txt'].hash, files['b.txt'].hash);
  assert.ok(files['c.txt'].hash && files['c.txt'].hash !== files['a.txt'].hash);
  assert.equal(files['unique.txt'].hash, undefined);
  assert.equal(files['empty1.txt'].hash, undefined);
  assert.deepEqual(Object.keys(files['unique.txt']).sort(), ['id', 'mtime', 'name', 'size']);
  assert.equal((await createFilesChore({ root }).scan()).stats.duplicates, 1);
});

test('files: a rescan reuses hashes until the size or mtime changes', async (t) => {
  const root = await tempDir(t);
  await put(join(root, 'a.txt'), 'abc');
  await put(join(root, 'b.txt'), 'abc');
  const store = localFolderStore(root);
  const first = byName(await store.list());

  // Same size and mtime: the cached hash is used, even though the bytes differ.
  await put(join(root, 'a.txt'), 'xyz');
  assert.equal(byName(await store.list())['a.txt'].hash, first['a.txt'].hash);

  await put(join(root, 'a.txt'), 'xyz', T2);
  const touched = byName(await store.list());
  assert.notEqual(touched['a.txt'].hash, first['a.txt'].hash, 'a new mtime means a new hash');
  assert.equal(touched['b.txt'].hash, first['b.txt'].hash);

  await put(join(root, 'a.txt'), 'abcd', T2);
  await put(join(root, 'b.txt'), 'abcd', T1);
  const resized = byName(await store.list());
  assert.equal(resized['a.txt'].hash, resized['b.txt'].hash, 'a new size means a new hash');
  assert.notEqual(resized['a.txt'].hash, touched['a.txt'].hash);
});

test('files: hashes of deleted files are forgotten', async (t) => {
  const root = await tempDir(t);
  await put(join(root, 'a.txt'), 'abc');
  await put(join(root, 'b.txt'), 'abc');
  const store = localFolderStore(root);
  const first = byName(await store.list());
  await unlink(join(root, 'a.txt'));
  assert.deepEqual((await store.list()).map((f) => f.name), ['b.txt']);
  // Back under the same name, size and mtime but with other bytes: it is read again.
  await put(join(root, 'a.txt'), 'xyz');
  const again = byName(await store.list());
  assert.notEqual(again['a.txt'].hash, first['a.txt'].hash);
  assert.equal(again['b.txt'].hash, first['b.txt'].hash);
});

async function mailbox(t) {
  const dir = await tempDir(t);
  await mkdir(join(dir, 'INBOX'));
  return dir;
}

const eml = (subject, status = 'O') => `From: a@x.example\r\nSubject: ${subject}\r\nStatus: ${status}\r\n\r\nbody`;

test('local mailbox: a rescan reads only new or changed files', async (t) => {
  const dir = await mailbox(t);
  const inbox = join(dir, 'INBOX');
  await put(join(inbox, 'a.eml'), eml('one'));
  await put(join(inbox, 'b.eml'), eml('two'));
  const provider = new LocalMailProvider(dir);
  const subjects = async () => Object.fromEntries((await provider.list()).map((m) => [m.id, m.subject]));
  assert.deepEqual(await subjects(), { 'a.eml': 'one', 'b.eml': 'two' });

  // Same size and mtime: the cached headers are used.
  await put(join(inbox, 'a.eml'), eml('uno'));
  assert.deepEqual(await subjects(), { 'a.eml': 'one', 'b.eml': 'two' });

  await put(join(inbox, 'a.eml'), eml('uno'), T2);
  await put(join(inbox, 'b.eml'), eml('three'));
  await put(join(inbox, 'c.eml'), eml('new'));
  assert.deepEqual(await subjects(), { 'a.eml': 'uno', 'b.eml': 'three', 'c.eml': 'new' });
});

test('local mailbox: messages that left the inbox are dropped from the cache', async (t) => {
  const dir = await mailbox(t);
  const inbox = join(dir, 'INBOX');
  await put(join(inbox, 'a.eml'), eml('one'));
  await put(join(inbox, 'b.eml'), eml('two'));
  const provider = new LocalMailProvider(dir);
  await provider.list();
  const r = await provider.move(['a.eml'], 'archive');
  assert.deepEqual((await provider.list()).map((m) => m.id), ['b.eml']);
  assert.deepEqual([...provider.cache.keys()], ['b.eml']);

  await provider.restore(r);
  await put(join(inbox, 'a.eml'), eml('uno'));
  const back = await provider.list();
  assert.equal(back.find((m) => m.id === 'a.eml').subject, 'uno', 'a returning file is read again');
});

test('local mailbox: callers get their own message objects', async (t) => {
  const dir = await mailbox(t);
  await put(join(dir, 'INBOX', 'a.eml'), eml('one', 'RO'));
  const provider = new LocalMailProvider(dir);
  const [first] = await provider.list();
  assert.equal(first.seen, true);
  first.subject = 'changed';
  assert.equal((await provider.list())[0].subject, 'one');
});
