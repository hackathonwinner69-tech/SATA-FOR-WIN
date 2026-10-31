// Receipt Rush. A lane runner down the checkout aisle. Each merchant arrives as
// a wave of three gates: ChoreCade's guess, another category, and Flag. Run
// through one and every charge from that merchant is filed there for real.
// Shopping carts between waves cost hearts; jumping skips a merchant for later.
import { Fx, intro, keyboard, loop, makeCanvas, reducedMotion, results, roundRect, truncate } from './kit.js';
import { gatesFor, laneX, project, runScore } from './lanes.js';
import { drawSprite } from '../js/sprites.js';
import { fmt } from '../js/api.js';

const SPEED0 = 0.32; // depth units per second
const HEARTS = 3;

export default async function play(ctx) {
  const { root, chore, act, setStats, exit, announce } = ctx;
  const { canvas, ctx: g, view, destroy: destroyCanvas } = makeCanvas(root);
  const fx = new Fx();
  let stopLoop = () => {};
  let kb = null;

  setStats([['Scanning', 'transactions…']]);
  const scan = await ctx.scan();
  const queue = [...scan.groups];
  const cats = chore.actions.filter((a) => a.id.startsWith('cat:'));
  const colorOf = Object.fromEntries(chore.actions.map((a) => [a.id, a.color]));
  const labelOf = Object.fromEntries(chore.actions.map((a) => [a.id, a.id === 'flag' ? 'Flag' : a.label]));

  if (!queue.length) {
    results(root, { title: 'ALL FILED', lines: ['Every transaction in this export already has a category.'], stats: [], onExit: exit });
    return () => destroyCanvas();
  }

  await intro(root, {
    title: 'RECEIPT RUSH',
    story: `${scan.stats.open} unfiled transactions from ${queue.length} merchants. Each merchant is a wave of three checkout gates. Pick a lane and run through its gate: every charge from that merchant is filed there (if you pick nothing, nothing is filed); the categorised CSV, the report and next month's rules rewrite themselves. Dodge the carts between waves.`,
    keys: [
      ['← →', 'pick a lane (or click one)'],
      ['↓ / Enter', 'keep the lane you are in'],
      ['Space', 'jump: skip this merchant for now, or hop a cart'],
      ['1 … 0', 'file under any category right now'],
      ['F', 'flag right now'],
    ],
  });

  const geo = () => ({ width: view.w, horizon: view.h * 0.3, bottom: view.h * 0.93 });
  const runner = { lane: 1, x: 1, jump: 0 };
  let things = []; // gates and carts: { kind, z, lane, ... }
  let wave = null; // { group, gates, spawnedAt }
  let speed = SPEED0;
  let hearts = HEARTS;
  let score = 0;
  let streak = 0;
  let filed = 0;
  let skipped = 0;
  let distance = 0;
  let over = false;
  let hurt = 0;
  const tally = {};

  function nextWave() {
    if (!queue.length) return (wave = null);
    const group = queue.shift();
    const gates = gatesFor(group, cats.map((c) => c.id));
    // A wave only files anything once the player has chosen a lane for it.
    wave = { group, gates, start: performance.now(), chosen: false };
    things.push({ kind: 'gates', z: 1, gates, group });
    // a couple of carts on the run-up to the next wave
    for (let i = 0; i < Math.min(3, 1 + Math.floor(filed / 6)); i++) {
      if (Math.random() < 0.7) things.push({ kind: 'cart', z: 1.45 + i * 0.22, lane: Math.floor(Math.random() * 3) });
    }
    announce(`${group.label}: ${fmt.money(group.total)}, ${group.count} charges. Gates: ${gates.map((a) => labelOf[a]).join(', ')}.`);
  }

  function file(action, how = 'gate') {
    if (!wave) return;
    const { group } = wave;
    const wise = action === group.suggestion;
    const fast = performance.now() - wave.start < 4000;
    streak = wise || fast ? streak + 1 : 0;
    score += runScore({ count: group.count, wise, fast, streak });
    filed += group.count;
    if (action.startsWith('cat:')) tally[action.slice(4)] = (tally[action.slice(4)] ?? 0) + group.total;
    const g0 = geo();
    const y = g0.bottom - 60;
    fx.burst(laneX(runner.lane, y, g0), y, colorOf[action] ?? '#f2b632', 30);
    fx.float(view.w / 2, view.h * 0.45, `${labelOf[action].toUpperCase()} · ${truncate(group.label, 20)}${wise ? ' ★' : ''}`, wise ? '#f2b632' : '#f4f1ea', 18);
    act(group.id, action).catch(() => {});
    things = things.filter((t) => t.kind !== 'gates');
    if (how === 'key') things = things.filter((t) => t.kind !== 'cart' || t.z < 1);
    speed = SPEED0 + Math.min(0.35, filed * 0.0015 + (scan.groups.length - queue.length) * 0.006);
    nextWave();
  }

  function skip(reason = 'SKIPPED · BACK OF THE LINE') {
    if (!wave) return;
    queue.push(wave.group);
    skipped++;
    streak = 0;
    fx.float(view.w / 2, view.h * 0.45, reason, '#c9bfae', 15);
    things = things.filter((t) => t.kind !== 'gates');
    nextWave();
  }

  kb = keyboard((e) => {
    if (over) return;
    const k = e.key.toLowerCase();
    if (k === 'arrowleft' || k === 'a') runner.lane = Math.max(0, runner.lane - 1);
    if (k === 'arrowright' || k === 'd') runner.lane = Math.min(2, runner.lane + 1);
    if (['arrowleft', 'a', 'arrowright', 'd', 'arrowdown', 's', 'enter'].includes(k) && wave) wave.chosen = true;
    if ((k === ' ' || k === 'arrowup' || k === 'w') && runner.jump <= 0) runner.jump = 0.75;
    if (k === 'f') file('flag', 'key');
    const cat = cats.find((c) => c.key === k);
    if (cat) file(cat.id, 'key');
  });
  canvas.addEventListener('pointerdown', (e) => {
    runner.lane = Math.max(0, Math.min(2, Math.floor((e.offsetX / view.w) * 3)));
    if (wave) wave.chosen = true;
  });

  function finish(title) {
    over = true;
    stopLoop();
    const subs = Object.entries(tally).sort((a, b) => a[1] - b[1]);
    results(root, {
      title,
      lines: [
        `Your categorised CSV, expense-report.md and merchant-rules.json are next to ${chore.target.split(/[/\\]/).pop()}.`,
        subs.length ? `Biggest spend: ${subs[0][0]} at ${fmt.money(subs[0][1])}.` : '',
        queue.length || wave ? `${queue.length + (wave ? 1 : 0)} merchants are still waiting; everything you filed stays filed.` : '',
      ].filter(Boolean),
      stats: [
        [score.toLocaleString(), 'score'],
        [filed.toLocaleString(), 'transactions filed'],
        [String(skipped), 'skipped'],
      ],
      onExit: exit,
    });
  }

  nextWave();
  stopLoop = loop((dt, t) => {
    if (over) return;
    const W = view.w;
    const H = view.h;
    const G = geo();
    distance += speed * dt;
    runner.x += (runner.lane - runner.x) * Math.min(1, dt * 14);
    runner.jump = Math.max(0, runner.jump - dt);
    hurt = Math.max(0, hurt - dt);

    for (const th of things) th.z -= speed * dt;
    for (const th of [...things]) {
      if (th.z > 0.04) continue;
      things = things.filter((x) => x !== th);
      if (th.kind === 'gates') {
        if (runner.jump > 0) skip();
        else if (!wave?.chosen) skip('NO LANE PICKED · NOTHING FILED');
        else file(th.gates[runner.lane]);
      } else if (th.kind === 'cart' && th.lane === runner.lane && runner.jump <= 0 && hurt <= 0) {
        hearts--;
        hurt = 1;
        streak = 0;
        fx.float(W / 2, H * 0.6, 'OOF! CART', '#d93f25', 22);
        if (hearts <= 0) return finish('CHECKOUT CLOSED');
      }
    }
    if (!wave && !things.some((x) => x.kind === 'gates')) return finish('BOOKS BALANCED');
    fx.step(dt);

    // ---------- draw ----------
    g.fillStyle = '#15141b';
    g.fillRect(0, 0, W, H);
    // store sign on the horizon
    g.fillStyle = '#22202b';
    g.fillRect(0, 0, W, G.horizon);
    g.fillStyle = '#f2b632';
    g.font = `700 ${Math.min(22, W / 30)}px Silkscreen, monospace`;
    g.textAlign = 'center';
    g.fillText('CHECKOUT', W / 2, G.horizon - 12);
    // road
    g.fillStyle = '#e8dfcf';
    g.beginPath();
    g.moveTo(laneX(-0.5, G.horizon, G), G.horizon);
    g.lineTo(laneX(2.5, G.horizon, G), G.horizon);
    g.lineTo(laneX(2.5, H, G), H);
    g.lineTo(laneX(-0.5, H, G), H);
    g.fill();
    // moving floor tiles
    g.fillStyle = '#d6cbb6';
    for (let i = 0; i < 14; i++) {
      const z = 1 - ((i / 14 + distance * 2) % 1);
      const a = project(z, G);
      const b = project(z - 0.035, G);
      g.fillRect(laneX(-0.5, a.y, G), a.y, laneX(2.5, a.y, G) - laneX(-0.5, a.y, G), Math.max(1, b.y - a.y));
    }
    // lane lines
    g.strokeStyle = '#1d1b16';
    g.lineWidth = 2;
    for (const l of [0.5, 1.5]) {
      g.beginPath();
      g.moveTo(laneX(l, G.horizon, G), G.horizon);
      g.lineTo(laneX(l, H, G), H);
      g.stroke();
    }

    // far things first
    for (const th of [...things].sort((a, b) => b.z - a.z)) {
      if (th.z > 1) continue;
      const { y, s } = project(th.z, G);
      if (th.kind === 'cart') {
        const x = laneX(th.lane, y, G);
        const w = 70 * s;
        g.fillStyle = '#d93f25';
        roundRect(g, x - w / 2, y - w * 0.8, w, w * 0.6, 4 * s);
        g.fill();
        g.strokeStyle = '#1d1b16';
        g.lineWidth = Math.max(1, 3 * s);
        g.stroke();
        g.fillStyle = '#1d1b16';
        g.beginPath();
        g.arc(x - w * 0.3, y - w * 0.12, 6 * s, 0, 7);
        g.arc(x + w * 0.3, y - w * 0.12, 6 * s, 0, 7);
        g.fill();
      } else {
        th.gates.forEach((a, lane) => {
          const x = laneX(lane, y, G);
          const w = (W / 3.6) * s;
          const h = 90 * s;
          g.fillStyle = colorOf[a] ?? '#6b665c';
          g.fillRect(x - w / 2, y - h, w, h * 0.42);
          g.fillRect(x - w / 2, y - h, w * 0.08, h);
          g.fillRect(x + w / 2 - w * 0.08, y - h, w * 0.08, h);
          g.strokeStyle = '#1d1b16';
          g.lineWidth = Math.max(1, 3 * s);
          g.strokeRect(x - w / 2, y - h, w, h * 0.42);
          g.fillStyle = '#fffdf8';
          const size = Math.max(8, 18 * s);
          g.font = `700 ${size}px Silkscreen, monospace`;
          g.fillText(labelOf[a].toUpperCase(), x, y - h + h * 0.3);
          if (a === th.group.suggestion && s > 0.35) {
            g.fillStyle = '#f2b632';
            g.font = `700 ${Math.max(8, 13 * s)}px Silkscreen, monospace`;
            g.fillText(th.group.aiSuggested ? '★ CLAUDE' : '★ GUESS', x, y - h - 6 * s);
          }
        });
      }
    }

    // runner
    const ry = G.bottom - 20 - (runner.jump > 0 ? Math.sin((runner.jump / 0.75) * Math.PI) * 70 : 0);
    const rx = laneX(runner.x, G.bottom, G);
    if (!(hurt > 0 && !reducedMotion && Math.floor(t * 14) % 2)) drawSprite(g, 'robot', rx - 20, ry - 40, 4, '#12895f');
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.beginPath();
    g.ellipse(rx, G.bottom + 2, 22, 6, 0, 0, 7);
    g.fill();

    // the receipt for the current wave
    if (wave) {
      const { group } = wave;
      const w = Math.min(460, W - 32);
      const x = (W - w) / 2;
      roundRect(g, x, 12, w, 74, 8);
      g.fillStyle = '#fffdf8';
      g.fill();
      g.strokeStyle = '#1d1b16';
      g.lineWidth = 3;
      g.stroke();
      g.textAlign = 'left';
      g.fillStyle = '#1d1b16';
      g.font = '700 18px Silkscreen, monospace';
      g.fillText(truncate(group.label, 26), x + 14, 38);
      g.font = '600 13px "IBM Plex Mono", monospace';
      g.fillStyle = '#57524a';
      g.fillText(`${group.count} charge${group.count > 1 ? 's' : ''}${group.flags.length ? ' · ' + group.flags.join(' · ') : ''}`, x + 14, 62);
      g.textAlign = 'right';
      g.font = '600 22px "IBM Plex Mono", monospace';
      g.fillStyle = group.total < 0 ? '#d93f25' : '#12895f';
      g.fillText(fmt.money(group.total), x + w - 14, 40);
      g.textAlign = 'center';
    }
    // hearts
    for (let i = 0; i < HEARTS; i++) {
      g.fillStyle = i < hearts ? '#d93f25' : '#3a3744';
      g.fillRect(16 + i * 22, H - 28, 16, 14);
    }
    fx.draw(g);

    setStats([
      ['Score', score.toLocaleString()],
      ['Streak', streak > 1 ? `×${streak}` : '-'],
      ['Merchants left', String(queue.length + (wave ? 1 : 0))],
      ['Filed', `${filed} / ${scan.stats.open}`],
      ['Hearts', `${hearts}/${HEARTS}`],
    ]);
  });

  return () => {
    stopLoop();
    kb?.destroy();
    destroyCanvas();
  };
}
