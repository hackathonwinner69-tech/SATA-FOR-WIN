// The whole arcade as one Vercel function, playing the demo sandbox in /tmp.
// Vercel serves public/ as static files; everything else lands here.
import { join } from 'node:path';
import { Arcade } from '../src/arcade.js';
import { createServer } from '../src/server.js';
import { createDemoChores } from '../src/demo.js';
import { lazyAsync } from '../src/core/async.js';

async function build() {
  const sandbox = join('/tmp', 'chorecade-demo');
  const chores = await createDemoChores(sandbox);
  const arcade = new Arcade({ chores, journalFile: join(sandbox, 'journal.jsonl'), mode: 'demo', advisor: null });
  const { app } = createServer(arcade, { port: 4747, token: process.env.CHORECADE_TOKEN ?? 'demo' });
  return app;
}

const getApp = lazyAsync(build);

export default async function handler(req, res) {
  const app = await getApp();
  return app(req, res);
}
