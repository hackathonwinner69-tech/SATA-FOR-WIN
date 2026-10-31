// A fake Google for the connector tests. It routes by method + URL, answers
// batch requests call by call (in reverse order, which Google is allowed to
// do), and records every HTTP request in `calls` and every API call, batched
// or not, in `inner`.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoogleAuth } from '../src/google/auth.js';

const REPLY = Symbol('reply');
/** A route result with a status other than 200, or extra headers. */
export const reply = (status, body = {}, headers = {}) => ({ [REPLY]: true, status, body, headers });
/** A route result that leaves the call's answer out of the batch response. */
export const DROP = Symbol('drop');

/** Split a batch request body back into its calls, insisting on CRLF line endings. */
export function unpack(body, contentType) {
  const boundary = /boundary=([^;\s]+)/.exec(contentType)[1];
  const sections = body.split(`--${boundary}`);
  if (sections.at(-1) !== '--\r\n') throw new Error('batch body does not end with the closing boundary');
  return sections.slice(1, -1).map((section) => {
    const [partHead, ...rest] = section.replace(/^\r\n/, '').split('\r\n\r\n');
    const [requestHead, ...body] = rest.join('\r\n\r\n').split('\r\n\r\n');
    const [method, path, version] = requestHead.split('\r\n')[0].split(' ');
    if (version !== 'HTTP/1.1' || !/^\//.test(path)) throw new Error(`bad request line in batch part: ${requestHead}`);
    const text = body.join('\r\n\r\n').replace(/\r\n$/, '');
    return { id: /Content-ID: <([^>]+)>/i.exec(partHead)[1], method, path, body: text ? JSON.parse(text) : undefined };
  });
}

/** `now`, when given, stamps every recorded HTTP request with `at`. */
export function fakeGoogle(routes, { now } = {}) {
  const calls = [];
  const inner = [];
  const stats = { inFlight: 0, maxInFlight: 0 };
  const answer = (method, url, body) => {
    inner.push({ method, url, body });
    const route = routes.find(([m, re]) => m === method && re.test(url));
    if (!route) return reply(404, { error: { code: 404, message: `no route for ${method} ${url}` } });
    const out = typeof route[2] === 'function' ? route[2](url, body, inner) : route[2];
    return out === DROP || out?.[REPLY] ? out : reply(200, out);
  };
  const fetchImpl = async (target, init = {}) => {
    const url = String(target);
    const method = init.method ?? 'GET';
    const headers = init.headers ?? {};
    if (/\/batch\//.test(url)) {
      const parts = unpack(init.body, headers['content-type']);
      calls.push({ method, url, parts, headers, at: now?.() });
      stats.maxInFlight = Math.max(stats.maxInFlight, ++stats.inFlight);
      await new Promise((r) => setTimeout(r, 1));
      stats.inFlight--;
      const { origin } = new URL(url);
      const answers = parts.map((p) => [p.id, answer(p.method, origin + p.path, p.body)]).reverse();
      const b = 'batch_fake_Ab12';
      const text = answers
        .filter(([, a]) => a !== DROP)
        .map(([id, a]) =>
          [`--${b}`, 'Content-Type: application/http', `Content-ID: <response-${id}>`, '', `HTTP/1.1 ${a.status} X`, 'Content-Type: application/json; charset=UTF-8', ...Object.entries(a.headers).map(([k, v]) => `${k}: ${v}`), '', JSON.stringify(a.body), ''].join('\r\n'),
        )
        .join('');
      return new Response(`${text}--${b}--\r\n`, { status: 200, headers: { 'content-type': `multipart/mixed; boundary=${b}` } });
    }
    const body = init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body, headers, at: now?.() });
    const a = answer(method, url, body);
    return new Response(JSON.stringify(a.body), { status: a.status, headers: a.headers });
  };
  return { calls, inner, stats, fetchImpl, apiCalls: () => calls.filter((c) => !/oauth2\.googleapis\.com/.test(c.url)) };
}

const TOKEN = ['POST', /oauth2\.googleapis\.com\/token/, (url, body) => ({ access_token: `at-${body.grant_type}`, expires_in: 3600, refresh_token: body.grant_type === 'authorization_code' ? 'rt-1' : undefined, scope: 'gmail drive' })];
const PROFILE = ['GET', /users\/me\/profile/, { emailAddress: 'player@example.com' }];

/**
 * Sign in through the real code exchange against a fake Google. Time is a fake
 * clock: a sleep is recorded and moves the clock on as it wakes, so pacing and
 * backoff cost no real time. Waking on a later turn of the event loop lets
 * whatever is not sleeping (a scan returning) run first, as it would in real time.
 */
export async function signedIn(routes, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'chorecade-g-'));
  const clock = { t: 1_000_000 };
  const google = fakeGoogle([TOKEN, PROFILE, ...routes], { now: () => clock.t });
  const sleeps = [];
  const logs = [];
  const sleep = async (ms) => {
    sleeps.push(ms);
    await new Promise((resolve) => setImmediate(resolve));
    clock.t += ms;
  };
  const auth = new GoogleAuth({ clientId: 'cid', clientSecret: 'secret', tokenFile: join(dir, 'token.json'), fetchImpl: google.fetchImpl, now: () => clock.t, sleep, log: (m) => logs.push(m), ...extra });
  const url = new URL(auth.authUrl('http://127.0.0.1:4747/oauth/google/callback'));
  await auth.exchange('the-code', url.searchParams.get('state'));
  google.signIn = google.calls.splice(0);
  google.inner.length = 0;
  return { auth, google, dir, url, sleeps, clock, logs };
}
