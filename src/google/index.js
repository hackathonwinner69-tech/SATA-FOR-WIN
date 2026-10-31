// Google services in the arcade: once signed in, Gmail becomes an Inbox
// Invaders cabinet, Drive a Folder Frenzy cabinet, and reviewed expenses can be
// exported to Google Sheets.
import { createInboxChore } from '../chores/inbox/index.js';
import { createFilesChore } from '../chores/files/index.js';
import { GmailProvider } from './gmail.js';
import { DriveStore } from './drive.js';
import { exportToSheets } from './sheets.js';

export const GOOGLE_CHORES = ['gmail', 'drive'];

export function googleChores(auth, { dataDir, dryRun = false, gmailMax, driveFolder } = {}) {
  return [
    createInboxChore({ provider: new GmailProvider(auth, { max: gmailMax }), dataDir, id: 'gmail', title: 'Inbox Invaders: Gmail', remote: true, dryRun }),
    createFilesChore({ store: new DriveStore(auth, { folderId: driveFolder }), id: 'drive', title: 'Folder Frenzy: Drive', remote: true, dryRun }),
  ];
}

/** Express routes for sign-in, sign-out and Sheets export. `api` is the token-guarded router. */
export function mountGoogle({ app, api, arcade, auth, port, options }) {
  const redirectUri = `http://127.0.0.1:${port}/oauth/google/callback`;
  const connectChores = () => {
    for (const chore of googleChores(auth, options)) arcade.addChore(chore);
  };
  if (auth.connected) connectChores();

  api.get('/google', (req, res) => res.json(auth.status()));

  api.post('/google/connect', (req, res) => {
    try {
      res.json({ url: auth.authUrl(redirectUri) });
    } catch (err) {
      res.status(err.status ?? 500).json({ error: err.message });
    }
  });

  api.post('/google/disconnect', async (req, res) => {
    await auth.disconnect();
    for (const id of GOOGLE_CHORES) arcade.removeChore(id);
    res.json(auth.status());
  });

  api.post('/chores/:id/export/sheets', async (req, res) => {
    try {
      const chore = arcade.chore(req.params.id);
      if (!chore.table) throw Object.assign(new Error('this chore has nothing to export'), { status: 400 });
      if (!auth.connected) throw Object.assign(new Error('sign in with Google first'), { status: 401 });
      res.json(await exportToSheets(auth, await chore.table()));
    } catch (err) {
      res.status(err.status ?? 500).json({ error: err.message });
    }
  });

  // Google sends the browser back here. Not token-guarded (it is a top-level
  // navigation from Google), but it only succeeds with a state we issued.
  app.get('/oauth/google/callback', async (req, res) => {
    const { code, state, error } = req.query;
    if (error || typeof code !== 'string' || typeof state !== 'string') return res.redirect('/?google=cancelled');
    try {
      await auth.exchange(code, state);
      connectChores();
      res.redirect('/?google=connected');
    } catch (err) {
      res.status(err.status ?? 500).type('text').send(`Google sign-in failed: ${err.message}`);
    }
  });
}
