// The arcade floor: cabinets, the live log, and launching games.
import { api, fmt, listen } from './api.js';

const CABINETS = {
  inbox: {
    icon: '👾',
    accent: '#22d3ee',
    game: '/games/invaders.js',
    how: 'Senders descend as invaders. Blast them with the archive laser, trash torpedo or unsubscribe EMP: every hit moves all of that sender’s mail.',
  },
  files: {
    icon: '📦',
    accent: '#a3e635',
    game: '/games/frenzy.js',
    how: 'Crates of look-alike files fall towards the bins. Steer each one into Images, Documents, Installers... and the files really move.',
  },
  expenses: {
    icon: '🧾',
    accent: '#fbbf24',
    game: '/games/receipts.js',
    toasts: 'bottom-left',
    how: 'Merchant cards fly in against the clock. File each into a category and your categorised CSV, report and rules write themselves.',
  },
  lint: {
    icon: '🐉',
    accent: '#f472b6',
    game: '/games/dungeon.js',
    toasts: 'bottom-right',
    how: 'A dungeon crawl where every broken lint rule is a monster. Slaying one runs ESLint’s autofix for that rule across the project.',
  },
};

const IMPACT_LABELS = {
  archived: (v) => `${fmt.n(v)} emails archived`,
  trashed: (v) => `${fmt.n(v)} trashed`,
  unsubscribed: (v) => `${fmt.n(v)} lists unsubscribed`,
  kept: (v) => `${fmt.n(v)} kept`,
  moved: (v) => `${fmt.n(v)} files sorted`,
  bytes: (v) => `${fmt.bytes(v)} tidied`,
  categorized: (v) => `${fmt.n(v)} transactions filed`,
  dollars: (v) => `${fmt.money(v)} reviewed`,
  flagged: (v) => `${fmt.n(v)} flagged`,
  fixed: (v) => `${fmt.n(v)} lint problems fixed`,
  silenced: (v) => `${fmt.n(v)} silenced`,
  logged: (v) => `${fmt.n(v)} logged`,
  files: () => null,
};

export function describeImpact(impact = {}) {
  return Object.entries(impact)
    .map(([k, v]) => IMPACT_LABELS[k]?.(v))
    .filter(Boolean);
}

const $ = (id) => document.getElementById(id);
let state = null;
let current = null; // { id, cleanup, impactListeners }
const logEntries = new Map();
const activeJobs = new Set();

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function shortPath(p) {
  const parts = String(p).split(/[/\\]/).filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : p;
}

function renderHub() {
  const mode = $('mode');
  mode.textContent = { demo: 'DEMO SANDBOX', live: 'LIVE', 'dry-run': 'DRY RUN' }[state.mode];
  mode.className = `badge ${state.mode === 'live' ? 'live' : 'demo'}`;
  $('cabinets').innerHTML = state.chores
    .map((c) => {
      const meta = CABINETS[c.id];
      const impact = describeImpact(c.impact);
      return `<button class="cabinet" data-id="${c.id}" style="--accent:${meta.accent}">
        <span class="icon">${meta.icon}</span>
        <h3>${esc(c.title)}</h3>
        <span class="chore">${esc(c.chore)}</span>
        <span class="target" title="${esc(c.target)}">${esc(shortPath(c.target))}</span>
        <span class="how">${esc(meta.how)}</span>
        <span class="impact">${esc(impact.slice(0, 2).join(' · '))}</span>
        <span class="play">▶ INSERT COIN</span>
      </button>`;
    })
    .join('');
  const all = state.chores.flatMap((c) => describeImpact(c.impact).map((t) => ({ t, c })));
  $('totals').innerHTML = all.length
    ? all
        .map(({ t }) => {
          const [num, ...rest] = t.split(' ');
          return `<div class="total"><b>${esc(num)}</b><span>${esc(rest.join(' '))}</span></div>`;
        })
        .join('')
    : '';
  for (const el of document.querySelectorAll('.cabinet')) el.addEventListener('click', () => launch(el.dataset.id));
}

export function toast(message, error = false) {
  const el = document.createElement('div');
  el.className = `toast${error ? ' err' : ''}`;
  el.textContent = message;
  $('toasts').append(el);
  while ($('toasts').children.length > 5) $('toasts').firstChild.remove();
  setTimeout(() => el.remove(), error ? 6000 : 3500);
}

async function launch(id) {
  const chore = state.chores.find((c) => c.id === id);
  const meta = CABINETS[id];
  $('hub').classList.add('hidden');
  $('stage').classList.remove('hidden');
  $('hud-title').textContent = `${meta.icon} ${chore.title}`;
  $('game').innerHTML = '';
  $('stage').dataset.toasts = meta.toasts ?? 'top-right';
  const impactListeners = new Set();
  current = { id, impactListeners, cleanup: null };
  const setStats = (items) => {
    $('hud-stats').innerHTML = items.map(([k, v]) => `<span>${esc(k)} <b>${esc(v)}</b></span>`).join('');
  };
  const ctx = {
    root: $('game'),
    chore,
    toast,
    setStats,
    scan: () => api(`/chores/${id}/scan`, { method: 'POST' }),
    act: (groupId, action) =>
      api(`/chores/${id}/act`, { method: 'POST', body: { groupId, action } }).catch((err) => {
        toast(err.message, true);
        throw err;
      }),
    onImpact: (fn) => impactListeners.add(fn),
    impact: () => state.chores.find((c) => c.id === id).impact,
    exit,
  };
  try {
    const session = current;
    const mod = await import(meta.game);
    const cleanup = await mod.default(ctx);
    // The player may have left during the intro; tidy up the game they abandoned.
    if (current === session) session.cleanup = cleanup;
    else cleanup?.();
  } catch (err) {
    toast(`Could not start: ${err.message}`, true);
  }
}

function exit() {
  current?.cleanup?.();
  current = null;
  $('stage').classList.add('hidden');
  $('hub').classList.remove('hidden');
  renderHub();
}

function renderLogEntry(entry) {
  let li = document.getElementById(`log-${entry.id}`);
  if (!li) {
    li = document.createElement('li');
    li.id = `log-${entry.id}`;
    $('log-list').prepend(li);
  }
  const time = new Date(entry.at).toLocaleTimeString();
  li.className = entry.undone ? 'undone' : '';
  li.innerHTML = `<div class="what">${esc(entry.label)}<small>${esc(entry.chore)} · ${time}${entry.dryRun ? ' · dry run' : ''}</small></div>
    ${entry.undoable && !entry.undone ? '<button>Undo</button>' : ''}`;
  li.querySelector('button')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = '…';
    try {
      await api(`/journal/${entry.id}/undo`, { method: 'POST' });
    } catch (err) {
      e.target.disabled = false;
      e.target.textContent = 'Undo';
      alert(err.message);
    }
  });
  $('log-count').textContent = logEntries.size;
}

function onEvent(event) {
  if (event.type === 'hello') {
    state = event.state;
    if (!current) renderHub();
  }
  if (event.type === 'job') {
    if (event.job.status === 'queued' || event.job.status === 'running') activeJobs.add(event.job.id);
    else activeJobs.delete(event.job.id);
    const worker = $('worker');
    const n = activeJobs.size;
    worker.textContent = n ? `${n} change${n > 1 ? 's' : ''} running in background` : 'idle';
    worker.classList.toggle('busy', n > 0);
    if (event.job.status === 'failed') toast(`${event.job.label}: ${event.job.error}`, true);
  }
  if (event.type === 'change') {
    const chore = state.chores.find((c) => c.id === event.chore);
    if (chore) chore.impact = event.impact;
    logEntries.set(event.entry.id, event.entry);
    renderLogEntry(event.entry);
    if (current?.id === event.chore) {
      toast(`✔ ${event.entry.label}`);
      for (const fn of current.impactListeners) fn(event.impact, event.entry);
    } else if (!current) renderHub();
  }
  if (event.type === 'undo') {
    const chore = state.chores.find((c) => c.id === event.chore);
    if (chore) chore.impact = event.impact;
    if (current?.id === event.chore) for (const fn of current.impactListeners) fn(event.impact, null);
    const entry = logEntries.get(event.entryId);
    if (entry) {
      entry.undone = true;
      renderLogEntry(entry);
    }
    toast(`↩ ${event.summary}`);
  }
}

async function boot() {
  for (const entry of (await api('/journal')).reverse()) {
    logEntries.set(entry.id, entry);
    renderLogEntry(entry);
  }
  listen(onEvent);
  $('log-toggle').addEventListener('click', () => $('log').classList.toggle('hidden'));
  $('log-close').addEventListener('click', () => $('log').classList.add('hidden'));
  $('exit').addEventListener('click', exit);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && current) exit();
  });
}

boot().catch((err) => {
  document.body.insertAdjacentHTML('beforeend', `<p style="padding:20px;color:#f43f5e">ChoreCade could not reach its server: ${esc(err.message)}</p>`);
});
