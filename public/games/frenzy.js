// Folder Frenzy. Crates of look-alike files fall down one of eight chutes.
// Steer a crate into a bin and those files really move there. A crate you
// never touch is a miss: it changes nothing and comes round again.
import { Fx, intro, keyboard, loop, makeCanvas, results, roundRect, truncate } from './kit.js';
import { fmt } from '../js/api.js';

const LANES = [
  { action: 'move:Documents', label: 'Documents', icon: '📄', color: '#38bdf8' },
  { action: 'move:Images', label: 'Images', icon: '🖼️', color: '#e879f9' },
  { action: 'move:Media', label: 'Media', icon: '🎵', color: '#f97316' },
  { action: 'move:Code', label: 'Code', icon: '⌨️', color: '#a3e635' },
  { action: 'move:Archives', label: 'Archives', icon: '🗜️', color: '#facc15' },
  { action: 'move:Installers', label: 'Installers', icon: '💿', color: '#14b8a6' },
  { action: 'trash', label: 'Trash', icon: '🗑️', color: '#f43f5e' },
  { action: 'keep', label: 'Leave', icon: '✋', color: '#64748b' },
];

export default async function play(ctx) {
  const { root, act, setStats, exit } = ctx;
  const { canvas, ctx: g, view, destroy: destroyCanvas } = makeCanvas(root);
  const fx = new Fx();
  let stopLoop = () => {};
  let kb = null;

  setStats([['Scanning', 'folder…']]);
  const scan = await ctx.scan();
  const queue = [...scan.groups];

  await intro(root, {
    title: 'FOLDER FRENZY',
    story: `${scan.stats.files} loose files (${fmt.bytes(scan.stats.bytes)}) in ${ctx.chore.target.split(/[/\\]/).pop()}. They come down in crates of look-alikes. Steer each crate into a bin before it lands: the files really move there. The glowing bin is ChoreCade's guess. Duplicates are red: send them to Trash, a folder you can still open. A crate you never touch changes nothing.`,
    keys: [
      ['← →', 'steer the crate'],
      ['↓', 'drop faster'],
      ['1 2 3 4 5 6 7 8', 'send straight to a bin'],
      ['Click', 'send to the bin you click'],
      ['Space', 'send to the glowing bin'],
    ],
  });

  let crate = null;
  let score = 0;
  let streak = 0;
  let sorted = 0;
  let bytes = 0;
  let misses = 0;
  let level = 0;
  let over = false;
  let flash = null;

  const laneW = () => view.w / LANES.length;
  const binTop = () => view.h - 120;

  function next() {
    if (!queue.length) return (crate = null);
    const group = queue.shift();
    const suggested = Math.max(0, LANES.findIndex((l) => l.action === group.suggestion));
    // Start away from the right bin so there is always some steering to do.
    let lane = Math.floor(Math.random() * LANES.length);
    if (lane === suggested) lane = (lane + 3) % LANES.length;
    crate = { group, lane, x: lane, y: -70, touched: false, suggested, fast: false };
  }

  function land(lane, how = 'drop') {
    if (!crate) return;
    const c = crate;
    crate = null;
    const binCenter = (lane + 0.5) * laneW();
    if (!c.touched && how === 'drop') {
      misses++;
      streak = 0;
      queue.push(c.group);
      fx.float(binCenter, binTop() - 20, 'MISSED: NOTHING MOVED', '#64748b', 13);
      return next();
    }
    const l = LANES[lane];
    const wise = lane === c.suggested;
    streak = wise ? streak + 1 : 0;
    score += Math.round((c.group.count * 10 + 50) * (wise ? 2 : 1) * (1 + streak * 0.15));
    if (l.action !== 'keep') {
      sorted += c.group.count;
      bytes += c.group.bytes ?? 0;
    }
    level = Math.floor((scan.groups.length - queue.length) / 4);
    fx.burst(binCenter, binTop(), l.color, 26);
    fx.float(binCenter, binTop() - 24, `${l.label.toUpperCase()} ×${c.group.count}${wise ? '  PERFECT' : ''}`, wise ? '#a3e635' : l.color, 14);
    flash = { lane, t: 0.4 };
    act(c.group.id, l.action).catch(() => {});
    next();
  }

  function send(lane) {
    if (!crate || over) return;
    crate.touched = true;
    land(lane, 'send');
  }

  kb = keyboard((e) => {
    if (!crate || over) return;
    if (e.key === 'ArrowLeft') {
      crate.lane = Math.max(0, crate.lane - 1);
      crate.touched = true;
    }
    if (e.key === 'ArrowRight') {
      crate.lane = Math.min(LANES.length - 1, crate.lane + 1);
      crate.touched = true;
    }
    if (e.key === ' ') send(crate.suggested);
    const n = Number(e.key);
    if (n >= 1 && n <= LANES.length) send(n - 1);
  });
  canvas.addEventListener('click', (e) => send(Math.floor(e.offsetX / laneW())));

  function finish() {
    over = true;
    stopLoop();
    results(root, {
      title: 'FOLDER SORTED',
      lines: ['Every crate is in a bin. Moves are journaled: undo any of them from the real-world log.'],
      stats: [
        [score.toLocaleString(), 'score'],
        [sorted.toLocaleString(), 'files moved'],
        [fmt.bytes(bytes), 'tidied'],
        [String(misses), 'misses'],
      ],
      onExit: exit,
    });
  }

  next();
  stopLoop = loop((dt) => {
    const { w: W, h: H } = view;
    const lw = laneW();
    const top = binTop();
    if (crate) {
      if (kb.down.has('ArrowDown')) crate.touched = crate.fast = true;
      const fall = (top + 70) / Math.max(1.6, 5 - level * 0.35);
      crate.y += fall * dt * (kb.down.has('ArrowDown') ? 5 : 1);
      crate.x += (crate.lane - crate.x) * Math.min(1, dt * 16);
      if (crate.y + 60 >= top) land(crate.lane);
    } else if (!over && !queue.length) finish();
    fx.step(dt);
    if (flash) flash.t -= dt;

    g.clearRect(0, 0, W, H);
    // chutes
    for (let i = 0; i < LANES.length; i++) {
      const l = LANES[i];
      const glow = crate && i === crate.suggested;
      g.fillStyle = i % 2 ? 'rgba(255,255,255,0.015)' : 'rgba(255,255,255,0.03)';
      g.fillRect(i * lw, 0, lw, top);
      if (glow) {
        const grad = g.createLinearGradient(0, top - 200, 0, top);
        grad.addColorStop(0, 'transparent');
        grad.addColorStop(1, l.color + '55');
        g.fillStyle = grad;
        g.fillRect(i * lw, top - 200, lw, 200);
      }
      // bin
      const lit = flash && flash.lane === i && flash.t > 0;
      roundRect(g, i * lw + 6, top, lw - 12, 100, 12);
      g.fillStyle = lit ? l.color : '#0f1629';
      g.fill();
      g.lineWidth = glow ? 3 : 1.5;
      g.strokeStyle = glow ? l.color : '#22304f';
      g.stroke();
      g.textAlign = 'center';
      g.font = '26px system-ui, sans-serif';
      g.fillText(l.icon, (i + 0.5) * lw, top + 42);
      g.font = '700 12px ui-monospace, Consolas, monospace';
      g.fillStyle = lit ? '#04121a' : l.color;
      g.fillText(`${i + 1} ${l.label}`, (i + 0.5) * lw, top + 72);
    }
    // crate
    if (crate) {
      const cw = Math.min(lw * 1.6, 230);
      const x = (crate.x + 0.5) * lw - cw / 2;
      const dup = crate.group.kind === 'duplicate';
      const mystery = crate.group.kind === 'unknown';
      g.shadowColor = dup ? '#f43f5e' : '#fbbf24';
      g.shadowBlur = 18;
      roundRect(g, x, crate.y, cw, 64, 10);
      g.fillStyle = dup ? '#4c0519' : mystery ? '#1e293b' : '#422006';
      g.fill();
      g.shadowBlur = 0;
      g.strokeStyle = dup ? '#f43f5e' : mystery ? '#94a3b8' : '#fbbf24';
      g.lineWidth = 2;
      g.stroke();
      g.fillStyle = '#fff7ed';
      g.textAlign = 'center';
      g.font = '700 12px ui-monospace, Consolas, monospace';
      g.fillText(truncate(crate.group.label, Math.floor(cw / 7.5)), x + cw / 2, crate.y + 24);
      g.font = '11px ui-monospace, Consolas, monospace';
      g.fillStyle = 'rgba(255,247,237,0.75)';
      g.fillText(`${crate.group.count} file${crate.group.count > 1 ? 's' : ''} · ${fmt.bytes(crate.group.bytes)}`, x + cw / 2, crate.y + 44);
      if (!crate.touched) {
        g.fillStyle = 'rgba(148,163,184,0.8)';
        g.fillText('steer me', x + cw / 2, crate.y - 8);
      }
    }
    fx.draw(g);
    setStats([
      ['Score', score.toLocaleString()],
      ['Streak', streak > 1 ? `×${streak}` : '-'],
      ['Crates left', String(queue.length + (crate ? 1 : 0))],
      ['Files moved', `${sorted} / ${scan.stats.files}`],
      ['Tidied', fmt.bytes(bytes)],
    ]);
  });

  return () => {
    stopLoop();
    kb?.destroy();
    destroyCanvas();
  };
}
