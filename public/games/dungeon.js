// Lint Dungeon. An interactive crawl: each floor is one lint pass, each
// monster one broken rule with HP equal to how often it is broken. Spells
// are real: Autofix runs ESLint's fixer for that rule across the project.
// Whatever survives regroups on the next floor, which is a fresh lint pass.
import { esc, intro, keyboard, results } from './kit.js';

const STYLE = `
.ld { position:absolute; inset:0; display:flex; flex-direction:column; gap:14px; padding:18px; overflow:auto; background:radial-gradient(900px 400px at 50% 110%, #3b0a2a55, transparent); }
.ld-story { font:14px/1.55 ui-monospace,Consolas,monospace; color:#cbd5e1; min-height:3.2em; max-width:900px; }
.ld-story b { color:#f472b6; }
.ld-focus { display:flex; align-items:center; gap:10px; font:12px ui-monospace,Consolas,monospace; color:#8a97b8; }
.ld-focus .ld-bar { flex:1; max-width:340px; height:10px; background:#141d36; border-radius:99px; overflow:hidden; }
.ld-focus .ld-bar i { display:block; height:100%; background:linear-gradient(90deg,#f43f5e,#a3e635); transition:width .2s; }
.ld-room { display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:14px; flex:1; align-content:start; }
.ld-mon { position:relative; background:linear-gradient(180deg,#1a1430,#0f1629); border:1px solid #2b2550; border-radius:16px; padding:16px; cursor:pointer; transition:transform .15s, border-color .15s, opacity .3s; }
.ld-mon.sel { border-color:#f472b6; box-shadow:0 0 0 1px #f472b6, 0 0 30px -10px #f472b6; transform:translateY(-3px); }
.ld-mon.dead { opacity:0; transform:scale(.8) rotate(-4deg); pointer-events:none; }
.ld-mon.hit { animation:shake .3s; }
@keyframes shake { 25%{transform:translateX(-6px)} 75%{transform:translateX(6px)} }
.ld-face { font-size:44px; line-height:1; }
.ld-name { font:800 15px ui-monospace,Consolas,monospace; color:#f9a8d4; margin-top:8px; word-break:break-all; }
.ld-hp { height:8px; background:#141d36; border-radius:99px; overflow:hidden; margin:8px 0 4px; position:relative; }
.ld-hp i { position:absolute; inset:0 auto 0 0; background:#f43f5e; }
.ld-hp i.fix { background:#a3e635; }
.ld-meta { font:11px ui-monospace,Consolas,monospace; color:#8a97b8; }
.ld-taunt { margin-top:8px; font:11px/1.4 ui-monospace,Consolas,monospace; color:#cbd5e1; background:#0b1020; border-radius:8px; padding:8px; }
.ld-spells { position:sticky; bottom:0; background:linear-gradient(transparent,#070b16 30%); padding-top:14px; display:flex; gap:8px; flex-wrap:wrap; justify-content:center; padding-bottom:6px; }
.ld-spells button { background:#0f1629; border:1px solid #22304f; border-radius:12px; padding:10px 14px; font:13px ui-monospace,Consolas,monospace; color:#e6ecff; }
.ld-spells button:hover:not(:disabled) { border-color:var(--c); box-shadow:0 0 18px -6px var(--c); }
.ld-spells button:disabled { opacity:.35; cursor:not-allowed; }
.ld-spells kbd { margin-right:6px; }
`;

const FACES = {
  'no-unused-vars': '👻',
  'no-undef': '🕳️',
  'prefer-const': '🗿',
  'no-var': '🦖',
  eqeqeq: '⚖️',
  curly: '🐍',
  'prefer-template': '🧵',
  'object-shorthand': '🦎',
  'no-else-return': '🪃',
  'dot-notation': '🔸',
  'prefer-arrow-callback': '🏹',
  yoda: '🧙',
  'parse-error': '💀',
};

const FLOORS = [
  'The Swamp of Shadowed Variables',
  'The Crypt of Loose Equality',
  'The Hall of Forgotten Braces',
  'The Abyss of Legacy Code',
  'The Throne of the Last Warning',
];

const SPELLS = [
  { id: 'fix', key: 'F', label: 'Autofix', color: '#a3e635', verb: 'cast AUTOFIX' },
  { id: 'disable', key: 'S', label: 'Silence', color: '#facc15', verb: 'cast SILENCE' },
  { id: 'log', key: 'L', label: 'Quest log', color: '#38bdf8', verb: 'write it into the QUEST LOG' },
  { id: 'skip', key: 'X', label: 'Not today', color: '#64748b', verb: 'back away from' },
];

export default async function play(ctx) {
  const { root, act, setStats, exit } = ctx;
  const style = document.createElement('style');
  style.textContent = STYLE;
  root.append(style);

  setStats([['Linting', 'project…']]);
  let scan = await ctx.scan();
  const startProblems = scan.stats.problems;
  if (!scan.groups.length) {
    results(root, { title: 'NO MONSTERS', lines: ['ESLint finds nothing to complain about. The dungeon is already clean.'], stats: [], onExit: exit });
    return () => {};
  }

  await intro(root, {
    title: 'LINT DUNGEON',
    story: `${scan.stats.problems} problems lurk in ${scan.stats.files} files (${scan.stats.engine}). Every monster is one rule. Green HP is what Autofix can burn away for real; red needs a human. Your focus drains while monsters stand. Clear the floor and the survivors regroup below.`,
    keys: [
      ['← → / Tab', 'choose a monster (or click)'],
      ['F', 'Autofix: ESLint fixes this rule everywhere'],
      ['S', 'Silence: add a marked eslint-disable comment'],
      ['L', 'Quest log: write it in LINT_QUESTLOG.md'],
      ['X', 'Not today: leave it for later'],
    ],
    start: 'ENTER THE DUNGEON',
  });

  const ui = document.createElement('div');
  ui.className = 'ld';
  ui.innerHTML = `<div class="ld-story"></div>
    <div class="ld-focus">FOCUS <span class="ld-bar"><i></i></span> <span class="ld-focus-n"></span></div>
    <div class="ld-room"></div>
    <div class="ld-spells">${SPELLS.map((s) => `<button data-s="${s.id}" style="--c:${s.color}"><kbd>${s.key}</kbd>${s.label}</button>`).join('')}</div>`;
  root.append(ui);
  const story = ui.querySelector('.ld-story');
  const room = ui.querySelector('.ld-room');

  let floor = 0;
  let monsters = [];
  let selected = 0;
  let focus = 100;
  let slain = 0;
  let sent = 0;
  let landed = 0;
  const shelved = new Set(); // rules the player chose to leave
  let done = false;
  let timer = 0;

  ctx.onImpact((impact, entry) => entry && landed++);

  function narrate(html) {
    story.innerHTML = html;
  }

  function renderRoom() {
    room.innerHTML = '';
    monsters.forEach((m, i) => {
      const el = document.createElement('div');
      el.className = `ld-mon${i === selected ? ' sel' : ''}`;
      const sample = m.group.samples[0];
      el.innerHTML = `<div class="ld-face">${FACES[m.group.rule] ?? '👹'}</div>
        <div class="ld-name">${esc(m.group.rule)}</div>
        <div class="ld-hp"><i style="width:100%"></i><i class="fix" style="width:${(m.group.fixable / m.group.count) * 100}%"></i></div>
        <div class="ld-meta">HP ${m.group.count} · ${m.group.fixable} autofixable · ${m.group.size} file${m.group.size > 1 ? 's' : ''}</div>
        <div class="ld-taunt">“${esc(m.group.detail)}”<br>${esc(sample.file)}:${sample.line}</div>`;
      el.addEventListener('click', () => {
        selected = i;
        renderRoom();
      });
      m.el = el;
      room.append(el);
    });
    const target = monsters[selected];
    for (const b of ui.querySelectorAll('.ld-spells button')) b.disabled = !target || (b.dataset.s === 'fix' && !target.group.fixable);
  }

  function enterFloor() {
    const groups = scan.groups.filter((g) => !shelved.has(g.rule));
    if (!groups.length) return finish();
    monsters = groups.map((group) => ({ group }));
    selected = 0;
    const name = FLOORS[Math.min(floor, FLOORS.length - 1)];
    narrate(
      floor === 0
        ? `You descend into <b>${esc(name)}</b>. ${monsters.length} monsters stir in the dark, the largest a <b>${esc(monsters[0].group.rule)}</b> with ${monsters[0].group.count} HP.`
        : `Floor ${floor + 1}: <b>${esc(name)}</b>. The survivors regroup: ${monsters.length} remain, ${groups.reduce((s, g) => s + g.count, 0)} problems in all.`,
    );
    renderRoom();
  }

  async function nextFloor() {
    narrate('The floor falls silent. The worker is still sweeping up behind you…');
    // Wait for the background worker to finish this floor's spells before re-linting.
    const until = Date.now() + 20_000;
    while (landed < sent && Date.now() < until) await new Promise((r) => setTimeout(r, 150));
    scan = await ctx.scan();
    floor++;
    enterFloor();
  }

  function cast(spellId) {
    const m = monsters[selected];
    if (!m || done) return;
    if (spellId === 'fix' && !m.group.fixable) return narrate(`Autofix fizzles: ESLint cannot fix <b>${esc(m.group.rule)}</b> by itself.`);
    const spell = SPELLS.find((s) => s.id === spellId);
    act(m.group.id, spellId).catch(() => {});
    sent++;
    // Logged and skipped rules are left standing on purpose; do not meet them again below.
    if (spellId === 'skip' || spellId === 'log') shelved.add(m.group.rule);
    if (spellId !== 'skip') slain++;
    focus = Math.min(100, focus + 6);
    const partial = spellId === 'fix' && m.group.fixable < m.group.count;
    narrate(
      `You ${spell.verb} on <b>${esc(m.group.rule)}</b>. ` +
        (spellId === 'fix'
          ? partial
            ? `${m.group.fixable} of its ${m.group.count} HP burn away; the rest will regroup below.`
            : `It dissolves: ${m.group.count} problems fixed across ${m.group.size} file${m.group.size > 1 ? 's' : ''}.`
          : spellId === 'disable'
            ? `It falls quiet under ${m.group.count} marked comments.`
            : spellId === 'log'
              ? 'Its lair is now charted in LINT_QUESTLOG.md.'
              : 'It will still be here another day.'),
    );
    m.el.classList.add('dead');
    monsters.splice(selected, 1);
    selected = Math.min(selected, monsters.length - 1);
    setTimeout(() => (monsters.length ? renderRoom() : nextFloor()), 300);
  }

  ui.querySelector('.ld-spells').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b && !b.disabled) cast(b.dataset.s);
  });

  const kb = keyboard((e) => {
    const k = e.key.toLowerCase();
    if (k === 'arrowright' || k === 'tab') {
      e.preventDefault();
      selected = (selected + 1) % Math.max(1, monsters.length);
      renderRoom();
    }
    if (k === 'arrowleft') {
      selected = (selected - 1 + monsters.length) % Math.max(1, monsters.length);
      renderRoom();
    }
    const spell = SPELLS.find((s) => s.key.toLowerCase() === k);
    if (spell) cast(spell.id);
  });

  // Monsters chip at your focus while you hesitate: a little pressure, no real harm.
  timer = setInterval(() => {
    if (done || !monsters.length) return;
    const attacker = monsters[Math.floor(Math.random() * monsters.length)];
    focus -= Math.min(9, 2 + Math.log2(attacker.group.count + 1));
    attacker.el?.classList.remove('hit');
    void attacker.el?.offsetWidth;
    attacker.el?.classList.add('hit');
    if (focus <= 0) {
      done = true;
      results(root, {
        title: 'YOU PROCRASTINATED',
        lines: ['Your focus ran out. Everything you already cast really happened and stays done.'],
        stats: [
          [String(slain), 'monsters handled'],
          [String(startProblems), 'problems at the start'],
        ],
        onAgain: () => {
          focus = 100;
          done = false;
          nextFloor();
        },
        onExit: exit,
      });
    }
  }, 1600);

  const statLoop = setInterval(() => {
    ui.querySelector('.ld-focus .ld-bar i').style.width = `${Math.max(0, focus)}%`;
    ui.querySelector('.ld-focus-n').textContent = `${Math.max(0, Math.round(focus))}`;
    setStats([
      ['Floor', String(floor + 1)],
      ['Monsters here', String(monsters.length)],
      ['Handled', String(slain)],
      ['Fixed for real', String(ctx.impact().fixed ?? 0)],
      ['Problems at start', String(startProblems)],
    ]);
  }, 200);

  async function finish() {
    done = true;
    while (landed < sent) await new Promise((r) => setTimeout(r, 150));
    const after = await ctx.scan();
    results(root, {
      title: after.stats.problems ? 'DUNGEON SURVIVED' : 'DUNGEON CLEANSED',
      lines: [
        after.stats.problems
          ? `${after.stats.problems} problems remain: the ones you logged or left for another day.`
          : 'ESLint has nothing left to say about this project.',
        'Review the diff before you commit. Every file change can be undone from the real-world log.',
      ],
      stats: [
        [String(startProblems), 'problems at the start'],
        [String(after.stats.problems), 'problems now'],
        [String(ctx.impact().fixed ?? 0), 'autofixed'],
        [String(floor + 1), 'floors'],
      ],
      onExit: exit,
    });
  }

  enterFloor();
  return () => {
    done = true;
    clearInterval(timer);
    clearInterval(statLoop);
    kb.destroy();
  };
}
