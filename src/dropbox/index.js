// Dropbox in the arcade: once signed in, one Dropbox folder becomes a Folder
// Frenzy cabinet.
import { httpError, jsonRoute } from '../core/http.js';
import { createFilesChore } from '../chores/files/index.js';
import { cleanLine } from '../core/safety.js';
import { APPS_URL } from './auth.js';
import { DropboxStore } from './store.js';

export const DROPBOX_CHORE = 'dropbox';
const CONNECTED_APPS_URL = 'https://www.dropbox.com/account/connected_apps';

export function dropboxChore(auth, { dryRun = false, folder = '' } = {}) {
  return createFilesChore({ store: new DropboxStore(auth, { folder }), id: DROPBOX_CHORE, title: 'Folder Frenzy: Dropbox', remote: true, dryRun });
}

/** Express routes for sign-in and sign-out. `api` is the token-guarded router. */
export function mountDropbox({ app, api, arcade, auth, port, options }) {
  // Dropbox needs this exact URI, port included, on the app's Settings tab.
  const redirectUri = `http://127.0.0.1:${port}/oauth/dropbox/callback`;
  const connect = () => arcade.addChore(dropboxChore(auth, options));
  // A sign-in that Dropbox revoked takes its cabinet with it, just like signing out.
  auth.onRevoked = () => arcade.removeChore(DROPBOX_CHORE);
  if (auth.connected) connect();

  api.get('/dropbox', (req, res) => res.json(auth.status()));

  api.post('/dropbox/connect', jsonRoute(() => {
    if (auth.connected) throw httpError(409, 'already connected to Dropbox; disconnect first to switch account');
    return { url: auth.authUrl(redirectUri) };
  }));

  api.post('/dropbox/disconnect', jsonRoute(async () => {
    const { revoked } = await auth.disconnect();
    arcade.removeChore(DROPBOX_CHORE);
    const warning = revoked ? undefined : `Signed out here, but Dropbox did not confirm it removed ChoreCade's access. Remove it at ${CONNECTED_APPS_URL}`;
    return { ...auth.status(), revoked, warning };
  }));

  // Dropbox sends the browser back here. Not token-guarded (it is a top-level
  // navigation from Dropbox), but it only succeeds with a state we issued. It
  // then returns to localhost, where the arcade link left its session cookie.
  app.get('/oauth/dropbox/callback', async (req, res) => {
    const home = (outcome) => `http://localhost:${port}/?dropbox=${outcome}`;
    const { code, state, error, error_description: description } = req.query;
    if (error && error !== 'access_denied') {
      const why = cleanLine(typeof description === 'string' && description ? description : error);
      return res.status(400).type('text').send(`Dropbox sign-in failed: ${why}. Check the Permissions tab of your app at ${APPS_URL} (see .env.example), then connect again from the arcade.`);
    }
    if (error || typeof code !== 'string' || typeof state !== 'string') return res.redirect(home('cancelled'));
    try {
      await auth.exchange(code, state);
      connect();
      res.redirect(home('connected'));
    } catch (err) {
      res.status(err.status ?? 500).type('text').send(`Dropbox sign-in failed: ${err.message}`);
    }
  });
}
