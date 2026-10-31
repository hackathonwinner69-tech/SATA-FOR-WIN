// Inbox Invaders: a synthwave shooter. Senders fly at you from the horizon
// over a neon grid; each ship is one sender and grows with how much mail it
// sent. A hit applies your current weapon to every email from that sender.
// Sound is synthesised live (see sound.js); press M to mute.
import { Fx, actionBar, intro, keyboard, loop, makeCanvas, reducedMotion, results, roundRect, truncate } from './kit.js';
import { aimTarget, gridRows, hullHalf, project, shotHits, worldX } from './grid3d.js';
import { createSound } from './sound.js';

const WEAPONS = {
  archive: { color: '#3ee8ff', name: 'ARCHIVE', short: 'Archive' },
  trash: { color: '#ff4d7d', name: 'TRASH', short: 'Trash' },
  unsubscribe: { color: '#c77dff', name: 'UNSUB', short: 'Unsub' },
  keep: { color: '#5bff8f', name: 'KEEP', short: 'Keep' },
};
const KEYS = { a: 'archive', 1: 'archive', d: 'trash', 2: 'trash', u: 'unsubscribe', 3: 'unsubscribe', k: 'keep', 4: 'keep' };
const HULL = { newsletter: '#7b4dff', notification: '#21b8e0', receipt: '#ff9d3c', person: '#ffd23f' };
const MAX_ON_SCREEN = 8;
const SHIELDS = 3;

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

/** Ships at least half inside the view; each ship carries its screen box (y, h) from the last frame. */
export function onScreen(ships, view) {
  return ships.filter((s) => s.y + s.h / 2 > 0 && s.y + s.h / 2 < view.h);
}

export default async function play(ctx) {
  const { root, chore, act, toast, setStats, exit, announce } = ctx;
  const { canvas, ctx: g, view, destroy: destroyCanvas } = makeCanvas(root);
  const fx = new Fx();
  const sound = createSound();
  let stopLoop = () => {};
  let kb = null;
  let bar = null;

  setStats([['Scanning', 'inbox…']]);
  const scan = await ctx.scan();
  const queue = [...scan.groups];
  // Gmail reads a big inbox in the background, so the first scan may cover only the newest mail.
  const totalMail = scan.stats.remaining ?? scan.stats.messages;
  let loading = scan.stats.loading ?? 0;
  let topping = false;
  setStats([]);
  const still = loading ? ` ChoreCade is still reading ${loading.toLocaleString()} more; their senders join in as they arrive.` : '';

  await intro(root, {
    title: 'INBOX INVADERS',
    story: `${scan.stats.messages.toLocaleString()} emails from ${queue.length} senders are racing at you out of the sunset.${still} Each ship is one sender: one hit handles every email it ever sent you. The glow around a ship is the weapon ChoreCade would pick. Gold ships are people: trashing or unsubscribing a human takes two separate presses of fire. Ships that reach you escape and come round again, and newsletters shoot back.`,
    keys: [
      ['← →', 'steer (or use the mouse)'],
      ['Space', 'fire (or click)'],
      ['A D U K', 'archive · trash · unsubscribe · keep'],
      ['B', 'smart bomb: ChoreCade’s pick for every low-risk ship'],
      ['M', 'sound on / off'],
    ],
  });

  // ---------- sound toggle (a real button, so it works without the M key) ----------
  const muteBtn = document.createElement('button');
  muteBtn.type = 'button';
  muteBtn.className = 'btn quiet sound-toggle';
  const paintMute = () => {
    muteBtn.textContent = sound.muted ? '♪ Sound off' : '♪ Sound on';
    muteBtn.setAttribute('aria-pressed', String(!sound.muted));
  };
  muteBtn.addEventListener('click', () => {
    sound.toggle();
    paintMute();
  });
  paintMute();
  if (sound.available) root.append(muteBtn);
  sound.startMusic();

  const player = { x: 0, cooldown: 0, hurt: 0 };
  let weapon = 'archive';
  let ships = [];
  let shots = [];
  let bolts = [];
  let score = 0;
  let combo = 0;
  let comboTimer = 0;
  let bombs = 1;
  let shields = SHIELDS;
  let handled = 0;
  let senders = 0;
  let escaped = 0;
  let spawnTimer = 0;
  let scroll = 0;
  let over = false;
  let flash = 0;
  let targetX = null;
  let press = 0; // counts presses of fire, so a held button is one press
  const streaks = Array.from({ length: 40 }, () => ({ x: Math.random(), y: Math.random() * 0.36, w: 6 + Math.random() * 18, v: 0.005 + Math.random() * 0.02 }));
  const scanlines = scanlinePattern();

  bar = actionBar(
    root,
    chore.actions.map((a) => ({ ...a, color: WEAPONS[a.id].color, short: WEAPONS[a.id].short })),
    (id) => {
      weapon = id;
      bar.select(id);
    },
  );
  bar.select(weapon);

  const geo = () => ({ width: view.w, horizon: view.h * 0.4, bottom: view.h * 0.84 });

  function spawn() {
    if (!queue.length || ships.length >= MAX_ON_SCREEN) return;
    const group = queue.shift();
    // Keep new ships apart from others still near the horizon.
    let best = { x: 0, room: -1 };
    for (let i = 0; i < 8; i++) {
      const x = (Math.random() * 2 - 1) * 0.8;
      const room = Math.min(...ships.filter((s) => s.z > 0.75).map((s) => Math.abs(s.x - x)), 9);
      if (room > best.room) best = { x, room };
    }
    ships.push({ group, x: best.x, z: 1, y: 0, h: 0, half: hullHalf(group.count), phase: Math.random() * 6, shield: group.risk === 'high', hit: 0, fireCd: 1 + Math.random() * 2 });
  }

  function destroyShip(ship, how, smart = false) {
    ships = ships.filter((s) => s !== ship);
    const p = project(ship.x, ship.z, geo());
    fx.burst(p.x, p.y, WEAPONS[how].color, 26 + Math.min(40, ship.group.count / 4), 260 * p.s + 60);
    sound.boom(ship.group.count > 100);
    const wise = how === ship.group.suggestion;
    combo = comboTimer > 0 ? combo + 1 : 1;
    comboTimer = 2.4;
    if (combo > 1) sound.combo(combo);
    if (combo % 8 === 0) {
      bombs++;
      fx.float(p.x, p.y - 40, '+1 SMART BOMB', '#ffd23f', 18);
    }
    score += Math.round(ship.group.count * (wise ? 2 : 1) * (1 + combo * 0.1) * 10);
    handled += how === 'keep' ? 0 : ship.group.count;
    senders++;
    fx.float(p.x, p.y - 10, `${WEAPONS[how].name} ×${ship.group.count}`, WEAPONS[how].color, 16);
    if (wise && !smart) fx.float(p.x, p.y + 12, 'SMART SHOT ×2', '#5bff8f', 12);
    act(ship.group.id, how).catch(() => {});
  }

  function fire() {
    if (player.cooldown > 0 || over) return;
    player.cooldown = 0.17;
    // Aim assist: a shot fired roughly at a ship curves onto it, as in arcade rail shooters.
    shots.push({ x: player.x, z: 0.02, weapon, press, target: aimTarget(player.x, ships) });
    sound.laser(weapon);
  }

  function smartBomb() {
    if (!bombs || over) return;
    const targets = onScreen(ships, view).filter((s) => s.group.risk === 'low');
    if (!targets.length) return toast('No low-risk ships on screen for the smart bomb');
    bombs--;
    flash = reducedMotion ? 0 : 0.35;
    sound.bomb();
    for (const s of targets) destroyShip(s, s.group.suggestion, true);
    fx.float(view.w / 2, view.h * 0.5, `SMART BOMB · ${targets.length} SENDERS`, '#ffd23f', 26);
    announce(`Smart bomb: ${targets.length} senders handled.`);
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
    if (k === 'm') {
      sound.toggle();
      paintMute();
    }
  });
  canvas.addEventListener('pointermove', (e) => (targetX = worldX(e.offsetX, geo())));
  canvas.addEventListener('pointerdown', (e) => {
    player.x = targetX = worldX(e.offsetX, geo());
    press++;
    fire();
  });

  /**
   * Once every known sender is out, scan again for the senders of mail read
   * since. A scan holds back moves queued after it, so this waits until the queue is empty.
   */
  async function topUp() {
    topping = true;
    try {
      const next = await ctx.scan();
      if (over) return;
      const fresh = new Map(next.groups.map((gr) => [gr.id, gr]));
      for (const s of ships) s.group = fresh.get(s.group.id) ?? s.group;
      const flying = new Set(ships.map((s) => s.group.id));
      queue.splice(0, queue.length, ...next.groups.filter((gr) => !flying.has(gr.id)));
      loading = next.stats.loading ?? 0;
    } catch (err) {
      toast(`Could not read more mail: ${err.message}`, true);
      loading = 0;
    } finally {
      topping = false;
    }
  }

  function finish(title) {
    if (over) return;
    over = true;
    stopLoop();
    sound.stopMusic();
    if (!title) sound.win();
    const impact = ctx.impact();
    results(root, {
      title: title ?? 'INBOX CLEARED',
      lines: [
        title ? 'Your shields gave out. Every sender you hit really was handled, and stays handled.' : `You took out all ${senders} senders.`,
        'The worker files the last of it in the background: check the ledger.',
      ],
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
    if (over) return;
    const G = geo();
    const { w: W, h: H } = view;

    // ---------- input ----------
    // arrows only: A and D are the archive and trash weapons
    const steer = (kb.down.has('ArrowRight') ? 1 : 0) - (kb.down.has('ArrowLeft') ? 1 : 0);
    if (steer) {
      targetX = null;
      player.x += steer * 1.9 * dt;
    } else if (targetX !== null) player.x += (targetX - player.x) * Math.min(1, dt * 12);
    player.x = Math.max(-0.95, Math.min(0.95, player.x));
    if (kb.down.has(' ')) fire();
    player.cooldown -= dt;
    player.hurt = Math.max(0, player.hurt - dt);
    comboTimer -= dt;
    if (comboTimer <= 0) combo = 0;
    flash = Math.max(0, flash - dt);

    // ---------- world ----------
    const speed = 0.1 + Math.min(0.1, senders * 0.0018);
    scroll = (scroll + dt * (0.6 + speed * 4)) % 1;
    spawnTimer -= dt;
    if (spawnTimer <= 0) {
      spawn();
      spawnTimer = Math.max(0.45, 1.4 - senders * 0.01);
    }
    for (const s of ships) {
      s.z -= speed * dt * (s.z > 0.92 ? 3 : 1);
      s.x = Math.max(-0.9, Math.min(0.9, s.x + Math.sin(t * 1.2 + s.phase) * 0.12 * dt));
      s.hit = Math.max(0, s.hit - dt);
      // newsletters and notifications shoot back; people never do
      s.fireCd -= dt;
      if (s.fireCd <= 0 && s.z < 0.8 && s.group.risk !== 'high') {
        s.fireCd = 2.2 + Math.random() * 2.5;
        bolts.push({ x: s.x, z: s.z, vz: 0.55 + speed });
      }
    }
    for (const sh of shots) {
      sh.z += 1.5 * dt;
      if (sh.target && ships.includes(sh.target)) sh.x += (sh.target.x - sh.x) * Math.min(1, dt * 7);
    }
    for (const sh of shots) {
      const ship = ships.find((s) => shotHits(sh, s));
      if (!ship) continue;
      sh.dead = true;
      const outcome = shieldHit(ship, sh);
      if (outcome === 'drop') {
        ship.shield = false;
        ship.shieldPress = sh.press;
        ship.hit = 0.4;
        sound.shield();
        const p = project(ship.x, ship.z, G);
        fx.burst(p.x, p.y, '#ffd23f', 12, 120);
        fx.float(p.x, p.y - 30, 'A HUMAN! FIRE AGAIN TO CONFIRM', '#ffd23f', 12);
        continue;
      }
      if (outcome === 'absorb') {
        const p = project(ship.x, ship.z, G);
        fx.burst(p.x, p.y, '#ffd23f', 4, 60);
        continue;
      }
      destroyShip(ship, sh.weapon);
    }
    shots = shots.filter((sh) => !sh.dead && sh.z < 1.05);
    for (const b of bolts) {
      b.z -= b.vz * dt;
      if (b.z < 0.04 && Math.abs(b.x - player.x) < 0.08 && player.hurt <= 0) {
        b.dead = true;
        shields--;
        player.hurt = 1.2;
        flash = reducedMotion ? 0 : 0.2;
        sound.hurt();
        announce(`Hit! ${shields} shield${shields === 1 ? '' : 's'} left.`);
        if (shields <= 0) return finish('SHIELDS DOWN');
      }
    }
    bolts = bolts.filter((b) => !b.dead && b.z > -0.05);
    for (const s of [...ships]) {
      if (s.z > 0) continue;
      ships = ships.filter((x) => x !== s);
      queue.push(s.group); // it will come round again
      escaped++;
      combo = 0;
      sound.escape();
      fx.float(W / 2 + s.x * W * 0.4, G.bottom - 30, 'ESCAPED', '#8a7fb8', 14);
    }
    fx.step(dt);
    if (!queue.length && loading && !topping) topUp();
    if (!queue.length && !ships.length && !loading && !topping) return finish();

    // ---------- draw: sky, streaks, striped sun ----------
    const sky = g.createLinearGradient(0, 0, 0, G.horizon);
    sky.addColorStop(0, '#10062b');
    sky.addColorStop(0.55, '#4a1b8c');
    sky.addColorStop(1, '#b23fd6');
    g.fillStyle = sky;
    g.fillRect(0, 0, W, G.horizon);
    g.fillStyle = 'rgba(255,255,255,0.75)';
    for (const st of streaks) {
      if (!reducedMotion) st.x = (st.x + st.v * dt) % 1.1;
      g.fillRect(st.x * W - st.w, st.y * H, st.w, 2);
    }
    const R = Math.min(W * 0.16, H * 0.2);
    g.save();
    g.beginPath();
    g.rect(0, 0, W, G.horizon);
    g.clip();
    const sun = g.createLinearGradient(0, G.horizon - R, 0, G.horizon);
    sun.addColorStop(0, '#fff3a8');
    sun.addColorStop(0.5, '#ff9de2');
    sun.addColorStop(1, '#ff4fa3');
    g.fillStyle = sun;
    g.shadowColor = '#ff7ad9';
    g.shadowBlur = 40;
    g.beginPath();
    g.arc(W / 2, G.horizon, R, Math.PI, 0);
    g.fill();
    g.shadowBlur = 0;
    // horizontal cut-outs across the lower half of the sun, thicker towards the horizon
    g.fillStyle = sky;
    for (let i = 0; i < 6; i++) {
      const y = G.horizon - R * 0.5 + i * (R * 0.09) + (reducedMotion ? 0 : ((t * 8) % (R * 0.09)));
      g.fillRect(W / 2 - R, y, R * 2, 1.5 + i * 1.2);
    }
    g.restore();

    // ---------- draw: the neon grid floor ----------
    const floor = g.createLinearGradient(0, G.horizon, 0, H);
    floor.addColorStop(0, '#1a0a3d');
    floor.addColorStop(1, '#05041a');
    g.fillStyle = floor;
    g.fillRect(0, G.horizon, W, H - G.horizon);
    g.strokeStyle = '#a24bff';
    g.lineWidth = 1.5;
    g.shadowColor = '#c77dff';
    g.shadowBlur = 8;
    g.beginPath();
    for (let x = -3; x <= 3.001; x += 0.25) {
      const a = project(x, 1, G);
      const b = project(x, -0.6, G);
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y + (b.y - a.y) * 0.4);
    }
    for (const z of gridRows(reducedMotion ? 0 : scroll)) {
      const y = project(0, z, G).y;
      g.moveTo(0, y);
      g.lineTo(W, y);
    }
    g.stroke();
    g.shadowBlur = 0;
    // horizon glow
    const glow = g.createLinearGradient(0, G.horizon - 6, 0, G.horizon + 18);
    glow.addColorStop(0, 'rgba(255,120,220,0)');
    glow.addColorStop(0.4, 'rgba(255,120,220,0.55)');
    glow.addColorStop(1, 'rgba(255,120,220,0)');
    g.fillStyle = glow;
    g.fillRect(0, G.horizon - 6, W, 24);

    // ---------- draw: ships, far ones first ----------
    for (const s of [...ships].sort((a, b) => b.z - a.z)) drawShip(s, G, t);
    for (const sh of shots) {
      const a = project(sh.x, sh.z, G);
      const b = project(sh.x, Math.max(0, sh.z - 0.06), G);
      g.strokeStyle = WEAPONS[sh.weapon].color;
      g.lineWidth = Math.max(1.5, 5 * a.s);
      g.shadowColor = WEAPONS[sh.weapon].color;
      g.shadowBlur = 12;
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.stroke();
      g.shadowBlur = 0;
    }
    for (const b of bolts) {
      const p = project(b.x, b.z, G);
      g.fillStyle = '#ffffff';
      g.shadowColor = '#ff4d7d';
      g.shadowBlur = 14;
      g.beginPath();
      g.ellipse(p.x, p.y, 10 * p.s + 2, 5 * p.s + 1.5, -0.4, 0, Math.PI * 2);
      g.fill();
      g.shadowBlur = 0;
    }

    // ---------- draw: your ship ----------
    const pp = project(player.x, 0, G);
    const sw = Math.max(34, W * 0.055);
    if (!(player.hurt > 0 && !reducedMotion && Math.floor(t * 14) % 2)) {
      g.shadowColor = '#5bff8f';
      g.shadowBlur = 22;
      g.fillStyle = '#35e07a';
      g.beginPath();
      g.moveTo(pp.x, pp.y - sw * 0.55);
      g.lineTo(pp.x + sw / 2, pp.y + sw * 0.2);
      g.lineTo(pp.x - sw / 2, pp.y + sw * 0.2);
      g.closePath();
      g.fill();
      g.shadowBlur = 0;
      g.fillStyle = '#ffd23f';
      g.fillRect(pp.x - sw / 2, pp.y + sw * 0.2, sw, 3);
      g.fillStyle = '#ff4d7d';
      g.fillRect(pp.x - sw / 2 + 4, pp.y + sw * 0.2 + 3, sw - 8, 3);
      // the barrel glows in the current weapon's colour
      g.fillStyle = WEAPONS[weapon].color;
      g.fillRect(pp.x - 2, pp.y - sw * 0.55 - 6, 4, 8);
    }
    if (!queue.length && !ships.length && (loading || topping)) {
      g.fillStyle = '#fff3a8';
      g.textAlign = 'center';
      g.font = `700 ${Math.max(14, W / 50)}px Silkscreen, monospace`;
      g.fillText(`STILL READING ${loading.toLocaleString()} MORE EMAILS…`, W / 2, H * 0.62);
    }
    fx.draw(g);

    // ---------- draw: in-screen HUD ----------
    g.textAlign = 'left';
    g.font = `700 ${Math.max(14, W / 40)}px Silkscreen, monospace`;
    g.fillStyle = '#fff3a8';
    g.shadowColor = '#ff4fa3';
    g.shadowBlur = 10;
    g.fillText(`SCORE ${score.toLocaleString()}`, 16, 30);
    g.shadowBlur = 0;
    if (combo > 1) {
      g.fillStyle = '#5bff8f';
      g.font = `700 ${Math.max(12, W / 55)}px Silkscreen, monospace`;
      g.fillText(`COMBO ×${combo}`, 16, 52);
    }
    for (let i = 0; i < SHIELDS; i++) {
      g.fillStyle = i < shields ? '#ff4d7d' : 'rgba(255,255,255,0.15)';
      g.fillRect(W - 24 - i * 26, 14, 20, 14);
    }
    g.fillStyle = '#ffd23f';
    for (let i = 0; i < bombs; i++) {
      const bx = W - 34 - i * 18;
      g.beginPath();
      g.moveTo(bx, 36);
      g.lineTo(bx + 6, 42);
      g.lineTo(bx, 48);
      g.lineTo(bx - 6, 42);
      g.fill();
    }

    // ---------- CRT finish: scanlines and hit flash ----------
    g.fillStyle = scanlines;
    g.fillRect(0, 0, W, H);
    if (flash > 0) {
      g.fillStyle = `rgba(255,255,255,${flash * 0.6})`;
      g.fillRect(0, 0, W, H);
    }

    setStats([
      ['Score', score.toLocaleString()],
      ['Senders left', String(queue.length + ships.length)],
      ['Emails handled', `${handled.toLocaleString()} / ${totalMail.toLocaleString()}`],
      ['Shields', `${shields}/${SHIELDS}`],
      ['Escaped', String(escaped)],
      ...(loading ? [['Still reading', loading.toLocaleString()]] : []),
    ]);
  });

  function drawShip(s, G, t) {
    const p = project(s.x, s.z, G);
    const right = project(s.x + s.half, s.z, G);
    const hw = Math.max(6, right.x - p.x);
    const hh = hw * 0.32;
    const hull = s.hit > 0 ? '#ffffff' : HULL[s.group.kind] ?? '#6b6f9e';
    const ring = WEAPONS[s.group.suggestion]?.color ?? '#b7b0d8';
    const bob = reducedMotion ? 0 : Math.sin(t * 3 + s.phase) * 3 * p.s;
    const y = p.y - hh * 1.6 + bob;
    s.y = y - hh * 2; // screen box, used by onScreen() for the smart bomb
    s.h = hh * 3;
    // shadow on the grid
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.beginPath();
    g.ellipse(p.x, p.y, hw * 0.8, hh * 0.35, 0, 0, Math.PI * 2);
    g.fill();
    // saucer: glowing rim in the suggested weapon's colour, hull by sender kind, a dome on top
    g.shadowColor = ring;
    g.shadowBlur = 18 * p.s + 4;
    g.fillStyle = hull;
    g.beginPath();
    g.ellipse(p.x, y, hw, hh, 0, 0, Math.PI * 2);
    g.fill();
    g.shadowBlur = 0;
    g.strokeStyle = ring;
    g.lineWidth = Math.max(1, 3 * p.s);
    g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.75)';
    g.beginPath();
    g.ellipse(p.x, y - hh * 0.5, hw * 0.38, hh * 0.75, 0, Math.PI, 0);
    g.fill();
    // running lights
    for (let i = -2; i <= 2; i++) {
      g.fillStyle = Math.floor(t * 6 + i) % 2 ? ring : '#ffffff';
      g.fillRect(p.x + i * hw * 0.35 - 1.5, y + hh * 0.2, 3, 3);
    }
    if (s.shield) {
      g.strokeStyle = 'rgba(255,210,63,0.85)';
      g.lineWidth = Math.max(1.5, 3 * p.s);
      g.beginPath();
      g.ellipse(p.x, y, hw * 1.25, hh * 2.1, 0, 0, Math.PI * 2);
      g.stroke();
    }
    // label once the ship is close enough to read
    if (p.s > 0.22) {
      const label = `${truncate(s.group.label, 22)} ×${s.group.count}`;
      g.font = `600 ${Math.round(10 + 3 * p.s)}px "IBM Plex Mono", monospace`;
      const lw = g.measureText(label).width + 12;
      roundRect(g, p.x - lw / 2, y - hh * 2.2 - 18, lw, 18, 4);
      g.fillStyle = 'rgba(16,6,43,0.85)';
      g.fill();
      g.strokeStyle = ring;
      g.lineWidth = 1;
      g.stroke();
      g.fillStyle = '#ffffff';
      g.textAlign = 'center';
      g.fillText(label, p.x, y - hh * 2.2 - 5);
    }
  }

  function scanlinePattern() {
    const tile = document.createElement('canvas');
    tile.width = 4;
    tile.height = 3;
    const c = tile.getContext('2d');
    c.fillStyle = 'rgba(0,0,0,0.22)';
    c.fillRect(0, 2, 4, 1);
    return g.createPattern(tile, 'repeat');
  }

  return () => {
    over = true;
    stopLoop();
    kb?.destroy();
    sound.close();
    destroyCanvas();
  };
}
