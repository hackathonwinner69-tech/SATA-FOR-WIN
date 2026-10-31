#!/usr/bin/env node
// chorecade                         play the demo against a generated sandbox
// chorecade --files ~/Downloads     sort a real folder (and so on, see --help)
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
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
                        cannot (sends file names and merchant names to the
                        Anthropic API; needs ANTHROPIC_API_KEY or \`ant auth login\`)
  --gmail-max <n>       newest inbox messages to scan once Google is connected (2000)
  --drive-folder <id>   Drive folder to sort once Google is connected (My Drive)
  --one-click-unsubscribe
                        send RFC 8058 one-click unsubscribe requests (live mail only)
  --port <n>            default 4747
  --sandbox <dir>       where the demo lives, default ./sandbox
`;

// Settings such as GOOGLE_CLIENT_ID can live in a .env file next to package.json.
if (existsSync('.env')) process.loadEnvFile('.env');

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
  if (values.mail) chores.push(createInboxChore({ provider: new LocalMailProvider(resolve(values.mail)), dataDir, dryRun }));
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
  const sandbox = resolve(values.sandbox);
  if (!existsSync(join(sandbox, 'mail'))) {
    const { seedDemo } = await import('../scripts/seed-demo.js');
    console.log(`seeding demo sandbox in ${sandbox} ...`);
    await seedDemo(sandbox);
  }
  // The demo never touches the network: one-click unsubscribe stays off.
  chores.push(
    createInboxChore({ provider: new LocalMailProvider(join(sandbox, 'mail')), dataDir: join(sandbox, 'mail'), dryRun }),
    createFilesChore({ root: join(sandbox, 'Downloads'), dryRun }),
    createExpensesChore({ csvPath: join(sandbox, 'expenses', 'bank-export.csv'), outDir: join(sandbox, 'expenses'), dryRun }),
    createLintChore({ root: join(sandbox, 'buggy-app'), dryRun }),
  );
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
const { app } = createServer(arcade, {
  port,
  google: { auth: google, options: { dataDir, dryRun, gmailMax: Number(values['gmail-max']), driveFolder: values['drive-folder'] } },
});

app.listen(port, '127.0.0.1', () => {
  console.log(`\nChoreCade (${mode}) at http://localhost:${port}`);
  for (const c of chores) console.log(`  ${c.title.padEnd(16)} ${c.target}`);
  const googleState = google.connected ? `signed in as ${google.token.email}` : google.configured ? 'ready, sign in from the arcade' : 'not set up (see README: Google services)';
  console.log(`\nGoogle: ${googleState}`);
  if (advisor) console.log('\nClaude advisor on: file and merchant names are sent to the Anthropic API for suggestions.');
  if (mode === 'live') console.log('\nLive mode: moves change real things. Everything is journaled and undoable from the HUD.');
});
