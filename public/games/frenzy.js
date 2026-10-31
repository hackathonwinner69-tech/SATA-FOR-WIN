// Folder Frenzy. You are a little courier robot in a messy room. Crates of
// look-alike files land on the floor; pick one up, run it to a bin door on the
// walls and the files really move there. Dust bunnies knock crates out of your
// hands. A crate only moves files when you deliver it: dropped crates change nothing.
import { Fx, intro, keyboard, loop, makeCanvas, reducedMotion, results, roundRect, truncate } from './kit.js';
import { approach, clamp, deliveryScore, dist, inside, nearest, wallDoors } from './arena.js';
import { drawSprite } from '../js/sprites.js';
import { fmt } from '../js/api.js';

const BINS = [
  { action: 'move:Documents', label: 'Documents', color: '#2b59d9' },
  { action: 'move:Images', label: 'Images', color: '#c2417e' },
  { action: 'move:Media', label: 'Media', color: '#e36a1c' },
  { action: 'move:Code', label: 'Code', color: '#12895f' },
  { action: 'move:Archives', label: 'Archives', color: '#b78a10' },
  { action: 'move:Installers', label: 'Installers', color: '#0f7f8c' },
  { action: 'trash', label: 'Trash', color: '#d93f25' },
  { action: 'keep', label: 'Leave it', color: '#6b665c' },
];
const ON_FLOOR = 4;
const SPEED = 290;

export default async function play(ctx) {
  const { root, act, setStats, exit, announce } = ctx;
  const { canvas, ctx: g, view, destroy: destroyCanvas } = makeCanvas(root);
  const fx = new Fx();
  let stopLoop = () => {};
  let kb = null;

  setStats([['Scanning', 'folder…']]);
  const scan = await ctx.scan();
  const queue = [...scan.groups];
  setStats([]);

  await intro(root, {
    title: 'FOLDER FRENZY',
    story: `${scan.stats.files} loose files (${fmt.bytes(scan.stats.bytes)}) are piled up in crates of look-alikes. Pick a crate up and run it to a bin door: the files really move there. The arrow points at ChoreCade's guess. Red crates are exact duplicates; Trash is a folder you can still open. Dust bunnies knock crates out of your hands, and a dropped crate changes nothing.`,
    keys: [
      ['W A S D', 'run (arrow keys work too)'],
      ['Space', 'pick up / put down a crate'],
      ['Click', 'run to where you click'],
      ['Shift', 'dash'],
    ],
  });

  const player = { x: view.w / 2, y: view.h / 2, carrying: null, stun: 0, safe: 0, dash: 0, dashCd: 0, face: 1, target: null };
  // Sprite pixel size follows the screen so the actors read on a laptop and a big monitor alike.
  const px = () => clamp(Math.min(view.w, view.h * 1.4) / 240, 3, 5);
  let crates = [];
  const bunnies = [];
  let score = 0;
  let streak = 0;
  let streakTimer = 0;
  let delivered = 0;
  let moved = 0;
  let bytes = 0;
  let drops = 0;
  let clock = 0;
  let over = false;
  let shake = 0;

  const doors = () => wallDoors(BINS, view.w, view.h, { depth: Math.min(110, view.w * 0.13) });
  const floor = () => {
    const d = Math.min(110, view.w * 0.13);
    return { x: d + 30, y: 40, w: view.w - 2 * d - 60, h: view.h - 80 };
  };

  function spawnCrate() {
    if (!queue.length || crates.length >= ON_FLOOR) return;
    const f = floor();
    const group = queue.shift();
    // Try a few spots and keep the one furthest from other crates and the robot.
    let best = null;
    for (let i = 0; i < 10; i++) {
      const p = { x: f.x + Math.random() * f.w, y: f.y + Math.random() * f.h };
      const room = Math.min(...[...crates, player].map((o) => dist(o, p)));
      if (!best || room > best.room) best = { ...p, room };
    }
    crates.push({ group, x: best.x, y: best.y, drop: 0.5 });
  }

  function spawnBunny() {
    const f = floor();
    bunnies.push({ x: f.x + Math.random() * f.w, y: Math.random() < 0.5 ? f.y : f.y + f.h, vx: 0, vy: 0, wobble: Math.random() * 6 });
  }

  function suggestedDoor(group) {
    return doors().find((d) => d.action === group.suggestion) ?? doors().find((d) => d.action === 'keep');
  }

  function pickOrDrop() {
    if (over || player.stun > 0) return;
    if (player.carrying) {
      const f = floor();
      crates.push({ ...player.carrying, x: clamp(player.x, f.x, f.x + f.w), y: clamp(player.y + 10, f.y, f.y + f.h), drop: 0 });
      player.carrying = null;
      return;
    }
    const c = nearest(player, crates, 60);
    if (!c) return;
    crates = crates.filter((x) => x !== c);
    player.carrying = c;
    announce(`Picked up ${c.group.label}, ${c.group.count} files. Suggested bin: ${suggestedDoor(c.group).label}.`);
  }

  function deliver(door) {
    const c = player.carrying;
    player.carrying = null;
    const wise = door.action === c.group.suggestion;
    streak = streakTimer > 0 ? streak + 1 : 1;
    streakTimer = 7;
    score += deliveryScore({ count: c.group.count, wise, streak });
    delivered++;
    if (door.action !== 'keep') {
      moved += c.group.count;
      bytes += c.group.bytes ?? 0;
    }
    const cx = door.x + door.w / 2;
    const cy = door.y + door.h / 2;
    fx.burst(cx, cy, door.color, 34);
    fx.float(clamp(cx, 90, view.w - 90), cy - 18, `${door.label.toUpperCase()} ×${c.group.count}${wise ? ' ★' : ''}`, wise ? '#f2b632' : '#f4f1ea', 15);
    act(c.group.id, door.action).catch(() => {});
    // Every few deliveries the room gets a little more hostile.
    if (delivered % 4 === 0 && bunnies.length < 6) spawnBunny();
  }

  function knocked(bunny) {
    if (player.safe > 0 || player.dash > 0) return;
    player.stun = 0.8;
    // A short grace period afterwards, and the bunny bounces off, so a hit can never lock you in place.
    player.safe = 2;
    bunny.daze = 2.2;
    shake = reducedMotion ? 0 : 0.3;
    streak = 0;
    if (player.carrying) {
      const a = Math.random() * Math.PI * 2;
      const f = floor();
      crates.push({ ...player.carrying, x: clamp(player.x + Math.cos(a) * 80, f.x, f.x + f.w), y: clamp(player.y + Math.sin(a) * 80, f.y, f.y + f.h), drop: 0.4 });
      player.carrying = null;
      drops++;
      fx.float(player.x, player.y - 30, 'DROPPED! NOTHING MOVED', '#c9bfae', 13);
    }
  }

  kb = keyboard((e) => {
    if (e.key === ' ' || e.key === 'e' || e.key === 'Enter') pickOrDrop();
    if (e.key === 'Shift' && player.dashCd <= 0) {
      player.dash = 0.22;
      player.dashCd = 1.2;
    }
  });
  const pointer = (e) => {
    // Empty-handed you cannot walk into a doorway, so aim for the nearest reachable spot.
    const d = Math.min(110, view.w * 0.13);
    const x = player.carrying ? e.offsetX : clamp(e.offsetX, d + 14, view.w - d - 14);
    player.target = { x, y: e.offsetY };
  };
  canvas.addEventListener('pointerdown', (e) => {
    pointer(e);
    // Clicking a crate you are standing next to picks it up.
    const c = nearest({ x: e.offsetX, y: e.offsetY }, crates, 40);
    if (c && dist(player, c) < 60) pickOrDrop();
  });

  function finish() {
    over = true;
    stopLoop();
    results(root, {
      title: 'ROOM TIDY',
      lines: [`Every crate is in a bin. ${moved} files moved, all journaled: undo any delivery from the ledger.`],
      stats: [
        [score.toLocaleString(), 'score'],
        [moved.toLocaleString(), 'files moved'],
        [fmt.bytes(bytes), 'tidied'],
        [`${Math.floor(clock / 60)}:${String(Math.floor(clock % 60)).padStart(2, '0')}`, 'time'],
      ],
      onExit: exit,
    });
  }

  spawnBunny();
  stopLoop = loop((dt, t) => {
    const W = view.w;
    const H = view.h;
    if (over) return;
    clock += dt;
    streakTimer -= dt;
    if (streakTimer <= 0) streak = 0;
    player.stun = Math.max(0, player.stun - dt);
    player.safe = Math.max(0, player.safe - dt);
    player.dash = Math.max(0, player.dash - dt);
    player.dashCd = Math.max(0, player.dashCd - dt);
    shake = Math.max(0, shake - dt);
    while (crates.length < ON_FLOOR && queue.length) spawnCrate();

    // movement
    if (player.stun <= 0) {
      let dx = 0;
      let dy = 0;
      const k = kb.down;
      if (k.has('ArrowLeft') || k.has('a') || k.has('A')) dx -= 1;
      if (k.has('ArrowRight') || k.has('d') || k.has('D')) dx += 1;
      if (k.has('ArrowUp') || k.has('w') || k.has('W')) dy -= 1;
      if (k.has('ArrowDown') || k.has('s') || k.has('S')) dy += 1;
      const speed = SPEED * (player.dash > 0 ? 2.6 : 1) * (player.carrying ? 0.88 : 1);
      if (dx || dy) {
        player.target = null;
        const n = Math.hypot(dx, dy);
        player.x += (dx / n) * speed * dt;
        player.y += (dy / n) * speed * dt;
        if (dx) player.face = Math.sign(dx);
      } else if (player.target) {
        const next = approach(player, player.target, speed * dt);
        if (next.x !== player.x) player.face = Math.sign(next.x - player.x);
        player.x = next.x;
        player.y = next.y;
        if (dist(player, player.target) < 2) {
          player.target = null;
          if (!player.carrying && nearest(player, crates, 40)) pickOrDrop();
        }
      }
    }
    player.x = clamp(player.x, 14, W - 14);
    player.y = clamp(player.y, 20, H - 20);

    // deliveries
    if (player.carrying) {
      const door = doors().find((d) => inside(player, d));
      if (door) deliver(door);
    } else {
      // keep the robot out of the doorways when empty-handed
      const d = Math.min(110, W * 0.13);
      player.x = clamp(player.x, d + 14, W - d - 14);
    }

    // dust bunnies drift towards you, faster as the room gets tidier
    const f = floor();
    const chase = 70 + Math.min(90, delivered * 4);
    for (const b of bunnies) {
      b.daze = Math.max(0, (b.daze ?? 0) - dt);
      if (b.daze > 0) {
        // a bunny that just hit you wanders off before it comes back
        b.x = clamp(b.x + Math.sign(b.x - player.x || 1) * 60 * dt, f.x, f.x + f.w);
        b.y = clamp(b.y + Math.sign(b.y - player.y || 1) * 60 * dt, f.y, f.y + f.h);
        b.vx = b.vy = 0;
        continue;
      }
      const toward = approach(b, player, 1);
      b.vx += (toward.x - b.x) * chase * dt * 3 + Math.sin(t * 2 + b.wobble) * 30 * dt;
      b.vy += (toward.y - b.y) * chase * dt * 3 + Math.cos(t * 1.7 + b.wobble) * 30 * dt;
      const v = Math.hypot(b.vx, b.vy);
      if (v > chase) {
        // bleed off speed gradually so a knockback carries the bunny away
        b.vx *= chase / v;
        b.vy *= chase / v;
      }
      b.x = clamp(b.x + b.vx * dt, f.x - 20, f.x + f.w + 20);
      b.y = clamp(b.y + b.vy * dt, f.y - 20, f.y + f.h + 20);
      if (dist(b, player) < 24) knocked(b);
    }
    for (const c of crates) c.drop = Math.max(0, c.drop - dt);
    fx.step(dt);
    if (!queue.length && !crates.length && !player.carrying) finish();

    // ---------- draw ----------
    g.save();
    if (shake > 0) g.translate((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8);
    g.fillStyle = '#15141b';
    g.fillRect(0, 0, W, H);
    // floorboards
    g.strokeStyle = '#1f1d27';
    g.lineWidth = 1;
    for (let y = 0; y < H; y += 34) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(W, y);
      g.stroke();
    }
    const hint = player.carrying ? suggestedDoor(player.carrying.group) : null;
    for (const d of doors()) {
      const lit = hint && hint.index === d.index;
      g.fillStyle = lit ? d.color : '#22202b';
      g.fillRect(d.x + 4, d.y + 4, d.w - 8, d.h - 8);
      g.lineWidth = 3;
      g.strokeStyle = d.color;
      g.strokeRect(d.x + 4, d.y + 4, d.w - 8, d.h - 8);
      g.fillStyle = lit ? '#15141b' : '#f4f1ea';
      g.textAlign = 'center';
      let size = 14;
      do g.font = `700 ${size}px Silkscreen, monospace`;
      while (g.measureText(d.label.toUpperCase()).width > d.w - 18 && --size > 8);
      g.fillText(d.label.toUpperCase(), d.x + d.w / 2, d.y + d.h / 2 + 5);
    }
    // guide arrow from the robot to the suggested door
    if (hint && !reducedMotion) {
      const tx = hint.x + hint.w / 2;
      const ty = hint.y + hint.h / 2;
      const a = Math.atan2(ty - player.y, tx - player.x);
      g.save();
      g.translate(player.x + Math.cos(a) * 42, player.y + Math.sin(a) * 42);
      g.rotate(a);
      g.fillStyle = hint.color;
      g.beginPath();
      g.moveTo(10, 0);
      g.lineTo(-6, -7);
      g.lineTo(-6, 7);
      g.fill();
      g.restore();
    }
    for (const c of crates) drawCrate(c, c.x, c.y - c.drop * 60);
    const P = px();
    for (const b of bunnies) drawSprite(g, 'bunny', b.x - 5 * P, b.y - 4 * P, P);
    // robot, blinking while stunned
    if (!(player.safe > 0 && Math.floor(t * 12) % 2)) {
      drawSprite(g, 'robot', player.x - 5 * P, player.y - 5 * P, P, player.dash > 0 ? '#2b59d9' : null);
    }
    if (player.carrying) drawCrate(player.carrying, player.x, player.y - 12 * P, true);
    fx.draw(g);
    g.restore();

    setStats([
      ['Score', score.toLocaleString()],
      ['Streak', streak > 1 ? `×${streak}` : '-'],
      ['Crates left', String(queue.length + crates.length + (player.carrying ? 1 : 0))],
      ['Files moved', `${moved} / ${scan.stats.files}`],
      ['Drops', String(drops)],
    ]);
  });

  function drawCrate(c, x, y, held = false) {
    const dup = c.group.kind === 'duplicate';
    const P = px();
    drawSprite(g, 'crate', x - 5 * P, y - 4 * P, P, dup ? '#d93f25' : null);
    y += 4 * P - 14;
    const label = `${truncate(c.group.label, 22)} ×${c.group.count}`;
    g.font = '600 11px "IBM Plex Mono", monospace';
    const w = g.measureText(label).width + 12;
    roundRect(g, x - w / 2, y + 16, w, 18, 4);
    g.fillStyle = held ? '#f2b632' : '#fffdf8';
    g.fill();
    g.fillStyle = '#1d1b16';
    g.textAlign = 'center';
    g.fillText(label, x, y + 29);
  }

  return () => {
    stopLoop();
    kb?.destroy();
    destroyCanvas();
  };
}
