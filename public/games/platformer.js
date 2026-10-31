// Pure platformer logic for Lint Dungeon: a seeded level builder and tile
// collision. No DOM, so it is unit-tested in Node.

export const TILE = 16;
export const ROWS = 11; // 176 px of world under a 180 px screen
export const SECTION = 20; // tiles per section (one screen is 20 tiles wide)
export const GROUND = 9; // first solid row of the floor
export const PHYS = { gravity: 900, jump: 330, run: 100 };

/** Small deterministic RNG so a floor of the same rules always looks the same. */
export function rng(seedText) {
  let h = 2166136261;
  for (const c of seedText) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Make each lint group a recognizable castle creature, consistently across runs. */
export function foeKind(group) {
  if (group.count >= 8) return 'boss';
  if (group.fixable) return 'crawler';
  const rule = group.rule ?? group.id ?? '';
  const archetypes = ['bat', 'wisp', 'sentinel'];
  const hash = [...rule].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return archetypes[hash % archetypes.length];
}

/**
 * Lay out a floor: one section per two rules plus a starting room and an exit
 * room. Each named wing gets a distinct silhouette, with short stairs and
 * ledges kept within a comfortable jump of the main route.
 */
export function buildLevel(groups, seedText = '', floorIndex = 0) {
  const rand = rng(seedText + groups.map((g) => g.id).join());
  const sections = Math.max(2, Math.ceil(groups.length / 2)) + 2;
  const w = sections * SECTION;
  const solid = new Uint8Array(w * ROWS);
  const set = (x, y) => {
    if (x >= 0 && x < w && y >= 0 && y < ROWS) solid[y * w + x] = 1;
  };
  for (let x = 0; x < w; x++) for (let y = GROUND; y < ROWS; y++) set(x, y);
  // walls at both ends
  for (let y = 0; y < ROWS; y++) {
    set(0, y);
    set(w - 1, y);
  }
  const foes = [];
  const candles = [];
  const pits = [];
  const wingLayouts = [
    { ledges: [[3, 6, 5], [13, 5, 4]], pits: [[9, 2]] }, // Entrance Hall: broken entry bridge
    { ledges: [[2, 7, 4], [7, 6, 4], [12, 5, 4], [16, 6, 2]], pits: [] }, // Clock Corridor: rising gears
    { ledges: [[2, 6, 5], [8, 7, 4], [14, 6, 4]], pits: [[10, 2]] }, // Flooded Archive: stepping islands
    { ledges: [[2, 7, 4], [6, 6, 4], [11, 7, 4], [15, 6, 3]], pits: [[9, 2]] }, // Root Cellar: root stairs
    { ledges: [[3, 5, 4], [7, 7, 6], [13, 5, 4]], pits: [] }, // Mirror Gallery: high side balconies
    { ledges: [[2, 7, 4], [6, 6, 4], [10, 5, 4], [15, 6, 3]], pits: [[13, 2]] }, // Ember Foundry: stepped furnace
    { ledges: [[2, 6, 6], [12, 6, 5]], pits: [[9, 2]] }, // Inner Keep: guarded bridge
    { ledges: [[3, 5, 3], [8, 7, 4], [14, 5, 3]], pits: [] }, // Throne: open boss arena
  ];
  const layout = wingLayouts[((floorIndex % wingLayouts.length) + wingLayouts.length) % wingLayouts.length];
  for (let s = 1; s < sections - 1; s++) {
    const x0 = s * SECTION;
    for (const [offset, width] of layout.pits) {
      const px = x0 + offset;
      for (let x = px; x < px + width; x++) for (let y = GROUND; y < ROWS; y++) solid[y * w + x] = 0;
      pits.push({ x: px, w: width });
    }
    for (const [offset, row, length] of layout.ledges) {
      const px = x0 + offset;
      for (let x = px; x < px + length; x++) set(x, row);
      if (rand() < 0.55) candles.push({ x: (px + Math.floor(length / 2)) * TILE + 4, y: (row - 1) * TILE });
    }
    candles.push({ x: (x0 + 2) * TILE + 4, y: (GROUND - 1) * TILE });
    for (const group of groups.slice((s - 1) * 2, (s - 1) * 2 + 2)) {
      const kind = foeKind(group);
      let fx = x0 + 4 + Math.floor(rand() * (SECTION - 8));
      const pit = pits.find((p) => fx >= p.x - 1 && fx <= p.x + p.w);
      if (pit) fx = pit.x + pit.w + 1; // never spawn a foe over a pit
      const flying = kind === 'bat' || kind === 'wisp';
      foes.push({ group, kind, x: fx * TILE, y: (flying ? 4 : GROUND - (kind === 'boss' ? 2 : 1)) * TILE, section: s });
    }
  }
  return { w, h: ROWS, solid, foes, candles, pits, sections, exit: { x: (w - 3) * TILE, y: (GROUND - 3) * TILE } };
}

export function isSolid(level, tx, ty) {
  if (tx < 0 || tx >= level.w) return true;
  if (ty < 0) return false;
  if (ty >= level.h) return false; // falling off the bottom is a pit, not a wall
  return level.solid[ty * level.w + tx] === 1;
}

/**
 * Move a box by (dx, dy) one axis at a time, stopping at solid tiles.
 * Returns the new box plus which sides touched something.
 */
export function moveBox(level, box, dx, dy) {
  // Split big moves so a fast fall can never skip through a one-tile platform.
  const steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / (TILE / 2));
  if (steps > 1) {
    let out = { ...box };
    const flags = { hitX: false, hitTop: false, onGround: false };
    for (let i = 0; i < steps; i++) {
      out = moveBox(level, out, flags.hitX ? 0 : dx / steps, flags.onGround || flags.hitTop ? 0 : dy / steps);
      flags.hitX ||= out.hitX;
      flags.hitTop ||= out.hitTop;
      flags.onGround ||= out.onGround;
    }
    return { ...out, ...flags };
  }
  const out = { ...box, hitX: false, hitTop: false, onGround: false };
  out.x += dx;
  if (dx !== 0) {
    const edge = dx > 0 ? out.x + out.w - 0.001 : out.x;
    const tx = Math.floor(edge / TILE);
    for (let ty = Math.floor(out.y / TILE); ty <= Math.floor((out.y + out.h - 0.001) / TILE); ty++) {
      if (isSolid(level, tx, ty)) {
        out.x = dx > 0 ? tx * TILE - out.w : (tx + 1) * TILE;
        out.hitX = true;
        break;
      }
    }
  }
  out.y += dy;
  if (dy !== 0) {
    const edge = dy > 0 ? out.y + out.h - 0.001 : out.y;
    const ty = Math.floor(edge / TILE);
    for (let tx = Math.floor(out.x / TILE); tx <= Math.floor((out.x + out.w - 0.001) / TILE); tx++) {
      if (isSolid(level, tx, ty)) {
        if (dy > 0) {
          out.y = ty * TILE - out.h;
          out.onGround = true;
        } else {
          out.y = (ty + 1) * TILE;
          out.hitTop = true;
        }
        break;
      }
    }
  }
  return out;
}

export const overlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
