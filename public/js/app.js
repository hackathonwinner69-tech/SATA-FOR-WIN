// The arcade floor: the backlog, the ledger, and launching games.
import { api, fmt, listen } from './api.js';
import { spriteSvg } from './sprites.js';
import { createAccounts, G_LOGO } from './accounts.js';
import { setupTour } from './tour.js';
import { esc, overlay } from '../games/kit.js';

export const CABINETS = {
  invaders: {
    accent: '#2b59d9',
    module: '/games/invaders.js',
    what: 'Each invader is one sender. One hit archives, trashes or unsubscribes all of its mail.',
  },
  frenzy: {
    accent: '#f2b632',
    module: '/games/frenzy.js',
    what: 'Grab crates of look-alike files and run them to the right bin before the dust bunnies catch you.',
    toasts: 'bottom-left',
  },
  blocks: {
    accent: '#0f7a54',
    module: '/games/blocks.js',
    what: 'Each merchant falls as a block. Steer it into a category column to file its charges for real, and watch the columns grow into a chart of your spending. Flag the red ones.',
    toasts: 'bottom-right',
  },
  dungeon: {
    accent: '#9b3d78',
    module: '/games/dungeon.js',
    what: 'A castle crawl: every lint rule is a foe. The Fix Beam runs ESLint’s autofix for real, the whip hushes, the scroll logs.',
  },
};

const IMPACT_LABELS = {
  archived: (v) => `${fmt.n(v)} archived`,
  trashed: (v) => `${fmt.n(v)} trashed`,
  unsubscribed: (v) => `${fmt.n(v)} unsubscribed`,
  moved: (v) => `${fmt.n(v)} files sorted`,
  bytes: (v) => `${fmt.bytes(v)} tidied`,
  categorized: (v) => `${fmt.n(v)} filed`,
  flagged: (v) => `${fmt.n(v)} flagged`,
  fixed: (v) => `${fmt.n(v)} fixed`,
  silenced: (v) => `${fmt.n(v)} silenced`,
  logged: (v) => `${fmt.n(v)} logged`,
};

export function describeImpact(impact = {}) {
  return Object.entries(impact)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => IMPACT_LABELS[k]?.(v))
    .filter(Boolean);
}

const $ = (id) => document.getElementById(id);

let state = null;
const accounts = createAccounts({ showNotice, announce, onChange: () => {
  if (!current && state) renderMachines();
} });
const { refreshGoogle, refreshDropbox } = accounts;

function showNotice(text, focus = true) {
  const el = $('notice');
  el.textContent = text;
  el.classList.remove('hidden');
  if (focus) el.focus();
}
let current = null; // { id, cleanup, impactListeners, moves, opener }
let counting = 0;
const ledger = new Map();
const undoing = new Set(); // ledger entry ids with an undo on its way
const activeJobs = new Set();
// A job can finish before the POST that queued it has answered, so finished jobs are kept for a while.
const endedJobs = new Map();
const jobWaiters = new Map();

/** Resolves with the job once the worker reports it done or failed. */
function jobEnd(id) {
  if (endedJobs.has(id)) return Promise.resolve(endedJobs.get(id));
  return new Promise((resolve) => jobWaiters.set(id, [...(jobWaiters.get(id) ?? []), resolve]));
}

function jobEnded(job) {
  endedJobs.set(job.id, job);
  if (endedJobs.size > 300) endedJobs.delete(endedJobs.keys().next().value);
  for (const resolve of jobWaiters.get(job.id) ?? []) resolve(job);
  jobWaiters.delete(job.id);
}

function shortPath(p) {
  const parts = String(p).split(/[/\\]/).filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : p;
}

export function announce(message) {
  // Re-set the text so repeated identical messages are still read out.
  const el = $('announcer');
  el.textContent = '';
  requestAnimationFrame(() => (el.textContent = message));
}

function renderTally() {
  const parts = state.chores.filter((c) => c.backlog).map((c) => `${fmt.n(c.backlog.remaining)} ${c.unit}`);
  $('tally').textContent = parts.length ? parts.join(' · ') : counting ? 'Counting your chores…' : 'Open a cabinet to count its chores.';
}

const START_NOTE = {
  demo: 'Every move does a real chore in the sandbox, and you can undo it from the ledger.',
  live: 'Every move does a real chore on your files, and you can undo it from the ledger.',
  'dry-run': 'Dry run: every move is written to the ledger and nothing on disk changes.',
};

function renderStart() {
  const first = state.chores.find((c) => c.id === 'inbox') ?? state.chores.find((c) => c.game === 'invaders') ?? state.chores[0];
  $('start').classList.toggle('hidden', !first);
  if (!first) return;
  const btn = $('start-btn');
  btn.dataset.start = first.id;
  btn.textContent = `Start here: ${first.title}`;
  $('start-note').textContent = START_NOTE[state.mode] ?? START_NOTE.live;
}

function machineCount(c) {
  const b = c.backlog;
  if (b) return `<b>${fmt.n(b.remaining)}</b><span>${esc(c.unit)} left</span>`;
  if (c.scanError) return `<span>Could not count: ${esc(c.scanError)}</span>`;
  return counting && !c.remote ? '<span>Counting…</span>' : '<span>Not scanned yet</span>';
}

function renderMachines() {
  const mode = $('mode');
  mode.textContent = { demo: 'Demo sandbox', live: 'Live', 'dry-run': 'Dry run' }[state.mode];
  mode.className = `chip${state.mode === 'live' ? ' live' : ''}`;
  // Re-rendering replaces the buttons, so remember which one had focus.
  const focused = document.activeElement?.closest?.('#machines [data-play], #machines [data-calm], #machines [data-sheets]');
  const focusKey = focused && ['play', 'calm', 'sheets'].map((k) => focused.dataset[k] && `[data-${k}="${focused.dataset[k]}"]`).find(Boolean);
  $('machines').innerHTML = state.chores
    .map((c) => {
      const meta = CABINETS[c.game];
      const b = c.backlog;
      const handled = b ? Math.max(0, b.baseline - b.remaining) : 0;
      const pct = b?.baseline ? Math.round((handled / b.baseline) * 100) : 0;
      const impact = describeImpact(c.impact);
      const real = c.remote ? '<span class="tag warn">your real account</span>' : '';
      const exportBtn = c.game === 'blocks' && accounts.google.connected ? `<button class="btn quiet" type="button" data-sheets="${c.id}">${G_LOGO} Export to Sheets</button>` : '';
      return `<li class="machine" style="--accent:${meta.accent}" aria-labelledby="m-${c.id}">
        <div class="art">${spriteSvg(c.game, { size: 52 })}</div>
        <div>
          <h2 id="m-${c.id}">${esc(c.title)}${real}</h2>
          <p class="what">${esc(meta.what)}</p>
          <div class="count">${machineCount(c)}</div>
          <div class="meter" role="progressbar" aria-label="${esc(c.chore)} progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div>
          <p class="done">${esc(impact.slice(0, 3).join(' · '))}</p>
          <p class="source" title="${esc(c.target)}">${esc(shortPath(c.target))}</p>
        </div>
        <div class="controls">
          <button class="btn big" type="button" data-play="${c.id}" aria-label="Play ${esc(c.title)}">Play</button>
          <button class="btn quiet" type="button" data-calm="${c.id}" aria-label="Calm mode for ${esc(c.title)}: no timer, works with a keyboard and screen reader">Calm mode</button>
          ${exportBtn}
        </div>
      </li>`;
    })
    .join('');
  for (const el of document.querySelectorAll('[data-play]')) el.addEventListener('click', () => launch(el.dataset.play, 'game', el));
  for (const el of document.querySelectorAll('[data-calm]')) el.addEventListener('click', () => launch(el.dataset.calm, 'calm', el));
  for (const el of document.querySelectorAll('[data-sheets]')) el.addEventListener('click', () => exportSheets(el));
  if (focusKey) $('machines').querySelector(focusKey)?.focus();
  renderTally();
  renderStart();
}

async function exportSheets(button) {
  button.disabled = true;
  announce('Exporting to Google Sheets…');
  try {
    const result = await api(`/chores/${button.dataset.sheets}/export/sheets`, { method: 'POST' });
    if (result.dryRun) {
      showNotice(`Dry run: no spreadsheet was created. A real run would make “${result.title}” with ${result.tabs.map((t) => t.name).join(' and ')} tabs.`);
      return;
    }
    const { url } = result;
    if (!/^https:\/\/docs\.google\.com\//.test(url)) throw new Error('unexpected link from Google');
    showNotice('');
    $('notice').innerHTML = `Exported. <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open your expenses in Google Sheets</a>`;
    announce('Exported to Google Sheets. A link is at the top of the page.');
  } catch (err) {
    showNotice(`Export failed: ${err.message}`);
    if (err.status === 401) refreshGoogle();
  } finally {
    button.disabled = false;
  }
}

/** Count every local chore so the board shows the real backlog straight away. */
async function countAll() {
  counting++;
  for (const c of state.chores) {
    if (c.remote) continue;
    try {
      const { stats } = await api(`/chores/${c.id}/scan`, { method: 'POST' });
      c.backlog = { baseline: stats.baseline, remaining: stats.remaining };
      c.scanError = null;
    } catch (err) {
      c.scanError = err.message;
      toast(err.message, true);
    }
  }
  counting--;
  if (!current) renderMachines();
}

export function toast(message, error = false) {
  if (!current) return;
  const el = document.createElement('div');
  el.className = `toast${error ? ' err' : ''}`;
  el.textContent = message;
  $('toasts').append(el);
  while ($('toasts').children.length > 4) $('toasts').firstChild.remove();
  setTimeout(() => el.remove(), error ? 6000 : 3000);
}

async function launch(id, mode, opener) {
  const chore = state.chores.find((c) => c.id === id);
  const meta = CABINETS[chore.game];
  $('floor').classList.add('hidden');
  $('stage').classList.remove('hidden');
  $('stage').dataset.toasts = meta.toasts ?? 'top-right';
  $('hud-title').textContent = mode === 'calm' ? `${chore.title}: calm mode` : chore.title;
  $('hud-stats').innerHTML = '';
  const screen = $('game');
  screen.innerHTML = '';
  screen.className = mode === 'calm' ? 'screen paper' : 'screen';
  const session = { id, cleanup: null, impactListeners: new Set(), moves: new Set(), opener };
  current = session;
  $('exit').focus();

  const ctx = {
    root: screen,
    chore,
    toast,
    announce,
    setStats(items) {
      $('hud-stats').innerHTML = items.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
    },
    scan: async () => {
      const result = await api(`/chores/${id}/scan`, { method: 'POST' });
      chore.backlog = { baseline: result.stats.baseline, remaining: result.stats.remaining };
      return result;
    },
    act(groupId, action) {
      const move = api(`/chores/${id}/act`, { method: 'POST', body: { groupId, action } }).catch((err) => {
        toast(err.message, true);
        throw err;
      });
      session.moves.add(move.then((job) => jobEnd(job.id), () => null));
      return move;
    },
    /** The job `act` returned, once the worker has finished it (status 'done' or 'failed'). */
    landed: (job) => jobEnd(job.id),
    /** Resolves when every move this game made has finished or failed, or after `ms`, whichever is first. */
    settled: (ms = 15_000) => Promise.race([Promise.all(session.moves), new Promise((r) => setTimeout(r, ms))]),
    onImpact: (fn) => session.impactListeners.add(fn),
    impact: () => chore.impact,
    exit,
  };
  try {
    const mod = await import(mode === 'calm' ? '/games/calm.js' : meta.module);
    const cleanup = await mod.default(ctx);
    // The player may have left during the intro; tidy up the game they abandoned.
    if (current === session) session.cleanup = cleanup;
    else cleanup?.();
  } catch (err) {
    if (current !== session) return;
    $('hud-stats').innerHTML = '';
    screen.innerHTML = '';
    overlay(screen, `<h2>Could not start</h2><p>${esc(err.message)}</p>`, [{ label: 'Back to the arcade', ghost: true, onClick: exit }]);
  }
}

function exit() {
  if (!current) return;
  const { opener } = current;
  current.cleanup?.();
  current = null;
  $('stage').classList.add('hidden');
  $('floor').classList.remove('hidden');
  renderMachines();
  countAll();
  // Put focus back on the button that opened the game; cabinet buttons were just re-rendered.
  const again = opener?.isConnected ? opener : opener && document.querySelector(`[data-${opener.dataset.play ? 'play' : 'calm'}="${opener.dataset.play ?? opener.dataset.calm}"]`);
  (again ?? $('main')).focus();
}

function renderLedgerEntry(entry) {
  const list = $('ledger-list');
  list.querySelector('.empty')?.remove();
  let li = document.getElementById(`log-${entry.id}`);
  if (!li) {
    li = document.createElement('li');
    li.id = `log-${entry.id}`;
    list.prepend(li);
  }
  const hadFocus = li.contains(document.activeElement);
  const time = new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const chore = state?.chores.find((c) => c.id === entry.chore);
  const pending = undoing.has(entry.id);
  li.className = entry.undone ? 'undone' : '';
  // A pending undo keeps its button focusable (aria-disabled, not disabled) so keyboard focus stays put.
  const button = pending
    ? `<button type="button" aria-disabled="true" aria-label="Undoing: ${esc(entry.label)}">…</button>`
    : `<button type="button" aria-label="Undo: ${esc(entry.label)}">Undo</button>`;
  li.innerHTML = `<div class="what">${esc(entry.label)}<small>${esc(chore?.title ?? entry.chore)} · ${time}${entry.dryRun ? ' · dry run' : ''}${entry.undone ? ' · undone' : ''}</small></div>
    ${entry.undoable && !entry.undone ? button : ''}`;
  li.querySelector('button')?.addEventListener('click', () => undo(entry));
  if (hadFocus) (li.querySelector('button') ?? $('ledger')).focus();
}

async function undo(entry) {
  if (undoing.has(entry.id)) return;
  undoing.add(entry.id);
  renderLedgerEntry(entry);
  let error = null;
  try {
    const job = await api(`/journal/${entry.id}/undo`, { method: 'POST' });
    const end = await jobEnd(job.id);
    // A failed job is announced by the job event handler; the POST errors below are not.
    if (end.status === 'failed') error = end.error;
    // The 'undo' event normally settles the entry; this covers one that went missing.
    else if (undoing.delete(entry.id)) {
      entry.undone = true;
      renderLedgerEntry(entry);
    }
  } catch (err) {
    error = err.message;
    announce(`Undo failed: ${err.message}`);
  }
  if (error === null) return;
  undoing.delete(entry.id);
  renderLedgerEntry(entry);
  showNotice(`Undo failed: ${error}`, false);
}

function onEvent(event) {
  if (event.type === 'hello' || event.type === 'state') {
    const backlogs = new Map((state?.chores ?? []).map((c) => [c.id, c.backlog]));
    const remoteBefore = (state?.chores ?? []).filter((c) => c.remote).map((c) => c.id);
    state = event.state;
    for (const c of state.chores) c.backlog ??= backlogs.get(c.id) ?? null;
    if (event.type === 'hello') countAll();
    // Remote cabinets also go when Google or Dropbox revokes the sign-in, so the masthead is refreshed with them.
    const gone = remoteBefore.filter((id) => !state.chores.some((c) => c.id === id));
    if (event.type === 'hello' || gone.some((id) => id !== 'dropbox')) refreshGoogle();
    if (event.type === 'hello' || gone.includes('dropbox')) refreshDropbox();
    if (!current) renderMachines();
    // Entries can arrive before the chores they belong to, so their chore names are filled in now.
    for (const entry of ledger.values()) renderLedgerEntry(entry);
  }
  if (event.type === 'job') {
    if (event.job.status === 'queued' || event.job.status === 'running') activeJobs.add(event.job.id);
    else activeJobs.delete(event.job.id);
    const n = activeJobs.size;
    const worker = $('worker');
    worker.textContent = n ? `Worker: ${n} change${n > 1 ? 's' : ''} running` : 'Worker idle';
    worker.classList.toggle('busy', n > 0);
    if (event.job.status === 'failed') {
      toast(`${event.job.label}: ${event.job.error}`, true);
      announce(`Failed: ${event.job.label}. ${event.job.error}`);
    }
    if (event.job.status === 'done' || event.job.status === 'failed') jobEnded(event.job);
  }
  if (event.type === 'change') {
    const chore = state.chores.find((c) => c.id === event.chore);
    if (chore) chore.impact = event.impact;
    ledger.set(event.entry.id, event.entry);
    renderLedgerEntry(event.entry);
    announce(event.entry.label);
    if (current?.id === event.chore) {
      toast(`✓ ${event.entry.label}`);
      for (const fn of current.impactListeners) fn(event.impact, event.entry);
    }
  }
  if (event.type === 'undo') {
    const chore = state.chores.find((c) => c.id === event.chore);
    if (chore) chore.impact = event.impact;
    if (current?.id === event.chore) for (const fn of current.impactListeners) fn(event.impact, null);
    const entry = ledger.get(event.entryId);
    undoing.delete(event.entryId);
    if (entry) {
      entry.undone = true;
      renderLedgerEntry(entry);
    }
    toast(`↩ ${event.summary}`);
    announce(`Undone: ${event.summary}`);
    if (!current) countAll();
  }
}

/** What signing in added, keyed by the cabinets left out because their access was not granted. */
const SIGNED_IN = {
  '': 'Signed in with Google. Your Gmail inbox and Drive are now cabinets below. They are your real accounts: every move is journaled and undoable.',
  drive: 'Signed in with Google. Drive access was not granted, so your Gmail inbox is the only new cabinet and Sheets export is off. To add Drive, sign out and connect again with Drive ticked. Gmail is your real account: every move is journaled and undoable.',
  gmail: 'Signed in with Google. Gmail access was not granted, so your Drive is the only new cabinet. To add Gmail, sign out and connect again with Gmail ticked. Drive is your real account: every move is journaled and undoable.',
  'drive,gmail': 'Signed in with Google, but neither Gmail nor Drive access was granted, so no cabinets were added. Sign out and connect again with both ticked.',
};

async function boot() {
  $('logo').innerHTML = spriteSvg('invaders', { size: 36 });
  const entries = await api('/journal');
  if (!entries.length) $('ledger-list').innerHTML = '<li class="empty">Nothing yet. Play a game and the real changes show up here.</li>';
  for (const entry of entries.reverse()) {
    ledger.set(entry.id, entry);
    renderLedgerEntry(entry);
  }
  const params = new URLSearchParams(location.search);
  if (params.has('google')) {
    const outcome = params.get('google');
    const skipped = (params.get('skipped') ?? '').split(',').filter(Boolean).sort().join(',');
    history.replaceState(null, '', '/');
    showNotice(outcome === 'connected' ? (SIGNED_IN[skipped] ?? SIGNED_IN['']) : 'Google sign-in was cancelled.');
  }
  if (params.has('dropbox')) {
    const connected = params.get('dropbox') === 'connected';
    history.replaceState(null, '', '/');
    showNotice(
      connected
        ? 'Connected to Dropbox. Your Dropbox folder is now the Folder Frenzy: Dropbox cabinet below. It is your real account: every move is journaled and undoable, and Trash is a ChoreCade Trash folder, so nothing is deleted.'
        : 'Dropbox sign-in was cancelled.',
    );
  }
  listen(onEvent);
  $('exit').addEventListener('click', exit);
  $('start-btn').addEventListener('click', (e) => state && launch(e.currentTarget.dataset.start, 'game', e.currentTarget));
  // Escape leaves the game from anywhere, the intro and results cards included, just like the Back button.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && current) exit();
  });

  setupTour();
}

boot().catch((err) => {
  $('tally').textContent = `ChoreCade could not reach its server: ${err.message}`;
});
