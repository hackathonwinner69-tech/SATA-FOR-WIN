// The whole arcade as one Vercel function, playing the demo sandbox in /tmp.
// Vercel serves public/ as static files; everything else lands here.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Arcade } from '../src/arcade.js';
import { createServer } from '../src/server.js';
import { createInboxChore } from '../src/chores/inbox/index.js';
import { LocalMailProvider } from '../src/chores/inbox/local-provider.js';
import { createFilesChore } from '../src/chores/files/index.js';
import { createExpensesChore } from '../src/chores/expenses/index.js';
import { createLintChore } from '../src/chores/lint/index.js';

let ready;

async function build() {
  const sandbox = join('/tmp', 'chorecade-demo');
  if (!existsSync(join(sandbox, 'mail'))) {
    const { seedDemo } = await import('../scripts/seed-demo.js');
    await seedDemo(sandbox);
  }
  const chores = [
    createInboxChore({ provider: new LocalMailProvider(join(sandbox, 'mail')), dataDir: join(sandbox, 'mail'), dryRun: false }),
    createFilesChore({ root: join(sandbox, 'Downloads'), dryRun: false }),
    createExpensesChore({ csvPath: join(sandbox, 'expenses', 'bank-export.csv'), outDir: join(sandbox, 'expenses'), dryRun: false }),
    createLintChore({ root: join(sandbox, 'buggy-app'), dryRun: false }),
  ];
  const arcade = new Arcade({ chores, journalFile: join(sandbox, 'journal.jsonl'), mode: 'demo', advisor: null });
  const { app } = createServer(arcade, { port: 4747, token: process.env.CHORECADE_TOKEN ?? 'demo' });
  return app;
}

export default async function handler(req, res) {
  ready ??= build();
  const app = await ready;
  return app(req, res);
}
