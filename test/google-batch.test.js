import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoogleAuth, SCOPES } from '../src/google/auth.js';
import { batch, buildBatch, parseBatch } from '../src/google/batch.js';
import { unpack } from './google-fake.js';

const CRLF = (lines) => lines.join('\r\n');

/** A batch response the way Google writes one: CRLF, "response-" Content-IDs, JSON bodies. */
function googleResponse(parts, boundary = 'batch_xGm5hLCd2Ys_AAbe2k1bCGw') {
  const text = parts
    .map(([id, status, body, headers = []]) =>
      CRLF([`--${boundary}`, 'Content-Type: application/http', `Content-ID: <response-${id}>`, '', `HTTP/1.1 ${status}`, 'Content-Type: application/json; charset=UTF-8', 'Vary: Origin', 'Vary: X-Origin', 'Vary: Referer', ...headers, '', JSON.stringify(body, null, 2), '', '']),
    )
    .join('');
  return new Response(`${text}--${boundary}--\r\n`, { status: 200, headers: { 'content-type': `multipart/mixed; boundary=${boundary}` } });
}

/** An auth that is already signed in, against `handle(call, calls)`. */
function signedIn(handle) {
  const calls = [];
  const sleeps = [];
  const fetchImpl = async (url, init = {}) => {
    const call = { url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body };
    if (/\/batch\//.test(call.url)) call.parts = unpack(init.body, call.headers['content-type']);
    calls.push(call);
    return handle(call, calls);
  };
  const auth = new GoogleAuth({ clientId: 'cid', clientSecret: 'secret', tokenFile: join(tmpdir(), 'chorecade-gb-unused.json'), fetchImpl, sleep: async (ms) => sleeps.push(ms), log: () => {} });
  auth.token = { refresh_token: 'rt', access_token: 'at', expires_at: Date.now() + 3600_000, scope: Object.values(SCOPES).join(' '), email: 'p@example.com' };
  return { auth, calls, sleeps };
}

const URL_GMAIL = 'https://gmail.googleapis.com/batch/gmail/v1';
const get = (id) => ({ method: 'GET', path: `/gmail/v1/users/me/messages/${id}`, query: [['format', 'metadata'], ['metadataHeaders', 'From']] });

test('a batch request is one application/http part per call, with CRLF line endings', () => {
  const body = buildBatch(
    [
      { method: 'GET', path: '/gmail/v1/users/me/messages/a', query: [['format', 'metadata'], ['metadataHeaders', 'From'], ['metadataHeaders', 'Subject']] },
      { method: 'PATCH', path: '/drive/v3/files/f1', query: { fields: 'id' }, body: { trashed: true } },
    ],
    'b0',
  );
  assert.equal(
    body,
    CRLF([
      '--b0',
      'Content-Type: application/http',
      'Content-ID: <item0>',
      '',
      'GET /gmail/v1/users/me/messages/a?format=metadata&metadataHeaders=From&metadataHeaders=Subject HTTP/1.1',
      '',
      '',
      '--b0',
      'Content-Type: application/http',
      'Content-ID: <item1>',
      '',
      'PATCH /drive/v3/files/f1?fields=id HTTP/1.1',
      'Content-Type: application/json; charset=UTF-8',
      'Content-Length: 16',
      '',
      '{"trashed":true}',
      '--b0--',
      '',
    ]),
  );
});

test('a batch response is read by Content-ID, in any order, error parts included', async () => {
  const res = googleResponse([
    ['item2', '404 Not Found', { error: { code: 404, message: 'Requested entity was not found.', errors: [{ message: 'Requested entity was not found.', domain: 'global', reason: 'notFound' }], status: 'NOT_FOUND' } }],
    ['item0', '200 OK', { id: 'a', internalDate: '1767225600000', payload: { headers: [{ name: 'From', value: 'Sam <sam@friends.example>' }] } }],
    ['item1', '429 Too Many Requests', { error: { code: 429, message: 'Too many concurrent requests for user.', status: 'RESOURCE_EXHAUSTED' } }, ['Retry-After: 3']],
  ]);
  const answers = parseBatch(await res.text(), res.headers.get('content-type'));
  assert.deepEqual([...answers.keys()], ['item2', 'item0', 'item1']);
  assert.equal(answers.get('item0').status, 200);
  assert.equal(answers.get('item0').body.payload.headers[0].value, 'Sam <sam@friends.example>');
  assert.equal(answers.get('item1').headers['retry-after'], '3');
  assert.equal(answers.get('item2').body.error.status, 'NOT_FOUND');

  const quoted = parseBatch(CRLF(['--"q"', 'Content-ID: <response-item0>', '', 'HTTP/1.1 204 No Content', '', '', '--"q"--', '']).replaceAll('"q"', 'q'), 'multipart/mixed; boundary="q"');
  assert.deepEqual(quoted.get('item0'), { status: 204, headers: {}, body: {} }, 'a quoted boundary and an empty body');
  assert.equal(parseBatch('{}', 'application/json'), null);
});

test('batch() returns answers in request order and retries only the rate-limited call', async () => {
  const { auth, calls, sleeps } = signedIn((call, all) =>
    all.length === 1
      ? googleResponse([
          ['item1', '429 Too Many Requests', { error: { code: 429, message: 'Rate Limit Exceeded' } }, ['Retry-After: 2']],
          ['item2', '404 Not Found', { error: { code: 404, message: 'Requested entity was not found.' } }],
          ['item0', '200 OK', { id: 'a' }],
        ])
      : googleResponse([['item0', '200 OK', { id: 'b' }]]),
  );
  const out = await batch(auth, URL_GMAIL, [get('a'), get('b'), get('c')]);
  assert.deepEqual(out.map((a) => [a.status, a.body.id ?? a.body.error.message]), [[200, 'a'], [200, 'b'], [404, 'Requested entity was not found.']]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].parts.map((p) => p.path), ['/gmail/v1/users/me/messages/b?format=metadata&metadataHeaders=From']);
  assert.deepEqual(sleeps, [2000]);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.authorization, 'Bearer at');
  assert.match(calls[0].headers['content-type'], /^multipart\/mixed; boundary=batch_\w+$/);
});

test('batch() gives up on a call after a bounded number of retries', async () => {
  const { auth, calls } = signedIn(() => googleResponse([['item0', '503 Service Unavailable', { error: { code: 503, message: 'Backend Error' } }]]));
  const [answer] = await batch(auth, URL_GMAIL, [get('a')]);
  assert.equal(answer.status, 503);
  assert.equal(calls.length, 5);
});

test('a missing part is a failure for that call: retried when safe to repeat, never for a create', async () => {
  // Google never answers the call for message b.
  const gets = signedIn((call) => googleResponse(call.parts.filter((p) => /messages\/a\?/.test(p.path)).map((p) => [p.id, '200 OK', { id: 'a' }])));
  const out = await batch(gets.auth, URL_GMAIL, [get('a'), get('b')]);
  assert.equal(out[0].status, 200);
  assert.equal(out[1].status, 502);
  assert.match(out[1].body.error.message, /no answer/);
  assert.equal(gets.calls.length, 1 + 4, 'the unanswered GET was asked for again, a bounded number of times');

  const creates = signedIn(() => googleResponse([['item1', '500 Internal Server Error', { error: { code: 500, message: 'Backend Error' } }]]));
  const made = await batch(creates.auth, 'https://www.googleapis.com/batch/drive/v3', [
    { method: 'POST', path: '/drive/v3/files', body: { name: 'Documents' } },
    { method: 'POST', path: '/drive/v3/files', body: { name: 'Images' } },
  ]);
  assert.deepEqual(made.map((a) => a.status), [502, 500]);
  assert.equal(creates.calls.length, 1, 'a create is never sent twice');
});

test('an outer 401 refreshes the token once and the batch goes through', async () => {
  const { auth, calls } = signedIn((call) => {
    if (/oauth2\.googleapis\.com\/token/.test(call.url)) return new Response(JSON.stringify({ access_token: 'at-new', expires_in: 3600 }), { status: 200 });
    if (call.headers.authorization === 'Bearer at') return new Response(JSON.stringify({ error: { code: 401, message: 'Invalid Credentials', status: 'UNAUTHENTICATED' } }), { status: 401 });
    return googleResponse([['item0', '200 OK', { id: 'a' }]]);
  });
  const [answer] = await batch(auth, URL_GMAIL, [get('a')]);
  assert.deepEqual(answer.body, { id: 'a' });
  assert.deepEqual(calls.map((c) => c.headers.authorization ?? 'token'), ['Bearer at', 'token', 'Bearer at-new']);
});

test('an outer error or a reply that is not a batch fails the whole batch clearly', async () => {
  const denied = signedIn(() => new Response(JSON.stringify({ error: { code: 403, message: 'Gmail API has not been used in project 123 before or it is disabled.' } }), { status: 403 }));
  await assert.rejects(batch(denied.auth, URL_GMAIL, [get('a')]), (err) => err.status === 403 && /Google batch request failed with HTTP 403: Gmail API has not been used/.test(err.message));

  const odd = signedIn(() => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
  await assert.rejects(batch(odd.auth, URL_GMAIL, [get('a')]), (err) => err.status === 502 && /not a batch response/.test(err.message));

  const flaky = signedIn((call, all) => (all.length === 1 ? new Response('<html>oops</html>', { status: 502 }) : googleResponse([['item0', '200 OK', { id: 'a' }]])));
  assert.equal((await batch(flaky.auth, URL_GMAIL, [get('a')]))[0].status, 200, 'a batch of GETs is retried as a whole after a 502');
});

test('a part refused as rate limited with a 403 is retried; a 403 for the daily limit is not', async () => {
  const limit = (reason) => ({ error: { code: 403, message: reason, errors: [{ domain: 'usageLimits', reason, message: reason }] } });
  const { auth, calls } = signedIn((call, all) =>
    all.length === 1
      ? googleResponse([
          ['item0', '403 Forbidden', limit('userRateLimitExceeded')],
          ['item1', '403 Forbidden', limit('dailyLimitExceeded')],
          ['item2', '403 Forbidden', limit('rateLimitExceeded')],
        ])
      : googleResponse(call.parts.map((p) => [p.id, '200 OK', { path: p.path }])),
  );
  const out = await batch(auth, URL_GMAIL, [get('a'), get('b'), get('c')]);
  assert.deepEqual(out.map((a) => a.status), [200, 403, 200]);
  assert.equal(out[1].body.error.message, 'dailyLimitExceeded');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].parts.map((p) => p.path.split('?')[0]), ['/gmail/v1/users/me/messages/a', '/gmail/v1/users/me/messages/c']);
});

test('beforeSend runs before every send of a batch, retries included', async () => {
  const { auth } = signedIn((call, all) => (all.length === 1 ? googleResponse([['item0', '200 OK', {}], ['item1', '429 Too Many Requests', { error: { code: 429 } }]]) : googleResponse([['item0', '200 OK', {}]])));
  const sizes = [];
  await batch(auth, URL_GMAIL, [get('a'), get('b')], { beforeSend: async (sent) => sizes.push(sent.length) });
  assert.deepEqual(sizes, [2, 1]);
});
