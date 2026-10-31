import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoogleAuth } from '../src/google/auth.js';
import { GmailProvider, QuotaBudget } from '../src/google/gmail.js';
import { createInboxChore } from '../src/chores/inbox/index.js';
import { DriveStore, binForMime } from '../src/google/drive.js';
import { exportToSheets } from '../src/google/sheets.js';
import { groupFiles } from '../src/chores/files/index.js';
import { fakeGoogle, reply, signedIn } from './google-fake.js';

const isBatch = (service) => (c) => c.url === `https://${service === 'gmail' ? 'gmail' : 'www'}.googleapis.com/batch/${service}/v${service === 'gmail' ? 1 : 3}`;

test('sign-in uses PKCE and a one-time state, and stores only the refresh token', async () => {
  const { auth, google, dir, url } = await signedIn([]);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.ok(url.searchParams.get('code_challenge').length >= 43);
  assert.match(url.searchParams.get('scope'), /gmail\.modify/);

  const exchange = google.signIn.find((c) => c.body?.grant_type === 'authorization_code');
  assert.equal(exchange.body.code, 'the-code');
  assert.ok(exchange.body.code_verifier.length >= 43, 'the verifier goes with the code');

  const saved = JSON.parse(await readFile(join(dir, 'token.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved).sort(), ['email', 'refresh_token', 'scope']);
  assert.deepEqual(auth.status(), { configured: true, connected: true, email: 'player@example.com' });

  // The same state cannot be replayed.
  await assert.rejects(auth.exchange('the-code', url.searchParams.get('state')), /expired or was not started here/);
  await rm(dir, { recursive: true, force: true });
});

test('an unknown state is refused before anything is sent to Google', async () => {
  const google = fakeGoogle([]);
  const auth = new GoogleAuth({ clientId: 'cid', clientSecret: 's', tokenFile: join(tmpdir(), 'nope.json'), fetchImpl: google.fetchImpl });
  await assert.rejects(auth.exchange('code', 'forged'), /not started here/);
  assert.equal(google.calls.length, 0);
});

test('access tokens refresh when they expire', async () => {
  let clock = 1_000_000;
  const { auth, google } = await signedIn([], { now: () => clock });
  assert.equal(await auth.accessToken(), 'at-authorization_code');
  clock += 2 * 3600 * 1000;
  assert.equal(await auth.accessToken(), 'at-refresh_token');
  assert.ok(google.calls.some((c) => c.body?.grant_type === 'refresh_token' && c.body.refresh_token === 'rt-1'));
});

/** A fake Gmail mailbox: `ids` newest first, listings paged like messages.list. */
function mailbox(total, { unread = () => false } = {}) {
  const box = { ids: Array.from({ length: total }, (_, i) => `m${i}`), unread: new Set(), gone: new Set(), fail: new Map() };
  box.ids.forEach((id, i) => unread(i) && box.unread.add(id));
  box.routes = [
    [
      'GET',
      /\/users\/me\/messages\?/,
      (url) => {
        const p = new URL(url).searchParams;
        const list = /is:unread/.test(p.get('q')) ? box.ids.filter((id) => box.unread.has(id)) : box.ids;
        const start = Number(p.get('pageToken') ?? 0);
        const end = start + Number(p.get('maxResults'));
        return { messages: list.slice(start, end).map((id) => ({ id, threadId: id })), ...(end < list.length ? { nextPageToken: String(end) } : {}), resultSizeEstimate: list.length };
      },
    ],
    [
      'GET',
      /\/users\/me\/messages\/[^/?]+\?/,
      (url) => {
        const id = decodeURIComponent(/messages\/([^/?]+)\?/.exec(url)[1]);
        if (box.fail.has(id)) return box.fail.get(id)();
        if (box.gone.has(id) || !box.ids.includes(id)) return reply(404, { error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' } });
        return {
          internalDate: '1767225600000',
          payload: {
            headers: [
              { name: 'From', value: id === 'm0' ? 'News <news@shop.example>' : `Sam <sam${id}@friends.example>` },
              { name: 'Subject', value: `hello ${id}` },
              ...(id === 'm0' ? [{ name: 'List-Unsubscribe', value: '<https://u.example/x>' }] : []),
            ],
          },
        };
      },
    ],
    ['POST', /messages\/batchModify$/, {}],
  ];
  return box;
}

const batchedIds = (call) => call.parts.map((p) => /messages\/([^/?]+)\?/.exec(p.path)[1]);

test('Gmail: lists the inbox from headers only, archives and trashes in bulk, and undoes both', async () => {
  const box = mailbox(3, { unread: (i) => i === 0 });
  const { auth, google } = await signedIn(box.routes);
  const gmail = new GmailProvider(auth);
  const list = await gmail.list();
  assert.deepEqual(list.map((m) => [m.id, m.seen]), [['m0', false], ['m1', true], ['m2', true]]);
  assert.deepEqual(list[0], { id: 'm0', from: 'News <news@shop.example>', subject: 'hello m0', date: '2026-01-01T00:00:00.000Z', seen: false, listUnsubscribe: '<https://u.example/x>', listUnsubscribePost: null });
  const gets = google.inner.filter((c) => /messages\/m\d\?/.test(c.url));
  assert.equal(gets.length, 3);
  assert.ok(gets.every((c) => /format=metadata/.test(c.url) && /fields=internalDate%2Cpayload%2Fheaders/.test(c.url)), 'bodies are never fetched');

  const archived = await gmail.move(['m0', 'm1'], 'archive');
  assert.deepEqual(google.calls.at(-1).body, { ids: ['m0', 'm1'], removeLabelIds: ['INBOX'] });
  await gmail.restore(archived);
  assert.deepEqual(google.calls.at(-1).body, { ids: ['m0', 'm1'], addLabelIds: ['INBOX'] });

  const trashed = await gmail.move(['m2'], 'trash');
  assert.deepEqual(trashed, { target: 'trash', ids: ['m2'] });
  assert.deepEqual(google.calls.at(-1).body, { ids: ['m2'], addLabelIds: ['TRASH'], removeLabelIds: ['INBOX'] });
  await gmail.restore(trashed);
  assert.deepEqual(google.calls.at(-1).body, { ids: ['m2'], addLabelIds: ['INBOX'], removeLabelIds: ['TRASH'] });
  assert.ok(google.inner.every((c) => c.method !== 'DELETE' && !/\/(un)?trash$/.test(c.url)), 'nothing is deleted, and no per-message trash calls');
});

const unitsOf = (c) => (c.parts ? c.parts.length * 20 : /batchModify/.test(c.url) ? 50 : 5);
/** The most Gmail quota units spent in any 60-second window, from the request times. */
const busiestMinute = (calls) => Math.max(...calls.map((c) => calls.filter((d) => d.at >= c.at && d.at < c.at + 60_000).reduce((sum, d) => sum + unitsOf(d), 0)));

test('Gmail: QuotaBudget refills at 80 units a second up to 1,000', async () => {
  const clock = { t: 0 };
  const sleeps = [];
  const budget = new QuotaBudget({ now: () => clock.t, sleep: async (ms) => sleeps.push(ms) && (clock.t += ms) });
  await budget.take(1000);
  assert.deepEqual(sleeps, [], 'a full bucket spends at once');
  assert.equal(budget.delay(80), 1000);
  await budget.take(80);
  assert.deepEqual(sleeps, [1000]);
  clock.t += 3600_000;
  assert.equal(budget.delay(1000), 0);
  assert.equal(budget.delay(1001), 0, 'asking for more than the capacity waits for a full bucket, not forever');
  await budget.take(1000);
  assert.equal(budget.delay(20), 250);
});

test('Gmail: the first scan returns within the time budget and the rest is read in the background, inside the quota', async () => {
  const box = mailbox(2100, { unread: (i) => i % 7 === 0 });
  const { auth, google, clock } = await signedIn(box.routes);
  const gmail = new GmailProvider(auth);
  const start = clock.t;

  const first = await gmail.list();
  assert.ok(clock.t - start <= 20_000, `returned after ${clock.t - start} ms`);
  assert.equal(first.length, 100, 'two batches fit in the first 20 s: 1,000 units at once, then 80 a second');
  assert.deepEqual(first.map((m) => m.id), box.ids.slice(0, 100), 'newest first');
  assert.equal(gmail.pending, 1900);
  assert.deepEqual([first[0].seen, first[1].seen, first[7].seen], [false, true, false]);

  await gmail.settled();
  const batches = google.calls.filter(isBatch('gmail'));
  assert.equal(google.apiCalls().length, 45, '4 inbox pages, 1 unread page and 40 batches, where one request per message took 2,004');
  assert.equal(batches.length, 40);
  assert.ok(batches.every((b) => b.parts.length <= 50 && b.parts.every((p) => p.method === 'GET')));
  assert.equal(google.stats.maxInFlight, 1);
  assert.ok(google.apiCalls().filter((c) => !isBatch('gmail')(c)).every((c) => /fields=messages%2Fid%2CnextPageToken/.test(c.url)), 'listings ask only for ids');
  const took = clock.t - start;
  assert.ok(took > 480_000 && took < 495_000, `fully read after ${took} ms`);
  assert.ok(busiestMinute(google.apiCalls()) <= 6000, `busiest minute spent ${busiestMinute(google.apiCalls())} units`);
  assert.equal(gmail.pending, 0);

  google.calls.length = 0;
  const second = await gmail.list();
  assert.equal(second.length, 2000, 'the next scan has everything the background read');
  assert.deepEqual(second.slice(0, 100), first);
  assert.equal(google.apiCalls().length, 5, 'nothing new: the listings only');

  google.calls.length = 0;
  box.ids.unshift('n1', 'n2', 'n3');
  box.unread.add('n1');
  box.unread.delete('m7');
  const third = await gmail.list();
  assert.equal(google.apiCalls().length, 6, 'the listings and one batch for the three new messages');
  assert.deepEqual(batchedIds(google.calls.find(isBatch('gmail'))).sort(), ['n1', 'n2', 'n3']);
  assert.deepEqual(third.slice(0, 3).map((m) => [m.id, m.seen]), [['n1', false], ['n2', true], ['n3', true]]);
  assert.equal(third.find((m) => m.id === 'm7').seen, true, 'read state comes from the listing, not the cache');
  assert.equal(gmail.cache.size, 2000);
  assert.ok(!gmail.cache.has('m1999'), 'messages pushed out of the newest 2000 leave the cache');
});

test('Gmail: the inbox scan counts messages still loading as remaining; a background failure is logged once and the next scan resumes', async () => {
  const box = mailbox(300);
  box.fail.set('m200', () => reply(403, { error: { code: 403, message: 'Metadata scope does not support this request.', errors: [{ reason: 'forbidden' }] } }));
  const { auth, google, logs } = await signedIn(box.routes);
  const gmail = new GmailProvider(auth);
  const inbox = createInboxChore({ provider: gmail, dataDir: tmpdir(), id: 'gmail' });

  const { groups, stats } = await inbox.scan();
  assert.deepEqual([stats.messages, stats.loading, stats.remaining], [100, 200, 300]);
  assert.equal(groups.reduce((sum, g) => sum + g.count, 0), 100, 'groups cover only the messages read');

  await gmail.settled();
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^Gmail: Gmail scan stopped with 51 messages still to read: Gmail message read failed with HTTP 403: Metadata scope/);
  assert.equal(google.calls.filter(isBatch('gmail')).length, 5, 'no batch after the failure');

  box.fail.clear();
  const again = await inbox.scan();
  assert.deepEqual([again.stats.messages, again.stats.loading, again.stats.remaining], [300, 0, 300]);
  assert.equal(logs.length, 1);

  const local = createInboxChore({ provider: { describe: () => 'local', list: async () => [{ id: 'a', from: 'a@x.example', subject: 's', date: null, seen: true }] }, dataDir: tmpdir() });
  assert.equal((await local.scan()).stats.loading, 0, 'providers without background reads load nothing');
});

test('Gmail: reading in the background stops at sign-out or when the provider is closed, without logging', async () => {
  for (const stop of [(gmail, auth) => auth.disconnect(), (gmail) => gmail.close()]) {
    const box = mailbox(1000);
    const { auth, google, logs } = await signedIn(box.routes);
    const gmail = new GmailProvider(auth);
    assert.equal((await gmail.list()).length, 100);
    await stop(gmail, auth);
    await gmail.settled();
    assert.ok(google.calls.filter(isBatch('gmail')).length <= 3, 'at most the batch already on its way');
    assert.ok(gmail.pending >= 850);
    assert.deepEqual(logs, []);
  }
});
test('Gmail: a rate-limited message is retried on its own, and a deleted one is skipped', async () => {
  const box = mailbox(10);
  box.fail.set('m3', () => {
    box.fail.delete('m3');
    return reply(429, { error: { code: 429, message: 'Too many concurrent requests for user.', status: 'RESOURCE_EXHAUSTED' } }, { 'Retry-After': '2' });
  });
  box.gone.add('m4');
  const { auth, google, sleeps } = await signedIn(box.routes);
  const list = await new GmailProvider(auth).list();
  assert.deepEqual(list.map((m) => m.id), ['m0', 'm1', 'm2', 'm3', 'm5', 'm6', 'm7', 'm8', 'm9']);
  const batches = google.calls.filter(isBatch('gmail'));
  assert.equal(batches.length, 2);
  assert.deepEqual(batchedIds(batches[1]), ['m3']);
  assert.deepEqual(sleeps, [2000], 'Retry-After on the part is honoured');
});

test('Gmail: a failed read while the scan waits stops it with a clear message, and the next scan resumes', async () => {
  const box = mailbox(120);
  box.fail.set('m60', () => reply(403, { error: { code: 403, message: 'Metadata scope does not support this request.', status: 'PERMISSION_DENIED' } }));
  const { auth, google, logs } = await signedIn(box.routes);
  const gmail = new GmailProvider(auth);
  await assert.rejects(gmail.list(), (err) => {
    assert.equal(err.status, 403);
    assert.match(err.message, /^Gmail scan stopped with 21 messages still to read: Gmail message read failed with HTTP 403: Metadata scope/);
    assert.match(err.message, /Scan again in a minute/);
    return true;
  });
  assert.equal(google.calls.filter(isBatch('gmail')).length, 2, 'no new batch after the failure');
  assert.deepEqual(logs, [], 'thrown, so not logged as well');

  box.fail.clear();
  google.calls.length = 0;
  assert.equal((await gmail.list()).length, 120);
  const batches = google.calls.filter(isBatch('gmail'));
  assert.equal(batches.length, 1);
  assert.equal(batches[0].parts.length, 21, 'only the failed message and the batch that never ran');
});
test('Gmail: trash goes 1000 messages per batchModify, a failed chunk reports what moved, and old trash entries still restore', async () => {
  let modifies = 0;
  const { auth, google } = await signedIn([['POST', /messages\/batchModify$/, () => (++modifies === 2 ? reply(400, { error: { code: 400, message: 'Invalid label: TRASH' } }) : {})]]);
  const gmail = new GmailProvider(auth);
  const ids = Array.from({ length: 1500 }, (_, i) => `t${i}`);
  const err = await gmail.move(ids, 'trash').catch((e) => e);
  assert.match(err.message, /HTTP 400: Invalid label/);
  assert.deepEqual(err.moved, { target: 'trash', ids: ids.slice(0, 1000) });
  assert.equal(err.count, 1000);
  assert.deepEqual(google.calls[0].body, { ids: ids.slice(0, 1000), addLabelIds: ['TRASH'], removeLabelIds: ['INBOX'] });
  assert.deepEqual(google.calls[1].body.ids, ids.slice(1000));
  assert.equal(google.calls.length, 2, 'two requests where one per message took 1,500');

  assert.equal(await gmail.restore(err.moved), 1000);
  assert.deepEqual(google.calls.at(-1).body, { ids: ids.slice(0, 1000), addLabelIds: ['INBOX'], removeLabelIds: ['TRASH'] });
  // A journal entry from a version that called messages.trash per message looks the same.
  assert.equal(await gmail.restore({ target: 'trash', ids: ['old-1', 'old-2'] }), 2);
  assert.deepEqual(google.calls.at(-1).body, { ids: ['old-1', 'old-2'], addLabelIds: ['INBOX'], removeLabelIds: ['TRASH'] });
});

test('Drive: duplicates from md5, bins created once, moves and trash reversed', async () => {
  const { auth, google } = await signedIn([
    ['GET', /files\?.*name\+%3D/, { files: [] }],
    [
      'GET',
      /drive\/v3\/files\?/,
      {
        files: [
          { id: '1', name: 'report.pdf', mimeType: 'application/pdf', size: '10', md5Checksum: 'aa', modifiedTime: '2026-01-01T00:00:00Z' },
          { id: '2', name: 'report (1).pdf', mimeType: 'application/pdf', size: '10', md5Checksum: 'aa', modifiedTime: '2026-02-01T00:00:00Z' },
          { id: '3', name: 'Budget', mimeType: 'application/vnd.google-apps.spreadsheet' },
        ],
      },
    ],
    ['POST', /drive\/v3\/files\?fields=id/, { id: 'bin-docs' }],
    ['PATCH', /drive\/v3\/files\/\w+/, { id: 'x' }],
  ]);
  const drive = new DriveStore(auth);
  const files = await drive.list();
  assert.equal(files.find((f) => f.id === '3').binHint, 'Documents', 'Google Sheets go to Documents by MIME type');
  const { groups } = groupFiles(files);
  assert.deepEqual(groups.find((g) => g.kind === 'duplicate').files, ['2'], 'the newer copy is the duplicate');

  const moved = await drive.move(['1'], 'Documents');
  await drive.move(['3'], 'Documents');
  assert.equal(google.calls.filter((c) => c.method === 'POST' && /drive\/v3\/files/.test(c.url)).length, 1, 'bin folder created once');
  assert.match(google.inner.at(-1).url, /files\/3\?addParents=bin-docs&removeParents=root/);
  await drive.restore(moved);
  assert.match(google.inner.at(-1).url, /files\/1\?addParents=root&removeParents=bin-docs/);

  const trashed = await drive.move(['2'], null);
  assert.deepEqual(google.inner.at(-1).body, { trashed: true });
  await drive.restore(trashed);
  assert.deepEqual(google.inner.at(-1).body, { trashed: false });
  assert.ok(google.inner.filter((c) => c.method === 'PATCH').length === 5 && google.calls.every((c) => c.method !== 'PATCH'), 'every PATCH went through a batch');
  assert.equal(binForMime('video/mp4'), 'Media');
});

test('Drive: 100 PATCHes per batch; a failed file stops new batches and reports what moved', async () => {
  const ids = Array.from({ length: 250 }, (_, i) => `f${i}`);
  const failing = new Map([['f150', 'move'], ['f20', 'restore']]);
  let phase = 'move';
  let flaky = true;
  const { auth, google, sleeps } = await signedIn([
    [
      'PATCH',
      /drive\/v3\/files\/\w+/,
      (url) => {
        const id = /files\/(\w+)\?/.exec(url)[1];
        if (failing.get(id) === phase) return reply(403, { error: { code: 403, message: 'The user does not have sufficient permissions for this file.' } });
        if (id === 'f10' && flaky) {
          flaky = false;
          return reply(503, { error: { code: 503, message: 'Backend Error' } });
        }
        return { id };
      },
    ],
  ]);
  const drive = new DriveStore(auth, { inFlight: 1 });
  const err = await drive.move(ids, null).catch((e) => e);
  assert.equal(err.status, 403);
  assert.match(err.message, /HTTP 403: The user does not have sufficient permissions/);
  const done = [...ids.slice(0, 150), ...ids.slice(151, 200)];
  assert.deepEqual(err.moved, { ids: done, trashed: true, where: 'Drive trash' });
  assert.equal(err.count, 199);
  const batches = google.calls.filter(isBatch('drive'));
  assert.deepEqual(batches.map((b) => b.parts.length), [100, 1, 100], 'the 503 is retried on its own; no batch starts after the 403');
  assert.equal(sleeps.length, 1);
  assert.ok(batches[0].parts.every((p) => p.method === 'PATCH' && /\?fields=id$/.test(p.path) && p.body.trashed === true));

  phase = 'restore';
  await assert.rejects(drive.restore(err.moved), (e) => /^put 99 of 199 files back before it failed: .*HTTP 403/.test(e.message) && e.status === 403);
});

test('Sheets export asks only for the id and URL, and writes RAW values so a merchant name cannot become a formula', async () => {
  const { auth, google } = await signedIn([
    ['POST', /spreadsheets\?/, { spreadsheetId: 'sheet-1', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-1' }],
    ['POST', /values:batchUpdate/, {}],
  ]);
  const out = await exportToSheets(auth, { title: 'Expenses', tabs: [{ name: 'Transactions', rows: [['Description'], ['=IMPORTXML("http://evil")']] }] });
  assert.deepEqual(out, { id: 'sheet-1', url: 'https://docs.google.com/spreadsheets/d/sheet-1' });
  assert.match(google.calls[0].url, /spreadsheets\?fields=spreadsheetId%2CspreadsheetUrl$/);
  const write = google.calls.find((c) => /values:batchUpdate/.test(c.url));
  assert.equal(write.body.valueInputOption, 'RAW');
  assert.equal(write.body.data[0].range, "'Transactions'!A1");
});

test('Sheets export splits a very large tab across requests by rows, and a failed write names the spreadsheet', async () => {
  const rows = [['Date', 'Description', 'Amount', 'Category'], ...Array.from({ length: 30_000 }, (_, i) => ['2026-01-01', `Coffee shop number ${i} on Main Street`, -4.5, 'Food'])];
  const totals = [['Category', 'Total'], ['Food', -135000]];
  const tabs = [{ name: 'Transactions', rows }, { name: "Bob's totals", rows: totals }];
  let writes = 0;
  let failAt = 0;
  const { auth, google } = await signedIn([
    ['POST', /spreadsheets\?/, { spreadsheetId: 'sheet-2', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-2' }],
    ['POST', /values:batchUpdate/, () => (++writes === failAt ? reply(400, { error: { code: 400, message: 'Invalid data[0]: Your input contains more than the maximum of 50000 characters in a single cell.' } }) : {})],
  ]);
  await exportToSheets(auth, { title: 'Expenses', tabs });
  const bodies = google.calls.filter((c) => /values:batchUpdate/.test(c.url)).map((c) => c.body);
  assert.ok(bodies.length >= 2, `split into ${bodies.length} requests`);
  assert.ok(bodies.every((b) => b.valueInputOption === 'RAW' && JSON.stringify(b).length < 1_100_000));
  const data = bodies.flatMap((b) => b.data);
  const transactions = data.filter((d) => d.range.startsWith("'Transactions'"));
  let next = 1;
  for (const d of transactions) {
    assert.equal(d.range, `'Transactions'!A${next}`);
    next += d.values.length;
  }
  assert.deepEqual(transactions.flatMap((d) => d.values), rows);
  assert.deepEqual(data.filter((d) => d.range === "'Bob''s totals'!A1").map((d) => d.values), [totals]);

  writes = 0;
  failAt = 2;
  await assert.rejects(exportToSheets(auth, { title: 'Expenses', tabs }), (err) => {
    assert.equal(err.status, 400);
    assert.equal(err.url, 'https://docs.google.com/spreadsheets/d/sheet-2');
    assert.match(err.message, /created the spreadsheet https:\/\/docs\.google\.com\/spreadsheets\/d\/sheet-2 but could not fill it in \(.*HTTP 400.*\); open it/);
    return true;
  });
});
