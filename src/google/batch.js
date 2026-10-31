// Google's batch endpoint: many API calls in one multipart/mixed HTTP request.
// https://developers.google.com/workspace/gmail/api/guides/batch
// Every call in a batch still counts against quota; batching saves round trips.
import { randomBytes } from 'node:crypto';
import { RETRIES, googleError, rateLimited, repeatable } from './auth.js';

/** Run `fn` over `items` with at most `limit` in flight. */
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

export function chunks(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function parseJson(text) {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Header lines to a lower-cased name -> value object. */
function headerMap(lines) {
  const headers = {};
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return headers;
}

/** Split an HTTP message (or MIME part) into its header lines and body. */
function splitMessage(text) {
  const end = /\r?\n\r?\n/.exec(text);
  const head = end ? text.slice(0, end.index) : text;
  return { lines: head.split(/\r?\n/), body: end ? text.slice(end.index + end[0].length) : '' };
}

/**
 * The multipart/mixed body for `calls` ({ method, path, query, body }): one
 * application/http part per call, with Content-ID item<index>. Paths only,
 * no host: Google refuses full URLs inside a batch.
 */
export function buildBatch(calls, boundary) {
  const parts = calls.map((call, i) => {
    const query = call.query ? String(new URLSearchParams(call.query)) : '';
    const head = [`--${boundary}`, 'Content-Type: application/http', `Content-ID: <item${i}>`, '', `${call.method ?? 'GET'} ${call.path}${query ? `?${query}` : ''} HTTP/1.1`];
    if (call.body === undefined) return [...head, '', ''].join('\r\n');
    const json = JSON.stringify(call.body);
    return [...head, 'Content-Type: application/json; charset=UTF-8', `Content-Length: ${Buffer.byteLength(json)}`, '', json].join('\r\n');
  });
  return `${parts.join('\r\n')}\r\n--${boundary}--\r\n`;
}

/**
 * The answers in a multipart/mixed batch response, by Content-ID without the
 * "response-" prefix Google adds: Map id -> { status, headers, body }. Body is
 * the parsed JSON, {} when empty, null when not JSON. Null when the response
 * is not multipart at all.
 */
export function parseBatch(text, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^\s;]+))/i.exec(contentType ?? '');
  if (!match) return null;
  const answers = new Map();
  const sections = `\r\n${text}`.split(new RegExp(`\\r?\\n--${escapeRe(match[1] ?? match[2])}`));
  for (const section of sections.slice(1)) {
    if (section.startsWith('--')) break;
    const part = splitMessage(section.replace(/^[ \t]*\r?\n/, ''));
    const id = /^<?(?:response-)?(.*?)>?$/.exec(headerMap(part.lines)['content-id'] ?? '')?.[1];
    const inner = splitMessage(part.body);
    const status = Number(/^HTTP\/[\d.]+\s+(\d{3})/.exec(inner.lines[0])?.[1]);
    if (id && status) answers.set(id, { status, headers: headerMap(inner.lines.slice(1)), body: parseJson(inner.body) });
  }
  return answers;
}

export const succeeded = (answer) => answer.status >= 200 && answer.status < 300 && answer.body !== null;

/** The error for one failed call in a batch, worded like a failed single request. */
export const answerError = (what, answer) => googleError(what, { status: answer.status, statusText: '' }, answer.body);

const NO_ANSWER = { error: { message: 'Google sent no answer for this call in the batch' } };

/**
 * Send `calls` ({ method, path, query, body, idempotent }) to the batch
 * endpoint `url` as one request through `auth`, so the token, refresh and
 * retry rules of a single request apply to the batch as a whole. Resolves with
 * one { status, headers, body } per call, in order. A call refused as rate
 * limited (429, or 403 rateLimitExceeded) is sent again, and so is one
 * answered 5xx or not at all when it is safe to repeat, up to RETRIES times
 * with the usual backoff. `beforeSend(calls)` runs before every send,
 * retries included, e.g. to wait for quota.
 */
export async function batch(auth, url, calls, { beforeSend } = {}) {
  const results = new Array(calls.length);
  let pending = calls.map((_, i) => i);
  for (let attempt = 0; pending.length; attempt++) {
    const sent = pending.map((i) => calls[i]);
    const boundary = `batch_${randomBytes(12).toString('hex')}`;
    await beforeSend?.(sent);
    const res = await auth.send(url, {
      method: 'POST',
      headers: { 'content-type': `multipart/mixed; boundary=${boundary}` },
      body: buildBatch(sent, boundary),
      idempotent: sent.every((call) => repeatable(call.method, call.idempotent)),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw googleError('Google batch request', res, parseJson(text));
    const answers = parseBatch(text, res.headers.get('content-type'));
    if (!answers) throw Object.assign(new Error(`Google batch request returned HTTP ${res.status} but not a batch response`), { status: 502 });
    const retry = [];
    let delay = 0;
    sent.forEach((call, k) => {
      const answer = answers.get(`item${k}`) ?? { status: 502, headers: {}, body: NO_ANSWER };
      const again = rateLimited(answer.status, answer.body) || (answer.status >= 500 && repeatable(call.method, call.idempotent));
      if (again && attempt < RETRIES) {
        retry.push(pending[k]);
        delay = Math.max(delay, auth.backoff(attempt, answer.headers['retry-after']));
      } else {
        results[pending[k]] = answer;
      }
    });
    pending = retry;
    if (pending.length) await auth.sleep(delay);
  }
  return results;
}
