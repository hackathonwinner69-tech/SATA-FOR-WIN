// Pure geometry shared by the arena games. No DOM here, so it is unit-tested in Node.

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Move `from` towards `to` by at most `step`; returns the new point. */
export function approach(from, to, step) {
  const d = dist(from, to);
  if (d <= step || d === 0) return { x: to.x, y: to.y };
  return { x: from.x + ((to.x - from.x) / d) * step, y: from.y + ((to.y - from.y) / d) * step };
}

/** Lay `labels` out as doors down the left and right walls of a w×h arena. */
export function wallDoors(labels, w, h, { depth = 92, top = 0 } = {}) {
  const perSide = Math.ceil(labels.length / 2);
  const doorH = (h - top) / perSide;
  return labels.map((label, i) => {
    const right = i >= perSide;
    const row = right ? i - perSide : i;
    return { ...label, index: i, x: right ? w - depth : 0, y: top + row * doorH, w: depth, h: doorH };
  });
}

export function inside(p, r, pad = 0) {
  return p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad;
}

export function nearest(p, items, within = Infinity) {
  let best = null;
  let bestD = within;
  for (const it of items) {
    const d = dist(p, it);
    if (d < bestD) [best, bestD] = [it, d];
  }
  return best;
}

/** Points scored for a delivery: bigger packs, smart picks and streaks pay more. */
export function deliveryScore({ count, wise, streak }) {
  return Math.round((50 + count * 10) * (wise ? 2 : 1) * (1 + Math.min(streak, 10) * 0.15));
}

/** How many hits a lint boss takes: more for rules broken more often, never more than six. */
export function bossHp(count) {
  return clamp(Math.ceil(Math.log2(count + 1)), 1, 6);
}
