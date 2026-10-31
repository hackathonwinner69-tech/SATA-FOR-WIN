// Pure logic for Receipt Rush encounters: a monster for every merchant, its
// flavour text, and its bullet pattern. No DOM, so it is unit-tested in Node.
import { rng } from './platformer.js';

/** A symmetric 12x10 creature grown from the merchant's name, so each merchant always looks the same. */
export function monsterFor(name) {
  const rand = rng(name);
  const half = 6;
  const rows = [];
  for (let y = 0; y < 10; y++) {
    let row = '';
    for (let x = 0; x < half; x++) {
      // denser towards the middle so it reads as a body, not noise
      const edge = Math.abs(x - half) / half;
      row += rand() < 0.75 - edge * 0.45 - (y === 0 || y === 9 ? 0.25 : 0) ? 'b' : '.';
    }
    rows.push(row + [...row].reverse().join(''));
  }
  // eyes and a mouth on top of the body
  const eyeY = 3 + Math.floor(rand() * 2);
  const put = (r, x, c) => (rows[r] = rows[r].slice(0, x) + c + rows[r].slice(x + 1));
  put(eyeY, 3, 'e');
  put(eyeY, 8, 'e');
  for (let x = 4; x < 8; x++) put(eyeY + 3, x, rand() < 0.5 ? 'm' : 'b');
  put(eyeY + 3, 5, 'm');
  put(eyeY + 3, 6, 'm');
  return rows;
}

/** Which attack a merchant uses: subscriptions spiral, big charges fall like boulders, regulars rain coins. */
export function patternFor(group) {
  if (group.flags?.includes('recurring')) return 'spiral';
  if (group.flags?.some((f) => /large|duplicate/.test(f))) return 'boulders';
  if (group.count >= 15) return 'rain';
  return 'sweep';
}

/** How long the dodge lasts: a little longer for merchants that cost more. */
export function attackLength(group) {
  return Math.min(6, 3 + Math.log10(Math.abs(group.total) + 1) * 0.6);
}

const money = (n) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

export function flavour(group) {
  const lines = {
    spiral: `* ${group.label} appears. It renews itself every month.`,
    boulders: `* ${group.label} looms. It cost you ${money(group.total)}.`,
    rain: `* ${group.label} swarms in. You saw it ${group.count} times.`,
    sweep: `* ${group.label} blocks the way.`,
  };
  return lines[patternFor(group)];
}

export function checkText(group) {
  const flags = group.flags?.length ? ` ${group.flags.join(', ')}.` : '';
  return `* ${group.label}: ${group.count} charge${group.count === 1 ? '' : 's'}, ${money(group.total)} in all.${flags} ${group.detail ?? ''}`.trim();
}

/**
 * Advance a pattern by dt inside the bullet box and return bullets to add.
 * `state` carries the pattern's clock between frames.
 */
export function spawnBullets(pattern, state, dt, box, rand = Math.random) {
  const out = [];
  state.t = (state.t ?? 0) + dt;
  state.cool = (state.cool ?? 0) - dt;
  if (state.cool > 0) return out;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  if (pattern === 'spiral') {
    state.cool = 0.12;
    const a = state.t * 2.6;
    for (const k of [0, Math.PI]) out.push({ x: cx, y: cy, vx: Math.cos(a + k) * 70, vy: Math.sin(a + k) * 70, r: 3, glyph: '$' });
  } else if (pattern === 'boulders') {
    state.cool = 0.75;
    out.push({ x: box.x + 10 + rand() * (box.w - 20), y: box.y - 10, vx: 0, vy: 55 + rand() * 25, r: 9, glyph: '$$' });
  } else if (pattern === 'rain') {
    state.cool = 0.09;
    out.push({ x: box.x + rand() * box.w, y: box.y - 4, vx: (rand() - 0.5) * 20, vy: 90 + rand() * 50, r: 2.5, glyph: '¢' });
  } else {
    state.cool = 0.45;
    const fromLeft = rand() < 0.5;
    const y = box.y + 8 + rand() * (box.h - 16);
    out.push({ x: fromLeft ? box.x - 6 : box.x + box.w + 6, y, vx: fromLeft ? 95 : -95, vy: 0, r: 4, glyph: '=' });
  }
  return out;
}

export function hits(soul, bullet) {
  return Math.hypot(soul.x - bullet.x, soul.y - bullet.y) < bullet.r + soul.r;
}
