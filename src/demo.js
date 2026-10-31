// The CLI and the hosted demo use the same sandbox and chore configuration.
import { join } from 'node:path';
import { exists } from './core/fsx.js';
import { createInboxChore } from './chores/inbox/index.js';
import { LocalMailProvider } from './chores/inbox/local-provider.js';
import { createFilesChore } from './chores/files/index.js';
import { createExpensesChore } from './chores/expenses/index.js';
import { createLintChore } from './chores/lint/index.js';

export async function createDemoChores(sandbox, { dryRun = false } = {}) {
  if (!(await exists(join(sandbox, 'mail')))) {
    const { seedDemo } = await import('../scripts/seed-demo.js');
    await seedDemo(sandbox);
  }
  return [
    createInboxChore({ provider: new LocalMailProvider(join(sandbox, 'mail')), dataDir: join(sandbox, 'mail'), dryRun }),
    createFilesChore({ root: join(sandbox, 'Downloads'), dryRun }),
    createExpensesChore({ csvPath: join(sandbox, 'expenses', 'bank-export.csv'), outDir: join(sandbox, 'expenses'), dryRun }),
    createLintChore({ root: join(sandbox, 'buggy-app'), dryRun }),
  ];
}
