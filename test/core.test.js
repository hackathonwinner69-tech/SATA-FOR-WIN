import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Arcade } from '../src/arcade.js';
import { Journal } from '../src/core/journal.js';
import { moveAllBack, safeMove } from '../src/core/fsx.js';
import { cleanLine, mdText, sameToken, withinReal } from '../src/core/safety.js';

const posix = { skip: process.platform === 'win32' && 'needs POSIX symlinks and modes' };

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'chorecade-core-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const ok = (group) => ({ affected: group.ids.length, summary: `went ${group.label}`, impact: { gone: group.ids.length }, undo: { ids: group.ids } });

function fakeChore(behave, { target = '/tmp/fake' } = {}) {
  return {
    id: 'fake',
    title: 'Fake',
    chore: 'Test',
    game: 'calm',
    unit: 'things',
    target,
    actions: [{ id: 'go', label: 'Go' }],
    async scan() {
      return { groups: [{ id: 'g1', label: 'G1', ids: ['a', 'b', 'c'] }, { id: 'g2', label: 'G2', ids: ['d'] }], stats: { remaining: 4 } };
    },
    apply: async (group, action) => behave(group, action),
    async undo(undo) {
      return { restored: undo.ids.length, summary: `put back ${undo.ids.length}` };
    },
  };
}

async function arcadeWith(t, chore) {
  const dir = await tempDir(t);
  return new Arcade({ chores: [chore], journalFile: join(dir, 'journal.jsonl'), mode: 'demo' });
}

test('journal: an undo survives a restart and a line torn by a crash is skipped', posix, async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, 'state', 'journal.jsonl');
  const journal = new Journal(file);
  const one = await journal.record({ chore: 'files', target: '/x', action: 'trash', label: 'one', affected: 1, undo: { k: 1 } });
  await journal.record({ chore: 'files', target: '/x', action: 'trash', label: 'two', affected: 1, undo: { k: 2 } });
  await journal.markUndone(one.id);
  await appendFile(file, '{"id":"half-writ');

  const again = new Journal(file);
  await again.load();
  assert.deepEqual(again.entries.map((e) => [e.label, e.undone]), [['one', true], ['two', false]]);
  assert.equal('undo' in again.recent()[0], false);
  assert.equal(again.recent()[0].undoable, true);

  await again.record({ chore: 'files', action: 'keep', label: 'three', affected: 0 });
  const reread = new Journal(file);
  await reread.load();
  assert.deepEqual(reread.entries.map((e) => e.label), ['one', 'two', 'three']);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(join(dir, 'state'))).mode & 0o777, 0o700);
});

test('journal: writes from many chores at once never interleave', async (t) => {
  const file = join(await tempDir(t), 'journal.jsonl');
  const journal = new Journal(file);
  await Promise.all(
    Array.from({ length: 25 }, (_, i) => journal.record({ chore: `c${i % 3}`, action: 'archive', label: `move ${i}`, affected: i, undo: { blob: 'x'.repeat(5000) } })),
  );
  const lines = (await readFile(file, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 25);
  for (const line of lines) assert.ok(JSON.parse(line).id);
});

test('safeMove never replaces a file that is already there', async (t) => {
  const dir = await tempDir(t);
  await mkdir(join(dir, 'bin'));
  await writeFile(join(dir, 'report.pdf'), 'new');
  await writeFile(join(dir, 'bin', 'report.pdf'), 'old');
  const to = await safeMove(join(dir, 'report.pdf'), join(dir, 'bin'));
  assert.equal(to, join(dir, 'bin', 'report (2).pdf'));
  assert.equal(await readFile(join(dir, 'bin', 'report.pdf'), 'utf8'), 'old');
  assert.equal(await readFile(to, 'utf8'), 'new');
});

test('safeMove refuses to move a symlink', posix, async (t) => {
  const dir = await tempDir(t);
  await writeFile(join(dir, 'real.txt'), 'x');
  await symlink(join(dir, 'real.txt'), join(dir, 'link.txt'));
  await assert.rejects(safeMove(join(dir, 'link.txt'), join(dir, 'bin')), /symlink/);
});

test('moveAllBack restores nothing while one original spot is taken again', async (t) => {
  const dir = await tempDir(t);
  const moved = [];
  for (const name of ['a.txt', 'b.txt']) {
    await writeFile(join(dir, name), name);
    moved.push({ from: join(dir, name), to: await safeMove(join(dir, name), join(dir, 'bin')) });
  }
  await writeFile(join(dir, 'b.txt'), 'someone else');
  await assert.rejects(moveAllBack(moved), /taken again; nothing was restored/);
  assert.equal(await readFile(join(dir, 'bin', 'a.txt'), 'utf8'), 'a.txt');

  await rm(join(dir, 'b.txt'));
  assert.equal(await moveAllBack(moved), 2);
  assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'a.txt');
  assert.equal(await readFile(join(dir, 'b.txt'), 'utf8'), 'b.txt');
});

test('withinReal refuses a folder that links outside the root', posix, async (t) => {
  const dir = await tempDir(t);
  const root = join(dir, 'root');
  await mkdir(root);
  await mkdir(join(dir, 'outside'));
  await symlink(join(dir, 'outside'), join(root, 'Documents'));
  await assert.rejects(withinReal(root, 'Documents/x.pdf'), /outside/);
  await assert.rejects(withinReal(root, '../outside/x.pdf'), /outside/);
  assert.equal(await withinReal(root, 'Images/new/x.png'), join(root, 'Images', 'new', 'x.png'));
});

test('untrusted text becomes one line that Markdown cannot turn into a link', () => {
  assert.equal(cleanLine('Evil\r\n- [x] injected\u0007 line'), 'Evil - [x] injected line');
  assert.equal(cleanLine('x'.repeat(10), 5), 'xxxx…');
  assert.equal(mdText('[click](https://evil.test) <img src=x>'), '\\[click\\](https://evil.test) \\<img src=x\\>');
});

test('session tokens must match exactly', () => {
  assert.equal(sameToken('abc', 'abc'), true);
  assert.equal(sameToken('abd', 'abc'), false);
  assert.equal(sameToken('ab', 'abc'), false);
  assert.equal(sameToken(['abc'], 'abc'), false);
  assert.equal(sameToken(undefined, 'abc'), false);
});

test('a move that failed without changing anything can be played again', async (t) => {
  let fail = true;
  const arcade = await arcadeWith(t, fakeChore((group) => {
    if (fail) throw new Error('disk on fire');
    return ok(group);
  }));
  await arcade.scan('fake');
  const job = arcade.act('fake', 'g1', 'go');
  await arcade.queue.drain();
  assert.equal(arcade.queue.jobs.get(job.id).status, 'failed');
  assert.equal(arcade.journal.entries.length, 0);

  fail = false;
  const retry = arcade.act('fake', 'g1', 'go');
  await arcade.queue.drain();
  assert.equal(arcade.queue.jobs.get(retry.id).status, 'done');
  assert.equal(arcade.journal.entries.length, 1);
});

test('the part of a move that happened before it failed is journaled and can be undone', async (t) => {
  const arcade = await arcadeWith(t, fakeChore((group) => {
    throw Object.assign(new Error('quota exceeded'), {
      partial: { affected: 2, summary: `went 2 of 3 from ${group.label} before it failed`, impact: { gone: 2 }, undo: { ids: group.ids.slice(0, 2) } },
    });
  }));
  await arcade.scan('fake');
  const job = arcade.act('fake', 'g1', 'go');
  await arcade.queue.drain();
  assert.equal(arcade.queue.jobs.get(job.id).status, 'failed');
  const [entry] = arcade.journal.recent();
  assert.equal(entry.affected, 2);
  assert.equal(entry.undoable, true);
  assert.deepEqual(arcade.impact.fake, { gone: 2 });
  assert.throws(() => arcade.act('fake', 'g1', 'go'), /already handled/);

  await arcade.undo(entry.id);
  await arcade.queue.drain();
  assert.equal(arcade.journal.get(entry.id).undone, true);
  assert.deepEqual(arcade.impact.fake, { gone: 0 });
});

test('an undo is refused while it is on its way and once it is done', async (t) => {
  const arcade = await arcadeWith(t, fakeChore(ok));
  await arcade.scan('fake');
  arcade.act('fake', 'g1', 'go');
  await arcade.queue.drain();
  const [entry] = arcade.journal.recent();
  await arcade.undo(entry.id);
  await assert.rejects(arcade.undo(entry.id), /already on its way/);
  await arcade.queue.drain();
  await assert.rejects(arcade.undo(entry.id), /already undone/);
});

test('an undo only runs against the folder or mailbox the change was made in', async (t) => {
  const journalFile = join(await tempDir(t), 'journal.jsonl');
  const first = new Arcade({ chores: [fakeChore(ok, { target: '/home/me/Downloads' })], journalFile, mode: 'live' });
  await first.scan('fake');
  first.act('fake', 'g1', 'go');
  await first.queue.drain();
  const [entry] = first.journal.recent();

  const second = new Arcade({ chores: [fakeChore(ok, { target: '/home/me/Desktop' })], journalFile, mode: 'live' });
  await assert.rejects(second.undo(entry.id), /made in \/home\/me\/Downloads/);
});

test('a scan waits for queued moves and skips groups queued behind it', async (t) => {
  const order = [];
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const chore = fakeChore(async (group) => {
    await gate;
    order.push(`apply ${group.id}`);
    return ok(group);
  });
  const scan = chore.scan;
  chore.scan = async () => {
    order.push('scan');
    return scan();
  };
  const arcade = await arcadeWith(t, chore);
  await arcade.scan('fake');
  arcade.act('fake', 'g1', 'go');
  const afterMove = arcade.scan('fake');
  release();
  await afterMove;
  assert.deepEqual(order, ['scan', 'apply g1', 'scan']);

  const rescan = arcade.scan('fake');
  arcade.act('fake', 'g2', 'go');
  assert.deepEqual((await rescan).groups.map((g) => g.id), ['g1']);
  await arcade.queue.drain();
});
