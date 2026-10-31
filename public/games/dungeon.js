// Lint Dungeon. A top-down arena: every broken lint rule is a boss bug, bigger
// the more often the rule is broken. Pick a spell and shoot. A boss falls to
// one spell, and that spell is what really happens: Autofix runs ESLint's fixer
// for the rule, Silence adds marked disable comments, Quest log writes it down.
// Each floor is a fresh lint pass, so whatever a fix exposes comes back below.
import { Fx, actionBar, intro, keyboard, loop, makeCanvas, reducedMotion, results, roundRect, truncate } from './kit.js';
import { approach, bossHp, clamp, dist } from './arena.js';
import { drawSprite } from '../js/sprites.js';

const SPELLS = [
  { id: 'fix', label: 'Autofix', key: '1', color: '#17a673' },
  { id: 'disable', label: 'Silence', key: '2', color: '#f2b632' },
  { id: 'log', label: 'Quest log', key: '3', color: '#4f7cf0' },
];
const FLOORS = ['The Swamp of Shadowed Variables', 'The Crypt of Loose Equality', 'The Hall of Forgotten Braces', 'The Abyss of Legacy Code', 'The Last Warning'];
const ON_FLOOR = 3;
const HEARTS = 3;

export default async function play(ctx) {
  const { root, act, setStats, exit, announce, toast } = ctx;
  const { canvas, ctx: g, view, destroy: destroyCanvas } = makeCanvas(root);
  const fx = new Fx();
  let stopLoop = () => {};
  let kb = null;
  let bar = null;

  setStats([['Linting', 'project…']]);
  let scan = await ctx.scan();
  const startProblems = scan.stats.problems;
  if (!scan.groups.length) {
    results(root, { title: 'NO MONSTERS', lines: ['ESLint has nothing to complain about. The dungeon is already clean.'], stats: [], onExit: exit });
    return () => destroyCanvas();
  }

  await intro(root, {
    title: 'LINT DUNGEON',
    story: `${scan.stats.problems} problems lurk in ${scan.stats.files} files. Every boss is one lint rule. Green bosses can be burned away with Autofix, which really runs ESLint's fixer for that rule; plum ones are immune and need Silence or the Quest log. A boss only falls to one spell, so finish what you start. Clear a floor and whatever survived regroups below.`,
    keys: [
      ['W A S D', 'move (arrow keys work too)'],
      ['Mouse', 'aim and hold to shoot'],
      ['Space', 'shoot at the nearest boss'],
      ['1 2 3', 'Autofix · Silence · Quest log'],
    ],
    start: 'ENTER THE DUNGEON',
  });

  const player = { x: view.w / 2, y: view.h * 0.7, cd: 0, hurt: 0 };
  let spell = 'fix';
  let bosses = [];
  let shots = [];
  let pending = [];
  let floor = 0;
  let hearts = HEARTS;
  let slain = 0;
  let sent = 0;
  let landed = 0;
  let over = false;
  let between = false;
  let aim = null;
  let firing = false;
  const shelved = new Set();
  ctx.onImpact((impact, entry) => entry && landed++);

  bar = actionBar(root, SPELLS, (id) => {
    spell = id;
    bar.select(id);
  });
  bar.select(spell);

  function enterFloor() {
    pending = scan.groups.filter((gr) => !shelved.has(gr.rule));
    bosses = [];
    if (!pending.length) return finish();
    const name = FLOORS[Math.min(floor, FLOORS.length - 1)];
    announce(`Floor ${floor + 1}, ${name}: ${pending.length} bosses, ${pending.reduce((s, x) => s + x.count, 0)} problems.`);
    fx.float(view.w / 2, view.h * 0.4, `FLOOR ${floor + 1}: ${name.toUpperCase()}`, '#f4f1ea', 20);
    between = false;
  }

  function spawn() {
    if (!pending.length || bosses.length >= ON_FLOOR) return;
    const group = pending.shift();
    const edge = Math.floor(Math.random() * 3);
    const x = edge === 0 ? 40 : edge === 1 ? view.w - 40 : 60 + Math.random() * (view.w - 120);
    const y = edge === 2 ? 40 : 60 + Math.random() * view.h * 0.4;
    const hp = bossHp(group.count);
    bosses.push({ group, x, y, hp, max: hp, by: null, flash: 0, wobble: Math.random() * 6, immune: 0 });
  }

  function shoot(tx, ty) {
    if (player.cd > 0 || over || between) return;
    player.cd = 0.16;
    const a = Math.atan2(ty - player.y, tx - player.x);
    shots.push({ x: player.x, y: player.y, vx: Math.cos(a) * 620, vy: Math.sin(a) * 620, spell, life: 1.2 });
  }

  function hit(boss, s) {
    const color = SPELLS.find((x) => x.id === s.spell).color;
    if (s.spell === 'fix' && !boss.group.fixable) {
      boss.immune = 0.6;
      fx.float(boss.x, boss.y - 40, 'IMMUNE: ESLINT CANNOT FIX THIS', '#c9bfae', 12);
      return;
    }
    if (boss.by && boss.by !== s.spell) {
      // switching spells mid-fight starts the fight over: one boss, one real action
      boss.hp = boss.max;
      fx.float(boss.x, boss.y - 40, 'SPELL CHANGED: HP RESTORED', '#c9bfae', 12);
    }
    boss.by = s.spell;
    boss.hp--;
    boss.flash = 0.12;
    fx.burst(s.x, s.y, color, 8, 120);
    if (boss.hp > 0) return;
    bosses = bosses.filter((b) => b !== boss);
    slain++;
    sent++;
    if (s.spell === 'log') shelved.add(boss.group.rule);
    fx.burst(boss.x, boss.y, color, 40);
    const partial = s.spell === 'fix' && boss.group.fixable < boss.group.count;
    const verb = { fix: 'FIXED', disable: 'SILENCED', log: 'LOGGED' }[s.spell];
    fx.float(boss.x, boss.y - 30, `${verb} ${boss.group.rule}${partial ? ' (PART)' : ''}`, color, 14);
    act(boss.group.id, s.spell).catch(() => {});
    if (partial) toast(`${boss.group.count - boss.group.fixable} of ${boss.group.rule} need a human; they regroup below`);
  }

  async function nextFloor() {
    between = true;
    fx.float(view.w / 2, view.h * 0.45, 'FLOOR CLEAR. THE WORKER SWEEPS UP…', '#f2b632', 16);
    const until = Date.now() + 20_000;
    while (landed < sent && Date.now() < until) await new Promise((r) => setTimeout(r, 150));
    if (over) return;
    scan = await ctx.scan();
    floor++;
    enterFloor();
  }

  kb = keyboard((e) => {
    const s = SPELLS.find((x) => x.key === e.key);
    if (s) {
      spell = s.id;
      bar.select(spell);
    }
  });
  canvas.addEventListener('pointermove', (e) => (aim = { x: e.offsetX, y: e.offsetY }));
  canvas.addEventListener('pointerdown', (e) => {
    aim = { x: e.offsetX, y: e.offsetY };
    firing = true;
  });
  const release = () => (firing = false);
  window.addEventListener('pointerup', release);

  async function finish(title) {
    if (over) return;
    over = true;
    stopLoop();
    while (landed < sent) await new Promise((r) => setTimeout(r, 150));
    const after = await ctx.scan();
    results(root, {
      title: title ?? (after.stats.problems ? 'DUNGEON SURVIVED' : 'DUNGEON CLEANSED'),
      lines: [
        title ? 'Your hearts ran out. Everything you cast really happened and stays done.' : after.stats.problems ? `${after.stats.problems} problems remain: the ones you logged for later.` : 'ESLint has nothing left to say about this project.',
        'Review the diff before you commit. Every change can be undone from the ledger.',
      ],
      stats: [
        [String(startProblems), 'problems at the start'],
        [String(after.stats.problems), 'problems now'],
        [String(slain), 'bosses beaten'],
        [String(floor + 1), 'floors'],
      ],
      onExit: exit,
    });
  }

  enterFloor();
  stopLoop = loop((dt, t) => {
    if (over) return;
    const W = view.w;
    const H = view.h;
    player.cd = Math.max(0, player.cd - dt);
    player.hurt = Math.max(0, player.hurt - dt);

    // move
    let dx = 0;
    let dy = 0;
    const k = kb.down;
    if (k.has('ArrowLeft') || k.has('a') || k.has('A')) dx -= 1;
    if (k.has('ArrowRight') || k.has('d') || k.has('D')) dx += 1;
    if (k.has('ArrowUp') || k.has('w') || k.has('W')) dy -= 1;
    if (k.has('ArrowDown') || k.has('s') || k.has('S')) dy += 1;
    if (dx || dy) {
      const n = Math.hypot(dx, dy);
      player.x += (dx / n) * 280 * dt;
      player.y += (dy / n) * 280 * dt;
    }
    player.x = clamp(player.x, 20, W - 20);
    player.y = clamp(player.y, 20, H - 70);

    // shoot: mouse held, or Space at the nearest boss
    if (firing && aim) shoot(aim.x, aim.y);
    if (k.has(' ') && bosses.length) {
      const target = bosses.reduce((a, b) => (dist(player, a) < dist(player, b) ? a : b));
      shoot(target.x, target.y);
    }

    if (!between) {
      spawn();
      if (!bosses.length && !pending.length) nextFloor();
    }
    for (const b of bosses) {
      const speed = 34 + floor * 8 + Math.min(30, b.group.count);
      const next = approach(b, player, speed * dt);
      b.x = next.x + Math.sin(t * 2 + b.wobble) * 0.6;
      b.y = next.y + Math.cos(t * 1.6 + b.wobble) * 0.6;
      b.flash = Math.max(0, b.flash - dt);
      b.immune = Math.max(0, b.immune - dt);
      if (dist(b, player) < 26 + b.max * 3 && player.hurt <= 0) {
        hearts--;
        player.hurt = 1.4;
        // the boss reels back so a hit cannot repeat on the next frame
        const back = approach(player, b, dist(player, b) + 120);
        b.x = clamp(back.x, 20, W - 20);
        b.y = clamp(back.y, 20, H - 20);
        if (hearts <= 0) return finish('YOU PROCRASTINATED');
      }
    }
    for (const s of shots) {
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.life -= dt;
      const b = bosses.find((bb) => dist(bb, s) < 18 + bb.max * 3);
      if (b) {
        s.life = 0;
        hit(b, s);
      }
    }
    shots = shots.filter((s) => s.life > 0 && s.x > -10 && s.x < W + 10 && s.y > -10 && s.y < H + 10);
    fx.step(dt);

    // ---------- draw ----------
    g.fillStyle = '#15141b';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#1c1a24';
    for (let y = 0; y < H; y += 48) for (let x = (y / 48) % 2 ? 0 : 48; x < W; x += 96) g.fillRect(x, y, 48, 48);
    for (const b of bosses) {
      const px = 3 + b.max * 0.7;
      const tint = b.flash > 0 ? '#ffffff' : b.immune > 0 ? '#6b665c' : b.group.rule === 'parse-error' ? '#d93f25' : b.group.fixable ? '#17a673' : '#b4447a';
      drawSprite(g, 'bug', b.x - 5 * px, b.y - 4.5 * px, px, tint);
      // label + HP pips
      const label = `${truncate(b.group.rule, 22)} ×${b.group.count}`;
      g.font = '600 11px "IBM Plex Mono", monospace';
      const w = g.measureText(label).width + 12;
      roundRect(g, b.x - w / 2, b.y + 5 * px, w, 18, 4);
      g.fillStyle = '#fffdf8';
      g.fill();
      g.fillStyle = '#1d1b16';
      g.textAlign = 'center';
      g.fillText(label, b.x, b.y + 5 * px + 13);
      for (let i = 0; i < b.max; i++) {
        g.fillStyle = i < b.hp ? (b.by ? SPELLS.find((s) => s.id === b.by).color : '#f4f1ea') : '#3a3744';
        g.fillRect(b.x - b.max * 6 + i * 12, b.y - 5 * px - 10, 9, 6);
      }
    }
    const color = SPELLS.find((s) => s.id === spell).color;
    for (const s of shots) {
      g.fillStyle = SPELLS.find((x) => x.id === s.spell).color;
      g.fillRect(s.x - 3, s.y - 3, 6, 6);
    }
    if (aim && !reducedMotion) {
      g.strokeStyle = color;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(aim.x, aim.y, 10, 0, 7);
      g.stroke();
    }
    if (!(player.hurt > 0 && !reducedMotion && Math.floor(t * 12) % 2)) drawSprite(g, 'robot', player.x - 18, player.y - 18, 3.6, color);
    for (let i = 0; i < HEARTS; i++) {
      g.fillStyle = i < hearts ? '#d93f25' : '#3a3744';
      g.fillRect(16 + i * 22, 16, 16, 14);
    }
    fx.draw(g);

    setStats([
      ['Floor', String(floor + 1)],
      ['Bosses left', String(bosses.length + pending.length)],
      ['Beaten', String(slain)],
      ['Fixed for real', String(ctx.impact().fixed ?? 0)],
      ['Hearts', `${hearts}/${HEARTS}`],
    ]);
  });

  return () => {
    over = true;
    stopLoop();
    kb?.destroy();
    window.removeEventListener('pointerup', release);
    destroyCanvas();
  };
}
