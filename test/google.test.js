import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoogleAuth } from '../src/google/auth.js';
import { GmailProvider } from '../src/google/gmail.js';
import { DriveStore, binForMime } from '../src/google/drive.js';
import { exportToSheets } from '../src/google/sheets.js';
import { groupFiles } from '../src/chores/files/index.js';

/** A fake Google: routes by method + URL pattern and records every call. */
function fakeGoogle(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url: String(url), body, headers: init.headers ?? {} });
    const route = routes.find(([m, re]) => m === method && re.test(String(url)));
    if (!route) return new Response(JSON.stringify({ error: { message: `no route for ${method} ${url}` } }), { status: 404 });
    const out = typeof route[2] === 'function' ? route[2](String(url), body) : route[2];
    return new Response(JSON.stringify(out), { status: 200 });
  };
  return { calls, fetchImpl };
}

const TOKEN = [/oauth2\.googleapis\.com\/token/, (url, body) => ({ access_token: `at-${body.grant_type}`, expires_in: 3600, refresh_token: body.grant_type === 'authorization_code' ? 'rt-1' : undefined, scope: 'gmail drive' })];
const PROFILE = ['GET', /users\/me\/profile/, { emailAddress: 'player@example.com' }];

async function signedIn(routes, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'chorecade-g-'));
  const google = fakeGoogle([['POST', ...TOKEN], PROFILE, ...routes]);
  const auth = new GoogleAuth({ clientId: 'cid', clientSecret: 'secret', tokenFile: join(dir, 'token.json'), fetchImpl: google.fetchImpl, ...extra });
  const url = new URL(auth.authUrl('http://127.0.0.1:4747/oauth/google/callback'));
  await auth.exchange('the-code', url.searchParams.get('state'));
  return { auth, google, dir, url };
}

test('sign-in uses PKCE and a one-time state, and stores only the refresh token', async () => {
  const { auth, google, dir, url } = await signedIn([]);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.ok(url.searchParams.get('code_challenge').length >= 43);
  assert.match(url.searchParams.get('scope'), /gmail\.modify/);

  const exchange = google.calls.find((c) => c.body?.grant_type === 'authorization_code');
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

test('Gmail: lists the inbox from headers only, archives in batches, trash and undo', async () => {
  const msg = (id, from, unread) => ({
    id,
    labelIds: unread ? ['INBOX', 'UNREAD'] : ['INBOX'],
    internalDate: '1767225600000',
    payload: { headers: [{ name: 'From', value: from }, { name: 'Subject', value: `hello ${id}` }, { name: 'List-Unsubscribe', value: '<https://u.example/x>' }] },
  });
  const { auth, google } = await signedIn([
    ['GET', /messages\?.*pageToken=p2/, { messages: [{ id: 'c' }] }],
    ['GET', /messages\?q=in%3Ainbox/, { messages: [{ id: 'a' }, { id: 'b' }], nextPageToken: 'p2' }],
    ['GET', /messages\/a\?/, msg('a', 'News <news@shop.example>', true)],
    ['GET', /messages\/b\?/, msg('b', 'News <news@shop.example>', false)],
    ['GET', /messages\/c\?/, msg('c', 'Sam <sam@friends.example>', false)],
    ['POST', /batchModify/, {}],
    ['POST', /messages\/\w+\/(un)?trash/, {}],
  ]);
  const gmail = new GmailProvider(auth);
  const list = await gmail.list();
  assert.deepEqual(list.map((m) => [m.id, m.seen]), [['a', false], ['b', true], ['c', true]]);
  assert.equal(list[0].listUnsubscribe, '<https://u.example/x>');
  assert.ok(google.calls.filter((c) => /messages\/a\?/.test(c.url)).every((c) => /format=metadata/.test(c.url)), 'bodies are never fetched');

  const archived = await gmail.move(['a', 'b'], 'archive');
  assert.deepEqual(google.calls.at(-1).body, { ids: ['a', 'b'], removeLabelIds: ['INBOX'] });
  await gmail.restore(archived);
  assert.deepEqual(google.calls.at(-1).body, { ids: ['a', 'b'], addLabelIds: ['INBOX'] });

  const trashed = await gmail.move(['c'], 'trash');
  assert.ok(google.calls.some((c) => c.method === 'POST' && /messages\/c\/trash$/.test(c.url)));
  await gmail.restore(trashed);
  assert.ok(google.calls.some((c) => /messages\/c\/untrash$/.test(c.url)));
  assert.ok(google.calls.every((c) => !/\/messages\/\w+$/.test(c.url) || c.method !== 'DELETE'), 'nothing is ever deleted');
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
  assert.match(google.calls.at(-1).url, /addParents=bin-docs&removeParents=root/);
  await drive.restore(moved);
  assert.match(google.calls.at(-1).url, /addParents=root&removeParents=bin-docs/);

  const trashed = await drive.move(['2'], null);
  assert.deepEqual(google.calls.at(-1).body, { trashed: true });
  await drive.restore(trashed);
  assert.deepEqual(google.calls.at(-1).body, { trashed: false });
  assert.equal(binForMime('video/mp4'), 'Media');
});

test('Sheets export writes RAW values so a merchant name cannot become a formula', async () => {
  const { auth, google } = await signedIn([
    ['POST', /spreadsheets$/, { spreadsheetId: 'sheet-1', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-1' }],
    ['POST', /values:batchUpdate/, {}],
  ]);
  const out = await exportToSheets(auth, { title: 'Expenses', tabs: [{ name: 'Transactions', rows: [['Description'], ['=IMPORTXML("http://evil")']] }] });
  assert.equal(out.url, 'https://docs.google.com/spreadsheets/d/sheet-1');
  const write = google.calls.find((c) => /values:batchUpdate/.test(c.url));
  assert.equal(write.body.valueInputOption, 'RAW');
  assert.equal(write.body.data[0].range, "'Transactions'!A1");
});
