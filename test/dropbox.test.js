import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DropboxAuth, SCOPES } from '../src/dropbox/auth.js';
import { DropboxStore, TRASH_FOLDER, normaliseFolder } from '../src/dropbox/store.js';
import { createFilesChore, groupFiles } from '../src/chores/files/index.js';

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A fake Dropbox: `routes` maps 'files/list_folder', 'oauth2/token' and so on to a value or a handler. Every call is recorded. */
function fakeDropbox(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const route = u.replace(/^https:\/\/api\.dropboxapi\.com\/(2\/)?/, '');
    const body = init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : init.body === undefined ? undefined : JSON.parse(init.body);
    const call = { url: u, route, body, raw: init.body, headers: init.headers ?? {}, signal: init.signal };
    calls.push(call);
    const handler = routes[route];
    if (!handler) return new Response(`Error in call to API function "${route}": no such route in this test`, { status: 400 });
    // A fixed Response is answered with a copy, so a route can be called more than once.
    const out = typeof handler === 'function' ? await handler(body, call, calls) : handler instanceof Response ? handler.clone() : handler;
    return out instanceof Response ? out : json(out);
  };
  return { calls, fetchImpl };
}

const ACCOUNT = { account_id: 'dbid:abc', email: 'p@example.com' };
const TOKEN = (body) => ({ access_token: `at-${body.grant_type}`, expires_in: 14400, token_type: 'bearer', scope: SCOPES.join(' '), account_id: 'dbid:abc', ...(body.grant_type === 'authorization_code' ? { refresh_token: 'rt-1' } : {}) });

/** An auth that is already signed in, with an injected sleep and log. */
function signedIn(routes = {}, { token = {}, tokenFile = join(tmpdir(), 'chorecade-dbx-unused.json'), ...extra } = {}) {
  const dropbox = fakeDropbox({ 'oauth2/token': TOKEN, 'users/get_current_account': ACCOUNT, ...routes });
  const sleeps = [];
  const logs = [];
  const auth = new DropboxAuth({ appKey: 'key', tokenFile, fetchImpl: dropbox.fetchImpl, sleep: async (ms) => sleeps.push(ms), log: (m) => logs.push(m), ...extra });
  auth.token = { refresh_token: 'rt', access_token: 'at', expires_at: Date.now() + 3600_000, scope: SCOPES.join(' '), ...ACCOUNT, ...token };
  return { auth, dropbox, sleeps, logs };
}

const tempDir = () => mkdtemp(join(tmpdir(), 'chorecade-dbx-'));

test('sign-in uses PKCE with no secret, a one-time state, offline access, and stores only the refresh token', async () => {
  const dir = await tempDir();
  const tokenFile = join(dir, 'nested', 'dropbox-token.json');
  const { auth, dropbox } = signedIn({}, { tokenFile });
  auth.token = null;
  const url = new URL(auth.authUrl('http://127.0.0.1:4747/oauth/dropbox/callback'));
  assert.equal(url.origin + url.pathname, 'https://www.dropbox.com/oauth2/authorize');
  const p = Object.fromEntries(url.searchParams);
  assert.equal(p.client_id, 'key');
  assert.equal(p.response_type, 'code');
  assert.equal(p.token_access_type, 'offline');
  assert.equal(p.code_challenge_method, 'S256');
  assert.equal(p.redirect_uri, 'http://127.0.0.1:4747/oauth/dropbox/callback');
  assert.deepEqual(p.scope.split(' ').sort(), ['account_info.read', 'files.content.write', 'files.metadata.read']);

  assert.equal(await auth.exchange('the-code', p.state), 'p@example.com');
  const exchange = dropbox.calls.find((c) => c.body?.grant_type === 'authorization_code');
  assert.equal(exchange.url, 'https://api.dropboxapi.com/oauth2/token');
  assert.equal(exchange.body.code, 'the-code');
  assert.equal(exchange.body.client_id, 'key');
  assert.equal(exchange.body.redirect_uri, p.redirect_uri);
  assert.equal(b64url(createHash('sha256').update(exchange.body.code_verifier).digest()), p.code_challenge, 'the verifier matches the challenge');
  assert.ok(!('client_secret' in exchange.body));

  const lookup = dropbox.calls.find((c) => c.route === 'users/get_current_account');
  assert.equal(lookup.raw, 'null', 'an argument-less route gets a JSON null body');
  assert.equal(lookup.headers['content-type'], 'application/json');
  assert.equal(lookup.headers.authorization, 'Bearer at-authorization_code');

  const saved = JSON.parse(await readFile(tokenFile, 'utf8'));
  assert.deepEqual(Object.keys(saved).sort(), ['account_id', 'email', 'refresh_token', 'scope']);
  assert.equal(saved.refresh_token, 'rt-1');
  if (process.platform !== 'win32') {
    assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, 'nested'))).mode & 0o777, 0o700);
  }
  assert.deepEqual(await readdir(join(dir, 'nested')), ['dropbox-token.json'], 'no temp file left behind');
  assert.deepEqual(auth.status(), { configured: true, connected: true, email: 'p@example.com' });

  await assert.rejects(auth.exchange('the-code', p.state), /expired or was not started here/);
  await rm(dir, { recursive: true, force: true });
});

test('a state is refused before anything is sent, after ten minutes, and without an app key there is no sign-in', async () => {
  let clock = 1_000_000;
  const { auth, dropbox } = signedIn({}, { now: () => clock });
  auth.token = null;
  await assert.rejects(auth.exchange('code', 'forged'), (err) => err.status === 400 && /not started here/.test(err.message));
  const state = new URL(auth.authUrl('http://127.0.0.1:1/cb')).searchParams.get('state');
  clock += 10 * 60 * 1000 + 1;
  await assert.rejects(auth.exchange('code', state), /expired/);
  assert.equal(dropbox.calls.length, 0);

  const bare = new DropboxAuth({ tokenFile: join(tmpdir(), 'none.json') });
  assert.equal(bare.configured, false);
  assert.throws(() => bare.authUrl('http://127.0.0.1:1/cb'), (err) => err.status === 400 && /DROPBOX_APP_KEY/.test(err.message));
});

test('a failed email lookup after sign-in keeps the connection and the account id', async () => {
  const dir = await tempDir();
  const { auth, logs } = signedIn({ 'users/get_current_account': () => json({ error_summary: 'other/..' }, 500) }, { tokenFile: join(dir, 't.json') });
  auth.token = null;
  const state = new URL(auth.authUrl('http://127.0.0.1:1/cb')).searchParams.get('state');
  assert.equal(await auth.exchange('c', state), null);
  assert.equal(auth.connected, true);
  assert.equal(auth.account, 'dbid:abc');
  assert.match(logs.join('\n'), /could not look up/);
  await rm(dir, { recursive: true, force: true });
});

test('concurrent calls with an expiring token share one refresh, sent with the app key and no secret', async () => {
  let clock = 1_000_000;
  const { auth, dropbox } = signedIn(
    {
      'oauth2/token': async (body) => {
        await new Promise((r) => setTimeout(r, 5));
        return TOKEN(body);
      },
      'files/list_folder': { entries: [], has_more: false },
    },
    { now: () => clock, token: { expires_at: clock + 30_000 } },
  );
  await Promise.all(Array.from({ length: 10 }, () => auth.api('files/list_folder', { path: '' }, { idempotent: true })));
  const refreshes = dropbox.calls.filter((c) => c.route === 'oauth2/token');
  assert.equal(refreshes.length, 1);
  assert.deepEqual(refreshes[0].body, { client_id: 'key', grant_type: 'refresh_token', refresh_token: 'rt' });
  assert.equal(await auth.accessToken(), 'at-refresh_token');
  clock += 14400_000 - 61_000;
  assert.equal(await auth.accessToken(), 'at-refresh_token', 'still fresh more than a minute before expiry');
});

test('idempotent routes are retried after server errors and network failures; moves only after a 429', async () => {
  const read = signedIn({ 'files/list_folder': (b, c, calls) => (calls.length === 1 ? json({}, 503) : calls.length === 2 ? Promise.reject(new TypeError('fetch failed')) : { entries: [] }) });
  assert.deepEqual(await read.auth.api('files/list_folder', { path: '' }, { idempotent: true }), { entries: [] });
  assert.equal(read.dropbox.calls.length, 3);
  assert.equal(read.sleeps.length, 2);
  assert.ok(read.dropbox.calls.every((c) => c.signal instanceof AbortSignal), 'every request has a timeout');

  const move = signedIn({ 'files/move_batch_v2': () => new Response('upstream error', { status: 500 }) });
  await assert.rejects(move.auth.api('files/move_batch_v2', { entries: [] }), (err) => err.status === 500 && /HTTP 500: upstream error/.test(err.message));
  assert.equal(move.dropbox.calls.length, 1, 'a move is sent once');

  const timeout = signedIn({
    'files/move_batch_v2': () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    },
  });
  await assert.rejects(timeout.auth.api('files/move_batch_v2', { entries: [] }), /timed out after 30 s/);
  assert.equal(timeout.dropbox.calls.length, 1);

  const limited = signedIn({ 'files/move_batch_v2': (b, c, calls) => (calls.length === 1 ? json({ error_summary: 'too_many_requests/..' }, 429, { 'retry-after': '2' }) : { '.tag': 'complete', entries: [] }) });
  assert.deepEqual(await limited.auth.api('files/move_batch_v2', { entries: [] }), { '.tag': 'complete', entries: [] });
  assert.deepEqual(limited.sleeps, [2000]);

  const down = signedIn({ 'files/list_folder': () => json({}, 503) });
  await assert.rejects(down.auth.api('files/list_folder', {}, { idempotent: true }), (err) => err.status === 503);
  assert.equal(down.dropbox.calls.length, 5, 'retries stop after a few attempts');
});

test("errors carry Dropbox's error summary, or the plain-text 400 message", async () => {
  const { auth } = signedIn({
    'files/get_metadata': json({ error_summary: 'path/not_found/..', error: { '.tag': 'path', path: { '.tag': 'not_found' } } }, 409),
    'files/list_folder': new Response('Error in call to API function "files/list_folder": request body: path: wrong format', { status: 400, headers: { 'content-type': 'text/plain' } }),
    'files/copy_v2': new Response('<html>Bad gateway</html>', { status: 502 }),
  });
  await assert.rejects(auth.api('files/get_metadata', { path: '/x' }), (err) => err.status === 409 && err.summary === 'path/not_found' && /HTTP 409: path\/not_found$/.test(err.message));
  await assert.rejects(auth.api('files/list_folder', { path: 'x' }), (err) => err.status === 400 && /request body: path: wrong format/.test(err.message));
  await assert.rejects(auth.api('files/copy_v2', {}), (err) => err.status === 502 && /not JSON/.test(err.message));
});

test('a 401 refreshes the access token once; a missing permission says which one to tick', async () => {
  const expired = signedIn({ 'files/list_folder': (b, call) => (call.headers.authorization === 'Bearer at' ? json({ error_summary: 'expired_access_token/', error: { '.tag': 'expired_access_token' } }, 401) : { entries: [] }) });
  assert.deepEqual(await expired.auth.api('files/list_folder', { path: '' }, { idempotent: true }), { entries: [] });
  assert.equal(expired.dropbox.calls.filter((c) => c.route === 'oauth2/token').length, 1);

  const scope = signedIn({ 'files/move_batch_v2': json({ error_summary: 'missing_scope/', error: { '.tag': 'missing_scope', required_scope: 'files.content.write' } }, 401) });
  await assert.rejects(scope.auth.api('files/move_batch_v2', { entries: [] }), (err) => err.status === 403 && /files\.content\.write permission/.test(err.message) && /Permissions tab/.test(err.message));
  assert.equal(scope.dropbox.calls.filter((c) => c.route === 'oauth2/token').length, 0, 'refreshing would not help');
});

test('a revoked refresh token forgets the sign-in, deletes the file and reports it', async () => {
  const dir = await tempDir();
  const tokenFile = join(dir, 'token.json');
  await writeFile(tokenFile, JSON.stringify({ refresh_token: 'rt' }));
  const { auth } = signedIn({ 'oauth2/token': json({ error: 'invalid_grant', error_description: 'refresh token is invalid or revoked' }, 400) }, { tokenFile, token: { access_token: null } });
  let revoked = 0;
  auth.onRevoked = () => revoked++;
  await assert.rejects(auth.api('files/list_folder', {}, { idempotent: true }), (err) => err.status === 401 && /connect Dropbox again/.test(err.message));
  assert.equal(revoked, 1);
  assert.equal(auth.connected, false);
  await assert.rejects(stat(tokenFile), { code: 'ENOENT' });
  await rm(dir, { recursive: true, force: true });
});

test('a damaged token file is ignored with a log line; a missing one is not an error', async () => {
  const dir = await tempDir();
  const tokenFile = join(dir, 'dropbox-token.json');
  await writeFile(tokenFile, '{"refresh_tok');
  const damaged = signedIn({}, { tokenFile });
  assert.equal(await damaged.auth.load(), false);
  assert.match(damaged.logs.join('\n'), /damaged/);
  const missing = signedIn({}, { tokenFile: join(dir, 'none.json') });
  assert.equal(await missing.auth.load(), false);
  assert.deepEqual(missing.logs, []);
  await rm(dir, { recursive: true, force: true });
});

test('disconnect revokes at Dropbox, forgets the token either way and says whether Dropbox confirmed', async () => {
  const dir = await tempDir();
  const tokenFile = join(dir, 'token.json');
  await writeFile(tokenFile, '{}');
  const ok = signedIn({ 'auth/token/revoke': () => new Response('null', { status: 200 }) }, { tokenFile });
  assert.deepEqual(await ok.auth.disconnect(), { revoked: true });
  const call = ok.dropbox.calls[0];
  assert.equal(call.route, 'auth/token/revoke');
  assert.equal(call.raw, 'null');
  assert.equal(call.headers.authorization, 'Bearer at');
  assert.equal(ok.auth.connected, false);
  await assert.rejects(stat(tokenFile), { code: 'ENOENT' });

  const failing = signedIn({ 'auth/token/revoke': json({ error_summary: 'other/' }, 500) });
  assert.deepEqual(await failing.auth.disconnect(), { revoked: false });
  assert.equal(failing.auth.connected, false);
  const offline = signedIn({
    'auth/token/revoke': () => {
      throw new TypeError('fetch failed');
    },
  });
  assert.deepEqual(await offline.auth.disconnect(), { revoked: false });
  const gone = signedIn({ 'oauth2/token': json({ error: 'invalid_grant' }, 400) }, { token: { access_token: null } });
  assert.deepEqual(await gone.auth.disconnect(), { revoked: true }, 'a sign-in Dropbox no longer accepts has no access left');
  await rm(dir, { recursive: true, force: true });
});

const file = (name, extra = {}) => ({ '.tag': 'file', id: `id:${name}`, name, path_display: `/Downloads/${name}`, path_lower: `/downloads/${name.toLowerCase()}`, size: 10, server_modified: '2026-01-01T00:00:00Z', content_hash: `h-${name}`, ...extra });

/** move_batch_v2 that answers each entry with success at its to_path, except the indices in `fail`. */
const mover = (fail = new Map()) => (body) => ({
  '.tag': 'complete',
  entries: body.entries.map((e, i) => (fail.has(i) ? { '.tag': 'failure', failure: fail.get(i) } : { '.tag': 'success', success: { '.tag': 'file', id: e.from_path, path_display: e.to_path } })),
});

test('the store lists one folder page by page, files only, skipping dot-files, with hashes for duplicates', async () => {
  const { auth, dropbox } = signedIn({
    'files/list_folder': { entries: [file('report.pdf'), { '.tag': 'folder', id: 'id:f', name: 'Documents', path_display: '/Downloads/Documents' }, file('.DS_Store')], cursor: 'c1', has_more: true },
    'files/list_folder/continue': { entries: [file('report (1).pdf', { content_hash: 'h-report.pdf', server_modified: '2026-02-01T00:00:00Z' })], cursor: 'c2', has_more: false },
  });
  const store = new DropboxStore(auth, { folder: 'Downloads/' });
  assert.equal(store.folder, '/Downloads');
  assert.equal(store.describe(), 'Dropbox p@example.com:/Downloads');
  assert.equal(new DropboxStore(auth).describe(), 'Dropbox p@example.com:/');
  const files = await store.list();
  assert.deepEqual(files.map((f) => f.id), ['id:report.pdf', 'id:report (1).pdf']);
  assert.deepEqual(files[0], { id: 'id:report.pdf', name: 'report.pdf', size: 10, mtime: Date.parse('2026-01-01T00:00:00Z'), hash: 'h-report.pdf' });
  assert.deepEqual(dropbox.calls[0].body, { path: '/Downloads', recursive: false });
  assert.deepEqual(dropbox.calls[1].body, { cursor: 'c1' });
  assert.deepEqual(groupFiles(files).groups.find((g) => g.kind === 'duplicate').files, ['id:report (1).pdf'], 'the newer copy is the duplicate');
  assert.equal(normaliseFolder('/'), '');
});

test('a folder that does not exist gets a clear message', async () => {
  const { auth } = signedIn({ 'files/list_folder': json({ error_summary: 'path/not_found/...', error: { '.tag': 'path', path: { '.tag': 'not_found' } } }, 409) });
  await assert.rejects(new DropboxStore(auth, { folder: '/Nope' }).list(), (err) => err.status === 404 && /no folder \/Nope/.test(err.message) && /--dropbox-folder/.test(err.message));
});

test('moves create the bin once (an existing one is fine), poll the batch job, record where each file landed, and undo by moving back', async () => {
  let polls = 0;
  const { auth, dropbox, sleeps } = signedIn({
    'files/list_folder': { entries: [file('a.pdf'), file('b.pdf'), file('c.zip')], has_more: false },
    'files/create_folder_v2': json({ error_summary: 'path/conflict/folder/..', error: { '.tag': 'path', path: { '.tag': 'conflict', conflict: { '.tag': 'folder' } } } }, 409),
    'files/move_batch_v2': (body) => (body.entries[0].to_path.includes('Documents') ? { '.tag': 'async_job_id', async_job_id: 'job-1' } : mover()(body)),
    'files/move_batch/check_v2': (body) => {
      assert.equal(body.async_job_id, 'job-1');
      if (++polls < 3) return { '.tag': 'in_progress' };
      return { '.tag': 'complete', entries: [{ '.tag': 'success', success: { '.tag': 'file', id: 'id:a.pdf', path_display: '/Downloads/Documents/a (1).pdf' } }, { '.tag': 'success', success: { '.tag': 'file', id: 'id:b.pdf', path_display: '/Downloads/Documents/b.pdf' } }] };
    },
  });
  const store = new DropboxStore(auth, { folder: '/Downloads' });
  await store.list();
  const moved = await store.move(['id:a.pdf', 'id:b.pdf'], 'Documents');
  const launch = dropbox.calls.find((c) => c.route === 'files/move_batch_v2');
  assert.deepEqual(launch.body, {
    entries: [
      { from_path: 'id:a.pdf', to_path: '/Downloads/Documents/a.pdf' },
      { from_path: 'id:b.pdf', to_path: '/Downloads/Documents/b.pdf' },
    ],
    autorename: true,
  });
  assert.equal(polls, 3);
  assert.deepEqual(sleeps, [250, 500, 1000], 'polling backs off');
  assert.deepEqual(moved, {
    entries: [
      { id: 'id:a.pdf', from: '/Downloads/a.pdf', to: '/Downloads/Documents/a (1).pdf' },
      { id: 'id:b.pdf', from: '/Downloads/b.pdf', to: '/Downloads/Documents/b.pdf' },
    ],
    where: 'Documents/ in Dropbox',
  });
  assert.equal(dropbox.calls.filter((c) => c.route === 'files/create_folder_v2').length, 1);

  const trashed = await store.move(['id:c.zip'], null);
  assert.equal(trashed.where, `${TRASH_FOLDER}/ in Dropbox`);
  assert.deepEqual(dropbox.calls.at(-1).body.entries, [{ from_path: 'id:c.zip', to_path: `/Downloads/${TRASH_FOLDER}/c.zip` }]);
  assert.deepEqual(dropbox.calls.filter((c) => c.route === 'files/create_folder_v2').map((c) => c.body.path), ['/Downloads/Documents', `/Downloads/${TRASH_FOLDER}`]);
  assert.ok(dropbox.calls.every((c) => !/delete/.test(c.route)), 'nothing is ever deleted');

  // b.pdf is already back (a half-finished undo), so only a.pdf moves.
  dropbox.calls.length = 0;
  const routes = { 'files/list_folder': { entries: [file('b.pdf'), file('a (1).pdf', { id: 'id:a.pdf', path_lower: '/downloads/documents/a (1).pdf' })], has_more: false } };
  const again = signedIn({ ...routes, 'files/move_batch_v2': mover() });
  assert.equal(await new DropboxStore(again.auth, { folder: '/Downloads' }).restore(moved), 2);
  const back = again.dropbox.calls.find((c) => c.route === 'files/move_batch_v2');
  assert.deepEqual(back.body, { entries: [{ from_path: 'id:a.pdf', to_path: '/Downloads/a.pdf' }], autorename: true });
});

test('a batch where some files fail keeps undo data for the ones that moved', async () => {
  const fail = new Map([[1, { '.tag': 'too_many_write_operations' }]]);
  const { auth } = signedIn({
    'files/list_folder': { entries: [file('a.pdf'), file('b.pdf'), file('c.pdf')], has_more: false },
    'files/create_folder_v2': { metadata: { name: 'Documents' } },
    'files/move_batch_v2': mover(fail),
  });
  const store = new DropboxStore(auth, { folder: '/Downloads' });
  const chore = createFilesChore({ store, id: 'dropbox', title: 'Folder Frenzy: Dropbox', remote: true });
  const { groups } = await chore.scan();
  const group = { ...groups[0], files: ['id:a.pdf', 'id:b.pdf', 'id:c.pdf'] };
  await assert.rejects(chore.apply(group, 'move:Documents'), (err) => {
    assert.equal(err.count, 2);
    assert.equal(err.moved.where, 'Documents/ in Dropbox');
    assert.deepEqual(err.moved.entries.map((e) => e.id), ['id:a.pdf', 'id:c.pdf']);
    assert.match(err.message, /could not move b\.pdf: Dropbox was busy/);
    assert.match(err.partial.summary, /^moved 2 of 3 files to Documents\/ in Dropbox before it failed/);
    return true;
  });

  const none = signedIn({ 'files/list_folder': { entries: [file('a.pdf')], has_more: false }, 'files/create_folder_v2': {}, 'files/move_batch_v2': mover(new Map([[0, { '.tag': 'relocation_error', relocation_error: { '.tag': 'from_lookup', from_lookup: { '.tag': 'not_found' } } }]])) });
  const lonely = new DropboxStore(none.auth, { folder: '/Downloads' });
  await lonely.list();
  await assert.rejects(lonely.move(['id:a.pdf'], 'Documents'), (err) => err.count === undefined && /no longer there/.test(err.message));
});

test('more than 1000 files go in several batches; a later batch failing keeps the earlier ones', async () => {
  const many = Array.from({ length: 1001 }, (_, i) => file(`f${i}.txt`));
  let batches = 0;
  const { auth, dropbox } = signedIn({
    'files/list_folder': { entries: many, has_more: false },
    'files/create_folder_v2': {},
    'files/move_batch_v2': (body) => (++batches === 1 ? mover()(body) : json({ error_summary: 'other/' }, 500)),
  });
  const store = new DropboxStore(auth, { folder: '/Downloads' });
  await store.list();
  await assert.rejects(store.move(many.map((f) => f.id), 'Documents'), (err) => err.count === 1000 && err.moved.entries.length === 1000);
  assert.deepEqual(dropbox.calls.filter((c) => c.route === 'files/move_batch_v2').map((c) => c.body.entries.length), [1000, 1]);
});

test('a file in the way of a bin, an unscanned id and a job that never finishes are refused clearly', async () => {
  const { auth } = signedIn({
    'files/list_folder': { entries: [file('a.pdf')], has_more: false },
    'files/create_folder_v2': json({ error_summary: 'path/conflict/file/..' }, 409),
  });
  const store = new DropboxStore(auth, { folder: '/Downloads' });
  await store.list();
  await assert.rejects(store.move(['id:a.pdf'], 'Documents'), /a file called Documents is where ChoreCade wants that bin folder/);
  await assert.rejects(store.move(['id:other'], 'Documents'), /scan again/);

  const stuck = signedIn({
    'files/list_folder': { entries: [file('a.pdf')], has_more: false },
    'files/create_folder_v2': {},
    'files/move_batch_v2': { '.tag': 'async_job_id', async_job_id: 'j' },
    'files/move_batch/check_v2': { '.tag': 'in_progress' },
  });
  const slow = new DropboxStore(stuck.auth, { folder: '/Downloads' });
  await slow.list();
  await assert.rejects(slow.move(['id:a.pdf'], 'Documents'), (err) => err.status === 504 && /still moving/.test(err.message));
  assert.ok(stuck.sleeps.reduce((a, b) => a + b, 0) <= 125_000, 'the wait is bounded');
});

test('a restore that fails part-way says how many files went back', async () => {
  const { auth } = signedIn({
    'files/list_folder': { entries: [], has_more: false },
    'files/move_batch_v2': mover(new Map([[1, { '.tag': 'relocation_error', relocation_error: { '.tag': 'to', to: { '.tag': 'insufficient_space' } } }]])),
  });
  const undo = { entries: [{ id: 'id:a', from: '/Downloads/a.pdf', to: '/Downloads/Documents/a.pdf' }, { id: 'id:b', from: '/Downloads/b.pdf', to: '/Downloads/Documents/b.pdf' }], where: 'Documents/ in Dropbox' };
  await assert.rejects(new DropboxStore(auth, { folder: '/Downloads' }).restore(undo), (err) => err.status === 409 && /^put 1 of 2 files back before it failed: Dropbox could not move b\.pdf: the Dropbox is full/.test(err.message));
});
