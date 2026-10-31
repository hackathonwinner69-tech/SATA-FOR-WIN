import { api } from './api.js';
import { esc } from '../games/kit.js';

const $ = (id) => document.getElementById(id);

export const G_LOGO = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.4 30.2 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.8 6C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4 7.1-10 7.1-17.5z"/><path fill="#FBBC05" d="M10.5 28.7a14.5 14.5 0 0 1 0-9.4l-7.8-6a24 24 0 0 0 0 21.4l7.8-6z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.9 2.3-8.4 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.8 6C6.6 42.6 14.6 48 24 48z"/></svg>';

export function createAccounts({ showNotice, announce, onChange }) {
  let google = { configured: false, connected: false, email: null };
  async function refreshGoogle() {
    try {
      google = await api('/google');
    } catch {
      return;
    }
    const slot = $('google-slot');
    if (google.connected) {
      slot.innerHTML = `<span class="chip g-chip">${G_LOGO}<span>${esc(google.email ?? 'Google')}</span></span> <button class="btn quiet" type="button" id="g-out">Sign out</button>`;
      $('g-out').addEventListener('click', async () => {
        let result;
        try {
          result = await api('/google/disconnect', { method: 'POST' });
        } catch (err) {
          showNotice(`Could not sign out of Google: ${err.message}`);
          return;
        }
        announce('Signed out of Google. Gmail and Drive cabinets removed.');
        if (result.warning) showNotice(result.warning);
        await refreshGoogle();
        if (!result.warning) $('g-in')?.focus();
      });
    } else {
      slot.innerHTML = `<button class="btn quiet g-btn" type="button" id="g-in">${G_LOGO}<span>Sign in with Google</span></button>`;
      $('g-in').addEventListener('click', async () => {
        if (!google.configured) {
          showNotice('Google sign-in needs a Google Cloud OAuth client. Copy .env.example to .env, add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, and restart. The README walks through it in two minutes.');
          return;
        }
        try {
          const { url } = await api('/google/connect', { method: 'POST' });
          location.assign(url);
        } catch (err) {
          showNotice(`Could not start Google sign-in: ${err.message}`);
          refreshGoogle();
        }
      });
    }
    onChange();
  }

  let dropbox = { configured: false, connected: false, email: null };

  const D_LOGO = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 43 40"><path fill="#0061FF" d="M12.5 0 0 8.1 8.7 15l12.5-7.8L12.5 0zM0 21.9l12.5 8.2 8.7-7.3-12.5-7.8L0 21.9zm21.2.9 8.7 7.3 12.5-8.2-8.7-6.9-12.5 7.8zM42.4 8.1 29.9 0l-8.7 7.2L33.7 15l8.7-6.9zM21.3 24.4l-8.8 7.3-3.7-2.5v2.8l12.5 7.5 12.5-7.5v-2.8l-3.7 2.5-8.8-7.3z"/></svg>';

  async function refreshDropbox() {
    try {
      dropbox = await api('/dropbox');
    } catch {
      return;
    }
    const slot = $('dropbox-slot');
    // Signing out also refreshes from the event stream; re-rendering the same state would drop the focus moved to the button.
    const shown = JSON.stringify(dropbox);
    if (slot.dataset.shown === shown) return;
    slot.dataset.shown = shown;
    if (dropbox.connected) {
      slot.innerHTML = `<span class="chip g-chip">${D_LOGO}<span>${esc(dropbox.email ?? 'Dropbox')}</span></span> <button class="btn quiet" type="button" id="d-out">Disconnect</button>`;
      $('d-out').addEventListener('click', async () => {
        let result;
        try {
          result = await api('/dropbox/disconnect', { method: 'POST' });
        } catch (err) {
          showNotice(`Could not disconnect Dropbox: ${err.message}`);
          return;
        }
        announce('Disconnected Dropbox. Its cabinet was removed.');
        if (result.warning) showNotice(result.warning);
        await refreshDropbox();
        if (!result.warning) $('d-in')?.focus();
      });
    } else {
      slot.innerHTML = `<button class="btn quiet g-btn" type="button" id="d-in">${D_LOGO}<span>Connect Dropbox</span></button>`;
      $('d-in').addEventListener('click', async () => {
        if (!dropbox.configured) {
          showNotice('Dropbox needs an app key. Create an app at dropbox.com/developers/apps, copy .env.example to .env, set DROPBOX_APP_KEY, and restart. The README walks through it.');
          return;
        }
        try {
          const { url } = await api('/dropbox/connect', { method: 'POST' });
          location.assign(url);
        } catch (err) {
          showNotice(`Could not start Dropbox sign-in: ${err.message}`);
          refreshDropbox();
        }
      });
    }
  }
  return { refreshGoogle, refreshDropbox, get google() { return google; } };
}
