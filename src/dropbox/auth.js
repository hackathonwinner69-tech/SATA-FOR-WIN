// Dropbox sign-in for a desktop app: OAuth 2 code flow with PKCE (no app
// secret), offline access so Dropbox returns a refresh token, and a loopback
// redirect. https://developers.dropbox.com/oauth-guide
// The refresh token is kept in a local file readable only by this user.
import { createHash, randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { writeAtomic } from '../core/fsx.js';
import { cleanLine } from '../core/safety.js';

// Exactly what the Folder Frenzy store calls: users/get_current_account,
// files/list_folder, and files/create_folder_v2 + files/move_batch_v2.
export const SCOPES = ['account_info.read', 'files.metadata.read', 'files.content.write'];
export const APPS_URL = 'https://www.dropbox.com/developers/apps';

const AUTH_URL = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const API = 'https://api.dropboxapi.com/2/';
const STATE_TTL = 10 * 60 * 1000;
const TIMEOUT = 30_000;
const REFRESH_EARLY = 60_000;
const RETRIES = 4;
const MAX_WAIT = 30_000;

const b64url = (buf) => buf.toString('base64url');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** The body as text and, when it parses, as JSON. Dropbox sends 400 errors as plain text. */
async function readBody(res) {
  const text = await res.text().catch(() => '');
  try {
    return { text, json: true, data: text ? JSON.parse(text) : null };
  } catch {
    return { text, json: false, data: null };
  }
}

function dropboxError(what, res, { text, json, data }) {
  const tag = typeof data?.error === 'string' ? data.error : data?.error?.['.tag'];
  if (tag === 'missing_scope') {
    const scope = data.error.required_scope ?? 'a needed';
    const message = `Dropbox has not given ChoreCade the ${scope} permission. Tick it on the Permissions tab of your app at ${APPS_URL}, then disconnect Dropbox here and connect again`;
    return Object.assign(new Error(message), { status: 403, code: tag });
  }
  // "path/not_found/.." -> "path/not_found"
  const summary = typeof data?.error_summary === 'string' ? data.error_summary.replace(/\/\.*$/, '') : undefined;
  const plain = !json && text && !text.trimStart().startsWith('<') ? cleanLine(text, 200) : null;
  const why = summary ?? data?.error_description ?? (typeof data?.error === 'string' ? data.error : null) ?? plain ?? (json ? res.statusText : 'the response was not JSON');
  return Object.assign(new Error(`${what} failed with HTTP ${res.status}${why ? `: ${why}` : ''}`), { status: res.status, code: tag, summary });
}

function fetchError(what, err) {
  const message = err?.name === 'TimeoutError' ? `${what} timed out after ${TIMEOUT / 1000} s` : `${what} could not reach Dropbox: ${err?.message ?? err}`;
  return Object.assign(new Error(message), { cause: err });
}

export class DropboxAuth {
  constructor({ appKey, tokenFile, fetchImpl = fetch, now = () => Date.now(), sleep = wait, random = Math.random, log = console.warn }) {
    this.appKey = appKey;
    this.tokenFile = tokenFile;
    this.fetch = fetchImpl;
    this.now = now;
    this.sleep = sleep;
    this.random = random;
    this.log = log;
    this.pending = new Map(); // state -> { verifier, redirectUri, at }
    this.token = null; // { refresh_token, access_token, expires_at, scope, email, account_id }
    this.refreshing = null;
    this.onRevoked = null; // called once Dropbox has rejected the saved sign-in and it is forgotten
  }

  get configured() {
    return Boolean(this.appKey);
  }

  get connected() {
    return Boolean(this.token?.refresh_token);
  }

  /** Who is signed in, for telling one account's journal entries from another's. */
  get account() {
    return this.token?.email ?? this.token?.account_id ?? null;
  }

  async load() {
    this.token = null;
    let text;
    try {
      text = await readFile(this.tokenFile, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') this.log(`Dropbox: could not read the saved sign-in (${err.message}); connect Dropbox again`);
      return false;
    }
    try {
      const token = JSON.parse(text);
      if (!token?.refresh_token) throw new Error('no refresh token');
      this.token = token;
    } catch {
      this.log(`Dropbox: the saved sign-in in ${this.tokenFile} is damaged and was ignored; connect Dropbox again`);
    }
    return this.connected;
  }

  /** Build the consent URL. `state` ties the callback to this request; PKCE ties the code to us. */
  authUrl(redirectUri) {
    if (!this.configured) throw Object.assign(new Error('Dropbox sign-in is not set up: add DROPBOX_APP_KEY to .env (see .env.example) and restart'), { status: 400 });
    const state = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(48));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    for (const [s, p] of this.pending) if (this.now() - p.at > STATE_TTL) this.pending.delete(s);
    this.pending.set(state, { verifier, redirectUri, at: this.now() });
    const params = new URLSearchParams({
      client_id: this.appKey,
      response_type: 'code',
      token_access_type: 'offline',
      redirect_uri: redirectUri,
      scope: SCOPES.join(' '),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
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
    if (!data.refresh_token) throw new Error('Dropbox did not return a refresh token; connect Dropbox again');
    this.refreshing = null;
    this.token = { refresh_token: data.refresh_token, scope: data.scope, account_id: data.account_id ?? null, email: null, ...this.accessFrom(data) };
    try {
      const account = await this.api('users/get_current_account', null, { idempotent: true });
      this.token.email = account?.email ?? null;
      this.token.account_id ??= account?.account_id ?? null;
    } catch (err) {
      this.log(`Dropbox: signed in, but could not look up the account's email address (${err.message})`);
    }
    await this.save();
    return this.token.email;
  }

  accessFrom(data) {
    return { access_token: data.access_token, expires_at: this.now() + Number(data.expires_in) * 1000 };
  }

  async tokenRequest(fields) {
    let res;
    try {
      res = await this.fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: this.appKey, ...fields }),
        signal: AbortSignal.timeout(TIMEOUT),
      });
    } catch (err) {
      throw fetchError('Dropbox token request', err);
    }
    const body = await readBody(res);
    if (!res.ok) throw dropboxError('Dropbox token request', res, body);
    if (!body.data) throw Object.assign(new Error(`Dropbox token request returned HTTP ${res.status} but the response was not JSON`), { status: 502 });
    return body.data;
  }

  /** A current access token. Concurrent callers share one refresh. */
  async accessToken() {
    if (!this.connected) throw Object.assign(new Error('not signed in to Dropbox'), { status: 401 });
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
      // The app was disconnected or the token revoked at Dropbox: the saved token is useless now.
      if (this.token === token) {
        this.token = null;
        await rm(this.tokenFile, { force: true }).catch(() => {});
        this.onRevoked?.();
      }
      throw Object.assign(new Error('Dropbox access was revoked or has expired; connect Dropbox again'), { status: 401, code: 'invalid_grant' });
    }
  }

  /**
   * Call an RPC route: POST https://api.dropboxapi.com/2/<route> with JSON
   * arguments (`null` for routes that take none, as Dropbox expects). Rate
   * limits (429) are always retried; server errors, timeouts and network
   * errors only for `idempotent` routes, so a move never runs twice.
   */
  async api(route, args = null, { idempotent = false } = {}) {
    const what = `Dropbox ${route}`;
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const canRetry = attempt < RETRIES;
      const accessToken = await this.accessToken();
      let res;
      try {
        res = await this.fetch(API + route, {
          method: 'POST',
          headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
          body: JSON.stringify(args),
          signal: AbortSignal.timeout(TIMEOUT),
        });
      } catch (err) {
        if (idempotent && canRetry) {
          await this.sleep(this.backoff(attempt));
          continue;
        }
        throw fetchError(what, err);
      }
      if (canRetry && (res.status === 429 || (res.status >= 500 && idempotent))) {
        await res.body?.cancel().catch(() => {});
        await this.sleep(this.backoff(attempt, res.headers.get('retry-after')));
        continue;
      }
      const body = await readBody(res);
      // An expired or revoked access token: refresh once. A missing permission will not get better by refreshing.
      if (res.status === 401 && !refreshed && body.data?.error?.['.tag'] !== 'missing_scope') {
        refreshed = true;
        if (this.token) this.token.expires_at = 0;
        continue;
      }
      if (!res.ok) throw dropboxError(what, res, body);
      if (!body.json) throw Object.assign(new Error(`${what} returned HTTP ${res.status} but the response was not JSON`), { status: 502 });
      return body.data;
    }
  }

  /** Milliseconds to wait before retry number `attempt`: Retry-After if Dropbox sent one, else exponential with jitter. */
  backoff(attempt, retryAfter) {
    if (retryAfter) {
      const seconds = Number(retryAfter);
      const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - this.now();
      if (Number.isFinite(ms)) return Math.min(Math.max(ms, 0), MAX_WAIT);
    }
    const ceiling = Math.min(400 * 2 ** attempt, MAX_WAIT);
    return Math.round(ceiling / 2 + (this.random() * ceiling) / 2);
  }

  /** Write the token to a private temp file, then rename it into place, so the file is never partial or readable by others. */
  async save() {
    const { refresh_token, scope, email, account_id } = this.token;
    await writeAtomic(this.tokenFile, JSON.stringify({ refresh_token, scope, email, account_id }), { mode: 0o600, directoryMode: 0o700 });
  }

  /**
   * Sign out: revoke the token at Dropbox (which disables the refresh token
   * too) and forget it here. The local token goes either way; `revoked` says
   * whether Dropbox confirmed it.
   */
  async disconnect() {
    let revoked = true;
    if (this.connected) {
      try {
        await this.api('auth/token/revoke');
      } catch (err) {
        // 401: Dropbox no longer accepts this sign-in, so there is no access left to remove.
        revoked = err.status === 401;
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
