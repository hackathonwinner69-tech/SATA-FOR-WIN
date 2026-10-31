#!/usr/bin/env node
// chorecade                         play the demo against a generated sandbox
// chorecade --files ~/Downloads     sort a real folder (and so on, see --help)
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createDemoChores } from './demo.js';
import { Arcade } from './arcade.js';
import { createServer } from './server.js';
import { createInboxChore } from './chores/inbox/index.js';
import { LocalMailProvider } from './chores/inbox/local-provider.js';
import { ImapMailProvider } from './chores/inbox/imap-provider.js';
import { createFilesChore } from './chores/files/index.js';
import { createExpensesChore } from './chores/expenses/index.js';
import { createLintChore } from './chores/lint/index.js';
import { createAdvisor } from './ai/advisor.js';
import { GoogleAuth } from './google/auth.js';
import { DropboxAuth } from './dropbox/auth.js';

const HELP = `ChoreCade: play a game, finish a real chore.

  chorecade                       demo: a generated sandbox with 5,000 emails,
                                  a messy folder, a bank export and a buggy repo
  chorecade [targets] [options]   live: only the chores you point at

Targets
  --mail <dir>          folder of .eml files with INBOX/ (moves to Archive/, Trash/)
  --imap-host <host>    IMAP server, e.g. imap.gmail.com (user: --imap-user,
                        password from the IMAP_PASS environment variable)
  --files <dir>         messy folder to sort (top-level files only)
  --expenses <csv>      bank or card export to categorise
  --lint <dir>          JavaScript project to clean up with ESLint

Options
  --dry-run             journal what would happen, change nothing
  --ai                  let Claude suggest bins and categories the built-in rules
                        cannot (sends file names, merchant names and totals to
                        the Anthropic API; needs ANTHROPIC_API_KEY or \`ant auth login\`)
  --gmail-max <n>       newest inbox messages to scan once Google is connected (2000)
  --drive-folder <id>   Drive folder to sort once Google is connected (My Drive)
  --dropbox-folder <path>
                        Dropbox folder to sort once Dropbox is connected, e.g.
                        /Downloads (default: the top of your Dropbox, or of the
                        app folder for an App folder app)
  --one-click-unsubscribe
                        send RFC 8058 one-click unsubscribe requests (live mail only)
  --port <n>            default 4747
  --sandbox <dir>       where the demo lives, default ./sandbox
`;

// Settings such as GOOGLE_CLIENT_ID can live in a .env file next to package.json.
const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { values } = parseArgs({
  options: {
    mail: { type: 'string' },
    'imap-host': { type: 'string' },
    'imap-user': { type: 'string' },
    'imap-port': { type: 'string' },
    files: { type: 'string' },
    expenses: { type: 'string' },
    lint: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    ai: { type: 'boolean', default: false },
    'gmail-max': { type: 'string', default: '2000' },
    'drive-folder': { type: 'string', default: 'root' },
    'dropbox-folder': { type: 'string', default: '' },
    'one-click-unsubscribe': { type: 'boolean', default: false },
    port: { type: 'string', default: process.env.PORT ?? '4747' },
    sandbox: { type: 'string', default: 'sandbox' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

const port = Number(values.port);
const dryRun = values['dry-run'];
const live = Boolean(values.mail || values['imap-host'] || values.files || values.expenses || values.lint);
const dataDir = resolve('.chorecade');
const chores = [];

if (live) {
  if (values.mail) chores.push(createInboxChore({ provider: new LocalMailProvider(resolve(values.mail)), dataDir, dryRun, oneClickUnsubscribe: values['one-click-unsubscribe'] }));
  if (values['imap-host']) {
    if (!process.env.IMAP_PASS) throw new Error('set IMAP_PASS in the environment; passwords never go on the command line');
    const provider = new ImapMailProvider({
      host: values['imap-host'],
      port: values['imap-port'] ?? 993,
      user: values['imap-user'],
      pass: process.env.IMAP_PASS,
    });
    chores.push(createInboxChore({ provider, dataDir, dryRun, oneClickUnsubscribe: values['one-click-unsubscribe'] }));
  }
  if (values.files) chores.push(createFilesChore({ root: resolve(values.files), dryRun }));
  if (values.expenses) {
    const csvPath = resolve(values.expenses);
    chores.push(createExpensesChore({ csvPath, outDir: dirname(csvPath), dryRun }));
  }
  if (values.lint) chores.push(createLintChore({ root: resolve(values.lint), dryRun }));
} else {
  chores.push(...await createDemoChores(resolve(values.sandbox), { dryRun }));
}

const mode = dryRun ? 'dry-run' : live ? 'live' : 'demo';
const advisor = values.ai ? createAdvisor() : null;
const arcade = new Arcade({ chores, journalFile: join(live ? dataDir : resolve(values.sandbox), 'journal.jsonl'), mode, advisor });
const google = new GoogleAuth({
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  tokenFile: join(dataDir, 'google-token.json'),
});
await google.load();
const dropbox = new DropboxAuth({ appKey: process.env.DROPBOX_APP_KEY, tokenFile: join(dataDir, 'dropbox-token.json') });
await dropbox.load();
const { app, token } = createServer(arcade, {
  port,
  google: { auth: google, options: { dataDir, dryRun, gmailMax: Number(values['gmail-max']), driveFolder: values['drive-folder'], oneClickUnsubscribe: values['one-click-unsubscribe'] } },
  dropbox: { auth: dropbox, options: { dryRun, folder: values['dropbox-folder'] } },
});

// Ctrl+C lets queued moves land and logs out of IMAP. A second Ctrl+C, or two seconds, ends it regardless.
let stopping = false;
function shutdown() {
  if (stopping) process.exit(130);
  stopping = true;
  setTimeout(() => process.exit(0), 2000).unref();
  arcade.close().finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

app.listen(port, '127.0.0.1', () => {
  console.log(`\nChoreCade (${mode}) at http://localhost:${port}/?token=${token}`);
  console.log("  Open this link to play. It holds this run's key; the bare address stays locked.");
  for (const c of chores) console.log(`  ${c.title.padEnd(16)} ${c.target}`);
  const googleState = google.connected ? `signed in${google.token.email ? ` as ${google.token.email}` : ''}` : google.configured ? 'ready, sign in from the arcade' : 'not set up (see README: Google services)';
  console.log(`\nGoogle: ${googleState}`);
  const dropboxState = dropbox.connected ? `signed in${dropbox.token.email ? ` as ${dropbox.token.email}` : ''}` : dropbox.configured ? 'ready, connect from the arcade' : 'not set up (see README: Dropbox)';
  console.log(`Dropbox: ${dropboxState}`);
  if (advisor) console.log('\nClaude advisor on: file names, merchant names and merchant totals are sent to the Anthropic API for suggestions.');
  if (mode === 'live') console.log('\nLive mode: moves change real things. Everything is journaled and undoable from the HUD.');
});
