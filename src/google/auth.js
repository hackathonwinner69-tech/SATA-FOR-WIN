// Google sign-in for a desktop app: OAuth 2.0 authorization code flow with
// PKCE and a loopback redirect, as Google recommends for installed apps.
// https://developers.google.com/identity/protocols/oauth2/native-app
// The refresh token is kept in a local file readable only by this user.
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const SCOPES = {
  // Read headers and move mail between labels; cannot permanently delete.
  gmail: 'https://www.googleapis.com/auth/gmail.modify',
  // See and move files in Drive (needed to sort files ChoreCade did not create).
  drive: 'https://www.googleapis.com/auth/drive',
};

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const STATE_TTL = 10 * 60 * 1000;

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export class GoogleAuth {
  constructor({ clientId, clientSecret, tokenFile, fetchImpl = fetch, now = () => Date.now() }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.tokenFile = tokenFile;
    this.fetch = fetchImpl;
    this.now = now;
    this.pending = new Map(); // state -> { verifier, redirectUri, at }
    this.token = null; // { refresh_token, access_token, expires_at, scope, email }
  }

  get configured() {
    return Boolean(this.clientId && this.clientSecret);
  }

  get connected() {
    return Boolean(this.token?.refresh_token);
  }

  async load() {
    try {
      this.token = JSON.parse(await readFile(this.tokenFile, 'utf8'));
    } catch {
      this.token = null;
    }
    return this.connected;
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
    this.token = { refresh_token: data.refresh_token, scope: data.scope, ...this.accessFrom(data) };
    this.token.email = await this.lookupEmail();
    await this.save();
    return this.token.email;
  }

  accessFrom(data) {
    return { access_token: data.access_token, expires_at: this.now() + (data.expires_in - 60) * 1000 };
  }

  async tokenRequest(fields) {
    const res = await this.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, ...fields }),
    });
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(`Google token request failed: ${data.error_description ?? data.error ?? res.status}`), { status: 502 });
    return data;
  }

  async accessToken() {
    if (!this.connected) throw Object.assign(new Error('not signed in to Google'), { status: 401 });
    if (!this.token.access_token || this.now() >= this.token.expires_at) {
      Object.assign(this.token, this.accessFrom(await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: this.token.refresh_token })));
    }
    return this.token.access_token;
  }

  /** Authorised JSON request with backoff on rate limits and server errors. */
  async api(url, { method = 'GET', body, query } = {}) {
    const target = query ? `${url}?${new URLSearchParams(query)}` : url;
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetch(target, {
        method,
        headers: { authorization: `Bearer ${await this.accessToken()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await new Promise((r) => setTimeout(r, 2 ** attempt * 400));
        continue;
      }
      if (res.status === 401 && attempt === 0) {
        this.token.expires_at = 0; // token revoked or expired early: refresh once
        continue;
      }
      const text = await res.text();
      const data = text ? JSON.parse(text) : {};
      if (!res.ok) throw Object.assign(new Error(`Google API ${res.status}: ${data.error?.message ?? res.statusText}`), { status: res.status === 403 ? 403 : 502 });
      return data;
    }
  }

  async lookupEmail() {
    try {
      return (await this.api('https://gmail.googleapis.com/gmail/v1/users/me/profile')).emailAddress;
    } catch {
      return (await this.api('https://www.googleapis.com/drive/v3/about', { query: { fields: 'user(emailAddress)' } })).user?.emailAddress ?? null;
    }
  }

  async save() {
    await mkdir(dirname(this.tokenFile), { recursive: true });
    const { refresh_token, scope, email } = this.token;
    await writeFile(this.tokenFile, JSON.stringify({ refresh_token, scope, email }), { mode: 0o600 });
    await chmod(this.tokenFile, 0o600).catch(() => {});
  }

  /** Sign out: revoke the grant at Google and forget the token here. */
  async disconnect() {
    if (this.token?.refresh_token) {
      await this.fetch(REVOKE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: this.token.refresh_token }),
      }).catch(() => {});
    }
    this.token = null;
    await rm(this.tokenFile, { force: true });
  }

  status() {
    return { configured: this.configured, connected: this.connected, email: this.token?.email ?? null };
  }
}
