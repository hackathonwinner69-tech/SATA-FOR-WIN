import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Arcade } from '../src/arcade.js';
import { GoogleAuth, SCOPES } from '../src/google/auth.js';
import { mountGoogle } from '../src/google/index.js';
import { exportToSheets } from '../src/google/sheets.js';

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });

/** A fake fetch: `handle(url, init, calls)` returns a Response or throws; every call is recorded. */
function fakeFetch(handle) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = { url: String(url), method: init.method ?? 'GET', body: init.body, signal: init.signal };
    calls.push(call);
    return handle(call, calls);
  };
  return { calls, fetchImpl };
}

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'chorecade-ga-'));
}

/** An auth that is already signed in, with an injected clock, sleep and log. */
function signedIn(handle, { token = {}, tokenFile = join(tmpdir(), 'chorecade-ga-unused.json'), ...extra } = {}) {
  const google = fakeFetch(handle);
  const sleeps = [];
  const logs = [];
  const auth = new GoogleAuth({
    clientId: 'cid',
    clientSecret: 'secret',
    tokenFile,
    fetchImpl: google.fetchImpl,
    sleep: async (ms) => sleeps.push(ms),
    log: (msg) => logs.push(msg),
    ...extra,
  });
  auth.token = { refresh_token: 'rt', access_token: 'at', expires_at: Date.now() + 3600_000, scope: Object.values(SCOPES).join(' '), email: 'p@example.com', ...token };
  return { auth, google, sleeps, logs };
}

const API = 'https://www.googleapis.com/drive/v3/files';

test('a POST that creates something is not retried after a 500, but a GET is', async () => {
  const post = signedIn(() => json({ error: { message: 'backend error' } }, 500));
  await assert.rejects(post.auth.api(API, { method: 'POST', body: { name: 'Documents' } }), (err) => err.status === 500 && /HTTP 500: backend error/.test(err.message));
  assert.equal(post.google.calls.length, 1, 'the folder create was sent once');

  const get = signedIn((call, calls) => (calls.length < 3 ? json({}, 503) : json({ files: [] })));
  assert.deepEqual(await get.auth.api(API), { files: [] });
  assert.equal(get.google.calls.length, 3);
  assert.equal(get.sleeps.length, 2);
  assert.ok(get.sleeps[1] > get.sleeps[0] / 2, 'backoff grows');
});

test('a POST marked idempotent is retried after a 500', async () => {
  const { auth, google } = signedIn((call, calls) => (calls.length === 1 ? json({}, 500) : json({ ok: true })));
  assert.deepEqual(await auth.api('https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify', { method: 'POST', body: { ids: ['a'] }, idempotent: true }), { ok: true });
  assert.equal(google.calls.length, 2);
});

test('429 is retried even for a POST, waiting as long as Retry-After says (capped)', async () => {
  const { auth, google, sleeps } = signedIn((call, calls) => {
    if (calls.length === 1) return json({}, 429, { 'retry-after': '2' });
    if (calls.length === 2) return json({}, 429, { 'retry-after': '3600' });
    return json({ id: 'f1' });
  });
  assert.deepEqual(await auth.api(API, { method: 'POST', body: {} }), { id: 'f1' });
  assert.equal(google.calls.length, 3);
  assert.deepEqual(sleeps, [2000, 30_000]);
});

test('retries stop after a few attempts and report the last status', async () => {
  const { auth, google } = signedIn(() => json({ error: { message: 'still down' } }, 503));
  await assert.rejects(auth.api(API), (err) => err.status === 503 && /still down/.test(err.message));
  assert.equal(google.calls.length, 5);
});

test('an HTML error page gives a clear error with the HTTP status', async () => {
  const { auth } = signedIn(() => new Response('<html><body>Bad Gateway</body></html>', { status: 502, statusText: 'Bad Gateway', headers: { 'content-type': 'text/html' } }));
  await assert.rejects(auth.api(API, { method: 'POST', body: {} }), (err) => {
    assert.ok(!(err instanceof SyntaxError));
    assert.equal(err.status, 502);
    assert.match(err.message, /HTTP 502: the response was not JSON/);
    return true;
  });
});

test('an HTML page from the token endpoint keeps its status too', async () => {
  const { auth } = signedIn(() => new Response('<html>oops</html>', { status: 500 }), { token: { access_token: null } });
  await assert.rejects(auth.accessToken(), (err) => err.status === 500 && /token request failed with HTTP 500/.test(err.message));
});

test('concurrent calls with an expired token share one refresh, made before expiry', async () => {
  let clock = 1_000_000;
  const { auth, google } = signedIn(
    async (call) => {
      if (/oauth2\.googleapis\.com\/token/.test(call.url)) {
        await new Promise((r) => setTimeout(r, 5));
        return json({ access_token: 'at-new', expires_in: 3600 });
      }
      return json({ ok: true });
    },
    { now: () => clock, token: { expires_at: clock + 30_000 } },
  );
  const results = await Promise.all(Array.from({ length: 10 }, () => auth.api(API)));
  assert.equal(results.length, 10);
  assert.equal(google.calls.filter((c) => /oauth2\.googleapis\.com\/token/.test(c.url)).length, 1, 'token 30 s from expiry is refreshed once');
  assert.equal(await auth.accessToken(), 'at-new');
  clock += 3600_000 - 61_000;
  assert.equal(await auth.accessToken(), 'at-new', 'still fresh more than a minute before expiry');
});

test('a revoked refresh token clears the sign-in and asks to connect again', async () => {
  const dir = await tempDir();
  const tokenFile = join(dir, 'token.json');
  await writeFile(tokenFile, JSON.stringify({ refresh_token: 'rt' }));
  const { auth } = signedIn(() => json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400), { tokenFile, token: { access_token: null } });
  await assert.rejects(auth.api(API), (err) => err.status === 401 && /connect Google again/.test(err.message));
  assert.equal(auth.connected, false);
  await assert.rejects(stat(tokenFile), { code: 'ENOENT' });
  await rm(dir, { recursive: true, force: true });
});

test('every request has a timeout; a timed-out GET is retried, a timed-out create is not', async () => {
  const timeout = () => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  };
  const get = signedIn((call, calls) => (calls.length === 1 ? timeout() : json({ files: [] })));
  assert.deepEqual(await get.auth.api(API), { files: [] });
  assert.equal(get.google.calls.length, 2);
  assert.ok(get.google.calls.every((c) => c.signal instanceof AbortSignal));

  const post = signedIn(timeout);
  await assert.rejects(post.auth.api('https://sheets.googleapis.com/v4/spreadsheets', { method: 'POST', body: {} }), /timed out after 30 s/);
  assert.equal(post.google.calls.length, 1);
});

test('the token is written privately and atomically; a damaged file is ignored at start-up', async () => {
  const dir = await tempDir();
  const tokenFile = join(dir, 'nested', 'google-token.json');
  const { auth } = signedIn(() => json({}), { tokenFile });
  await auth.save();
  if (process.platform !== 'win32') {
    assert.equal((await stat(join(dir, 'nested'))).mode & 0o777, 0o700);
    assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
  }
  assert.deepEqual(await readdir(join(dir, 'nested')), ['google-token.json'], 'no temp file left behind');
  assert.equal(JSON.parse(await readFile(tokenFile, 'utf8')).refresh_token, 'rt');

  await writeFile(tokenFile, '{"refresh_tok');
  const fresh = signedIn(() => json({}), { tokenFile });
  assert.equal(await fresh.auth.load(), false);
  assert.equal(fresh.auth.connected, false);
  assert.match(fresh.logs.join('\n'), /damaged/);

  const missing = signedIn(() => json({}), { tokenFile: join(dir, 'none.json') });
  assert.equal(await missing.auth.load(), false);
  assert.deepEqual(missing.logs, [], 'no token yet is not an error');
  await rm(dir, { recursive: true, force: true });
});

/** Sign in through the real exchange, with `profile` answering the email lookup. */
async function exchangeWith({ scope, profile }) {
  const dir = await tempDir();
  const { auth, google, logs } = signedIn((call) => {
    if (/oauth2\.googleapis\.com\/token/.test(call.url)) return json({ access_token: 'at', expires_in: 3600, refresh_token: 'rt-1', scope });
    return profile(call);
  }, { tokenFile: join(dir, 'token.json') });
  auth.token = null;
  const url = new URL(auth.authUrl('http://127.0.0.1:1/oauth/google/callback'));
  return { auth, google, logs, dir, state: url.searchParams.get('state') };
}

test('a failed email lookup after sign-in keeps the connection', async () => {
  const { auth, dir, state, logs } = await exchangeWith({ scope: SCOPES.gmail, profile: () => json({ error: { message: 'forbidden' } }, 403) });
  assert.equal(await auth.exchange('code', state), null);
  assert.deepEqual(auth.status(), { configured: true, connected: true, email: null });
  assert.equal(JSON.parse(await readFile(join(dir, 'token.json'), 'utf8')).refresh_token, 'rt-1');
  assert.match(logs.join('\n'), /could not look up/);
  await rm(dir, { recursive: true, force: true });
});

/** mountGoogle against recorded routes instead of a real Express app. */
function mounted(auth, options = {}) {
  const handlers = {};
  const router = (verb) => (path, fn) => (handlers[`${verb} ${path}`] = fn);
  const app = { get: router('GET') };
  const api = { get: router('GET'), post: router('POST') };
  const arcade = new Arcade({ chores: [], journalFile: join(tmpdir(), 'chorecade-ga-journal.jsonl'), mode: 'demo' });
  mountGoogle({ app, api, arcade, auth, port: 4999, options });
  const call = async (key, req = {}) => {
    const res = {
      code: 200,
      status(c) {
        this.code = c;
        return this;
      },
      type() {
        return this;
      },
      json(b) {
        this.body = b;
      },
      send(b) {
        this.body = b;
      },
      redirect(u) {
        this.code = 302;
        this.location = u;
      },
    };
    await handlers[key]({ params: {}, query: {}, ...req }, res);
    return res;
  };
  return { arcade, call };
}

test('only the cabinets whose scopes were granted are added, at sign-in and at start-up', async () => {
  const { auth, dir, state } = await exchangeWith({ scope: `${SCOPES.gmail} openid`, profile: () => json({ emailAddress: 'p@example.com' }) });
  const { arcade, call } = mounted(auth, { dataDir: dir });
  const res = await call('GET /oauth/google/callback', { query: { code: 'c', state } });
  assert.equal(res.location, 'http://localhost:4999/?google=connected&skipped=drive');
  assert.deepEqual([...arcade.chores.keys()], ['gmail']);
  assert.deepEqual((await call('GET /google')).body.skipped, ['drive']);

  const later = signedIn(() => json({}), { tokenFile: auth.tokenFile });
  await later.auth.load();
  const restarted = mounted(later.auth, { dataDir: dir });
  assert.deepEqual([...restarted.arcade.chores.keys()], ['gmail']);
  assert.match(later.logs.join('\n'), /Drive access was not granted/);

  const both = signedIn(() => json({}));
  assert.deepEqual([...mounted(both.auth, { dataDir: dir }).arcade.chores.keys()], ['gmail', 'drive']);
  const driveOnly = signedIn(() => json({}), { token: { scope: SCOPES.drive } });
  assert.deepEqual([...mounted(driveOnly.auth, { dataDir: dir }).arcade.chores.keys()], ['drive']);
  await rm(dir, { recursive: true, force: true });
});

test('connecting again while connected is refused', async () => {
  const { auth } = signedIn(() => json({}));
  const res = await mounted(auth).call('POST /google/connect');
  assert.equal(res.code, 409);
  assert.match(res.body.error, /disconnect first/);
});

test('a dry-run Sheets export creates nothing and shows what it would export', async () => {
  const table = { title: 'Expenses', tabs: [{ name: 'Totals', rows: [['Category', 'Total'], ['Food', 12]] }] };
  const { auth, google } = signedIn(() => json({ spreadsheetId: 's' }));
  assert.deepEqual(await exportToSheets(auth, table, { dryRun: true }), { dryRun: true, id: null, url: null, ...table });

  const { arcade, call } = mounted(auth, { dryRun: true });
  arcade.addChore({ id: 'expenses', title: 'Receipts', table: async () => table });
  const res = await call('POST /chores/:id/export/sheets', { params: { id: 'expenses' } });
  assert.equal(res.body.dryRun, true);
  assert.equal(google.calls.length, 0);
});

test('disconnect forgets the token even when Google fails to revoke it, and says so', async () => {
  const dir = await tempDir();
  const tokenFile = join(dir, 'token.json');
  await writeFile(tokenFile, '{}');
  const { auth, google } = signedIn(() => json({ error: 'server_error' }, 500), { tokenFile });
  const { arcade, call } = mounted(auth, { dataDir: dir });
  assert.equal(arcade.chores.size, 2);
  const res = await call('POST /google/disconnect');
  assert.equal(res.body.connected, false);
  assert.equal(res.body.revoked, false);
  assert.match(res.body.warning, /myaccount\.google\.com\/permissions/);
  assert.equal(arcade.chores.size, 0);
  await assert.rejects(stat(tokenFile), { code: 'ENOENT' });
  assert.ok(google.calls[0].signal instanceof AbortSignal);

  const ok = signedIn(() => new Response('', { status: 200 }));
  assert.deepEqual(await ok.auth.disconnect(), { revoked: true });
  const gone = signedIn(() => json({ error: 'invalid_token' }, 400));
  assert.deepEqual(await gone.auth.disconnect(), { revoked: true }, 'a token Google no longer knows has no access left');
  const offline = signedIn(() => {
    throw new TypeError('fetch failed');
  });
  assert.deepEqual(await offline.auth.disconnect(), { revoked: false });
  await rm(dir, { recursive: true, force: true });
});

test('a sign-in that Google revoked takes the Gmail and Drive cabinets with it', async () => {
  const dir = await tempDir();
  const { auth } = signedIn(() => json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400), { tokenFile: join(dir, 'token.json'), token: { access_token: null } });
  const { arcade } = mounted(auth, { dataDir: dir });
  assert.deepEqual([...arcade.chores.keys()], ['gmail', 'drive']);
  await assert.rejects(auth.api(API), (err) => err.status === 401);
  assert.equal(arcade.chores.size, 0);
  await rm(dir, { recursive: true, force: true });
});

test('a 403 rate limit is retried like a 429, even for a create; other 403s are not', async () => {
  const refused = (reason, message = 'User Rate Limit Exceeded') => json({ error: { code: 403, message, errors: [{ domain: 'usageLimits', reason, message }] } }, 403);
  const post = signedIn((call, calls) => (calls.length === 1 ? refused('userRateLimitExceeded') : json({ id: 'f1' })));
  assert.deepEqual(await post.auth.api(API, { method: 'POST', body: { name: 'Documents' } }), { id: 'f1' });
  assert.equal(post.google.calls.length, 2, 'refused, so it never ran: safe to send again');

  const get = signedIn((call, calls) => (calls.length < 3 ? refused('rateLimitExceeded', 'Rate Limit Exceeded') : json({ files: [] })));
  assert.deepEqual(await get.auth.api(API), { files: [] });
  assert.equal(get.google.calls.length, 3);

  for (const reason of ['dailyLimitExceeded', 'quotaExceeded', 'insufficientPermissions']) {
    const other = signedIn(() => refused(reason, `no: ${reason}`));
    await assert.rejects(other.auth.api(API), (err) => err.status === 403 && err.message === `Google API GET failed with HTTP 403: no: ${reason}`);
    assert.equal(other.google.calls.length, 1, `${reason} is not retried`);
  }
});
