import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HEADER_MAX, isoDate, parseAddress, parseHeaders, parseUnsubscribe } from '../src/chores/inbox/headers.js';
import { classifySender, createInboxChore, groupBySender } from '../src/chores/inbox/index.js';
import { LocalMailProvider } from '../src/chores/inbox/local-provider.js';
import { GmailProvider } from '../src/google/gmail.js';
import { createAdvisor } from '../src/ai/advisor.js';

// Windows needs extra rights for symlinks; the guards are the same code on every OS.
const posix = { skip: process.platform === 'win32' && 'needs POSIX symlinks' };

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'chorecade-inbox-'));
}

function fakeProvider(move = async (ids, target) => ({ target, ids })) {
  const calls = [];
  return {
    calls,
    kind: 'fake',
    describe: () => 'fake mailbox',
    list: async () => [],
    move: async (ids, target) => {
      calls.push([ids, target]);
      return move(ids, target);
    },
    restore: async (data) => data.ids.length,
  };
}

const group = (overrides = {}) => ({
  id: 'sender:news@shop.example',
  label: 'Shop News',
  detail: 'news@shop.example',
  count: 2,
  ids: ['1', '2'],
  unsubscribe: parseUnsubscribe('<https://shop.example/u>', 'List-Unsubscribe=One-Click'),
  ...overrides,
});

test('parseAddress: the last angle address wins and address-like names are not shown', () => {
  assert.deepEqual(parseAddress('"support@paypal.com" <x@evil.test>'), { name: 'x@evil.test', address: 'x@evil.test' });
  assert.deepEqual(parseAddress('"PayPal <support@paypal.com>" <X@Evil.test>'), { name: 'x@evil.test', address: 'x@evil.test' });
  assert.deepEqual(parseAddress('PayPal <support@paypal.com> <x@evil.test>'), { name: 'x@evil.test', address: 'x@evil.test' });
  assert.deepEqual(parseAddress('=?utf-8?q?support=40paypal.com?= <x@evil.test>'), { name: 'x@evil.test', address: 'x@evil.test' });
  assert.deepEqual(parseAddress('"Jane D" <Jane@X.example>'), { name: 'Jane D', address: 'jane@x.example' });
  assert.deepEqual(parseAddress('jane@x.example'), { name: 'jane@x.example', address: 'jane@x.example' });
});

test('headers: duplicate headers and their folded lines are ignored, values are capped', () => {
  const h = parseHeaders(`From: Good <good@x.example>\r\nFrom: x\r\n <evil@y.example>\r\nSubject: ${'a'.repeat(10_000)}\r\n\r\n`);
  assert.equal(parseAddress(h.from).address, 'good@x.example');
  assert.ok(h.subject.length <= HEADER_MAX);
});

test('parseUnsubscribe keeps only https: and mailto: links', () => {
  assert.equal(parseUnsubscribe('<javascript:alert(1)>, <http://x.example/u>, <file:///etc/passwd>'), null);
  assert.deepEqual(parseUnsubscribe('<javascript:alert(1)>, <mailto:u@x.example>, <https://x.example/u>'), {
    https: 'https://x.example/u',
    mailto: 'mailto:u@x.example',
    oneClick: false,
  });
});

test('classifySender: a sender is a newsletter only when most of its mail is list mail', () => {
  const msg = (date, unsub) => ({ from: 'Sam <sam@friends.example>', subject: 'hi', date, seen: true, listUnsubscribe: unsub ?? null });
  const one = classifySender([msg('2026-01-03', null), msg('2026-01-02', '<https://list.example/old>'), msg('2026-01-01', null)]);
  assert.equal(one.kind, 'person');
  const most = classifySender([
    msg('2026-01-01', '<https://list.example/old>'),
    msg('2026-01-03', '<https://list.example/new>'),
    msg('2026-01-04', null),
    msg('2026-01-02', '<https://list.example/mid>'),
  ]);
  assert.equal(most.kind, 'newsletter');
  assert.equal(most.unsub.https, 'https://list.example/new', 'the newest message with a link supplies it');
});

test('invalid dates become null and do not break grouping', async () => {
  assert.equal(isoDate('not a date'), null);
  assert.equal(isoDate(Number('x')), null);
  const dir = await tempDir();
  await mkdir(join(dir, 'INBOX'));
  await writeFile(join(dir, 'INBOX', 'a.eml'), 'From: a@x.example\r\nDate: garbage\r\nSubject: one\r\n\r\nbody');
  await writeFile(join(dir, 'INBOX', 'b.eml'), 'From: a@x.example\r\nDate: Thu, 1 Jan 2026 00:00:00 GMT\r\nSubject: two\r\n\r\nbody');
  const messages = await new LocalMailProvider(dir).list();
  assert.deepEqual(messages.map((m) => m.date).sort(), ['2026-01-01T00:00:00.000Z', null]);
  const [g] = groupBySender(messages);
  assert.equal(g.newest, '2026-01-01T00:00:00.000Z');
  await rm(dir, { recursive: true, force: true });
});

test('unsubscribe queue: sender text is escaped and only safe links are written', async () => {
  const dataDir = await tempDir();
  const inbox = createInboxChore({ provider: fakeProvider(), dataDir });
  await inbox.apply(group({ label: '[Win](https://evil.test) <img src=x>', detail: 'a@b.example', unsubscribe: parseUnsubscribe('<javascript:alert(1)>') }), 'unsubscribe');
  await inbox.apply(group({ unsubscribe: parseUnsubscribe('<https://shop.example/u?a=1>') }), 'unsubscribe');
  const lines = (await readFile(join(dataDir, 'unsubscribe-queue.md'), 'utf8')).trim().split('\n');
  assert.equal(lines[0], '- [ ] \\[Win\\](https://evil.test) \\<img src=x\\> (a@b.example) no unsubscribe link: filter it instead');
  assert.equal(lines[1], '- [ ] Shop News (news@shop.example) <https://shop.example/u?a=1>');
  assert.doesNotMatch(lines.join('\n'), /javascript:/);
  await rm(dataDir, { recursive: true, force: true });
});

test('one-click unsubscribe refuses private and loopback hosts', async () => {
  const dataDir = await tempDir();
  const posts = [];
  const fetchImpl = async (url) => {
    posts.push(url);
    return new Response('', { status: 200 });
  };
  const answers = { 'router.example': '192.168.1.1', 'self.example': '127.0.0.1', 'mapped.example': '::ffff:10.0.0.1', 'cgnat.example': '100.64.1.1', 'ula.example': 'fd00::1' };
  const lookups = [];
  const lookup = async (host) => {
    lookups.push(host);
    return [{ address: '93.184.216.34', family: 4 }, ...(answers[host] ? [{ address: answers[host], family: answers[host].includes(':') ? 6 : 4 }] : [])];
  };
  const inbox = createInboxChore({ provider: fakeProvider(), dataDir, oneClickUnsubscribe: true, fetchImpl, lookup });
  const urls = [...Object.keys(answers).map((h) => `https://${h}/u`), 'https://192.168.0.1/u', 'https://[::1]/u', 'https://public.example:8443/u'];
  for (const url of urls) {
    assert.equal(await inbox.unsubscribe(group({ unsubscribe: parseUnsubscribe(`<${url}>`, 'List-Unsubscribe=One-Click') })), 'unsubscribe link queued', url);
  }
  assert.deepEqual(posts, []);
  assert.ok(!lookups.includes('192.168.0.1'), 'IP literals are not looked up');

  assert.equal(await inbox.unsubscribe(group({ unsubscribe: parseUnsubscribe('<https://public.example/u>', 'List-Unsubscribe=One-Click') })), 'one-click unsubscribed');
  assert.deepEqual(posts, ['https://public.example/u']);
  await rm(dataDir, { recursive: true, force: true });
});

test('one-click posts to a public host with no redirects', async () => {
  const dataDir = await tempDir();
  const posts = [];
  const fetchImpl = async (url, init) => {
    posts.push({ url, init });
    return new Response('', { status: 200 });
  };
  const inbox = createInboxChore({ provider: fakeProvider(), dataDir, oneClickUnsubscribe: true, fetchImpl, lookup: async () => [{ address: '2606:2800:220:1::1', family: 6 }] });
  const r = await inbox.apply(group(), 'unsubscribe');
  assert.match(r.summary, /one-click unsubscribed/);
  assert.equal(posts[0].init.method, 'POST');
  assert.equal(posts[0].init.redirect, 'error');
  assert.equal(posts[0].init.body, 'List-Unsubscribe=One-Click');
  await rm(dataDir, { recursive: true, force: true });
});

test('dry run writes no unsubscribe file and moves nothing', async () => {
  const dataDir = join(await tempDir(), 'state');
  const provider = fakeProvider();
  let fetched = false;
  const inbox = createInboxChore({ provider, dataDir, dryRun: true, oneClickUnsubscribe: true, fetchImpl: async () => (fetched = true), lookup: async () => [{ address: '93.184.216.34', family: 4 }] });
  const r = await inbox.apply(group(), 'unsubscribe');
  assert.match(r.summary, /\[dry run\] would unsubscribe 2 from Shop News \(would send a one-click unsubscribe\)/);
  assert.equal(r.undo, null);
  assert.deepEqual(provider.calls, []);
  assert.equal(fetched, false);
  await assert.rejects(readdir(dataDir), { code: 'ENOENT' });
});

test('a move the server cannot undo is journaled without undo', async () => {
  const inbox = createInboxChore({ provider: fakeProvider(async () => null), dataDir: await tempDir() });
  const r = await inbox.apply(group(), 'archive');
  assert.equal(r.undo, null);
  assert.match(r.summary, /archived 2 from Shop News \(this server can't undo it\)/);
});

function fakeAuth(fail) {
  const calls = [];
  return {
    calls,
    async api(url, opts = {}) {
      calls.push({ url, ...opts });
      if (fail(url, opts)) throw Object.assign(new Error('backend error'), { status: 500 });
      return {};
    },
  };
}

test('Gmail trash: a failure part-way reports only the messages that moved', async () => {
  const auth = fakeAuth((url) => url.endsWith('/messages/b/trash'));
  const gmail = new GmailProvider(auth, { concurrency: 1 });
  const inbox = createInboxChore({ provider: gmail, dataDir: await tempDir(), id: 'gmail' });
  const err = await inbox.apply(group({ ids: ['a', 'b', 'c'], count: 3 }), 'trash').then(
    () => assert.fail('should have failed'),
    (e) => e,
  );
  assert.equal(err.message, 'backend error');
  assert.equal(err.count, 1);
  assert.deepEqual(err.partial, {
    affected: 1,
    summary: 'trashed 1 of 3 from Shop News before it failed: backend error',
    impact: { trashed: 1 },
    undo: { provider: 'gmail', moved: { target: 'trash', ids: ['a'] } },
  });
  assert.ok(!auth.calls.some((c) => c.url.endsWith('/messages/c/trash')), 'stops sending after a failure');
  assert.ok(auth.calls.every((c) => c.idempotent === true));
});

test('Gmail archive: a failed batch leaves earlier batches as the partial move', async () => {
  const ids = Array.from({ length: 1500 }, (_, i) => `m${i}`);
  const auth = fakeAuth((url, opts) => opts.body?.ids?.[0] === 'm1000');
  const err = await new GmailProvider(auth).move(ids, 'archive').then(
    () => assert.fail('should have failed'),
    (e) => e,
  );
  assert.equal(err.count, 1000);
  assert.deepEqual(err.moved, { target: 'archive', ids: ids.slice(0, 1000) });
  assert.ok(auth.calls.every((c) => c.idempotent === true));

  const nothing = await new GmailProvider(fakeAuth(() => true)).move(['x'], 'archive').catch((e) => e);
  assert.equal(nothing.count, undefined, 'nothing moved: the original error, untouched');
});

test('local mailbox: partial moves, symlinks skipped, folders outside the root refused', posix, async () => {
  const dir = await tempDir();
  const outside = await tempDir();
  await mkdir(join(dir, 'INBOX'));
  await writeFile(join(dir, 'INBOX', 'a.eml'), 'From: a@x.example\r\n\r\n');
  await writeFile(join(outside, 'secret.eml'), 'From: s@x.example\r\n\r\n');
  await symlink(join(outside, 'secret.eml'), join(dir, 'INBOX', 'link.eml'));
  const provider = new LocalMailProvider(dir);
  assert.deepEqual((await provider.list()).map((m) => m.id), ['a.eml']);

  const err = await provider.move(['a.eml', 'missing.eml'], 'archive').catch((e) => e);
  assert.equal(err.count, 1);
  assert.deepEqual(err.moved.moved.map((m) => m.from), [join(dir, 'INBOX', 'a.eml')]);
  assert.equal(await provider.restore(err.moved), 1);

  await symlink(outside, join(dir, 'Trash'));
  await assert.rejects(provider.move(['a.eml'], 'trash'), /outside/);
  assert.deepEqual(await readdir(join(dir, 'INBOX')), ['a.eml', 'link.eml']);
  await rm(dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

function fakeClient() {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        async create(params) {
          calls.push(params);
          const items = JSON.parse(params.messages[0].content.split('Items:\n')[1]);
          return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ answers: items.map((i) => ({ id: i.id, choice: 'keep' })) }) }] };
        },
      },
    },
  };
}

test('advisor sends only id, label and count, and caches advice across rescans', async () => {
  const chore = { id: 'files', actions: [{ id: 'bin:Documents' }, { id: 'keep' }] };
  const scan = (...names) => names.map((n) => ({ id: `pack:${n}`, label: n, detail: `${n}.pdf, private.pdf`, samples: ['x'], count: 2, kind: 'unknown', suggestion: null }));
  const client = fakeClient();
  const advisor = createAdvisor({ client });

  const first = scan('a', 'b');
  assert.equal(await advisor.advise(chore, first), 2);
  const items = JSON.parse(client.calls[0].messages[0].content.split('Items:\n')[1]);
  assert.deepEqual(items, [
    { id: 'pack:a', label: 'a', count: 2 },
    { id: 'pack:b', label: 'b', count: 2 },
  ]);

  const again = scan('a', 'b');
  assert.equal(await advisor.advise(chore, again), 2);
  assert.equal(client.calls.length, 1, 'a rescan of the same groups is not sent again');
  assert.equal(again[0].suggestion, 'keep');

  await advisor.advise(chore, scan('a', 'c'));
  assert.equal(client.calls.length, 2);
  assert.deepEqual(JSON.parse(client.calls[1].messages[0].content.split('Items:\n')[1]).map((i) => i.id), ['pack:c']);
});
