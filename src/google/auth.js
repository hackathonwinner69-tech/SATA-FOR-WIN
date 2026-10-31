// Google sign-in for a desktop app: OAuth 2.0 authorization code flow with
// PKCE and a loopback redirect, as Google recommends for installed apps.
// https://developers.google.com/identity/protocols/oauth2/native-app
// The refresh token is kept in a local file readable only by this user.
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export const SCOPES = {
  // Read headers and move mail between labels; cannot permanently delete.
  gmail: 'https://www.googleapis.com/auth/gmail.modify',
  // See and move files in Drive (needed to sort files ChoreCade did not create).
  drive: 'https://www.googleapis.com/auth/drive',
};

// Broader grants that also cover what each cabinet needs.
const ALSO_COVERS = { gmail: ['https://mail.google.com/'], drive: [] };

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const STATE_TTL = 10 * 60 * 1000;
const TIMEOUT = 30_000;
const REFRESH_EARLY = 60_000;
const RETRIES = 4;
const MAX_WAIT = 30_000;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'PUT', 'DELETE']);

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Parse a response body without letting an HTML error page hide the status. */
async function readBody(res) {
  const text = await res.text().catch(() => '');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function googleError(what, res, data) {
  const detail = data?.error?.message ?? data?.error_description ?? (typeof data?.error === 'string' ? data.error : null);
  const why = detail ?? (data === null ? 'the response was not JSON' : res.statusText);
  const code = typeof data?.error === 'string' ? data.error : data?.error?.status;
  return Object.assign(new Error(`${what} failed with HTTP ${res.status}${why ? `: ${why}` : ''}`), { status: res.status, code });
}

function fetchError(what, err) {
  const message = err?.name === 'TimeoutError' ? `${what} timed out after ${TIMEOUT / 1000} s` : `${what} could not reach Google: ${err?.message ?? err}`;
  return Object.assign(new Error(message), { cause: err });
}

export class GoogleAuth {
  constructor({ clientId, clientSecret, tokenFile, fetchImpl = fetch, now = () => Date.now(), sleep = wait, random = Math.random, log = console.warn }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.tokenFile = tokenFile;
    this.fetch = fetchImpl;
    this.now = now;
    this.sleep = sleep;
    this.random = random;
    this.log = log;
    this.pending = new Map(); // state -> { verifier, redirectUri, at }
    this.token = null; // { refresh_token, access_token, expires_at, scope, email }
    this.refreshing = null;
    this.onRevoked = null; // called once Google has rejected the saved sign-in and it is forgotten
  }

  get configured() {
    return Boolean(this.clientId && this.clientSecret);
  }

  get connected() {
    return Boolean(this.token?.refresh_token);
  }

  async load() {
    this.token = null;
    let text;
    try {
      text = await readFile(this.tokenFile, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') this.log(`Google: could not read the saved sign-in (${err.message}); connect Google again`);
      return false;
    }
    try {
      const token = JSON.parse(text);
      if (!token?.refresh_token) throw new Error('no refresh token');
      this.token = token;
    } catch {
      this.log(`Google: the saved sign-in in ${this.tokenFile} is damaged and was ignored; connect Google again`);
    }
    return this.connected;
  }

  /** Whether the signed-in account granted what a cabinet ('gmail' or 'drive') needs. */
  granted(name) {
    if (!this.connected) return false;
    // Google leaves `scope` out only when it granted exactly what was asked for.
    if (typeof this.token.scope !== 'string') return true;
    const scopes = this.token.scope.split(/\s+/);
    return [SCOPES[name], ...ALSO_COVERS[name]].some((s) => scopes.includes(s));
  }

  /** Build the consent URL. `state` ties the callback to this request; PKCE ties the code to us. */
  authUrl(redirectUri, scopes = Object.values(SCOPES)) {
    if (!this.configured) throw Object.assign(new Error('Google sign-in is not set up: add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET'), { status: 400 });
    const state = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(48));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    for (const [s, p] of this.pending) if (this.now() - p.at > STATE_TTL) this.pending.delete(s);
    this.pending.set(state, { verifier, redirectUri, at: this.now() });
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: scopes.join(' '),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
    });
    return `${AUTH_URL}?${params}`;
  }

  /** Finish sign-in. The state must match a request we made in the last ten minutes, once. */
  async exchange(code, state) {
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || this.now() - pending.at > STATE_TTL) throw Object.assign(new Error('sign-in expired or was not started here; try again'), { status: 400 });
    const data = await this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: pending.redirectUri,
      code_verifier: pending.verifier,
    });
    if (!data.refresh_token) throw new Error('Google did not return a refresh token; remove ChoreCade from your Google account permissions and sign in again');
    this.refreshing = null;
    this.token = { refresh_token: data.refresh_token, scope: data.scope, ...this.accessFrom(data), email: null };
    try {
      this.token.email = await this.lookupEmail();
    } catch (err) {
      this.log(`Google: signed in, but could not look up the account's email address (${err.message})`);
    }
    await this.save();
    return this.token.email;
  }

  accessFrom(data) {
    return { access_token: data.access_token, expires_at: this.now() + data.expires_in * 1000 };
  }

  async tokenRequest(fields) {
    let res;
    try {
      res = await this.fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, ...fields }),
        signal: AbortSignal.timeout(TIMEOUT),
      });
    } catch (err) {
      throw fetchError('Google token request', err);
    }
    const data = await readBody(res);
    if (!res.ok) throw googleError('Google token request', res, data);
    if (!data) throw Object.assign(new Error(`Google token request returned HTTP ${res.status} but the response was not JSON`), { status: 502 });
    return data;
  }

  /** A current access token. Concurrent callers share one refresh. */
  async accessToken() {
    if (!this.connected) throw Object.assign(new Error('not signed in to Google'), { status: 401 });
    if (this.token.access_token && this.now() < this.token.expires_at - REFRESH_EARLY) return this.token.access_token;
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  async refresh() {
    const token = this.token;
    try {
      const data = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: token.refresh_token });
      Object.assign(token, this.accessFrom(data));
      return token.access_token;
    } catch (err) {
      if (err.code !== 'invalid_grant') throw err;
      // The grant was revoked or expired at Google: the saved token is useless now.
      if (this.token === token) {
        this.token = null;
        await rm(this.tokenFile, { force: true }).catch(() => {});
        this.onRevoked?.();
      }
      throw Object.assign(new Error('Google access was revoked or has expired; connect Google again'), { status: 401 });
    }
  }

  /**
   * Authorised JSON request. Rate limits (429) are always retried; server
   * errors, timeouts and network errors only when the request is safe to
   * repeat (GET, HEAD, PUT, DELETE, or `idempotent: true`), so a POST that
   * creates something never runs twice.
   */
  async api(url, { method = 'GET', body, query, idempotent } = {}) {
    const target = query ? `${url}?${new URLSearchParams(query)}` : url;
    const repeatable = idempotent ?? SAFE_METHODS.has(method.toUpperCase());
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const canRetry = attempt < RETRIES;
      const accessToken = await this.accessToken();
      let res;
      try {
        res = await this.fetch(target, {
          method,
          headers: { authorization: `Bearer ${accessToken}`, ...(body ? { 'content-type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(TIMEOUT),
        });
      } catch (err) {
        if (repeatable && canRetry) {
          await this.sleep(this.backoff(attempt));
          continue;
        }
        throw fetchError(`Google API ${method}`, err);
      }
      if (canRetry && (res.status === 429 || (res.status >= 500 && repeatable))) {
        await res.body?.cancel().catch(() => {});
        await this.sleep(this.backoff(attempt, res.headers.get('retry-after')));
        continue;
      }
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await res.body?.cancel().catch(() => {});
        if (this.token) this.token.expires_at = 0; // token revoked or expired early: refresh once
        continue;
      }
      const data = await readBody(res);
      if (!res.ok) throw googleError(`Google API ${method}`, res, data);
      if (!data) throw Object.assign(new Error(`Google API ${method} returned HTTP ${res.status} but the response was not JSON`), { status: 502 });
      return data;
    }
  }

  /** Milliseconds to wait before retry number `attempt`: Retry-After if Google sent one, else exponential with jitter. */
  backoff(attempt, retryAfter) {
    if (retryAfter) {
      const seconds = Number(retryAfter);
      const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - this.now();
      if (Number.isFinite(ms)) return Math.min(Math.max(ms, 0), MAX_WAIT);
    }
    const ceiling = Math.min(400 * 2 ** attempt, MAX_WAIT);
    return Math.round(ceiling / 2 + (this.random() * ceiling) / 2);
  }

  async lookupEmail() {
    try {
      return (await this.api('https://gmail.googleapis.com/gmail/v1/users/me/profile')).emailAddress;
    } catch {
      return (await this.api('https://www.googleapis.com/drive/v3/about', { query: { fields: 'user(emailAddress)' } })).user?.emailAddress ?? null;
    }
  }

  /** Write the token to a private temp file, then rename it into place, so the file is never partial or readable by others. */
  async save() {
    const dir = dirname(this.tokenFile);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const { refresh_token, scope, email } = this.token;
    const tmp = join(dir, `.${basename(this.tokenFile)}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      await writeFile(tmp, JSON.stringify({ refresh_token, scope, email }), { mode: 0o600, flag: 'wx' });
      await rename(tmp, this.tokenFile);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  /**
   * Sign out: revoke the grant at Google and forget the token here. The local
   * token goes either way; `revoked` says whether Google confirmed it.
   */
  async disconnect() {
    let revoked = true;
    if (this.token?.refresh_token) {
      try {
        const res = await this.fetch(REVOKE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: this.token.refresh_token }),
          signal: AbortSignal.timeout(TIMEOUT),
        });
        // invalid_token: Google no longer knows this token, so there is no access left to remove.
        revoked = res.ok || (await readBody(res))?.error === 'invalid_token';
      } catch {
        revoked = false;
      }
    }
    this.token = null;
    this.refreshing = null;
    await rm(this.tokenFile, { force: true });
    return { revoked };
  }

  status() {
    return { configured: this.configured, connected: this.connected, email: this.token?.email ?? null };
  }
}
