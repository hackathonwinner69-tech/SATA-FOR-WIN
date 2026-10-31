// Pseudo-3D maths for the synthwave grid in Inbox Invaders. World space:
// x runs -1 (left edge of the road) to 1 (right), z runs 1 (horizon) to 0
// (the player's ship). No DOM, so it is unit-tested in Node.

/** Screen position and scale of a world point. Depth eases so the horizon is crowded and the foreground fast. */
export function project(x, z, { width, horizon, bottom }) {
  const p = Math.max(0, Math.min(1, 1 - z)) ** 1.9;
  const s = 0.08 + 0.92 * p;
  const y = horizon + (bottom - horizon) * p;
  const half = width * (0.06 + 0.5 * p);
  return { x: width / 2 + x * half, y, s };
}

/** Inverse of project for the bottom row: which world x is under screen x at the player's depth. */
export function worldX(screenX, { width }) {
  return Math.max(-1, Math.min(1, (screenX - width / 2) / (width * 0.56)));
}

/** A shot hits a ship when it has caught up with the ship's depth and is within its half-width. */
export function shotHits(shot, ship) {
  return Math.abs(shot.z - ship.z) < 0.05 && Math.abs(shot.x - ship.x) < ship.half;
}

/** Ship half-width in world units grows gently with how much mail the sender sent. */
export function hullHalf(count) {
  return Math.min(0.2, 0.07 + Math.log10(count + 1) * 0.05);
}

/** Depths of the floor's horizontal grid lines, scrolling towards the viewer by `offset` (0..1). */
export function gridRows(offset, rows = 14) {
  return Array.from({ length: rows }, (_, i) => 1 - ((i + offset) / rows));
}

/** The ship a shot fired from `x` should curve towards: roughly in line, nearest first. */
export function aimTarget(x, ships, cone = 0.3) {
  let best = null;
  for (const s of ships) {
    if (Math.abs(s.x - x) > cone + s.half) continue;
    if (!best || s.z < best.z) best = s;
  }
  return best;
}
