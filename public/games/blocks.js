// Budget Blocks. Every merchant falls as a block into a well with one column
// per category. Where it lands is where its charges are filed, for real, and
// the columns grow into a live chart of the money in each category. Red blocks
// (possible duplicate or large charges) are flagged for review instead.
import { Fx, actionBar, intro, keyboard, loop, makeCanvas, reducedMotion, results, roundRect, truncate } from './kit.js';
import { MAX_HEARTS, PAYDAY_FOR, ROWS, SLOW_FOR, Well, fallSpeed, powerAt, shortMoney } from './well.js';
import { fmt } from '../js/api.js';

const BG = '#15141b';
const WELL_BG = '#1b1a23';
const PANEL = '#1f1d27';
const LINE = '#2c2a36';
const DIM = '#8a8496';
const PAPER = '#f4f1ea';
const INK = '#1d1b16';
const RED = '#e8462b';
const GOLD = '#f2b632';
const STONE = '#c9bfae';
const LOSS = '#ff8a73';
const GAIN = '#7be0b0';
const PIXEL = 'Silkscreen, monospace';
const MONO = '"IBM Plex Mono", ui-monospace, Consolas, monospace';
/** Names for columns too narrow for the whole category. */
const SHORT = { Transport: 'Trans', Shopping: 'Shop', Subscriptions: 'Subs', Entertainment: 'Fun', Business: 'Biz' };
const POWER = {
  slow: { name: 'SLOW-MO', badge: 'SLOW', color: '#22d3ee' },
  auto: { name: 'AUTOPILOT', badge: 'AUTO', color: '#a5b4fc' },
  piggy: { name: 'PIGGY BANK', badge: '+♥', color: '#f9a8d4' },
  payday: { name: 'PAYDAY', badge: '×2', color: '#facc15' },
};
const OUTCOME = {
  smart: ['SMART ★', GOLD],
  override: ['FILED', PAPER],
  placed: ['FILED', PAPER],
  caught: ['CAUGHT IT!', GOLD],
  flagged: ['FLAGGED', STONE],
  audit: ['AUDIT! −♥', RED],
};
const HEART = ['.##.##.', '#######', '#######', '.#####.', '..###..', '...#...'];
const REPEAT_AFTER = 0.17;
const REPEAT_EVERY = 0.055;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
const money = (total) => (total > 0 ? `+${shortMoney(total)}` : shortMoney(-total));
const warning = (flag) => /duplicate|large/.test(flag);

/** Ink or paper, whichever has more contrast on `hex`. */
function inkOn(hex) {
  const [r, gr, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const lum = 0.2126 * r + 0.7152 * gr + 0.0722 * b;
  return (lum + 0.05) / 0.061 >= 1.05 / (lum + 0.05) ? INK : '#fffdf8';
}

export default async function play(ctx) {
  const { root, chore, act, announce, setStats, toast, exit } = ctx;
  const columns = chore.actions.filter((a) => a.id.startsWith('cat:')).map((a) => ({ ...a, ink: inkOn(a.color) }));
  const { canvas, ctx: g, view, destroy: destroyCanvas } = makeCanvas(root);
  canvas.style.touchAction = 'none';
  const fx = new Fx();
  const fits = new Map();
  let stopLoop = null;
  let kb = null;
  let bar = null;
  let disposed = false;

  let scan = null;
  let well = null;
  let ended = false;
  let closing = null; // shown over the well while the last moves land
  let paused = false;
  let shown = []; // bar heights as drawn, easing towards the real ones
  let bumps = [];
  let refused = [];
  let blockX = 0; // the falling block's column as drawn
  let shake = 0;
  let hurt = 0;
  let repeat = null; // a held arrow key: { key, dir, t }
  let drag = null;
  let lastLand = { x: 0, y: 0 };
  let statsKey = '';
  let barKey = '';

  const live = () => Boolean(well && !ended && !paused);

  async function round(first, ready = null) {
    setStats([['Scanning', 'transactions…']]);
    statsKey = '';
    scan = ready ?? (await ctx.scan());
    if (disposed) return;
    setStats([]);
    if (!scan.groups.length) {
      well = null;
      results(root, { title: 'ALL FILED', lines: ['Every transaction in this export already has a category.'], stats: [], onExit: exit });
      return;
    }
    if (first) {
      await intro(root, {
        title: 'BUDGET BLOCKS',
        story: `${plural(scan.stats.open, 'unfiled transaction')} from ${plural(scan.groups.length, 'merchant')} are falling into your budget. Steer each merchant into a category column: where it lands is where its charges are really filed, and the columns grow into a live chart of your spending. The glowing column is ChoreCade's guess and scores double. Red blocks are possible duplicates or large charges: flag them. A block you never steer files nothing, comes back later and costs a heart.`,
        keys: [
          ['← →', 'steer, or tap a column'],
          ['1-0', 'jump straight to a column'],
          ['↓', 'fall faster'],
          ['Space', 'drop and file it now, or tap its column again'],
          ['F', 'flag a red block for review'],
          ['H', 'hold one merchant for later'],
          ['S A', 'slow-mo and autopilot, once you have them'],
          ['P', 'pause'],
        ],
      });
      if (disposed) return;
    }
    const filed = Object.fromEntries(Object.entries(scan.stats.filed ?? {}).map(([k, v]) => [`cat:${k}`, v]));
    well = new Well(scan.groups, { columns, filed });
    shown = columns.map(() => 0);
    bumps = columns.map(() => 0);
    refused = columns.map(() => 0);
    blockX = well.block?.col ?? 0;
    ended = false;
    closing = null;
    paused = false;
    barKey = '';
    if (!stopLoop) start();
  }

  function start() {
    bar = actionBar(
      root,
      [
        { id: 'flag', label: 'Flag for review', short: 'Flag', key: 'F', color: RED },
        { id: 'hold', label: 'Hold', key: 'H', color: '#38bdf8' },
        { id: 'slow', label: 'Slow-mo', short: 'Slow', key: 'S', color: POWER.slow.color },
        { id: 'auto', label: 'Autopilot', short: 'Auto', key: 'A', color: POWER.auto.color },
      ],
      command,
    );
    // A clicked button keeps no focus, so Space and Enter go on playing the game instead of pressing it again.
    bar.el.addEventListener('mousedown', (e) => e.preventDefault());
    kb = keyboard(onKey);
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', () => (drag = null));
    stopLoop = loop(frame);
  }

  // ---------- input ----------
  function onKey(e) {
    if (e.target.closest?.('.overlay')) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k === 'p') return togglePause();
    if (!live()) return;
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      const dir = k === 'ArrowLeft' ? -1 : 1;
      steer(dir);
      repeat = { key: e.key, dir, t: 0 };
    } else if (k === ' ') command('drop');
    else if (k === 'f') command('flag');
    else if (k === 'h' || k === 'c' || k === 'Shift') command('hold');
    else if (k === 's') command('slow');
    else if (k === 'a') command('auto');
    else {
      const i = columns.findIndex((c) => c.key === e.key);
      if (i >= 0) jumpTo(i);
    }
  }

  function togglePause() {
    if (!well || ended) return;
    paused = !paused;
    repeat = null;
    announce(paused ? 'Paused. Press P to play on.' : 'Playing.');
  }

  function refuse(i) {
    if (i >= 0 && i < columns.length) refused[i] = 0.35;
  }

  function steer(dx) {
    const b = well.block;
    if (b && !well.move(dx)) refuse(b.col + dx);
  }

  function jumpTo(i) {
    if (well.block && !well.jump(i)) refuse(i);
  }

  function nudge(text) {
    const L = layout();
    fx.float(L.x + L.ww / 2, L.y + L.wh * 0.25, text, STONE, L.wide ? 13 : 11);
  }

  function command(id) {
    if (!live() || !well.block) return;
    if (id === 'drop') well.drop();
    else if (id === 'flag') well.flag();
    else if (id === 'hold' && !well.hold()) nudge(well.swapped ? 'ONE SWAP PER BLOCK' : 'NOTHING TO SWAP WITH');
    else if (id === 'slow' && !well.useSlow()) nudge(well.slow > 0 ? 'ALREADY IN SLOW-MO' : 'NO SLOW-MO YET: FILE A SLOW BLOCK');
    else if (id === 'auto' && !well.autopilot()) nudge(well.powers.auto ? 'NO GUESS FOR THIS ONE' : 'NO AUTOPILOT YET: FILE AN AUTO BLOCK');
  }

  function columnAt(L, x) {
    const i = Math.floor((x - L.x) / L.cw);
    return i >= 0 && i < L.n ? i : -1;
  }

  function onDown(e) {
    if (!live() || !well.block) return;
    const L = layout();
    const col = columnAt(L, e.offsetX);
    if (col < 0 || e.offsetY < L.y - 8 || e.offsetY > L.y + L.wh + L.names) return;
    drag = { id: e.pointerId, y: e.offsetY, block: well.block, from: well.block.col, col };
    canvas.setPointerCapture?.(e.pointerId);
    if (col !== well.block.col) jumpTo(col);
  }

  function onMove(e) {
    if (!drag || e.pointerId !== drag.id || !live() || well.block !== drag.block) return;
    const col = columnAt(layout(), e.offsetX);
    if (col < 0 || col === drag.col) return;
    drag.col = col;
    jumpTo(col);
  }

  function onUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (!live() || well.block !== d.block) return;
    // A swipe down drops the block; so does tapping the column it is already over.
    if (e.offsetY - d.y > 40 || (d.col === d.from && well.block.col === d.from)) command('drop');
  }

  // ---------- the round ----------
  function frame(dt, t) {
    if (live()) {
      if (repeat) {
        if (!kb.down.has(repeat.key)) repeat = null;
        else if ((repeat.t += dt) >= REPEAT_AFTER) {
          repeat.t -= REPEAT_EVERY;
          steer(repeat.dir);
        }
      }
      well.step(dt, { soft: kb.down.has('ArrowDown') });
      for (const e of well.drain()) onEvent(e);
    }
    if (well) {
      const ease = reducedMotion ? 1 : Math.min(1, dt * 12);
      shown = well.heights().map((h, i) => shown[i] + (h - shown[i]) * ease);
      if (well.block) blockX += (well.block.col - blockX) * (reducedMotion ? 1 : Math.min(1, dt * 30));
    }
    bumps = bumps.map((v) => Math.max(0, v - dt * 5));
    refused = refused.map((v) => Math.max(0, v - dt));
    shake = Math.max(0, shake - dt);
    hurt = Math.max(0, hurt - dt);
    fx.step(dt);
    draw(t);
    if (well) hud();
  }

  function onEvent(e) {
    const L = layout();
    const mid = (col) => L.x + (col + 0.5) * L.cw;
    const size = L.wide ? 15 : 12;
    if (e.type === 'spawn') {
      blockX = e.block.col;
      announceBlock(e.block);
    } else if (e.type === 'land' || e.type === 'flag') {
      const x = mid(e.col);
      const y = L.y + (e.y + 1) * L.ch;
      const [label, color] = OUTCOME[e.outcome];
      if (e.type === 'land') {
        bumps[e.col] = 1;
        fx.burst(x, y, columns[e.col].color, 26, 200);
      } else fx.burst(x, y - L.ch / 2, e.outcome === 'caught' ? GOLD : STONE, 22, 160);
      lastLand = { x: clamp(x, L.x + 80, L.x + L.ww - 80), y: y - 22 };
      fx.float(lastLand.x, lastLand.y, e.points ? `${label} +${e.points}` : label, color, size);
      file(e.group, e.action);
    } else if (e.type === 'miss') {
      fx.float(clamp(mid(e.col), L.x + 110, L.x + L.ww - 110), L.y + L.wh * 0.55, 'NOT STEERED: NOTHING FILED', STONE, size - 1);
    } else if (e.type === 'hurt') {
      hurt = 0.45;
      shake = reducedMotion ? 0 : 0.3;
    } else if (e.type === 'power') {
      const p = POWER[e.power];
      fx.float(lastLand.x, lastLand.y - 24, e.bonus ? `${p.name} +${e.bonus}` : `${p.name}!`, p.color, size);
    } else if (e.type === 'slow') {
      fx.float(L.x + L.ww / 2, L.y + L.wh * 0.3, 'SLOW-MO', POWER.slow.color, size + 4);
    } else if (e.type === 'level') {
      fx.float(L.x + L.ww / 2, L.y + L.wh * 0.35, `LEVEL ${e.level} · FASTER`, GOLD, L.wide ? 22 : 15);
    } else if (e.type === 'over') finish(e.reason);
  }

  function announceBlock(b) {
    const gr = b.group;
    const c = columns.find((x) => x.id === gr.suggestion);
    const hint = gr.risk === 'high' ? `Red flag, ${gr.flags.filter(warning).join(' and ') || 'check it'}: press F.` : c ? `Suggested: ${c.label}, key ${c.key}.` : 'No suggestion.';
    announce(`${gr.label}: ${plural(gr.count, 'charge')}, ${fmt.money(gr.total)}. ${hint}`);
  }

  /** The real move. The game has already filed it on the chart; a failure takes it back. */
  function file(group, action) {
    const mine = well;
    act(group.id, action).then(
      (job) => ctx.landed(job).then((end) => end.status === 'failed' && takeBack(mine, group, true)),
      // 409: the server no longer has this merchant as it was, so only a fresh scan can bring it back.
      (err) => takeBack(mine, group, err.status !== 409),
    );
  }

  function takeBack(mine, group, again) {
    if (disposed || mine !== well || !well.unfile(group.id, again)) return;
    const L = layout();
    const name = truncate(group.label, 16);
    fx.float(L.x + L.ww / 2, L.y + 40, again ? `${name} DID NOT SAVE: IT COMES BACK` : `${name} CHANGED: SCAN AGAIN LATER`, RED, L.wide ? 13 : 11);
  }

  async function finish(reason) {
    ended = true;
    repeat = null;
    drag = null;
    const mine = well;
    closing = 'FILING THE LAST FEW…';
    await ctx.settled(10_000);
    if (disposed || mine !== well) return;
    let after = null;
    try {
      after = await ctx.scan();
    } catch (err) {
      toast(`Could not count what is left: ${err.message}`, true);
    }
    if (disposed || mine !== well) return;
    closing = null;
    const open = after?.stats.open ?? null;
    const spend = well.columns
      .filter((c) => c.total < 0)
      .sort((a, b) => a.total - b.total)
      .slice(0, 3);
    results(root, {
      title: reason === 'clear' ? 'BUDGET BALANCED' : 'OUT OF HEARTS',
      lines: [
        reason === 'clear' ? 'Every merchant is filed or flagged.' : 'Your hearts ran out, but everything you filed stays filed.',
        spend.length ? `Biggest spending so far: ${spend.map((c) => `${c.label} ${shortMoney(-c.total)}`).join(', ')}.` : '',
        `Your categorised CSV, expense-report.md and merchant-rules.json are next to ${chore.target.split(/[/\\]/).pop()}.`,
        open === null ? '' : open ? `${plural(open, 'transaction')} still to file.` : 'Every transaction in the export is filed.',
      ].filter(Boolean),
      stats: [
        [well.score.toLocaleString(), 'score'],
        [well.sorted.toLocaleString(), 'transactions sorted'],
        [String(well.flagged.length), 'flagged for review'],
        [well.best > 1 ? `×${well.best}` : '-', 'best combo'],
      ],
      onAgain: open ? () => round(false, after).catch(failed) : undefined,
      onExit: exit,
    });
  }

  function failed(err) {
    results(root, { title: 'COULD NOT SCAN', lines: [err.message], stats: [], onExit: exit });
  }

  function hud() {
    const items = [
      ['Score', well.score.toLocaleString()],
      ['Combo', well.combo > 1 ? `×${well.combo}` : '-'],
      ['Level', String(well.level)],
      ['Hearts', String(Math.max(0, well.hearts))],
      ['Merchants left', String(well.left)],
      ['Sorted', `${well.sorted.toLocaleString()} / ${scan.stats.open.toLocaleString()}`],
    ];
    const key = items.flat().join('|');
    if (key !== statsKey) {
      statsKey = key;
      setStats(items);
    }
    const powers = `${well.powers.slow}|${well.powers.auto}`;
    if (powers === barKey) return;
    barKey = powers;
    relabel('slow', 'S', `Slow-mo ×${well.powers.slow}`, `Slow ${well.powers.slow}`);
    relabel('auto', 'A', `Autopilot ×${well.powers.auto}`, `Auto ${well.powers.auto}`);
  }

  function relabel(id, key, long, short) {
    const button = bar.el.querySelector(`[data-id="${id}"]`);
    button.querySelector('.lbl').textContent = long;
    button.querySelector('.short').textContent = short;
    button.setAttribute('aria-label', `${long} (key ${key})`);
  }

  // ---------- drawing ----------
  function layout() {
    const { w: W, h: H } = view;
    const n = columns.length;
    const wide = W >= 820 && W >= H * 1.1;
    const side = wide ? clamp(W * 0.18, 170, 250) : 0;
    const head = wide ? 24 : 86;
    const foot = 64;
    const cw = Math.max(16, Math.floor(Math.min(96, (W - 2 * side - (wide ? 64 : 16)) / n)));
    const font = cw >= 60 ? 11 : 9;
    const names = font * 2 + 20;
    const ch = Math.max(12, Math.floor(Math.min((H - head - foot - names) / ROWS, cw * 1.25, 60)));
    const ww = cw * n;
    const wh = ch * ROWS;
    const spare = Math.max(0, H - head - foot - names - wh);
    return { W, H, n, wide, cw, ch, ww, wh, font, names, x: Math.round((W - ww) / 2), y: Math.round(head + spare / 2) };
  }

  /** `text` cut with an ellipsis to fit `max` pixels in the current font. */
  function fit(text, max) {
    const key = `${g.font}|${max}|${text}`;
    let out = fits.get(key);
    if (out === undefined) {
      out = text;
      let n = Array.from(text).length;
      while (n > 2 && g.measureText(out).width > max) out = truncate(text, --n);
      if (fits.size > 2000) fits.clear();
      fits.set(key, out);
    }
    return out;
  }

  function wrap(text, max, lines) {
    const words = text.split(/\s+/).filter(Boolean);
    const out = [];
    while (words.length && out.length < lines) {
      let line = words.shift();
      while (words.length && g.measureText(`${line} ${words[0]}`).width <= max) line += ` ${words.shift()}`;
      out.push(line);
    }
    if (words.length) out[out.length - 1] += ` ${words.join(' ')}`;
    return out.map((l) => fit(l, max));
  }

  function draw(t) {
    const L = layout();
    g.save();
    if (shake > 0) g.translate((Math.random() - 0.5) * 12 * shake, (Math.random() - 0.5) * 12 * shake);
    g.fillStyle = BG;
    g.fillRect(-20, -20, L.W + 40, L.H + 40);
    if (well) {
      drawWell(L, t);
      if (L.wide) {
        drawTicketSide(L, t);
        drawStatusSide(L, t);
      } else drawStrip(L);
    }
    fx.draw(g);
    const note = paused ? 'PAUSED · P TO PLAY ON' : closing;
    if (note && well) banner(L, note);
    g.restore();
  }

  function drawWell(L, t) {
    const { x, y, cw, ch, ww, wh, n } = L;
    const b = well.block;
    const red = b?.group.risk === 'high';
    const hint = b && !red ? columns.findIndex((c) => c.id === b.group.suggestion) : -1;
    roundRect(g, x - 6, y - 6, ww + 12, wh + 12, 10);
    g.fillStyle = WELL_BG;
    g.fill();
    g.lineWidth = hurt > 0 ? 4 : 2;
    g.strokeStyle = hurt > 0 ? RED : well.payday > 0 ? GOLD : LINE;
    g.stroke();
    for (let i = 0; i < n; i++) {
      const cx = x + i * cw;
      if (i === hint) {
        g.globalAlpha = reducedMotion ? 0.14 : 0.1 + 0.06 * Math.sin(t * 5);
        g.fillStyle = columns[i].color;
        g.fillRect(cx, y, cw, wh);
      }
      if (refused[i] > 0) {
        g.globalAlpha = refused[i];
        g.fillStyle = RED;
        g.fillRect(cx, y, cw, wh);
      }
      g.globalAlpha = 1;
      if (i) {
        g.fillStyle = '#24222d';
        g.fillRect(cx, y, 1, wh);
      }
    }
    if (well.combo > 1) {
      g.font = `700 ${L.wide ? 22 : 15}px ${PIXEL}`;
      g.textAlign = 'center';
      g.fillStyle = 'rgba(242,182,50,0.35)';
      g.fillText(`COMBO ×${well.combo}`, x + ww / 2, y + wh * 0.42);
    }
    const rest = b ? well.floor(b.col) - 1 : 0;
    if (b) {
      g.fillStyle = 'rgba(244,241,234,0.045)';
      g.fillRect(x + b.col * cw, y + (b.y + 1) * ch, cw, Math.max(0, (rest - b.y) * ch));
    }
    for (let i = 0; i < n; i++) drawBar(L, i);
    if (b) {
      if (rest - b.y > 0.5) {
        g.setLineDash([5, 5]);
        g.lineWidth = 2;
        g.strokeStyle = red ? 'rgba(232,70,43,0.55)' : 'rgba(244,241,234,0.32)';
        roundRect(g, x + b.col * cw + 3, y + rest * ch + 3, cw - 6, ch - 6, 6);
        g.stroke();
        g.setLineDash([]);
      }
      tile(x + blockX * cw + 3, y + b.y * ch + 3, cw - 6, ch - 6, b.group, b.power, t);
    }
    if (well.slow > 0) {
      g.fillStyle = 'rgba(34,211,238,0.08)';
      g.fillRect(x, y, ww, wh);
    }
    for (let i = 0; i < n; i++) drawName(L, i, i === hint);
  }

  function drawBar(L, i) {
    const c = well.columns[i];
    const h = shown[i] * L.ch;
    if (h < 1) return;
    const x = L.x + i * L.cw + 4;
    const w = L.cw - 8;
    const bottom = L.y + L.wh;
    const top = bottom - h + bumps[i] * 5;
    const sum = c.items.reduce((s, it) => s + Math.abs(it.total), 0);
    let at = bottom;
    g.textAlign = 'center';
    g.font = `600 10px ${MONO}`;
    c.items.forEach((it, k) => {
      const sh = (sum ? Math.abs(it.total) / sum : 1 / c.items.length) * (bottom - top);
      at -= sh;
      g.globalAlpha = it.earlier ? 0.4 : k % 2 ? 0.84 : 1;
      g.fillStyle = c.color;
      g.fillRect(x, at, w, sh);
      g.globalAlpha = 1;
      if (k && sh > 2) {
        g.fillStyle = 'rgba(21,20,27,0.45)';
        g.fillRect(x, at + sh - 1, w, 1);
      }
      if (sh >= 15 && w >= 40) {
        g.fillStyle = it.earlier ? PAPER : c.ink;
        g.fillText(fit(it.label, w - 6), x + w / 2, at + sh / 2 + 3.5);
      }
    });
    g.fillStyle = 'rgba(255,255,255,0.35)';
    g.fillRect(x, top, w, 2);
    g.font = `700 ${L.cw >= 56 ? 12 : 9}px ${MONO}`;
    g.fillStyle = c.color;
    g.fillText(fit(money(c.total), L.cw - 2), x + w / 2, top - 6);
  }

  function drawName(L, i, lit) {
    const c = columns[i];
    const x = L.x + i * L.cw;
    const y = L.y + L.wh + 8;
    const mid = x + L.cw / 2;
    const size = L.font;
    g.fillStyle = c.color;
    g.fillRect(x + 4, y, L.cw - 8, 3);
    g.textAlign = 'center';
    g.font = `700 ${size}px ${MONO}`;
    const name = fit(g.measureText(c.label).width > L.cw - 6 ? (SHORT[c.label] ?? c.label) : c.label, L.cw - 4);
    if (lit) {
      const w = Math.min(L.cw - 2, g.measureText(name).width + 10);
      roundRect(g, mid - w / 2, y + 6, w, size + 7, 4);
      g.fillStyle = c.color;
      g.fill();
    }
    g.fillStyle = lit ? c.ink : PAPER;
    g.fillText(name, mid, y + 7 + size);
    g.font = `600 ${size}px ${MONO}`;
    g.fillStyle = lit ? c.color : DIM;
    g.fillText(c.key, mid, y + 2 * size + 15);
  }

  /** One merchant as a block: its guessed category's colour, or hazard stripes when it should be flagged. */
  function tile(x, y, w, h, group, power, t) {
    const red = group.risk === 'high';
    const col = columns.find((c) => c.id === group.suggestion);
    const r = Math.min(7, h / 4);
    roundRect(g, x, y, w, h, r);
    g.fillStyle = red ? '#3a1412' : (col?.color ?? STONE);
    g.fill();
    if (red) {
      g.save();
      g.clip();
      g.strokeStyle = 'rgba(232,70,43,0.4)';
      g.lineWidth = 4;
      for (let s = -h; s < w; s += 11) {
        g.beginPath();
        g.moveTo(x + s, y + h);
        g.lineTo(x + s + h, y);
        g.stroke();
      }
      g.restore();
      roundRect(g, x, y, w, h, r);
      g.lineWidth = reducedMotion ? 3 : 2 + 1.5 * (0.5 + 0.5 * Math.sin(t * 8));
      g.strokeStyle = RED;
    } else {
      g.lineWidth = 2;
      g.strokeStyle = INK;
    }
    g.stroke();
    g.fillStyle = red ? PAPER : (col?.ink ?? INK);
    g.textAlign = 'center';
    if (w >= 50) {
      const two = h >= 32;
      g.font = `700 ${two ? 11 : 10}px ${MONO}`;
      g.fillText(fit(group.label, w - 10), x + w / 2, y + (two ? h / 2 - 2 : h / 2 + 4));
      if (two) {
        g.font = `600 10px ${MONO}`;
        g.fillText(fit(`${money(group.total)} · ${group.count}×`, w - 10), x + w / 2, y + h / 2 + 11);
      }
    } else {
      g.font = `700 9px ${MONO}`;
      g.fillText(fit(money(group.total), w - 4), x + w / 2, y + h / 2 + 3);
    }
    if (red) badge(x + 3, y - 7, w >= 60 ? 'FLAG F' : 'F', RED, PAPER, 'left');
    if (power) badge(x + w - 3, y - 7, POWER[power].badge, POWER[power].color, INK, 'right');
  }

  function badge(x, y, text, bg, fg, align) {
    g.font = `700 9px ${PIXEL}`;
    const w = g.measureText(text).width + 8;
    const bx = align === 'right' ? x - w : x;
    roundRect(g, bx, y, w, 14, 7);
    g.fillStyle = bg;
    g.fill();
    g.lineWidth = 1.5;
    g.strokeStyle = INK;
    g.stroke();
    g.fillStyle = fg;
    g.textAlign = 'center';
    g.fillText(text, bx + w / 2, y + 10);
  }

  function heart(x, y, px, full) {
    g.fillStyle = full ? RED : '#3a3644';
    HEART.forEach((row, ry) => [...row].forEach((c, rx) => c === '#' && g.fillRect(x + rx * px, y + ry * px, px, px)));
  }

  function panel(x, y, w, h, stroke = LINE) {
    roundRect(g, x, y, w, h, 10);
    g.fillStyle = PANEL;
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = stroke;
    g.stroke();
  }

  function heading(text, x, y) {
    g.font = `700 10px ${PIXEL}`;
    g.textAlign = 'left';
    g.fillStyle = DIM;
    g.fillText(text, x + 2, y + 10);
    return y + 18;
  }

  /** What the ticket says about the falling merchant, as lines to draw. */
  function ticket(b, max) {
    const gr = b.group;
    const lines = [];
    g.font = `700 15px ${MONO}`;
    for (const text of wrap(gr.label, max, 2)) lines.push({ text, font: `700 15px ${MONO}`, color: PAPER, h: 20 });
    lines.push({ text: `${fmt.money(gr.total)} · ${plural(gr.count, 'charge')}`, font: `600 13px ${MONO}`, color: gr.total < 0 ? LOSS : GAIN, h: 20 });
    for (const flag of gr.flags ?? []) lines.push({ text: flag, font: `600 12px ${MONO}`, color: warning(flag) ? RED : DIM, h: 17 });
    lines.push({ h: 8 });
    const c = columns.find((x) => x.id === gr.suggestion);
    if (gr.risk === 'high') lines.push({ text: 'Red flag: press F', font: `700 13px ${MONO}`, color: RED, h: 20 });
    else if (c) lines.push({ text: `${gr.remembered ? 'Last time' : gr.aiSuggested ? 'Claude says' : 'Guess'}: ${c.label} · ${c.key}`, font: `600 13px ${MONO}`, color: c.color, chip: c.color, h: 20 });
    else lines.push({ text: 'No guess: any column is fine', font: `600 13px ${MONO}`, color: DIM, h: 20 });
    if (b.power) lines.push({ text: `Carries ${POWER[b.power].name}`, font: `700 12px ${MONO}`, color: POWER[b.power].color, h: 19 });
    return lines;
  }

  function drawTicketSide(L, t) {
    const x = 16;
    const w = L.x - 6 - 24 - x;
    const b = well.block;
    let y = heading('NOW FALLING', x, L.y - 6);
    const lines = b ? ticket(b, w - 24) : [{ text: well.left ? 'next merchant…' : '', font: `600 13px ${MONO}`, color: DIM, h: 20 }];
    const h = lines.reduce((s, l) => s + l.h, 0) + 20;
    panel(x, y, w, h, b?.group.risk === 'high' ? RED : LINE);
    let at = y + 10;
    g.textAlign = 'left';
    for (const l of lines) {
      at += l.h;
      if (!l.text) continue;
      let tx = x + 12;
      if (l.chip) {
        g.fillStyle = l.chip;
        g.fillRect(tx, at - 15, 10, 10);
        tx += 16;
      }
      g.font = l.font;
      g.fillStyle = l.color;
      g.fillText(fit(l.text, x + w - 12 - tx), tx, at - 5);
    }
    y += h + 16;

    y = heading('HOLD · H', x, y);
    const th = Math.min(L.ch - 6, 40);
    panel(x, y, w, th + 20);
    if (well.held) tile(x + 10, y + 10, Math.min(w - 20, 190), th, well.held.group, well.held.power, t);
    else {
      g.font = `600 12px ${MONO}`;
      g.fillStyle = DIM;
      g.fillText(fit(well.swapped ? 'swapped: one per block' : 'empty: H puts one aside', w - 20), x + 12, y + 14 + th / 2);
    }
    y += th + 36;

    y = heading(`FLAGGED FOR REVIEW · ${well.flagged.length}`, x, y);
    g.font = `600 12px ${MONO}`;
    for (const gr of well.flagged.slice(-4).reverse()) {
      g.fillStyle = gr.risk === 'high' ? LOSS : STONE;
      g.fillText(fit(`⚑ ${gr.label}`, w - 4), x + 2, y + 12);
      y += 18;
    }
  }

  function drawStatusSide(L, t) {
    const x = L.x + L.ww + 6 + 24;
    const w = L.W - 16 - x;
    let y = heading('NEXT', x, L.y - 6);
    const th = Math.min(L.ch - 6, 40);
    const next = well.queue.slice(0, 3);
    panel(x, y, w, 3 * (th + 8) + 12);
    next.forEach((gr, k) => tile(x + 10, y + 10 + k * (th + 8), w - 20, th, gr, powerAt(well.spawned + k), t));
    if (!next.length) {
      g.font = `600 12px ${MONO}`;
      g.textAlign = 'left';
      g.fillStyle = DIM;
      g.fillText(well.held ? 'only the held one' : 'this is the last one', x + 12, y + 30);
    }
    y += 3 * (th + 8) + 28;

    y = heading('HEARTS', x, y);
    for (let k = 0; k < MAX_HEARTS; k++) heart(x + 2 + k * 27, y + 2, 3, k < well.hearts);
    y += 36;

    y = heading('POWER-UPS', x, y);
    y = powerRow(x, y, w, POWER.slow.color, `SLOW-MO ×${well.powers.slow}`, 'S', well.slow / SLOW_FOR);
    y = powerRow(x, y, w, POWER.auto.color, `AUTOPILOT ×${well.powers.auto}`, 'A', 0);
    if (well.payday > 0) y = powerRow(x, y, w, POWER.payday.color, 'PAYDAY: POINTS ×2', '', well.payday / PAYDAY_FOR);
    y += 10;

    y = heading('LEVEL', x, y);
    g.textAlign = 'left';
    g.font = `700 26px ${PIXEL}`;
    g.fillStyle = PAPER;
    g.fillText(String(well.level), x + 2, y + 24);
    g.font = `600 12px ${MONO}`;
    g.fillStyle = DIM;
    g.fillText(fit(`${fallSpeed(well.level).toFixed(1)} rows a second`, w - 50), x + 44, y + (well.best > 1 ? 12 : 20));
    if (well.best > 1) g.fillText(fit(`best combo ×${well.best}`, w - 50), x + 44, y + 28);
  }

  function powerRow(x, y, w, color, label, key, left) {
    g.fillStyle = color;
    g.fillRect(x + 2, y + 3, 10, 10);
    g.font = `700 12px ${MONO}`;
    g.textAlign = 'left';
    g.fillStyle = PAPER;
    g.fillText(fit(label, w - 40), x + 20, y + 13);
    if (key) {
      g.textAlign = 'right';
      g.fillStyle = DIM;
      g.fillText(key, x + w - 2, y + 13);
    }
    if (left > 0) {
      g.fillStyle = LINE;
      g.fillRect(x + 20, y + 19, w - 22, 3);
      g.fillStyle = color;
      g.fillRect(x + 20, y + 19, (w - 22) * left, 3);
    }
    return y + 28;
  }

  /** Narrow screens: the falling merchant, hearts and what is next, in one strip above the well. */
  function drawStrip(L) {
    const x = 8;
    const w = L.W - 16;
    const y = L.y - 80;
    const b = well.block;
    panel(x, y, w, 70, b?.group.risk === 'high' ? RED : LINE);
    if (b) {
      const gr = b.group;
      g.font = `600 12px ${MONO}`;
      const total = fmt.money(gr.total);
      const tw = g.measureText(total).width;
      g.textAlign = 'right';
      g.fillStyle = gr.total < 0 ? LOSS : GAIN;
      g.fillText(total, x + w - 10, y + 20);
      g.textAlign = 'left';
      g.font = `700 13px ${MONO}`;
      g.fillStyle = PAPER;
      g.fillText(fit(`${gr.label} ×${gr.count}`, w - 30 - tw), x + 10, y + 20);
      const c = columns.find((col) => col.id === gr.suggestion);
      const [hint, color] = gr.risk === 'high' ? [`Red flag: ${gr.flags.filter(warning).join(', ') || 'check it'}. Tap Flag`, RED] : c ? [`★ ${c.label} (${c.key})`, c.color] : ['No guess: any column is fine', DIM];
      g.font = `600 12px ${MONO}`;
      g.fillStyle = color;
      g.fillText(fit(b.power ? `${hint} · ${POWER[b.power].name}` : hint, w - 20), x + 10, y + 40);
    }
    for (let k = 0; k < MAX_HEARTS; k++) heart(x + 10 + k * 18, y + 50, 2, k < well.hearts);
    g.font = `600 11px ${MONO}`;
    g.textAlign = 'right';
    g.fillStyle = DIM;
    const parts = [well.queue[0] ? `next ${well.queue[0].label}` : 'last one', well.held ? `held ${well.held.group.label}` : ''].filter(Boolean);
    g.fillText(fit(parts.join(' · '), w - 120), x + w - 10, y + 60);
  }

  function banner(L, text) {
    g.font = `700 ${L.wide ? 16 : 12}px ${PIXEL}`;
    const w = Math.min(L.ww, g.measureText(text).width + 32);
    const cx = L.x + L.ww / 2;
    const cy = L.y + L.wh * 0.4;
    roundRect(g, cx - w / 2, cy - 20, w, 40, 10);
    g.fillStyle = 'rgba(21,20,27,0.92)';
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = GOLD;
    g.stroke();
    g.fillStyle = GOLD;
    g.textAlign = 'center';
    g.fillText(fit(text, w - 16), cx, cy + 6);
  }

  await round(true);
  return () => {
    disposed = true;
    stopLoop?.();
    kb?.destroy();
    destroyCanvas();
  };
}
