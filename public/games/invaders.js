// Inbox Invaders. Each invader is one sender; its hull size is how much mail
// it has sent you. A hit applies your current weapon to all of that mail.
import { Fx, actionBar, drawStars, intro, keyboard, loop, makeCanvas, results, roundRect, stars, truncate } from './kit.js';

const WEAPONS = {
  archive: { color: '#38bdf8', name: 'ARCHIVE', short: 'Archive' },
  trash: { color: '#f43f5e', name: 'TRASH', short: 'Trash' },
  unsubscribe: { color: '#a855f7', name: 'UNSUB', short: 'Unsub' },
  keep: { color: '#22c55e', name: 'KEEP', short: 'Keep' },
};
const KEYS = { a: 'archive', 1: 'archive', d: 'trash', 2: 'trash', u: 'unsubscribe', 3: 'unsubscribe', k: 'keep', 4: 'keep' };
const HULL = { newsletter: '#7c3aed', notification: '#0891b2', receipt: '#b45309', person: '#eab308' };
const MAX_ON_SCREEN = 9;

/**
 * What a bullet does to a ship. A person's shield drops on the first trash or
 * unsubscribe hit, and only a bullet from a later press of fire confirms it, so
 * holding fire down cannot zap a human by accident.
 */
export function shieldHit(ship, bullet) {
  if (bullet.weapon !== 'trash' && bullet.weapon !== 'unsubscribe') return 'destroy';
  if (ship.shield) return 'drop';
  return bullet.press > (ship.shieldPress ?? -Infinity) ? 'destroy' : 'absorb';
}

/** Ships at least half inside the view; ones still sliding in from the top do not count. */
export function onScreen(ships, view) {
  return ships.filter((s) => s.y + s.h / 2 > 0 && s.y + s.h / 2 < view.h);
}

export default async function play(ctx) {
  const { root, chore, act, toast, setStats, exit } = ctx;
  const { canvas, ctx: g, view, destroy: destroyCanvas } = makeCanvas(root);
  const fx = new Fx();
  const field = stars();
  let stopLoop = () => {};
  let kb = null;
  let bar = null;

  setStats([['Scanning', 'inbox…']]);
  const scan = await ctx.scan();
  const queue = [...scan.groups];
  const totalMail = scan.stats.messages;
  setStats([]);

  await intro(root, {
    title: 'INBOX INVADERS',
    story: `${totalMail.toLocaleString()} emails from ${queue.length} senders are invading. Each ship is one sender: one hit handles every email it ever sent you. The ring around a ship shows the weapon ChoreCade would pick. Gold ships are people: trashing or unsubscribing a human takes two separate presses of fire.`,
    keys: [
      ['← →', 'move (or use the mouse)'],
      ['Space', 'fire (or click)'],
      ['A D U K', 'archive · trash · unsubscribe · keep'],
      ['B', 'smart bomb: ChoreCade’s pick for every low-risk ship on screen'],
    ],
  });

  const player = { x: view.w / 2, w: 54, cooldown: 0 };
  let weapon = 'archive';
  let ships = [];
  let bullets = [];
  let score = 0;
  let combo = 0;
  let comboTimer = 0;
  let bombs = 1;
  let handled = 0;
  let senders = 0;
  let escaped = 0;
  let speed = 14;
  let spawnTimer = 0;
  let over = false;
  let mouseX = null;
  let press = 0; // counts presses of fire, so a held button is one press

  bar = actionBar(
    root,
    chore.actions.map((a) => ({ ...a, color: WEAPONS[a.id].color, short: WEAPONS[a.id].short })),
    (id) => {
      weapon = id;
      bar.select(id);
    },
  );
  bar.select(weapon);

  function spawn() {
    if (!queue.length || ships.length >= MAX_ON_SCREEN) return;
    const group = queue.shift();
    const w = Math.min(220, 96 + Math.log2(group.count + 1) * 16);
    // Try a few spots and keep the one furthest from ships still near the top.
    let lane = 20;
    let best = -1;
    for (let i = 0; i < 8; i++) {
      const x = Math.random() * Math.max(1, view.w - w - 40) + 20;
      const gap = Math.min(...ships.filter((s) => s.y < 140).map((s) => Math.abs(s.x + s.w / 2 - (x + w / 2)) - (s.w + w) / 2), 999);
      if (gap > best) [best, lane] = [gap, x];
    }
    ships.push({ group, x: lane, y: -50, w, h: 46, phase: Math.random() * 6, shield: group.risk === 'high', hit: 0 });
  }

  function destroyShip(ship, how, smart = false) {
    ships = ships.filter((s) => s !== ship);
    const cx = ship.x + ship.w / 2;
    const cy = ship.y + ship.h / 2;
    fx.burst(cx, cy, WEAPONS[how].color, 30 + Math.min(40, ship.group.count / 4));
    const wise = how === ship.group.suggestion;
    combo = comboTimer > 0 ? combo + 1 : 1;
    comboTimer = 2.2;
    if (combo > 0 && combo % 8 === 0) {
      bombs++;
      fx.float(cx, cy - 40, '+1 SMART BOMB', '#fbbf24', 18);
    }
    const points = Math.round(ship.group.count * (wise ? 2 : 1) * (1 + combo * 0.1) * 10);
    score += points;
    handled += how === 'keep' ? 0 : ship.group.count;
    senders++;
    fx.float(cx, cy, `${WEAPONS[how].name} ×${ship.group.count}`, WEAPONS[how].color, 16);
    if (wise && !smart) fx.float(cx, cy + 20, 'SMART SHOT ×2', '#a3e635', 12);
    act(ship.group.id, how).catch(() => {});
  }

  function fire() {
    if (player.cooldown > 0 || over) return;
    player.cooldown = 0.18;
    bullets.push({ x: player.x, y: view.h - 70, weapon, press });
  }

  function smartBomb() {
    if (!bombs || over) return;
    const targets = onScreen(ships, view).filter((s) => s.group.risk === 'low');
    if (!targets.length) return toast('No low-risk ships on screen for the smart bomb');
    bombs--;
    for (const s of targets) destroyShip(s, s.group.suggestion, true);
    fx.float(view.w / 2, view.h / 2, `SMART BOMB · ${targets.length} SENDERS`, '#fbbf24', 26);
  }

  kb = keyboard((e) => {
    const k = e.key.toLowerCase();
    if (k === ' ') {
      press++;
      fire(); // a tap shorter than a frame still fires
    }
    if (KEYS[k]) {
      weapon = KEYS[k];
      bar.select(weapon);
    }
    if (k === 'b') smartBomb();
  });
  canvas.addEventListener('mousemove', (e) => (mouseX = e.offsetX));
  canvas.addEventListener('mousedown', (e) => {
    player.x = mouseX = e.offsetX;
    press++;
    fire();
  });

  function finish() {
    over = true;
    stopLoop();
    const impact = ctx.impact();
    results(root, {
      title: queue.length || ships.length ? 'GAME OVER' : 'INBOX CLEARED',
      lines: [`You took out ${senders} senders. The worker is filing the last of it in the background: check the real-world log.`],
      stats: [
        [score.toLocaleString(), 'score'],
        [(impact.archived ?? 0).toLocaleString(), 'archived'],
        [(impact.trashed ?? 0).toLocaleString(), 'trashed'],
        [(impact.unsubscribed ?? 0).toLocaleString(), 'unsubscribed'],
      ],
      onExit: exit,
    });
  }

  stopLoop = loop((dt, t) => {
    const { w: W, h: H } = view;
    // input
    if (kb.down.has('ArrowLeft') || kb.down.has('Left')) player.x -= 520 * dt;
    if (kb.down.has('ArrowRight') || kb.down.has('Right')) player.x += 520 * dt;
    if (mouseX !== null) player.x += (mouseX - player.x) * Math.min(1, dt * 14);
    if (kb.down.has(' ')) fire();
    player.x = Math.max(30, Math.min(W - 30, player.x));
    player.cooldown -= dt;
    comboTimer -= dt;
    if (comboTimer <= 0) combo = 0;

    // world
    spawnTimer -= dt;
    if (spawnTimer <= 0) {
      spawn();
      spawnTimer = Math.max(0.35, 1.3 - senders * 0.01);
    }
    speed = 14 + senders * 0.35;
    for (const s of ships) {
      s.y += speed * dt * (s.y < 60 ? 4 : 1);
      s.x = Math.max(8, Math.min(W - s.w - 8, s.x + Math.sin(t * 1.3 + s.phase) * 22 * dt));
      s.hit = Math.max(0, s.hit - dt);
    }
    for (const b of bullets) b.y -= 760 * dt;
    for (const b of bullets) {
      const s = ships.find((s) => b.x > s.x && b.x < s.x + s.w && b.y > s.y && b.y < s.y + s.h);
      if (!s) continue;
      b.dead = true;
      const outcome = shieldHit(s, b);
      if (outcome === 'drop') {
        s.shield = false;
        s.shieldPress = b.press;
        s.hit = 0.4;
        fx.burst(b.x, s.y + s.h, '#fde047', 12, 120);
        fx.float(s.x + s.w / 2, s.y - 8, 'A HUMAN! FIRE AGAIN TO CONFIRM', '#fde047', 12);
        continue;
      }
      if (outcome === 'absorb') {
        fx.burst(b.x, s.y + s.h, '#fde047', 4, 60);
        continue;
      }
      destroyShip(s, b.weapon);
    }
    bullets = bullets.filter((b) => !b.dead && b.y > -20);
    const line = H - 110;
    for (const s of [...ships]) {
      if (s.y + s.h < line) continue;
      ships = ships.filter((x) => x !== s);
      queue.push(s.group); // it will come round again
      escaped++;
      combo = 0;
      fx.float(s.x + s.w / 2, line, 'ESCAPED', '#64748b', 14);
    }
    fx.step(dt);
    if (!queue.length && !ships.length && !over) finish();

    // draw
    g.clearRect(0, 0, W, H);
    drawStars(g, view, field, dt);
    g.strokeStyle = 'rgba(244,63,94,0.25)';
    g.setLineDash([6, 8]);
    g.beginPath();
    g.moveTo(0, line);
    g.lineTo(W, line);
    g.stroke();
    g.setLineDash([]);

    for (const s of ships) {
      const hull = HULL[s.group.kind] ?? '#334155';
      const hint = WEAPONS[s.group.suggestion]?.color ?? '#94a3b8';
      g.shadowColor = hint;
      g.shadowBlur = 14;
      roundRect(g, s.x, s.y, s.w, s.h, 12);
      g.fillStyle = s.hit > 0 ? '#ffffff' : hull;
      g.fill();
      g.shadowBlur = 0;
      g.lineWidth = 2;
      g.strokeStyle = hint;
      g.stroke();
      if (s.shield) {
        g.strokeStyle = 'rgba(253,224,71,0.7)';
        g.lineWidth = 3;
        roundRect(g, s.x - 5, s.y - 5, s.w + 10, s.h + 10, 16);
        g.stroke();
      }
      g.fillStyle = '#f8fafc';
      g.textAlign = 'left';
      g.font = '700 12px ui-monospace, Consolas, monospace';
      g.fillText(truncate(s.group.label, Math.floor(s.w / 8)), s.x + 10, s.y + 19);
      g.font = '11px ui-monospace, Consolas, monospace';
      g.fillStyle = 'rgba(248,250,252,0.75)';
      g.fillText(`${s.group.count} mail · ${s.group.kind}`, s.x + 10, s.y + 35);
    }
    for (const b of bullets) {
      g.fillStyle = WEAPONS[b.weapon].color;
      g.shadowColor = WEAPONS[b.weapon].color;
      g.shadowBlur = 10;
      g.fillRect(b.x - 2, b.y - 12, 4, 16);
      g.shadowBlur = 0;
    }
    // player
    const py = H - 78;
    g.fillStyle = WEAPONS[weapon].color;
    g.shadowColor = WEAPONS[weapon].color;
    g.shadowBlur = 20;
    g.beginPath();
    g.moveTo(player.x, py - 22);
    g.lineTo(player.x + player.w / 2, py + 14);
    g.lineTo(player.x - player.w / 2, py + 14);
    g.closePath();
    g.fill();
    g.shadowBlur = 0;
    fx.draw(g);

    setStats([
      ['Score', score.toLocaleString()],
      ['Combo', combo > 1 ? `×${combo}` : '-'],
      ['Bombs', String(bombs)],
      ['Senders left', String(queue.length + ships.length)],
      ['Emails handled', `${handled.toLocaleString()} / ${totalMail.toLocaleString()}`],
      ['Escaped', String(escaped)],
    ]);
  });

  return () => {
    stopLoop();
    kb?.destroy();
    destroyCanvas();
  };
}
