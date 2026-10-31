import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedDemo } from '../scripts/seed-demo.js';
import { createInboxChore } from '../src/chores/inbox/index.js';
import { LocalMailProvider } from '../src/chores/inbox/local-provider.js';
import { createFilesChore, TRASH_DIR, namePattern } from '../src/chores/files/index.js';
import { createExpensesChore, normalizeMerchant } from '../src/chores/expenses/index.js';
import { createLintChore } from '../src/chores/lint/index.js';
import { parseCsv, toCsv } from '../src/chores/expenses/csv.js';
import { parseAddress, parseHeaders, parseUnsubscribe } from '../src/chores/inbox/headers.js';

let root;
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'chorecade-'));
  await seedDemo(root, { emails: 400 });
});
after(() => rm(root, { recursive: true, force: true }));

test('headers: folded lines, encoded words, addresses, unsubscribe', () => {
  const h = parseHeaders('Subject: =?UTF-8?B?SGVsbG8g8J+Ri4==?=\r\nFrom: "Jane D" <Jane@X.example>\r\nList-Unsubscribe: <mailto:u@x>,\r\n <https://x.example/u>\r\n\r\nbody');
  assert.equal(h.subject, 'Hello 👋');
  assert.deepEqual(parseAddress(h.from), { name: 'Jane D', address: 'jane@x.example' });
  assert.deepEqual(parseUnsubscribe(h['list-unsubscribe'], 'List-Unsubscribe=One-Click'), {
    https: 'https://x.example/u',
    mailto: 'mailto:u@x',
    oneClick: true,
  });
});

test('inbox: one shot archives a whole sender, undo puts it back', async () => {
  const inbox = createInboxChore({ provider: new LocalMailProvider(join(root, 'mail')), dataDir: join(root, 'state') });
  const { groups, stats } = await inbox.scan();
  assert.equal(stats.messages, 400);
  assert.ok(stats.senders < 150, 'mail collapses into far fewer senders');
  const people = groups.filter((g) => g.kind === 'person');
  assert.ok(people.length > 0 && people.every((g) => g.suggestion === 'keep' && g.risk === 'high'));

  const top = groups[0];
  const result = await inbox.apply(top, 'unsubscribe');
  assert.equal(result.affected, top.count);
  assert.equal((await readdir(join(root, 'mail', 'Archive'))).length, top.count);
  const queue = await readFile(join(root, 'state', 'unsubscribe-queue.md'), 'utf8');
  assert.match(queue, new RegExp(top.detail.replace(/\./g, '\\.')));

  await inbox.undo(result.undo);
  assert.equal((await readdir(join(root, 'mail', 'Archive'))).length, 0);
  assert.equal((await readdir(join(root, 'mail', 'INBOX'))).length, 400);
});

test('inbox: dry run changes nothing', async () => {
  const inbox = createInboxChore({ provider: new LocalMailProvider(join(root, 'mail')), dataDir: join(root, 'state'), dryRun: true });
  const { groups } = await inbox.scan();
  const r = await inbox.apply(groups[0], 'trash');
  assert.match(r.summary, /dry run/);
  assert.equal((await readdir(join(root, 'mail', 'Trash'))).length, 0);
});

test('files: duplicates found, packs moved into bins, undo restores', async () => {
  const dir = join(root, 'Downloads');
  const before = (await readdir(dir)).sort();
  const files = createFilesChore({ root: dir });
  const { groups, stats } = await files.scan();
  assert.equal(stats.duplicates, 7);
  const dupes = groups.filter((g) => g.kind === 'duplicate');
  assert.ok(dupes.every((g) => g.suggestion === 'trash'));

  const shots = groups.find((g) => g.label.startsWith('Screenshot'));
  assert.equal(shots.suggestion, 'move:Images');
  const r1 = await files.apply(shots, 'move:Images');
  const r2 = await files.apply(dupes[0], 'trash');
  assert.equal((await readdir(join(dir, 'Images'))).length, shots.count);
  assert.equal((await readdir(join(dir, TRASH_DIR))).length, dupes[0].count);

  await files.undo(r2.undo);
  await files.undo(r1.undo);
  const after = (await readdir(dir)).filter((n) => !['Images', TRASH_DIR].includes(n)).sort();
  assert.deepEqual(after, before);
});

test('files: refuses to touch paths outside the folder', async () => {
  const files = createFilesChore({ root: join(root, 'Downloads') });
  await assert.rejects(files.apply({ files: ['../expenses/bank-export.csv'], count: 1 }, 'move:Documents'), /outside/);
});

test('files: name patterns group look-alikes', () => {
  assert.equal(namePattern('Screenshot 2026-01-02 at 10.11.12.png'), namePattern('Screenshot 2025-12-31 at 09.08.07 (1).png'));
  assert.equal(namePattern('IMG_4021.jpg'), namePattern('IMG_4.jpg'));
});

test('expenses: merchants grouped, outputs written, undo un-files', async () => {
  const csvPath = join(root, 'expenses', 'bank-export.csv');
  const outDir = join(root, 'expenses');
  const chore = createExpensesChore({ csvPath, outDir });
  const { groups, stats } = await chore.scan();
  assert.ok(stats.transactions > 250);
  assert.deepEqual(stats.filed, {});
  const netflix = groups.find((g) => g.label.startsWith('NETFLIX'));
  assert.equal(netflix.suggestion, 'cat:Subscriptions');
  assert.ok(netflix.flags.includes('recurring'));
  const bestBuy = groups.find((g) => g.label === 'BEST BUY');
  assert.ok(bestBuy.flags.some((f) => /duplicate/.test(f)));

  const r = await chore.apply(netflix, 'cat:Subscriptions');
  const out = parseCsv(await readFile(chore.outputs.csv, 'utf8'));
  const cat = out[0].indexOf('Category');
  assert.equal(out.filter((row) => row[cat] === 'Subscriptions').length, netflix.count);
  assert.match(await readFile(chore.outputs.report, 'utf8'), /Subscriptions \(-\$15\.49 a month/);
  assert.equal(JSON.parse(await readFile(chore.outputs.rules, 'utf8'))[netflix.label], 'Subscriptions');

  // Filed merchants drop out of the next scan, and their money counts as filed.
  const filed = await chore.scan();
  assert.ok(!filed.groups.some((g) => g.id === netflix.id));
  assert.deepEqual(filed.stats.filed, { Subscriptions: netflix.total });
  await chore.undo(r.undo);
  const undone = await chore.scan();
  assert.ok(undone.groups.some((g) => g.id === netflix.id));
  assert.deepEqual(undone.stats.filed, {});
});

test('expenses: merchant names normalise across card noise', () => {
  assert.equal(normalizeMerchant('SQ *BLUE BOTTLE COFFEE #3'), 'BLUE BOTTLE COFFEE');
  assert.equal(normalizeMerchant('WHOLE FOODS MKT #10201'), 'WHOLE FOODS MKT');
  assert.deepEqual(parseCsv(toCsv([['a,b', 'say "hi"', 'x\ny']])), [['a,b', 'say "hi"', 'x\ny']]);
});

test('lint: fixing one rule touches only that rule, undo restores the files', async () => {
  const dir = join(root, 'buggy-app');
  const chore = createLintChore({ root: dir });
  const { groups, stats } = await chore.scan();
  assert.ok(stats.problems > 20);
  const noVar = groups.find((g) => g.rule === 'no-var');
  assert.ok(noVar.fixable > 0);
  const original = await readFile(join(dir, 'src', 'legacy.js'), 'utf8');

  const r = await chore.apply(noVar, 'fix');
  const after = await chore.scan();
  assert.ok(!after.groups.some((g) => g.rule === 'no-var'), 'no-var is gone');
  assert.ok(after.groups.some((g) => g.rule === 'eqeqeq'), 'other rules untouched');

  await chore.undo(r.undo);
  assert.equal(await readFile(join(dir, 'src', 'legacy.js'), 'utf8'), original);
});

test('lint: silencing adds a marked comment; undo refuses after a later edit', async () => {
  const dir = join(root, 'buggy-app');
  const chore = createLintChore({ root: dir });
  const { groups } = await chore.scan();
  const undef = groups.find((g) => g.rule === 'no-undef');
  const r = await chore.apply(undef, 'disable');
  const text = await readFile(join(dir, 'src', 'user.js'), 'utf8');
  assert.match(text, /eslint-disable-next-line no-undef -- TODO\(chorecade\)/);
  assert.ok(!(await chore.scan()).groups.some((g) => g.rule === 'no-undef'));

  await writeFile(join(dir, 'src', 'user.js'), text + '\n// edited by hand\n');
  await assert.rejects(chore.undo(r.undo), /changed since/);
  assert.match(await readFile(join(dir, 'src', 'user.js'), 'utf8'), /edited by hand/);
});

test('lint: quest log entries are undoable', async () => {
  const dir = join(root, 'lint-log');
  await mkdir(join(dir), { recursive: true });
  await writeFile(join(dir, 'a.js'), 'export const a = () => b;\n');
  const chore = createLintChore({ root: dir });
  const { groups } = await chore.scan();
  const r = await chore.apply(groups[0], 'log');
  assert.match(await readFile(join(dir, 'LINT_QUESTLOG.md'), 'utf8'), /no-undef/);
  await chore.undo(r.undo);
  await assert.rejects(readFile(join(dir, 'LINT_QUESTLOG.md')));
});
