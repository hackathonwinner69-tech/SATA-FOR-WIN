// Receipt Rush: turn-based encounters in the style of Undertale, with original
// art. Every merchant is a monster grown from its name. On your turn pick
// FILE (choose a category), CHECK (look closer), FLAG (mark for review) or
// SPARE (let it go for now). Your choice is the real action. Then the merchant
// attacks and you dodge its pattern inside the box with your coin.
import { Fx, intro, keyboard, loop, makeCanvas, reducedMotion, results, truncate } from './kit.js';
import { attackLength, checkText, flavour, hits, monsterFor, patternFor, spawnBullets } from './encounter.js';
import { fmt } from '../js/api.js';

const VW = 320;
const VH = 240;
const MAX_HP = 20;
const BUTTONS = [
  { id: 'file', label: 'FILE', color: '#17a673' },
  { id: 'check', label: 'CHECK', color: '#4f7cf0' },
  { id: 'flag', label: 'FLAG', color: '#e8462b' },
  { id: 'spare', label: 'SPARE', color: '#f2b632' },
];
const TEXT_BOX = { x: 16, y: 124, w: 288, h: 62 };
const FIGHT_BOX = { x: 105, y: 112, w: 110, h: 80 };
const lerp = (a, b, t) => a + (b - a) * t;

export default async function play(ctx) {
  const { root, chore, act, setStats, exit, announce } = ctx;
  const { canvas, ctx: g, view, destroy: destroyCanvas } = makeCanvas(root);
  const fx = new Fx();
  let stopLoop = () => {};
  let kb = null;

  setStats([['Scanning', 'transactions…']]);
  const scan = await ctx.scan();
  const queue = [...scan.groups];
  setStats([]);
  const cats = chore.actions.filter((a) => a.id.startsWith('cat:'));
  const colorOf = Object.fromEntries(chore.actions.map((a) => [a.id, a.color]));

  if (!queue.length) {
    results(root, { title: 'ALL FILED', lines: ['Every transaction in this export already has a category.'], stats: [], onExit: exit });
    return () => destroyCanvas();
  }

  await intro(root, {
    title: 'RECEIPT RUSH',
    story: `${scan.stats.open} unfiled transactions from ${queue.length} merchants block your path, one encounter at a time. On your turn, FILE puts every charge from that merchant under a category, FLAG marks it for review, CHECK looks closer, SPARE lets it go for now. What you choose really happens: the categorised CSV, the report and next month's rules rewrite themselves. Then the merchant strikes back, so dodge with your coin. Run out of budget and the day ends, but everything you filed stays filed.`,
    keys: [
      ['← → ↑ ↓', 'choose, and move your coin when dodging'],
      ['Z / Enter', 'confirm (or click)'],
      ['X / Backspace', 'back'],
    ],
    start: 'BEGIN',
  });

  let enemy = null; // { group, art, color, done }
  let phase = 'text'; // text | menu | pick | dodge
  let text = '';
  let shown = 0;
  let afterText = 'menu';
  let menuIndex = 0;
  let pickIndex = 0;
  let boxT = 0; // 0 = text box, 1 = fight box
  let dodge = null; // { time, pattern, state, hit, thenNext }
  let bullets = [];
  const soul = { x: 160, y: 152, r: 3.5, inv: 0 };
  let hp = MAX_HP;
  let score = 0;
  let streak = 0;
  let filed = 0;
  let spared = 0;
  let over = false;
  let hurtFlash = 0;

  function say(line, then = 'menu') {
    text = line;
    shown = 0;
    afterText = then;
    phase = 'text';
    announce(line.replace(/^\* /, ''));
  }

  function nextEnemy() {
    if (!queue.length) return finish('ALL CLEAR');
    const group = queue.shift();
    enemy = { group, art: monsterFor(group.label), color: colorOf[group.suggestion] ?? '#c9bfae' };
    menuIndex = 0;
    const sug = cats.findIndex((c) => c.id === group.suggestion);
    pickIndex = sug >= 0 ? sug : 0;
    say(flavour(group));
  }

  function startDodge(thenNext) {
    phase = 'dodge';
    bullets = [];
    soul.x = FIGHT_BOX.x + FIGHT_BOX.w / 2;
    soul.y = FIGHT_BOX.y + FIGHT_BOX.h / 2;
    dodge = { time: attackLength(enemy.group), pattern: patternFor(enemy.group), state: {}, hit: false, thenNext };
  }

  /** Merchants not dealt with yet: the queue, plus the one in front of you unless you already filed or spared it. */
  const merchantsLeft = () => queue.length + (enemy && !enemy.done ? 1 : 0);

  function resolve(action) {
    const { group } = enemy;
    enemy.done = true;
    const wise = action === group.suggestion;
    act(group.id, action).catch(() => {});
    filed += group.count;
    streak = wise ? streak + 1 : 0;
    score += Math.round((100 + group.count * 5) * (wise ? 2 : 1) * (1 + Math.min(streak, 10) * 0.1));
    const what = action === 'flag' ? 'flagged for review' : `filed under ${action.slice(4)}`;
    fx.burst(160, 60, colorOf[action] ?? '#f2b632', 30, 90);
    say(`* ${group.label} was ${what}. ${group.count} charge${group.count === 1 ? '' : 's'} sorted. It strikes back as it leaves!`, 'dodge-next');
  }

  function choose() {
    if (phase === 'menu') {
      const b = BUTTONS[menuIndex].id;
      if (b === 'file') phase = 'pick';
      if (b === 'check') say(checkText(enemy.group), 'dodge-menu');
      if (b === 'flag') resolve('flag');
      if (b === 'spare') {
        queue.push(enemy.group);
        enemy.done = true;
        spared++;
        streak = 0;
        say(`* You spared ${enemy.group.label}. It will be back later.`, 'next');
      }
    } else if (phase === 'pick') {
      if (pickIndex === cats.length) phase = 'menu';
      else resolve(cats[pickIndex].id);
    } else if (phase === 'text') {
      if (shown < text.length) shown = text.length;
      else if (afterText === 'menu') phase = 'menu';
      else if (afterText === 'next') nextEnemy();
      else if (afterText === 'dodge-next') startDodge(true);
      else if (afterText === 'dodge-menu') startDodge(false);
    }
  }

  kb = keyboard((e) => {
    if (over) return;
    const k = e.key;
    if (k === 'z' || k === 'Z' || k === 'Enter' || k === ' ') return choose();
    if ((k === 'x' || k === 'X' || k === 'Backspace') && phase === 'pick') {
      phase = 'menu';
      return;
    }
    if (phase === 'menu') {
      if (k === 'ArrowRight') menuIndex = (menuIndex + 1) % BUTTONS.length;
      if (k === 'ArrowLeft') menuIndex = (menuIndex + BUTTONS.length - 1) % BUTTONS.length;
    } else if (phase === 'pick') {
      const n = cats.length + 1; // categories plus Back
      if (k === 'ArrowDown') pickIndex = (pickIndex + 1) % n;
      if (k === 'ArrowUp') pickIndex = (pickIndex + n - 1) % n;
      if (k === 'ArrowRight') pickIndex = Math.min(n - 1, pickIndex + 5);
      if (k === 'ArrowLeft') pickIndex = Math.max(0, pickIndex - 5);
    }
  });

  // Mouse and touch: tap buttons and menu entries.
  canvas.addEventListener('pointerdown', (e) => {
    const scale = Math.min(view.w / VW, view.h / VH);
    const x = (e.offsetX - (view.w - VW * scale) / 2) / scale;
    const y = (e.offsetY - (view.h - VH * scale) / 2) / scale;
    if (phase === 'menu' && y > 210) {
      const i = Math.floor((x - 16) / 72);
      if (i >= 0 && i < BUTTONS.length) {
        menuIndex = i;
        choose();
      }
    } else if (phase === 'pick' && y > TEXT_BOX.y && y < TEXT_BOX.y + TEXT_BOX.h) {
      const col = x > 160 ? 1 : 0;
      const row = Math.floor((y - TEXT_BOX.y - 6) / 10);
      const i = col * 5 + row;
      if (row >= 0 && row < 5 && i <= cats.length) {
        pickIndex = i;
        choose();
      }
    } else if (phase === 'text') choose();
  });

  function finish(title) {
    if (over) return;
    over = true;
    stopLoop();
    const left = merchantsLeft();
    results(root, {
      title,
      lines: [
        `Your categorised CSV, expense-report.md and merchant-rules.json are next to ${chore.target.split(/[/\\]/).pop()}.`,
        left ? `${left} merchant${left === 1 ? ' is' : 's are'} still waiting. Everything you filed stays filed.` : 'Every merchant has been dealt with.',
      ],
      stats: [
        [score.toLocaleString(), 'score'],
        [filed.toLocaleString(), 'transactions sorted'],
        [String(spared), 'spared'],
        [`${Math.max(0, hp)}/${MAX_HP}`, 'budget left'],
      ],
      onExit: exit,
    });
  }

  function wrap(str, width) {
    const words = str.split(' ');
    const lines = [];
    let line = '';
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (g.measureText(next).width > width && line) {
        lines.push(line);
        line = w;
      } else line = next;
    }
    if (line) lines.push(line);
    return lines.slice(0, 4);
  }

  nextEnemy();
  stopLoop = loop((dt, t) => {
    if (over) return;
    shown = Math.min(text.length, shown + dt * 45);
    boxT += ((phase === 'dodge' ? 1 : 0) - boxT) * Math.min(1, dt * 10);
    soul.inv = Math.max(0, soul.inv - dt);
    hurtFlash = Math.max(0, hurtFlash - dt);
    const box = {
      x: lerp(TEXT_BOX.x, FIGHT_BOX.x, boxT),
      y: lerp(TEXT_BOX.y, FIGHT_BOX.y, boxT),
      w: lerp(TEXT_BOX.w, FIGHT_BOX.w, boxT),
      h: lerp(TEXT_BOX.h, FIGHT_BOX.h, boxT),
    };

    if (phase === 'dodge') {
      const k = kb.down;
      const dx = (k.has('ArrowRight') || k.has('d') ? 1 : 0) - (k.has('ArrowLeft') || k.has('a') ? 1 : 0);
      const dy = (k.has('ArrowDown') || k.has('s') ? 1 : 0) - (k.has('ArrowUp') || k.has('w') ? 1 : 0);
      const n = Math.hypot(dx, dy) || 1;
      soul.x = Math.max(box.x + 5, Math.min(box.x + box.w - 5, soul.x + (dx / n) * 110 * dt));
      soul.y = Math.max(box.y + 5, Math.min(box.y + box.h - 5, soul.y + (dy / n) * 110 * dt));
      if (boxT > 0.9) bullets.push(...spawnBullets(dodge.pattern, dodge.state, dt, FIGHT_BOX));
      for (const b of bullets) {
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        if (soul.inv <= 0 && hits(soul, b)) {
          hp -= b.r > 6 ? 4 : 2;
          soul.inv = 1;
          hurtFlash = 0.25;
          dodge.hit = true;
          streak = 0;
          b.dead = true;
          if (hp <= 0) return finish('YOU WENT BROKE');
        }
      }
      const margin = 30;
      bullets = bullets.filter((b) => !b.dead && b.x > FIGHT_BOX.x - margin && b.x < FIGHT_BOX.x + FIGHT_BOX.w + margin && b.y > FIGHT_BOX.y - margin && b.y < FIGHT_BOX.y + FIGHT_BOX.h + margin);
      dodge.time -= dt;
      if (dodge.time <= 0) {
        bullets = [];
        if (!dodge.hit) {
          score += 150;
          fx.float(160, 100, 'FLAWLESS +150', '#f2b632', 10);
        }
        if (dodge.thenNext) nextEnemy();
        else say(`* ${enemy.group.label} is waiting for your decision.`, 'menu');
      }
    }
    fx.step(dt);

    // ---------- draw ----------
    const W = view.w;
    const H = view.h;
    const scale = Math.min(W / VW, H / VH);
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    g.save();
    g.translate((W - VW * scale) / 2, (H - VH * scale) / 2);
    g.scale(scale, scale);

    // the merchant: name, total and its monster
    if (enemy) {
      const { group, art } = enemy;
      g.textAlign = 'center';
      g.fillStyle = '#fffdf8';
      g.font = '700 11px Silkscreen, monospace';
      g.fillText(truncate(group.label, 28), VW / 2, 16);
      g.font = '600 9px "IBM Plex Mono", monospace';
      g.fillStyle = group.total < 0 ? '#ff8a73' : '#7be0b0';
      g.fillText(`${fmt.money(group.total)} · ${group.count} charge${group.count === 1 ? '' : 's'}`, VW / 2, 28);
      const px = 5;
      const bob = reducedMotion ? 0 : Math.sin(t * 2) * 2;
      const mx = VW / 2 - (art[0].length * px) / 2 + (phase === 'dodge' && !reducedMotion ? Math.sin(t * 9) * 2 : 0);
      const my = 40 + bob;
      art.forEach((row, ry) => {
        [...row].forEach((c, rx) => {
          if (c === '.') return;
          g.fillStyle = c === 'e' ? '#fffdf8' : c === 'm' ? '#1d1b16' : enemy.color;
          g.fillRect(mx + rx * px, my + ry * px, px, px);
          if (c === 'e') {
            g.fillStyle = '#1d1b16';
            g.fillRect(mx + rx * px + 2, my + ry * px + 1, 2, 3);
          }
        });
      });
    }

    // the box: text and menus, or the bullet board
    g.fillStyle = '#000';
    g.fillRect(box.x, box.y, box.w, box.h);
    g.strokeStyle = hurtFlash > 0 ? '#e8462b' : '#fffdf8';
    g.lineWidth = 3;
    g.strokeRect(box.x, box.y, box.w, box.h);
    g.textAlign = 'left';
    g.fillStyle = '#fffdf8';
    g.font = '600 10px "IBM Plex Mono", monospace';
    if (phase === 'text' && boxT < 0.1) {
      wrap(text.slice(0, Math.floor(shown)), TEXT_BOX.w - 20).forEach((line, i) => g.fillText(line, TEXT_BOX.x + 10, TEXT_BOX.y + 16 + i * 13));
      if (shown >= text.length && Math.floor(t * 3) % 2) g.fillText('▼', TEXT_BOX.x + TEXT_BOX.w - 16, TEXT_BOX.y + TEXT_BOX.h - 8);
    } else if (phase === 'menu') {
      wrap(`* What will you do about ${enemy.group.label}?`, TEXT_BOX.w - 20).forEach((line, i) => g.fillText(line, TEXT_BOX.x + 10, TEXT_BOX.y + 16 + i * 13));
    } else if (phase === 'pick') {
      g.font = '600 9px "IBM Plex Mono", monospace';
      [...cats.map((c) => c.label), '← Back'].forEach((label, i) => {
        const x = TEXT_BOX.x + 18 + Math.floor(i / 5) * 144;
        const y = TEXT_BOX.y + 13 + (i % 5) * 10;
        const sel = i === pickIndex;
        const sug = cats[i]?.id === enemy.group.suggestion;
        g.fillStyle = sel ? '#f2b632' : sug ? '#7be0b0' : '#fffdf8';
        g.fillText(`${sel ? '◆ ' : '  '}${label}${sug ? (enemy.group.aiSuggested ? ' ★ Claude' : ' ★') : ''}`, x, y);
      });
    }
    if (phase === 'dodge' && boxT > 0.5) {
      g.save();
      g.beginPath();
      g.rect(box.x + 1.5, box.y + 1.5, box.w - 3, box.h - 3);
      g.clip();
      g.textAlign = 'center';
      for (const b of bullets) {
        g.fillStyle = b.r > 6 ? '#e8462b' : '#fffdf8';
        g.font = `700 ${Math.round(b.r * 2.6)}px "IBM Plex Mono", monospace`;
        g.fillText(b.glyph, b.x, b.y + b.r);
      }
      g.restore();
      // your coin
      if (!(soul.inv > 0 && !reducedMotion && Math.floor(t * 16) % 2)) {
        g.fillStyle = '#f2b632';
        g.beginPath();
        g.arc(soul.x, soul.y, soul.r + 1, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#b78a10';
        g.fillRect(soul.x - 0.5, soul.y - 2.5, 1, 5);
      }
    }

    // budget (HP) and the four buttons
    g.textAlign = 'left';
    g.font = '700 9px Silkscreen, monospace';
    g.fillStyle = '#fffdf8';
    g.fillText('BUDGET', 16, 204);
    g.fillStyle = '#c7361d';
    g.fillRect(64, 196, MAX_HP * 3, 9);
    g.fillStyle = '#f2b632';
    g.fillRect(64, 196, Math.max(0, hp) * 3, 9);
    g.fillStyle = '#fffdf8';
    g.font = '600 9px "IBM Plex Mono", monospace';
    g.fillText(`${Math.max(0, hp)} / ${MAX_HP}`, 132, 204);
    BUTTONS.forEach((b, i) => {
      const x = 16 + i * 72;
      const sel = phase === 'menu' && i === menuIndex;
      g.strokeStyle = sel ? '#f2b632' : b.color;
      g.lineWidth = 2;
      g.strokeRect(x, 212, 66, 22);
      g.fillStyle = sel ? '#f2b632' : b.color;
      g.font = '700 10px Silkscreen, monospace';
      g.textAlign = 'center';
      g.fillText(b.label, x + 36, 227);
      if (sel) {
        g.beginPath();
        g.arc(x + 9, 223, 3.5, 0, Math.PI * 2);
        g.fill();
      }
    });
    fx.draw(g);
    g.restore();

    setStats([
      ['Score', score.toLocaleString()],
      ['Streak', streak > 1 ? `×${streak}` : '-'],
      ['Merchants left', String(merchantsLeft())],
      ['Sorted', `${filed} / ${scan.stats.open}`],
      ['Budget', `${Math.max(0, hp)}/${MAX_HP}`],
    ]);
  });

  return () => {
    over = true;
    stopLoop();
    kb?.destroy();
    destroyCanvas();
  };
}
