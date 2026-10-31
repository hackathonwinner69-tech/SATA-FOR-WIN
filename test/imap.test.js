import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { ImapMailProvider, uidRanges } from '../src/chores/inbox/imap-provider.js';

const noConnection = () => Object.assign(new Error('Connection not available'), { code: 'NoConnection' });

/** "1:3,7" -> [1, 2, 3, 7]; "1:*" -> every UID in the mailbox. */
function parseRange(range, all) {
  if (range === '1:*') return all;
  return String(range)
    .split(',')
    .flatMap((part) => {
      const [a, b = a] = part.split(':').map(Number);
      return Array.from({ length: b - a + 1 }, (_, i) => a + i);
    })
    .filter((uid) => all.includes(uid));
}

/**
 * An in-memory IMAP server and an ImapFlow look-alike talking to it. Hooks
 * (`onFetch`, `onMove`) let a test drop the connection at a chosen moment.
 */
function fakeServer({ capabilities = ['MOVE', 'UIDPLUS'] } = {}) {
  const server = {
    connects: 0,
    logouts: 0,
    folderLists: 0,
    fetches: [],
    clients: [],
    lockHeld: false,
    boxes: { INBOX: { uidValidity: 1n, nextUid: 1, messages: new Map() }, '[Gmail]/All Mail': { uidValidity: 7n, nextUid: 100, messages: new Map() }, '[Gmail]/Trash': { uidValidity: 9n, nextUid: 500, messages: new Map() } },
    add(path, { from = 'news@shop.example', subject = 'hi', flags = [] } = {}) {
      const box = server.boxes[path];
      const uid = box.nextUid++;
      box.messages.set(uid, { from, subject, flags: new Set(flags), headers: 'List-Unsubscribe: <https://shop.example/u>\r\n\r\n' });
      return uid;
    },
    transfer(fromPath, uids, toPath) {
      const from = server.boxes[fromPath];
      const to = server.boxes[toPath];
      const uidMap = new Map();
      for (const uid of uids) {
        const msg = from.messages.get(uid);
        if (!msg) continue;
        from.messages.delete(uid);
        const fresh = to.nextUid++;
        to.messages.set(fresh, msg);
        uidMap.set(uid, fresh);
      }
      return uidMap;
    },
  };

  class FakeImapFlow {
    constructor(options) {
      this.options = options;
      this.listeners = {};
      this.usable = false;
      this.mailbox = false;
      this.capabilities = new Map(capabilities.map((c) => [c, true]));
      server.clients.push(this);
    }
    on(event, fn) {
      (this.listeners[event] ??= []).push(fn);
      return this;
    }
    async connect() {
      server.connects++;
      this.usable = true;
    }
    async logout() {
      if (!this.usable) throw noConnection();
      server.logouts++;
      this.close();
    }
    close() {
      if (!this.usable) return;
      this.usable = false;
      this.mailbox = false;
      for (const fn of this.listeners.close ?? []) fn();
    }
    async list() {
      if (!this.usable) throw noConnection();
      server.folderLists++;
      return [{ path: 'INBOX' }, { path: '[Gmail]/All Mail', specialUse: '\\All' }, { path: '[Gmail]/Trash', specialUse: '\\Trash' }];
    }
    async getMailboxLock(path) {
      if (!this.usable) throw noConnection();
      // Operations on the provider are queued, so two locks can never be held at once.
      assert.equal(server.lockHeld, false, 'mailbox locks interleaved');
      server.lockHeld = true;
      await sleep(1);
      this.mailbox = { path, uidValidity: server.boxes[path].uidValidity };
      let released = false;
      return {
        path,
        release: () => {
          if (!released) server.lockHeld = false;
          released = true;
        },
      };
    }
    async *fetch(range, query, options = {}) {
      if (!this.mailbox) return;
      const box = server.boxes[this.mailbox.path];
      server.fetches.push({ range, fields: Object.keys(query).filter((k) => query[k]).sort(), uid: Boolean(options.uid) });
      for (const uid of parseRange(range, [...box.messages.keys()])) {
        await server.onFetch?.(this, uid);
        if (!this.usable) throw noConnection();
        const m = box.messages.get(uid);
        yield {
          uid,
          flags: query.flags ? new Set(m.flags) : undefined,
          envelope: query.envelope ? { from: [{ name: 'Shop', address: m.from }], subject: m.subject, date: new Date('2026-01-01T00:00:00Z') } : undefined,
          headers: query.headers ? Buffer.from(m.headers) : undefined,
        };
      }
    }
    async messageMove(range, destination) {
      if (!this.mailbox) return undefined;
      const hook = server.onMove;
      server.onMove = null;
      if (hook && (await hook(this, range, destination)) === 'dropped') return false;
      const source = this.mailbox.path;
      const uidMap = server.transfer(source, parseRange(range, [...server.boxes[source].messages.keys()]), destination);
      return capabilities.includes('UIDPLUS') ? { path: source, destination, uidMap } : { path: source, destination };
    }
  }
  return { server, FakeImapFlow };
}

function provider(FakeImapFlow, opts = {}) {
  const p = new ImapMailProvider({ host: 'imap.example', user: 'me@example.com', pass: 'x', ImapFlow: FakeImapFlow, ...opts });
  return p;
}

test('uidRanges compresses runs of UIDs', () => {
  assert.equal(uidRanges([9, 1, 2, 3, 7, 10]), '1:3,7,9:10');
  assert.equal(uidRanges([5]), '5');
});

test('IMAP: one login serves many calls, and calls never interleave their mailbox locks', async () => {
  const { server, FakeImapFlow } = fakeServer();
  const uids = [server.add('INBOX'), server.add('INBOX'), server.add('INBOX', { from: 'a@b.example' })];
  const imap = provider(FakeImapFlow);
  const messages = await imap.list();
  assert.deepEqual(messages.map((m) => m.id), uids.map(String));
  assert.equal(messages[0].listUnsubscribe, '<https://shop.example/u>');
  assert.deepEqual(messages[0].sender, { name: 'Shop', address: 'news@shop.example' });

  const [, undo] = await Promise.all([imap.list(), imap.move([String(uids[0])], 'archive'), imap.list()]);
  assert.deepEqual(undo, { destination: '[Gmail]/All Mail', newUids: [100] });
  assert.equal(await imap.restore(undo), 1);
  assert.equal(await imap.move([String(uids[1])], 'trash').then((r) => r.destination), '[Gmail]/Trash');
  assert.equal(server.connects, 1);
  assert.equal(server.folderLists, 1, 'special folders are looked up once');
  await imap.close();
  assert.equal(server.logouts, 1);
});

test('IMAP: a connection that dropped between calls is replaced before the next one', async () => {
  const { server, FakeImapFlow } = fakeServer();
  server.add('INBOX');
  const imap = provider(FakeImapFlow);
  await imap.list();
  server.clients[0].close();
  assert.equal((await imap.list()).length, 1);
  assert.equal(server.connects, 2);
  await imap.close();
});

test('IMAP: a scan that loses its connection reconnects and runs again', async () => {
  const { server, FakeImapFlow } = fakeServer();
  for (let i = 0; i < 5; i++) server.add('INBOX');
  server.onFetch = (client, uid) => {
    if (uid !== 3) return;
    server.onFetch = null;
    client.close();
  };
  const imap = provider(FakeImapFlow);
  assert.equal((await imap.list()).length, 5);
  assert.equal(server.connects, 2);
  await imap.close();
});

test('IMAP: a move that dropped before reaching the server is repeated once', async () => {
  const { server, FakeImapFlow } = fakeServer();
  const uid = server.add('INBOX');
  const imap = provider(FakeImapFlow);
  await imap.list();
  server.onMove = (client) => {
    client.close();
    return 'dropped';
  };
  const undo = await imap.move([String(uid)], 'archive');
  assert.deepEqual(undo, { destination: '[Gmail]/All Mail', newUids: [100] });
  assert.equal(server.boxes['[Gmail]/All Mail'].messages.size, 1);
  assert.equal(server.connects, 2);
  await imap.close();
});

test('IMAP: a move that may have reached the server is not repeated', async () => {
  const { server, FakeImapFlow } = fakeServer();
  const uids = [server.add('INBOX'), server.add('INBOX')];
  const imap = provider(FakeImapFlow);
  await imap.list();
  // The server moves the mail, then the connection dies before the reply arrives.
  server.onMove = (client, range, destination) => {
    server.transfer('INBOX', [uids[0]], destination);
    client.close();
    return 'dropped';
  };
  await assert.rejects(imap.move(uids.map(String), 'archive'), /dropped during the move .* not repeated: rescan/);
  assert.equal(server.boxes['[Gmail]/All Mail'].messages.size, 1, 'nothing moved twice');
  assert.equal(server.boxes.INBOX.messages.size, 1);
  await imap.close();
});

test('IMAP: without MOVE a dropped move is never repeated', async () => {
  const { server, FakeImapFlow } = fakeServer({ capabilities: ['UIDPLUS'] });
  const uid = server.add('INBOX');
  const imap = provider(FakeImapFlow);
  server.onMove = (client) => {
    client.close();
    return 'dropped';
  };
  await assert.rejects(imap.move([String(uid)], 'trash'), /not repeated/);
  assert.equal(server.boxes['[Gmail]/Trash'].messages.size, 0);
  await imap.close();
});

test('IMAP: an undo that dropped before reaching the server is repeated once', async () => {
  const { server, FakeImapFlow } = fakeServer();
  const uid = server.add('INBOX');
  const imap = provider(FakeImapFlow);
  const undo = await imap.move([String(uid)], 'archive');
  server.onMove = (client) => {
    client.close();
    return 'dropped';
  };
  assert.equal(await imap.restore(undo), 1);
  assert.equal(server.boxes.INBOX.messages.size, 1);
  assert.equal(server.boxes['[Gmail]/All Mail'].messages.size, 0);
  await imap.close();
});

test('IMAP: server errors that are not about the connection are not retried', async () => {
  const { server, FakeImapFlow } = fakeServer();
  const imap = provider(FakeImapFlow);
  server.onFetch = () => {
    throw Object.assign(new Error('Mailbox is locked'), { code: 'NO' });
  };
  server.add('INBOX');
  await assert.rejects(imap.list(), /Mailbox is locked/);
  assert.equal(server.connects, 1);
  server.onFetch = null;
  assert.equal((await imap.list()).length, 1, 'the queue keeps going after a failure');
  await imap.close();
});

test('IMAP: an idle connection is closed with a timer that does not keep the process alive', async () => {
  const { server, FakeImapFlow } = fakeServer();
  server.add('INBOX');
  const imap = provider(FakeImapFlow, { idleMs: 20 });
  await imap.list();
  assert.equal(imap.idleTimer.hasRef(), false);
  await sleep(60);
  assert.equal(server.logouts, 1);
  assert.equal(imap.client, null);
  assert.equal((await imap.list()).length, 1);
  assert.equal(server.connects, 2);
  await imap.close();
  assert.equal(server.logouts, 2);
});

test('IMAP: a rescan fetches only flags, plus envelopes for new UIDs', async () => {
  const { server, FakeImapFlow } = fakeServer();
  const [a, b, c] = [server.add('INBOX', { subject: 'one' }), server.add('INBOX', { subject: 'two' }), server.add('INBOX', { subject: 'three' })];
  const imap = provider(FakeImapFlow);
  await imap.list();
  assert.deepEqual(server.fetches, [{ range: '1:*', fields: ['envelope', 'flags', 'headers', 'uid'], uid: false }]);

  server.fetches.length = 0;
  server.boxes.INBOX.messages.get(a).flags.add('\\Seen');
  server.boxes.INBOX.messages.delete(b);
  const d = server.add('INBOX', { subject: 'four' });
  const e = server.add('INBOX', { subject: 'five' });
  const messages = await imap.list();
  assert.deepEqual(server.fetches, [
    { range: '1:*', fields: ['flags', 'uid'], uid: false },
    { range: `${d}:${e}`, fields: ['envelope', 'flags', 'headers', 'uid'], uid: true },
  ]);
  assert.deepEqual(messages.map((m) => [m.id, m.subject, m.seen]), [
    [String(a), 'one', true],
    [String(c), 'three', false],
    [String(d), 'four', false],
    [String(e), 'five', false],
  ]);
  assert.deepEqual([...imap.known.records.keys()], [a, c, d, e], 'expunged messages are forgotten');

  server.fetches.length = 0;
  await imap.list();
  assert.deepEqual(server.fetches.map((f) => f.fields), [['flags', 'uid']], 'nothing new, so no envelopes');
  await imap.close();
});

test('IMAP: a new UIDVALIDITY throws the cache away and refuses moves from the old scan', async () => {
  const { server, FakeImapFlow } = fakeServer();
  const uid = server.add('INBOX', { subject: 'old' });
  const imap = provider(FakeImapFlow);
  await imap.list();
  server.boxes.INBOX.uidValidity = 2n;
  server.boxes.INBOX.messages.get(uid).subject = 'renumbered';
  await assert.rejects(imap.move([String(uid)], 'trash'), /renumbered the inbox .* rescan/);
  assert.equal(server.boxes['[Gmail]/Trash'].messages.size, 0);

  server.fetches.length = 0;
  const [msg] = await imap.list();
  assert.equal(msg.subject, 'renumbered');
  assert.deepEqual(server.fetches.map((f) => f.fields), [['envelope', 'flags', 'headers', 'uid']]);
  assert.ok(await imap.move([String(uid)], 'trash'));
  await imap.close();
});
