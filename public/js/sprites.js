// Hand-placed pixel sprites, one per cabinet, drawn as crisp SVG or onto a canvas.
// Each row is a string; every character is a palette key, '.' is empty.

const PALETTE = {
  k: '#1d1b16', // ink
  w: '#fffdf8', // paper
  r: '#e8462b', // tomato
  b: '#2b59d9', // cobalt
  y: '#f2b632', // sun
  g: '#17a673', // mint
  p: '#9b3d78', // plum
  s: '#c9bfae', // stone
};

export const SPRITES = {
  invaders: [
    '..k......k..',
    '...k....k...',
    '..kkkkkkkk..',
    '.kkbkkkkbkk.',
    'kkkkkkkkkkkk',
    'k.kkkkkkkk.k',
    'k.k......k.k',
    '...kk..kk...',
  ],
  frenzy: [
    '.kkkkk......',
    'kyyyyyk.....',
    'kyyyyyykkkkk',
    'kyyyyyyyyyyk',
    'kyykkkkkkyyk',
    'kyyyyyyyyyyk',
    'kyykkkkkyyyk',
    'kyyyyyyyyyyk',
    'kkkkkkkkkkkk',
  ],
  receipts: [
    '.kkkkkkkkkk.',
    '.kwwwwwwwwk.',
    '.kwkkkwgwwk.',
    '.kwwwwwwwwk.',
    '.kwkkkkkwwk.',
    '.kwwwwwwwwk.',
    '.kwkkwwkkwk.',
    '.kwwwwwwwwk.',
    '.kwkwkwkwkk.',
    '.kk.k.k.k.k.',
  ],
  dungeon: [
    '....k..k....',
    '.....kk.....',
    '...kkkkkk...',
    'k.kgkggkgk.k',
    '.kkggggggkk.',
    'k.kgkkkkgk.k',
    '.kkggggggkk.',
    'k..kggggk..k',
    '....kkkk....',
  ],
};

export function spriteSvg(name, { size = 48, label = '' } = {}) {
  const rows = SPRITES[name];
  const w = rows[0].length;
  const h = rows.length;
  let rects = '';
  rows.forEach((row, y) => {
    [...row].forEach((c, x) => {
      if (c !== '.') rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${PALETTE[c]}"/>`;
    });
  });
  const a11y = label ? `role="img" aria-label="${label}"` : 'aria-hidden="true"';
  return `<svg ${a11y} width="${size}" height="${Math.round((size * h) / w)}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">${rects}</svg>`;
}

/** Draw a sprite onto a canvas, recoloring ink with `tint` (for in-game enemies). */
export function drawSprite(ctx, name, x, y, px, tint) {
  const rows = SPRITES[name];
  rows.forEach((row, ry) => {
    [...row].forEach((c, rx) => {
      if (c === '.') return;
      ctx.fillStyle = c === 'k' && tint ? tint : PALETTE[c];
      ctx.fillRect(Math.round(x + rx * px), Math.round(y + ry * px), Math.ceil(px), Math.ceil(px));
    });
  });
}

export const spriteSize = (name) => ({ w: SPRITES[name][0].length, h: SPRITES[name].length });
