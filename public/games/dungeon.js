// Lint Dungeon: a side-scrolling castle crawl in the Metroidvania tradition.
// Every broken lint rule is a foe placed in the castle; big rules are bosses.
// Three weapons, three real actions: the Fix Beam runs ESLint's autofix for the
// rule (and only hurts foes ESLint can fix), the Hush Whip adds marked disable
// comments, the Quest Scroll writes the rule into LINT_QUESTLOG.md. A foe falls
// to one weapon, so the kill is the action. Clear a floor and the exit door
// opens; the next floor is a fresh lint pass. All art here is original.
import { Fx, actionBar, intro, keyboard, loop, makeCanvas, reducedMotion, results, truncate } from './kit.js';
import { bossHp } from './arena.js';
import { GROUND, PHYS, SECTION, TILE, buildLevel, moveBox, overlap } from './platformer.js';

const VW = 320;
const VH = 180;
const MAX_HP = 6;
const WEAPONS = [
  { id: 'fix', label: 'Fix Beam', short: 'Fix', key: '1', color: '#17a673' },
  { id: 'disable', label: 'Hush Whip', short: 'Hush', key: '2', color: '#f2b632' },
  { id: 'log', label: 'Quest Scroll', short: 'Scroll', key: '3', color: '#4f7cf0' },
];
const COLOR = Object.fromEntries(WEAPONS.map((w) => [w.id, w.color]));
const FLOORS = ['Entrance Hall', 'Clock Corridor', 'Flooded Archive', 'Inner Keep', 'Throne of Warnings'];

const PAL = { k: '#1d1b16', c: '#2b59d9', d: '#1b3a99', s: '#f2c79a', y: '#f2b632', w: '#fffdf8', r: '#c7361d', g: '#17a673', p: '#9b3d78', e: '#ffe14d', o: '#e36a1c' };
const ART = {
  hero: [
    '...kkkk...',
    '..kcccck..',
    '.kccsssck.',
    '.kcskssk..',
    '.kcsssssk.',
    '..kyyyyyk.',
    '.kcccccyk.',
    'kccccccck.',
    'kcwcccccck',
    '.kccccccck',
    '.kddddddk.',
    '..kd..dk..',
    '..kk..kk..',
  ],
  heroRun: [
    '...kkkk...',
    '..kcccck..',
    '.kccsssck.',
    '.kcskssk..',
    '.kcsssssk.',
    '..kyyyyyk.',
    '.kcccccyk.',
    'kccccccck.',
    'kcwcccccck',
    '.kccccccck',
    '.kddddddk.',
    '.kd....dk.',
    'kk......kk',
  ],
  crawler: [
    '..kkkkkk..',
    '.kggggggk.',
    'kgkggggkgk',
    'kggggggggk',
    '.kkkkkkkk.',
    'k.k.kk.k.k',
  ],
  bat: [
    'k....kk....k',
    'kk..kppk..kk',
    'kpk.kekek.pk',
    'kppkppppkppk',
    '.kpppkkpppk.',
    '..kk....kk..',
  ],
  boss: [
    '..k........k....',
    '...k......k.....',
    '....kkkkkk......',
    '..kkppppppkk....',
    '.kppekppekppk...',
    'kpppppppppppk...',
    'kppkkkkkkkppk...',
    'kpppppppppppk...',
    '.kpppppppppk....',
    'k.kkkkkkkkk.k...',
    '.k.k.k..k.k.k...',
  ],
  candle: ['.oo.', '.yy.', 'kwwk', 'kwwk', 'kwwk', 'kkkk'],
  heart: ['.r.r.', 'rrrrr', 'rrrrr', '.rrr.', '..r..'],
};

function sprite(g, rows, x, y, { flip = false, tint = null } = {}) {
  const w = rows[0].length;
  rows.forEach((row, ry) => {
    for (let rx = 0; rx < w; rx++) {
      const c = row[flip ? w - 1 - rx : rx];
      if (c === '.') continue;
      g.fillStyle = tint && c !== 'k' && c !== 'e' ? tint : PAL[c];
      g.fillRect(Math.round(x) + rx, Math.round(y) + ry, 1, 1);
    }
  });
}

const SIZE = { crawler: { w: 10, h: 6 }, bat: { w: 12, h: 6 }, boss: { w: 13, h: 11 } };

export default async function play(ctx) {
  const { root, act, setStats, exit, announce, toast } = ctx;
  const { ctx: g, view, destroy: destroyCanvas } = makeCanvas(root);
  const fx = new Fx();
  let stopLoop = () => {};
  let kb = null;

  setStats([['Linting', 'project…']]);
  let scan = await ctx.scan();
  const startProblems = scan.stats.problems;
  setStats([]);
  if (!scan.groups.length) {
    results(root, { title: 'NO MONSTERS', lines: ['ESLint has nothing to complain about. The castle is already clean.'], stats: [], onExit: exit });
    return () => destroyCanvas();
  }

  await intro(root, {
    title: 'LINT DUNGEON',
    story: `${scan.stats.problems} problems haunt ${scan.stats.files} files. Every foe in this castle is one lint rule; the big ones are bosses. Green foes can be burned away with the Fix Beam, which really runs ESLint's fixer for that rule. Purple ones are immune and need the Hush Whip (a marked disable comment) or the Quest Scroll (written into LINT_QUESTLOG.md). A foe falls to one weapon, so finish with the one you started. Whip the candles for hearts. Clear the floor and the exit door opens.`,
    keys: [
      ['← →', 'run'],
      ['Z / Space / ↑', 'jump (hold for higher)'],
      ['X / J', 'attack'],
      ['1 2 3 / C', 'Fix Beam · Hush Whip · Quest Scroll'],
    ],
    start: 'ENTER THE CASTLE',
  });

  let weapon = 'fix';
  const bar = actionBar(root, WEAPONS, (id) => {
    weapon = id;
    bar.select(id);
  });
  bar.select(weapon);

  let level;
  let foes;
  let candles;
  let pickups = [];
  let shots = [];
  let whip = null;
  let floor = 0;
  let cam = 0;
  let hp = MAX_HP;
  let slain = 0;
  let over = false;
  let between = false;
  let shake = 0;
  const shelved = new Set();
  const seen = new Set(); // sections visited, for the minimap

  const player = { x: 40, y: 0, w: 8, h: 13, vx: 0, vy: 0, onGround: false, face: 1, coyote: 0, jumpBuf: 0, inv: 0, knock: 0, attackCd: 0, safe: { x: 40, y: 0 }, anim: 0 };

  function enterFloor() {
    const groups = scan.groups.filter((gr) => !shelved.has(gr.rule));
    if (!groups.length) return finish();
    level = buildLevel(groups, `floor${floor}`);
    foes = level.foes.map((f) => {
      const hpMax = bossHp(f.group.count);
      return { ...f, ...SIZE[f.kind], vx: f.kind === 'crawler' ? 28 : 0, vy: 0, baseY: f.y, hp: hpMax, max: hpMax, by: null, flash: 0, immune: 0, phase: Math.random() * 6, hop: 2 };
    });
    candles = level.candles.map((c) => ({ ...c, w: 4, h: 6, lit: true }));
    pickups = [];
    shots = [];
    Object.assign(player, { x: 40, y: (GROUND - 2) * TILE, vx: 0, vy: 0 });
    player.safe = { x: player.x, y: player.y };
    seen.clear();
    between = false;
    const name = FLOORS[Math.min(floor, FLOORS.length - 1)];
    announce(`Floor ${floor + 1}, ${name}: ${foes.length} foes, ${groups.reduce((s, x) => s + x.count, 0)} problems.`);
    fx.float(VW / 2, 50, `FLOOR ${floor + 1}: ${name.toUpperCase()}`, '#f4f1ea', 10);
  }

  function attack() {
    if (player.attackCd > 0 || over || between) return;
    if (weapon === 'fix') {
      player.attackCd = 0.28;
      shots.push({ kind: 'beam', x: player.x + (player.face > 0 ? player.w : -6), y: player.y + 7, w: 6, h: 4, vx: 250 * player.face, vy: 0, life: 0.55 });
    } else if (weapon === 'disable') {
      player.attackCd = 0.42;
      whip = { t: 0.22, hit: new Set() };
    } else {
      player.attackCd = 0.5;
      shots.push({ kind: 'scroll', x: player.x + 2, y: player.y + 2, w: 6, h: 6, vx: 120 * player.face, vy: -210, life: 1.3, spin: 0 });
    }
  }

  function whipBox() {
    const len = 28;
    return { x: player.face > 0 ? player.x + player.w : player.x - len, y: player.y + 4, w: len, h: 7 };
  }

  function hitFoe(foe, spell) {
    if (spell === 'fix' && !foe.group.fixable) {
      if (foe.immune <= 0) fx.float(foe.x + foe.w / 2, foe.y - 6, 'IMMUNE', '#c9bfae', 7);
      foe.immune = 0.4;
      return;
    }
    if (foe.by && foe.by !== spell) {
      foe.hp = foe.max;
      fx.float(foe.x + foe.w / 2, foe.y - 6, 'WEAPON CHANGED: HP BACK', '#c9bfae', 6);
    }
    foe.by = spell;
    foe.hp--;
    foe.flash = 0.1;
    foe.x += player.x < foe.x ? 3 : -3;
    fx.burst(foe.x + foe.w / 2, foe.y + foe.h / 2, COLOR[spell], 6, 60);
    if (foe.hp > 0) return;
    foes = foes.filter((f) => f !== foe);
    slain++;
    if (spell === 'log') shelved.add(foe.group.rule);
    shake = reducedMotion ? 0 : 0.15;
    fx.burst(foe.x + foe.w / 2, foe.y + foe.h / 2, COLOR[spell], 26, 110);
    const partial = spell === 'fix' && foe.group.fixable < foe.group.count;
    const verb = { fix: 'FIXED', disable: 'HUSHED', log: 'LOGGED' }[spell];
    fx.float(foe.x + foe.w / 2, foe.y - 8, `${verb} ${foe.group.rule}`, COLOR[spell], 7);
    act(foe.group.id, spell).catch(() => {});
    if (partial) toast(`${foe.group.count - foe.group.fixable} of ${foe.group.rule} need a human; they return on the next floor`);
    if (!foes.length) {
      announce('The exit door is open.');
      fx.float(level.exit.x, level.exit.y - 10, 'DOOR OPEN →', '#4f7cf0', 8);
    }
  }

  function hitCandle(c) {
    if (!c.lit) return;
    c.lit = false;
    fx.burst(c.x + 2, c.y + 2, '#f2b632', 10, 50);
    pickups.push({ x: c.x, y: c.y, w: 5, h: 5, vy: -80 });
  }

  function hurt(from) {
    if (player.inv > 0) return;
    hp--;
    player.inv = 1.3;
    player.knock = 0.3;
    // a knockback that sends you back and up
    player.vx = (player.x < from.x ? -1 : 1) * 110;
    player.vy = -170;
    shake = reducedMotion ? 0 : 0.2;
    if (hp <= 0) finish('YOU PROCRASTINATED');
  }

  async function nextFloor() {
    between = true;
    fx.float(player.x, player.y - 10, 'THE WORKER SWEEPS UP…', '#f2b632', 8);
    await ctx.settled();
    if (over) return;
    try {
      scan = await ctx.scan();
    } catch (err) {
      toast(`Could not scan the next floor: ${err.message}`, true);
      return finish();
    }
    floor++;
    enterFloor();
  }

  kb = keyboard((e) => {
    const k = e.key.toLowerCase();
    if (k === 'z' || k === ' ' || k === 'arrowup' || k === 'w') player.jumpBuf = 0.12;
    if (k === 'x' || k === 'j') attack();
    const w = WEAPONS.find((x) => x.key === e.key);
    if (w) weapon = w.id;
    if (k === 'c' || k === 'k') weapon = WEAPONS[(WEAPONS.findIndex((x) => x.id === weapon) + 1) % WEAPONS.length].id;
    bar.select(weapon);
  });

  async function finish(title) {
    if (over) return;
    over = true;
    stopLoop();
    await ctx.settled();
    let left = '?';
    try {
      left = (await ctx.scan()).stats.problems;
    } catch (err) {
      toast(`Could not count what is left: ${err.message}`, true);
    }
    results(root, {
      title: title ?? (left ? 'CASTLE SURVIVED' : 'CASTLE CLEANSED'),
      lines: [
        title ? 'Your hearts ran out. Everything you did really happened and stays done.' : left === '?' ? 'ESLint could not be asked what is left.' : left ? `${left} problems remain: the ones you logged for later.` : 'ESLint has nothing left to say about this project.',
        'Review the diff before you commit. Every change can be undone from the ledger.',
      ],
      stats: [
        [String(startProblems), 'problems at the start'],
        [String(left), 'problems now'],
        [String(slain), 'foes beaten'],
        [String(floor + 1), 'floors'],
      ],
      onExit: exit,
    });
  }

  enterFloor();
  stopLoop = loop((dt, t) => {
    if (over || !level) return;
    const k = kb.down;
    const doorOpen = !foes.length;

    // ---------- player ----------
    player.inv = Math.max(0, player.inv - dt);
    player.knock = Math.max(0, player.knock - dt);
    player.attackCd = Math.max(0, player.attackCd - dt);
    player.jumpBuf = Math.max(0, player.jumpBuf - dt);
    player.coyote = player.onGround ? 0.1 : Math.max(0, player.coyote - dt);
    const knocked = player.knock > 0;
    if (!knocked && !between) {
      const dir = (k.has('ArrowRight') || k.has('d') || k.has('D') ? 1 : 0) - (k.has('ArrowLeft') || k.has('a') || k.has('A') ? 1 : 0);
      player.vx = dir * PHYS.run;
      if (dir) player.face = dir;
    }
    if (player.jumpBuf > 0 && player.coyote > 0) {
      player.vy = -PHYS.jump;
      player.jumpBuf = 0;
      player.coyote = 0;
    }
    const holding = k.has('z') || k.has('Z') || k.has(' ') || k.has('ArrowUp') || k.has('w') || k.has('W');
    player.vy += PHYS.gravity * dt * (player.vy < 0 && !holding ? 2.4 : 1);
    player.vy = Math.min(player.vy, 420);
    const moved = moveBox(level, player, player.vx * dt, player.vy * dt);
    Object.assign(player, { x: moved.x, y: moved.y, onGround: moved.onGround });
    if (moved.onGround || moved.hitTop) player.vy = 0;
    if (moved.onGround && !knocked) player.safe = { x: player.x, y: player.y };
    player.anim += Math.abs(player.vx) * dt;
    // the exit door is a wall until the floor is clear
    if (!doorOpen && player.x + player.w > level.exit.x) player.x = level.exit.x - player.w;
    if (doorOpen && !between && player.x + player.w > level.exit.x + 4) nextFloor();
    // fell into a pit
    if (player.y > level.h * TILE + 20) {
      hp--;
      Object.assign(player, { x: player.safe.x - player.face * 18, y: player.safe.y - 4, vx: 0, vy: 0, inv: 1.2 });
      if (hp <= 0) return finish('YOU PROCRASTINATED');
    }
    seen.add(Math.floor(player.x / (SECTION * TILE)));

    // ---------- weapons ----------
    if (whip) {
      whip.t -= dt;
      const box = whipBox();
      for (const f of foes) {
        if (whip.hit.has(f) || !overlap(box, f)) continue;
        whip.hit.add(f); // one lash, one hit
        hitFoe(f, 'disable');
      }
      for (const c of candles) if (overlap(box, c)) hitCandle(c);
      if (whip.t <= 0) whip = null;
    }
    for (const s of shots) {
      s.life -= dt;
      if (s.kind === 'scroll') {
        s.vy += 600 * dt;
        s.spin += dt * 14;
      }
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      const tx = Math.floor((s.x + s.w / 2) / TILE);
      const ty = Math.floor((s.y + s.h / 2) / TILE);
      if (ty >= 0 && ty < level.h && level.solid[ty * level.w + tx]) s.life = 0;
      const foe = foes.find((f) => overlap(s, f));
      if (foe) {
        s.life = 0;
        hitFoe(foe, s.kind === 'beam' ? 'fix' : 'log');
      }
      for (const c of candles) if (overlap(s, c)) hitCandle(c);
    }
    shots = shots.filter((s) => s.life > 0);

    // ---------- foes ----------
    for (const f of foes) {
      f.flash = Math.max(0, f.flash - dt);
      f.immune = Math.max(0, f.immune - dt);
      const near = Math.abs(f.x - player.x) < 160;
      if (f.kind === 'crawler') {
        const m = moveBox(level, f, f.vx * dt, 60 * dt);
        const ahead = Math.floor((f.vx > 0 ? m.x + f.w + 1 : m.x - 1) / TILE);
        const below = Math.floor((m.y + f.h + 2) / TILE);
        if (m.hitX || !level.solid[below * level.w + ahead]) f.vx = -f.vx;
        f.x = m.x;
        f.y = m.y;
      } else if (f.kind === 'bat') {
        if (near) f.x += Math.sign(player.x - f.x) * 30 * dt;
        f.y = f.baseY + Math.sin(t * 2.4 + f.phase) * 18 + (near ? Math.min(30, Math.max(-10, player.y - f.baseY)) * 0.6 : 0);
      } else {
        f.hop -= dt;
        f.vy += PHYS.gravity * dt;
        const dir = near ? Math.sign(player.x - f.x) : 0;
        const m = moveBox(level, f, dir * 22 * dt, f.vy * dt);
        if (m.onGround) {
          f.vy = 0;
          if (f.hop <= 0 && near) {
            f.vy = -230;
            f.hop = 2.2;
          }
        }
        f.x = m.x;
        f.y = m.y;
      }
      if (overlap(player, f)) hurt(f);
    }
    for (const p of pickups) {
      p.vy += 400 * dt;
      const m = moveBox(level, p, 0, p.vy * dt);
      p.y = m.y;
      if (m.onGround) p.vy = 0;
      if (overlap(player, p)) {
        p.taken = true;
        hp = Math.min(MAX_HP, hp + 1);
        fx.float(player.x, player.y - 6, '+1 HEART', '#c7361d', 7);
      }
    }
    pickups = pickups.filter((p) => !p.taken);
    fx.step(dt);
    shake = Math.max(0, shake - dt);
    cam += (Math.max(0, Math.min(level.w * TILE - VW, player.x - VW / 2 + player.face * 30)) - cam) * Math.min(1, dt * 6);

    // ---------- draw ----------
    const W = view.w;
    const H = view.h;
    const scale = Math.max(1, Math.min(W / VW, H / VH));
    const ox = (W - VW * scale) / 2;
    const oy = (H - VH * scale) / 2;
    g.fillStyle = '#0e0d13';
    g.fillRect(0, 0, W, H);
    g.save();
    g.translate(ox + (shake > 0 ? (Math.random() - 0.5) * 6 : 0), oy);
    g.scale(scale, scale);
    g.beginPath();
    g.rect(0, 0, VW, VH);
    g.clip();
    // back wall: parallax bricks and tall windows
    g.fillStyle = '#15141b';
    g.fillRect(0, 0, VW, VH);
    g.fillStyle = '#1c1a24';
    const par = cam * 0.5;
    for (let y = 0; y < VH; y += 12) for (let x = -((par + (y / 12) * 8) % 32); x < VW; x += 32) g.fillRect(x, y, 30, 10);
    g.fillStyle = '#26233a';
    for (let x = -(par % 120); x < VW; x += 120) {
      g.fillRect(x + 40, 26, 16, 44);
      g.beginPath();
      g.arc(x + 48, 26, 8, Math.PI, 0);
      g.fill();
    }
    g.translate(-Math.round(cam), 0);
    // tiles
    const tx0 = Math.floor(cam / TILE);
    for (let ty = 0; ty < level.h; ty++) {
      for (let tx = tx0; tx < tx0 + VW / TILE + 2; tx++) {
        if (!level.solid[ty * level.w + tx]) continue;
        const x = tx * TILE;
        const y = ty * TILE;
        g.fillStyle = '#3a3744';
        g.fillRect(x, y, TILE, TILE);
        g.fillStyle = '#4a4656';
        g.fillRect(x, y, TILE, 2);
        g.fillStyle = '#2a2833';
        g.fillRect(x + (ty % 2 ? 0 : 8), y + 8, 1, 8);
        g.fillRect(x, y + 8, TILE, 1);
      }
    }
    // exit door, Metroid style: red and shut until the floor is clear
    g.fillStyle = doorOpen ? '#4f7cf0' : '#c7361d';
    g.fillRect(level.exit.x, level.exit.y, 6, 3 * TILE);
    g.fillStyle = '#1d1b16';
    g.fillRect(level.exit.x + 6, level.exit.y, 2, 3 * TILE);
    for (const c of candles) {
      if (!c.lit) continue;
      sprite(g, ART.candle, c.x, c.y);
      if (Math.floor(t * 8) % 2) {
        g.fillStyle = '#ffe14d';
        g.fillRect(c.x + 1, c.y - 2, 2, 2);
      }
    }
    for (const p of pickups) sprite(g, ART.heart, p.x, p.y);
    for (const f of foes) {
      // green can be fixed, plum is immune to the Fix Beam, red will not even parse
      const tint = f.flash > 0 ? '#fffdf8' : f.immune > 0 ? '#6b665c' : f.group.rule === 'parse-error' ? '#c7361d' : f.group.fixable ? '#17a673' : '#9b3d78';
      const art = ART[f.kind];
      const flip = f.kind !== 'bat' && (f.vx || player.x - f.x) < 0;
      sprite(g, art, f.x - 1, f.y - (art.length - f.h), { flip, tint });
      // HP pips
      for (let i = 0; i < f.max; i++) {
        g.fillStyle = i < f.hp ? (f.by ? COLOR[f.by] : '#f4f1ea') : '#3a3744';
        g.fillRect(f.x + i * 3, f.y - 14, 2, 2);
      }
    }
    for (const s of shots) {
      g.fillStyle = s.kind === 'beam' ? COLOR.fix : COLOR.log;
      if (s.kind === 'beam') g.fillRect(s.x, s.y, s.w, s.h);
      else {
        g.save();
        g.translate(s.x + 3, s.y + 3);
        g.rotate(s.spin);
        g.fillRect(-3, -2, 6, 4);
        g.fillStyle = '#fffdf8';
        g.fillRect(-2, -1, 4, 1);
        g.restore();
      }
    }
    if (whip) {
      const b = whipBox();
      g.fillStyle = COLOR.disable;
      const reach = b.w * Math.min(1, (0.22 - whip.t) / 0.08);
      g.fillRect(player.face > 0 ? b.x : b.x + b.w - reach, b.y + 1, reach, 2);
      g.fillRect(player.face > 0 ? b.x + reach - 3 : b.x + b.w - reach, b.y, 3, 4);
    }
    if (!(player.inv > 0 && !reducedMotion && Math.floor(t * 14) % 2)) {
      const running = player.onGround && Math.abs(player.vx) > 0 && Math.floor(player.anim / 8) % 2;
      sprite(g, running ? ART.heroRun : ART.hero, player.x - 1, player.y, { flip: player.face < 0 });
    }
    fx.draw(g);
    g.restore();

    // ---------- screen-space overlay: labels, hearts, minimap ----------
    g.textAlign = 'center';
    g.font = '600 11px "IBM Plex Mono", monospace';
    for (const f of foes) {
      const sx = ox + (f.x + f.w / 2 - cam) * scale;
      if (sx < ox - 60 || sx > ox + VW * scale + 60) continue;
      const label = `${truncate(f.group.rule, 20)} ×${f.group.count}`;
      const sy = oy + (f.y - 18) * scale;
      const w = g.measureText(label).width + 10;
      g.fillStyle = 'rgba(255,253,248,0.92)';
      g.fillRect(sx - w / 2, sy - 13, w, 16);
      g.fillStyle = '#1d1b16';
      g.fillText(label, sx, sy);
    }
    for (let i = 0; i < MAX_HP; i++) {
      g.fillStyle = i < hp ? '#c7361d' : '#3a3744';
      g.fillRect(ox + 10 + i * 16, oy + 10, 12, 10);
    }
    const mw = 10;
    const mx = ox + VW * scale - level.sections * (mw + 2) - 10;
    for (let s = 0; s < level.sections; s++) {
      const here = Math.floor(player.x / (SECTION * TILE)) === s;
      const left = foes.some((f) => f.section === s);
      g.fillStyle = here ? '#f2b632' : seen.has(s) ? '#4f7cf0' : '#2a2833';
      g.fillRect(mx + s * (mw + 2), oy + 10, mw, 7);
      if (left) {
        g.fillStyle = '#c7361d';
        g.fillRect(mx + s * (mw + 2) + 4, oy + 12, 2, 3);
      }
    }

    setStats([
      ['Floor', `${floor + 1} · ${FLOORS[Math.min(floor, FLOORS.length - 1)]}`],
      ['Foes left', String(foes.length)],
      ['Beaten', String(slain)],
      ['Fixed for real', String(ctx.impact().fixed ?? 0)],
      ['Hearts', `${hp}/${MAX_HP}`],
    ]);
  });

  return () => {
    over = true;
    stopLoop();
    kb?.destroy();
    destroyCanvas();
  };
}
