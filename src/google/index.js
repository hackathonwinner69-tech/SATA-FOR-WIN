// Google services in the arcade: once signed in, Gmail becomes an Inbox
// Invaders cabinet, Drive a Folder Frenzy cabinet, and reviewed expenses can be
// exported to Google Sheets.
import { createInboxChore } from '../chores/inbox/index.js';
import { createFilesChore } from '../chores/files/index.js';
import { GmailProvider } from './gmail.js';
import { DriveStore } from './drive.js';
import { exportToSheets } from './sheets.js';

export const GOOGLE_CHORES = ['gmail', 'drive'];
const NAMES = { gmail: 'Gmail', drive: 'Drive' };
const PERMISSIONS_URL = 'https://myaccount.google.com/permissions';

export function googleChores(auth, { dataDir, dryRun = false, gmailMax, driveFolder, oneClickUnsubscribe = false } = {}) {
  return [
    createInboxChore({ provider: new GmailProvider(auth, { max: gmailMax }), dataDir, id: 'gmail', title: 'Inbox Invaders: Gmail', remote: true, dryRun, oneClickUnsubscribe }),
    createFilesChore({ store: new DriveStore(auth, { folderId: driveFolder }), id: 'drive', title: 'Folder Frenzy: Drive', remote: true, dryRun }),
  ];
}

/** Google cabinets left out because the user did not grant their access on the consent screen. */
export function skippedChores(auth) {
  return auth.connected ? GOOGLE_CHORES.filter((id) => !auth.granted(id)) : [];
}

/** Express routes for sign-in, sign-out and Sheets export. `api` is the token-guarded router. */
export function mountGoogle({ app, api, arcade, auth, port, options }) {
  const redirectUri = `http://127.0.0.1:${port}/oauth/google/callback`;
  const connectChores = () => {
    const skipped = skippedChores(auth);
    for (const chore of googleChores(auth, options)) {
      if (skipped.includes(chore.id)) arcade.removeChore(chore.id);
      else arcade.addChore(chore);
    }
    return skipped;
  };
  const status = () => ({ ...auth.status(), skipped: skippedChores(auth) });

  if (auth.connected) {
    const skipped = connectChores();
    if (skipped.length) {
      const names = skipped.map((id) => NAMES[id]).join(' and ');
      auth.log(`Google: ${names} access was not granted, so the ${names} cabinet is off. Sign out and connect again with ${names} ticked to add it.`);
    }
  }

  api.get('/google', (req, res) => res.json(status()));

  api.post('/google/connect', (req, res) => {
    try {
      if (auth.connected) throw Object.assign(new Error('already connected to Google; disconnect first to switch account or change access'), { status: 409 });
      res.json({ url: auth.authUrl(redirectUri) });
    } catch (err) {
      res.status(err.status ?? 500).json({ error: err.message });
    }
  });

  api.post('/google/disconnect', async (req, res) => {
    const { revoked } = await auth.disconnect();
    for (const id of GOOGLE_CHORES) arcade.removeChore(id);
    const warning = revoked ? undefined : `Signed out here, but Google did not confirm it removed ChoreCade's access. Remove it at ${PERMISSIONS_URL}`;
    res.json({ ...status(), revoked, warning });
  });

  api.post('/chores/:id/export/sheets', async (req, res) => {
    try {
      const chore = arcade.chore(req.params.id);
      if (!chore.table) throw Object.assign(new Error('this chore has nothing to export'), { status: 400 });
      if (!auth.connected) throw Object.assign(new Error('sign in with Google first'), { status: 401 });
      // Creating a spreadsheet goes through the Drive grant; ChoreCade asks for no separate Sheets scope.
      if (!auth.granted('drive')) throw Object.assign(new Error('Sheets export needs Drive access, which was not granted; sign out and connect again with Drive ticked'), { status: 403 });
      res.json(await exportToSheets(auth, await chore.table(), { dryRun: options?.dryRun }));
    } catch (err) {
      res.status(err.status ?? 500).json({ error: err.message });
    }
  });

  // Google sends the browser back here. Not token-guarded (it is a top-level
  // navigation from Google), but it only succeeds with a state we issued. It
  // then returns to localhost, where the arcade link left its session cookie.
  app.get('/oauth/google/callback', async (req, res) => {
    const home = (outcome) => `http://localhost:${port}/?google=${outcome}`;
    const { code, state, error } = req.query;
    if (error || typeof code !== 'string' || typeof state !== 'string') return res.redirect(home('cancelled'));
    try {
      await auth.exchange(code, state);
      const skipped = connectChores();
      res.redirect(home(skipped.length ? `connected&skipped=${skipped.join(',')}` : 'connected'));
    } catch (err) {
      res.status(err.status ?? 500).type('text').send(`Google sign-in failed: ${err.message}`);
    }
  });
}
