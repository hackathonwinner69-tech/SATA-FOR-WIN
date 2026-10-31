import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFilesChore, groupFiles, TRASH_DIR } from '../src/chores/files/index.js';
import { DriveStore } from '../src/google/drive.js';
import { reply, signedIn } from './google-fake.js';
import { createLintChore, QUEST_LOG } from '../src/chores/lint/index.js';
import { createExpensesChore, readTransactions } from '../src/chores/expenses/index.js';
import { parseCsv, toCsv } from '../src/chores/expenses/csv.js';

// Windows needs extra rights for symlinks; the guards are the same code on every OS.
const posix = { skip: process.platform === 'win32' && 'needs POSIX symlinks' };

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'chorecade-files-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A signed-in fake Drive (see google-fake.js); changing a file in `failing` is refused with HTTP 403. */
async function fakeDrive(failing = new Set()) {
  const { auth, google } = await signedIn([
    ['GET', /drive\/v3\/files\?/, { files: [] }],
    ['POST', /drive\/v3\/files\?/, { id: 'bin-new' }],
    ['PATCH', /drive\/v3\/files\/\w+\?/, (url) => (failing.has(/files\/(\w+)\?/.exec(url)[1]) ? reply(403, { error: { code: 403, message: 'backend error' } }) : { id: 'x' })],
  ]);
  return { auth, google, calls: google.inner };
}
const patched = (calls) => calls.filter((c) => c.method === 'PATCH').map((c) => [/files\/(\w+)\?/.exec(c.url)[1], c.body]).sort();

test('files: a bin or trash folder that is a symlink is refused', posix, async (t) => {
  const dir = await tempDir(t);
  const root = join(dir, 'Downloads');
  const elsewhere = join(dir, 'elsewhere');
  await mkdir(root);
  await mkdir(elsewhere);
  await mkdir(join(root, 'Images'));
  await writeFile(join(root, 'a.pdf'), 'pdf');
  await symlink(elsewhere, join(root, 'Documents'));
  await symlink(join(root, 'Images'), join(root, TRASH_DIR));
  const chore = createFilesChore({ root });

  await assert.rejects(chore.apply({ files: ['a.pdf'], count: 1 }, 'move:Documents'), /outside|symlink/);
  await assert.rejects(chore.apply({ files: ['a.pdf'], count: 1 }, 'trash'), /symlink/);
  assert.deepEqual(await readdir(elsewhere), []);
  assert.deepEqual(await readdir(join(root, 'Images')), []);
  assert.ok((await readdir(root)).includes('a.pdf'));
});

test('files: restore refuses a path under a symlinked folder', posix, async (t) => {
  const dir = await tempDir(t);
  const root = join(dir, 'Downloads');
  await mkdir(root);
  await writeFile(join(root, 'a.pdf'), 'pdf');
  const chore = createFilesChore({ root });
  const r = await chore.apply({ files: ['a.pdf'], count: 1 }, 'move:Documents');
  await rm(join(root, 'Documents'), { recursive: true });
  await mkdir(join(dir, 'elsewhere'));
  await writeFile(join(dir, 'elsewhere', 'a.pdf'), 'not ours');
  await symlink(join(dir, 'elsewhere'), join(root, 'Documents'));
  await assert.rejects(chore.undo(r.undo), /outside|symlink/);
  assert.equal(await readFile(join(dir, 'elsewhere', 'a.pdf'), 'utf8'), 'not ours');
});

test('files: empty files are never duplicates', async (t) => {
  const EMPTY_MD5 = 'd41d8cd98f00b204e9800998ecf8427e';
  const { groups, duplicates } = groupFiles([
    { id: '1', name: 'a.txt', size: 0, mtime: 1, hash: EMPTY_MD5 },
    { id: '2', name: 'b.txt', size: 0, mtime: 2, hash: EMPTY_MD5 },
    { id: '3', name: 'c.log', size: 0, mtime: 3, hash: EMPTY_MD5 },
  ]);
  assert.equal(duplicates, 0);
  assert.ok(!groups.some((g) => g.kind === 'duplicate'));

  const root = await tempDir(t);
  await writeFile(join(root, 'empty1.txt'), '');
  await writeFile(join(root, 'empty2.txt'), '');
  const { stats } = await createFilesChore({ root }).scan();
  assert.equal(stats.duplicates, 0);
});

test('files: a local move that fails partway reports only the files that moved, and they can be undone', async (t) => {
  const root = await tempDir(t);
  for (const n of ['a.txt', 'b.txt', 'd.txt']) await writeFile(join(root, n), n);
  const chore = createFilesChore({ root });
  const err = await chore.apply({ files: ['a.txt', 'b.txt', 'missing.txt', 'd.txt'], count: 4, bytes: 9 }, 'move:Documents').catch((e) => e);
  assert.ok(err instanceof Error);
  assert.match(err.message, /ENOENT/);
  assert.equal(err.partial.affected, 2);
  assert.match(err.partial.summary, /^moved 2 of 4 files to Documents\/ before it failed: /);
  assert.deepEqual(err.partial.impact, { moved: 2 });
  assert.deepEqual(err.partial.undo.moved.map((m) => m.from), [join(root, 'a.txt'), join(root, 'b.txt')]);
  assert.deepEqual((await readdir(join(root, 'Documents'))).sort(), ['a.txt', 'b.txt']);
  assert.ok((await readdir(root)).includes('d.txt'), 'nothing after the failure moved');

  await chore.undo(err.partial.undo);
  assert.deepEqual(await readdir(join(root, 'Documents')), []);
  assert.deepEqual((await readdir(root)).filter((n) => n.endsWith('.txt')).sort(), ['a.txt', 'b.txt', 'd.txt']);
});

test('files: a move where nothing moved has no partial, so it can be retried', async (t) => {
  const root = await tempDir(t);
  const err = await createFilesChore({ root }).apply({ files: ['missing.txt'], count: 1 }, 'trash').catch((e) => e);
  assert.match(err.message, /ENOENT/);
  assert.equal(err.partial, undefined);
});

test('Drive: a move that fails partway reports the moved ids; the PATCHes go out in one batch', async () => {
  const google = await fakeDrive(new Set(['3']));
  const drive = new DriveStore(google.auth);
  const chore = createFilesChore({ store: drive, remote: true });

  const err = await chore.apply({ files: ['1', '2', '3', '4'], count: 4 }, 'trash').catch((e) => e);
  assert.equal(err.message, 'Google API PATCH failed with HTTP 403: backend error');
  assert.equal(err.status, 403);
  assert.equal(err.count, 3);
  assert.deepEqual(err.moved, { ids: ['1', '2', '4'], trashed: true, where: 'Drive trash' });
  assert.equal(err.partial.affected, 3);
  assert.match(err.partial.summary, /^trashed 3 of 4 files into Drive trash before it failed: Google API PATCH failed with HTTP 403: backend error/);
  assert.deepEqual(err.partial.undo, err.moved);
  assert.equal(google.google.apiCalls().length, 1, 'one batch request for all four files');

  google.calls.length = 0;
  await chore.undo(err.partial.undo);
  assert.deepEqual(patched(google.calls), [['1', { trashed: false }], ['2', { trashed: false }], ['4', { trashed: false }]]);

  const bin = await chore.apply({ files: ['5', '3'], count: 2 }, 'move:Documents').catch((e) => e);
  assert.deepEqual(bin.moved, { ids: ['5'], to: 'bin-new', from: 'root', where: 'Documents/ in Drive' });
  assert.equal(google.google.calls.filter((c) => c.method === 'POST' && /drive\/v3\/files\?/.test(c.url)).length, 1, 'the bin folder is created once');
});

test('Drive: a move where no file went through throws the original error', async () => {
  const drive = new DriveStore((await fakeDrive(new Set(['1', '2']))).auth);
  const err = await drive.move(['1', '2'], null).catch((e) => e);
  assert.equal(err.message, 'Google API PATCH failed with HTTP 403: backend error');
  assert.equal(err.moved, undefined);
});

test('Drive: a restore that fails partway says how many went back', async () => {
  const drive = new DriveStore((await fakeDrive(new Set(['2']))).auth);
  await assert.rejects(drive.restore({ ids: ['1', '2', '3'], trashed: true }), /put 2 of 3 files back before it failed: Google API PATCH failed with HTTP 403: backend error/);
});

test('lint: refuses to write the quest log or a source file through a symlink', posix, async (t) => {
  const dir = await tempDir(t);
  const root = join(dir, 'repo');
  await mkdir(root);
  const secret = join(dir, 'zshrc');
  await writeFile(secret, 'export SECRET=1\n');
  await writeFile(join(root, 'a.js'), 'export const a = () => b;\n');
  await writeFile(join(root, 'real.js'), 'var x = 1;\nexport { x };\n');
  await symlink(secret, join(root, QUEST_LOG));
  // Even a link that stays inside the project is refused: the write would land on another file.
  await symlink(join(root, 'real.js'), join(root, 'link.js'));
  const chore = createLintChore({ root });
  const { groups } = await chore.scan();
  const undef = groups.find((g) => g.rule === 'no-undef');

  await assert.rejects(chore.apply(undef, 'log'), /outside/);
  await assert.rejects(chore.apply({ rule: 'no-var', files: [join(root, 'link.js')], count: 1, fixable: 1, samples: [] }, 'fix'), /symlink/);
  assert.equal(await readFile(secret, 'utf8'), 'export SECRET=1\n');
  assert.equal(await readFile(join(root, 'real.js'), 'utf8'), 'var x = 1;\nexport { x };\n');
  await assert.rejects(chore.undo({ changes: [{ file: join(root, QUEST_LOG), before: null, afterHash: 'x' }] }), /outside/);
  await assert.rejects(chore.undo({ changes: [{ file: join(root, 'link.js'), before: '', afterHash: 'x' }] }), /symlink/);
  assert.equal(await readFile(secret, 'utf8'), 'export SECRET=1\n');
});

test('lint: ESLint text in the quest log is one escaped line', async (t) => {
  const root = await tempDir(t);
  const chore = createLintChore({ root });
  const group = { rule: 'evil<img src=x>', files: [], count: 1, samples: [{ file: 'x](http://evil.example)', line: 3, message: 'bad\n# Heading [click](http://evil.example)' }] };
  await chore.apply(group, 'log');
  const log = await readFile(join(root, QUEST_LOG), 'utf8');
  assert.ok(log.includes('## evil\\<img src=x\\> (1)'));
  assert.ok(log.includes('- [ ] x\\](http://evil.example):3 bad # Heading \\[click\\](http://evil.example)'));
  assert.ok(!/^# Heading/m.test(log));
});

test('expenses: refuses to write an output through a symlink and changes nothing', posix, async (t) => {
  const dir = await tempDir(t);
  const csvPath = join(dir, 'bank.csv');
  await writeFile(csvPath, 'Date,Description,Amount\n2026-01-03,NETFLIX.COM,-15.49\n');
  const target = join(dir, 'target.md');
  await writeFile(target, 'keep me\n');
  await symlink(target, join(dir, 'expense-report.md'));
  const chore = createExpensesChore({ csvPath, outDir: dir });
  const { groups } = await chore.scan();
  await assert.rejects(chore.apply(groups[0], 'cat:Subscriptions'), /symlink/);
  assert.equal(await readFile(target, 'utf8'), 'keep me\n');
  assert.deepEqual((await readdir(dir)).sort(), ['bank.csv', 'expense-report.md', 'target.md']);
  assert.equal((await chore.scan()).groups.length, 1, 'the merchant is still unfiled');
});

test('expenses: outputs are written whole and merchant names are escaped in the report', async (t) => {
  const dir = await tempDir(t);
  const csvPath = join(dir, 'bank.csv');
  await writeFile(csvPath, 'Date,Description,Amount\n2026-01-03,<img src=x> [pay](http://evil.example),-9.99\n');
  const chore = createExpensesChore({ csvPath, outDir: dir });
  const { groups } = await chore.scan();
  await chore.apply(groups[0], 'flag');
  const report = await readFile(chore.outputs.report, 'utf8');
  assert.ok(!/<img|\]\(http/.test(report.replace(/\\[<>[\]]/g, '')));
  assert.ok(report.includes('\\<img src=x\\>'));
  assert.ok(!(await readdir(dir)).some((n) => n.endsWith('.tmp')), 'no temp files left behind');
});

test('csv: formula cells are neutralised, plain numbers are kept', () => {
  const cells = ['=SUM(A1:A9)', '+1+cmd', '-2+3', '@SUM(1)', '\t=1', '\r=1', '-12.50', '+5', '-$1,234.50', '12', 'Coffee'];
  const [row] = parseCsv(toCsv([cells]));
  assert.deepEqual(row, ["'=SUM(A1:A9)", "'+1+cmd", "'-2+3", "'@SUM(1)", "'\t=1", "'\r=1", '-12.50', '+5', '-$1,234.50', '12', 'Coffee']);
});

test('expenses: short rows such as a total footer are skipped', async (t) => {
  const text = 'Date,Description,Amount\n2026-01-01,COFFEE,-3.50\n\nTotal,-3.50\n2026-01-02,TEA,-2.00\n';
  const { txns, skipped } = readTransactions(text);
  assert.deepEqual(txns.map((x) => [x.description, x.amount]), [['COFFEE', -3.5], ['TEA', -2]]);
  assert.equal(skipped, 1);

  const dir = await tempDir(t);
  await writeFile(join(dir, 'bank.csv'), text);
  const { stats } = await createExpensesChore({ csvPath: join(dir, 'bank.csv'), outDir: dir }).scan();
  assert.equal(stats.transactions, 2);
  assert.equal(stats.skipped, 1);
});

test('expenses: a row that leaves out trailing empty fields is still a transaction', () => {
  const { rows, txns, skipped } = readTransactions('Date,Description,Amount,Notes\n2026-01-01,COFFEE,-3.50\n2026-01-02,TEA,-2.00,team\n');
  assert.deepEqual(txns.map((x) => x.description), ['COFFEE', 'TEA']);
  assert.deepEqual(rows[0], ['2026-01-01', 'COFFEE', '-3.50', '']);
  assert.equal(skipped, 0);
});

test('expenses: amounts in parentheses are negative, thousands separators parse', () => {
  const { txns } = readTransactions('Date,Description,Amount\n2026-01-01,A,(12.50)\n2026-01-02,B,($12.50)\n2026-01-03,C,"1,234.50"\n2026-01-04,D,"($1,234.50)"\n2026-01-05,E,-$7.25\n');
  assert.deepEqual(txns.map((x) => x.amount), [-12.5, -12.5, 1234.5, -1234.5, -7.25]);
});
