// The arcade floor: the backlog, the ledger, and launching games.
import { api, fmt, listen } from './api.js';
import { spriteSvg } from './sprites.js';

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
  receipts: {
    accent: '#0f7a54',
    module: '/games/receipts.js',
    what: 'Each merchant is a monster. Choose FILE, FLAG or SPARE on your turn (that choice files its charges for real), then dodge its attack.',
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
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let state = null;
let google = { configured: false, connected: false, email: null };

const G_LOGO = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.4 30.2 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.8 6C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4 7.1-10 7.1-17.5z"/><path fill="#FBBC05" d="M10.5 28.7a14.5 14.5 0 0 1 0-9.4l-7.8-6a24 24 0 0 0 0 21.4l7.8-6z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.9 2.3-8.4 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.8 6C6.6 42.6 14.6 48 24 48z"/></svg>';

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
      await api('/google/disconnect', { method: 'POST' });
      announce('Signed out of Google. Gmail and Drive cabinets removed.');
      refreshGoogle();
    });
  } else {
    slot.innerHTML = `<button class="btn quiet g-btn" type="button" id="g-in">${G_LOGO}<span>Sign in with Google</span></button>`;
    $('g-in').addEventListener('click', async () => {
      if (!google.configured) {
        showNotice('Google sign-in needs a Google Cloud OAuth client. Copy .env.example to .env, add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, and restart. The README walks through it in two minutes.');
        return;
      }
      const { url } = await api('/google/connect', { method: 'POST' });
      location.assign(url);
    });
  }
  if (!current && state) renderMachines();
}

function showNotice(text) {
  const el = $('notice');
  el.textContent = text;
  el.classList.remove('hidden');
  el.focus();
}
let current = null; // { id, cleanup, impactListeners, opener }
const ledger = new Map();
const activeJobs = new Set();

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
  $('tally').textContent = parts.length ? parts.join(' · ') : 'Counting your chores…';
}

function renderMachines() {
  const mode = $('mode');
  mode.textContent = { demo: 'Demo sandbox', live: 'Live', 'dry-run': 'Dry run' }[state.mode];
  mode.className = `chip${state.mode === 'live' ? ' live' : ''}`;
  $('machines').innerHTML = state.chores
    .map((c) => {
      const meta = CABINETS[c.game];
      const b = c.backlog;
      const handled = b ? Math.max(0, b.baseline - b.remaining) : 0;
      const pct = b?.baseline ? Math.round((handled / b.baseline) * 100) : 0;
      const impact = describeImpact(c.impact);
      const real = c.remote ? '<span class="tag warn">your real account</span>' : '';
      const exportBtn = c.game === 'receipts' && google.connected ? `<button class="btn quiet" type="button" data-sheets="${c.id}">${G_LOGO} Export to Sheets</button>` : '';
      return `<li class="machine" style="--accent:${meta.accent}" aria-labelledby="m-${c.id}">
        <div class="art">${spriteSvg(c.game, { size: 52 })}</div>
        <div>
          <h2 id="m-${c.id}">${esc(c.title)}${real}</h2>
          <p class="what">${esc(meta.what)}</p>
          <div class="count">${b ? `<b>${fmt.n(b.remaining)}</b><span>${esc(c.unit)} left</span>` : c.remote ? '<span>Not scanned yet</span>' : '<span>Counting…</span>'}</div>
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
  renderTally();
}

async function exportSheets(button) {
  button.disabled = true;
  announce('Exporting to Google Sheets…');
  try {
    const { url } = await api(`/chores/${button.dataset.sheets}/export/sheets`, { method: 'POST' });
    if (!/^https:\/\/docs\.google\.com\//.test(url)) throw new Error('unexpected link from Google');
    showNotice('');
    $('notice').innerHTML = `Exported. <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open your expenses in Google Sheets</a>`;
    announce('Exported to Google Sheets. A link is at the top of the page.');
  } catch (err) {
    showNotice(`Export failed: ${err.message}`);
  } finally {
    button.disabled = false;
  }
}

/** Count every local chore so the board shows the real backlog straight away. */
async function countAll() {
  for (const c of state.chores) {
    if (c.remote) continue;
    try {
      const { stats } = await api(`/chores/${c.id}/scan`, { method: 'POST' });
      c.backlog = { baseline: stats.baseline, remaining: stats.remaining };
    } catch (err) {
      toast(err.message, true);
    }
  }
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
  const session = { id, cleanup: null, impactListeners: new Set(), opener };
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
    act: (groupId, action) =>
      api(`/chores/${id}/act`, { method: 'POST', body: { groupId, action } }).catch((err) => {
        toast(err.message, true);
        throw err;
      }),
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
    toast(`Could not start: ${err.message}`, true);
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
  // Put focus back on the button that opened the game.
  const again = opener && document.querySelector(`[data-${opener.dataset.play ? 'play' : 'calm'}="${opener.dataset.play ?? opener.dataset.calm}"]`);
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
  const time = new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const chore = state?.chores.find((c) => c.id === entry.chore);
  li.className = entry.undone ? 'undone' : '';
  li.innerHTML = `<div class="what">${esc(entry.label)}<small>${esc(chore?.title ?? entry.chore)} · ${time}${entry.dryRun ? ' · dry run' : ''}${entry.undone ? ' · undone' : ''}</small></div>
    ${entry.undoable && !entry.undone ? `<button type="button" aria-label="Undo: ${esc(entry.label)}">Undo</button>` : ''}`;
  li.querySelector('button')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '…';
    try {
      await api(`/journal/${entry.id}/undo`, { method: 'POST' });
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Undo';
      announce(`Undo failed: ${err.message}`);
      alert(err.message);
    }
  });
}

function onEvent(event) {
  if (event.type === 'hello' || event.type === 'state') {
    const backlogs = new Map((state?.chores ?? []).map((c) => [c.id, c.backlog]));
    state = event.state;
    for (const c of state.chores) c.backlog ??= backlogs.get(c.id) ?? null;
    if (!current) renderMachines();
    if (event.type === 'hello') {
      countAll();
      refreshGoogle();
    }
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
    if (entry) {
      entry.undone = true;
      renderLedgerEntry(entry);
    }
    toast(`↩ ${event.summary}`);
    announce(`Undone: ${event.summary}`);
    if (!current) countAll();
  }
}

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
    history.replaceState(null, '', '/');
    showNotice(outcome === 'connected' ? 'Signed in with Google. Your Gmail inbox and Drive are now cabinets below. They are your real accounts: every move is journaled and undoable.' : 'Google sign-in was cancelled.');
  }
  listen(onEvent);
  $('exit').addEventListener('click', exit);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && current && !document.querySelector('.overlay')) exit();
  });
}

boot().catch((err) => {
  $('tally').textContent = `ChoreCade could not reach its server: ${err.message}`;
});
