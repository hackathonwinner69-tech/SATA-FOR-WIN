// Lint Dungeon: a side-scrolling castle crawl in the Metroidvania tradition.
// Every broken lint rule is a foe placed in the castle; big rules are bosses.
// Three weapons, three real actions: the Fix Beam runs ESLint's autofix for the
// rule (and only hurts foes ESLint can fix), the Hush Whip adds marked disable
// comments, the Quest Scroll writes the rule into LINT_QUESTLOG.md. A foe falls
// to one weapon, so the kill is the action. Clear a floor and the exit door
// opens; the next floor is a fresh lint pass. All art here is original.
import { Fx, actionBar, intro, keyboard, loop, makeCanvas, reducedMotion, results, truncate } from './kit.js';
import { bossHp } from './arena.js';
import { GROUND, PHYS, SECTION, TILE, buildLevel, moveBox, overlap } from './platformer.js';

const VW = 320;
const VH = 180;
const MAX_HP = 6;
const WEAPONS = [
  { id: 'fix', label: 'Fix Beam', key: '1', color: '#17a673' },
  { id: 'disable', label: 'Hush Whip', key: '2', color: '#f2b632' },
  { id: 'log', label: 'Quest Scroll', key: '3', color: '#4f7cf0' },
];
const COLOR = Object.fromEntries(WEAPONS.map((w) => [w.id, w.color]));
const FLOORS = ['Entrance Hall', 'Clock Corridor', 'Flooded Archive', 'Root Cellar', 'Mirror Gallery', 'Ember Foundry', 'Inner Keep', 'Throne of Warnings'];
const floorName = (index) => FLOORS[index] ?? `Deep Index ${index - FLOORS.length + 1}`;
const THEMES = [
  { sky: '#0c1020', haze: '#242b50', far: '#1b2140', near: '#24263c', glass: '#45658b', wall: '#15141b', brick: '#1c1a24', stone: '#3a3744', edge: '#4a4656', seam: '#2a2833' },
  { sky: '#0a1725', haze: '#1e3e53', far: '#143246', near: '#1c3949', glass: '#4e9db1', wall: '#101b24', brick: '#152631', stone: '#304754', edge: '#466574', seam: '#223641' },
  { sky: '#0b1b20', haze: '#1c4943', far: '#133633', near: '#1c3e3b', glass: '#53aa8b', wall: '#101d21', brick: '#14292b', stone: '#315451', edge: '#47756b', seam: '#223c3a' },
  { sky: '#171021', haze: '#442345', far: '#321c38', near: '#472945', glass: '#c2788d', wall: '#1b151e', brick: '#2a1e2b', stone: '#4d3546', edge: '#70506a', seam: '#352738' },
];

const INK = '#171626';
const PALETTE = { paper: '#fff8e8', gold: '#ffd166', blue: '#4d75ec', skin: '#f2bd98', mint: '#56d6a4', plum: '#b66bdf' };
const ellipse = (g, x, y, rx, ry, fill) => {
  g.fillStyle = fill;
  g.beginPath();
  g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  g.fill();
};

// Smooth canvas illustrations keep their shape when the viewport grows.
function drawHero(g, x, y, face, running, t) {
  g.save(); g.translate(Math.round(x + 4), Math.round(y + 12)); g.scale(face, 1);
  const stride = running ? Math.sin(t * 18) * 2 : 0;
  ellipse(g, 0, 1, 7, 2, 'rgba(0,0,0,.3)');
  g.fillStyle = '#273885'; g.beginPath(); g.moveTo(-4, -11); g.lineTo(-9, -7); g.lineTo(-7, 0); g.lineTo(4, 0); g.lineTo(6, -8); g.closePath(); g.fill();
  g.fillStyle = PALETTE.blue; g.beginPath(); g.moveTo(-5, -11); g.quadraticCurveTo(-8, -7, -5, -1); g.lineTo(5, -1); g.lineTo(4, -11); g.closePath(); g.fill();
  g.fillStyle = PALETTE.gold; g.beginPath(); g.moveTo(-5, -10); g.lineTo(3, -9); g.lineTo(4, -7); g.lineTo(-4, -8); g.closePath(); g.fill();
  g.fillStyle = PALETTE.skin; g.beginPath(); g.roundRect(-4, -19, 8, 8, 3); g.fill();
  g.fillStyle = INK; g.beginPath(); g.roundRect(-5, -21, 10, 5, 2); g.fill();
  g.fillStyle = PALETTE.gold; g.beginPath(); g.moveTo(-3, -21); g.lineTo(-1, -27); g.lineTo(1, -21); g.lineTo(4, -25); g.lineTo(4, -20); g.closePath(); g.fill();
  ellipse(g, 1.5, -15, 0.8, 1, INK);
  g.strokeStyle = '#b76c5b'; g.lineWidth = 0.7; g.beginPath(); g.arc(0, -13.5, 1.8, 0.2, 1.8); g.stroke();
  g.fillStyle = '#d7b66a'; g.beginPath(); g.roundRect(-8, -11, 4, 5, 2); g.roundRect(3, -11, 4, 5, 2); g.fill();
  g.fillStyle = INK; g.beginPath(); g.roundRect(-5 + stride, -2, 4, 4, 1.5); g.roundRect(1 - stride, -2, 4, 4, 1.5); g.fill();
  g.restore();
}

function drawCrawler(g, x, y, t, tint) {
  g.save(); g.translate(x + 5, y + 4 + Math.sin(t * 7) * 0.7);
  ellipse(g, 0, 2, 7, 3, '#2b2331'); g.fillStyle = tint; g.beginPath(); g.ellipse(0, 0, 7, 4, 0, Math.PI, 0); g.fill();
  g.strokeStyle = '#dcffe9'; g.lineWidth = 0.8;
  for (const dx of [-3, 0, 3]) { g.beginPath(); g.moveTo(dx, -2); g.lineTo(dx + 1, 1); g.stroke(); }
  for (const dx of [-5, -2, 2, 5]) { g.beginPath(); g.moveTo(dx, 2); g.lineTo(dx + (dx < 0 ? -2 : 2), 5 + Math.sin(t * 12 + dx) * 1.5); g.stroke(); }
  ellipse(g, -2, -0.5, 0.8, 1.2, PALETTE.gold); ellipse(g, 2, -0.5, 0.8, 1.2, PALETTE.gold); g.restore();
}

function drawBat(g, x, y, t, tint) {
  g.save(); g.translate(x + 6, y + 3); const flap = Math.sin(t * 11) * 3; g.fillStyle = tint;
  g.beginPath(); g.moveTo(-2, 0); g.quadraticCurveTo(-7, -7 - flap, -12, -3); g.lineTo(-8, 4); g.lineTo(-3, 2); g.closePath(); g.fill();
  g.beginPath(); g.moveTo(2, 0); g.quadraticCurveTo(7, -7 - flap, 12, -3); g.lineTo(8, 4); g.lineTo(3, 2); g.closePath(); g.fill();
  ellipse(g, 0, 1, 4, 4, '#392546'); g.fillStyle = tint; g.beginPath(); g.moveTo(-3, -2); g.lineTo(-4, -7); g.lineTo(0, -4); g.lineTo(4, -7); g.lineTo(3, -2); g.fill();
  ellipse(g, -1.4, 0, 0.7, 1, PALETTE.gold); ellipse(g, 1.4, 0, 0.7, 1, PALETTE.gold);
  g.strokeStyle = '#f5b7e4'; g.lineWidth = 0.7; g.beginPath(); g.moveTo(-1, 5); g.lineTo(0, 7); g.lineTo(1, 5); g.stroke(); g.restore();
}

function drawWisp(g, x, y, t, tint) {
  g.save(); g.translate(x + 5, y + 6 + Math.sin(t * 3.2 + x) * 2);
  g.shadowColor = tint; g.shadowBlur = 9;
  const gradient = g.createRadialGradient(-1, -2, 1, 0, 0, 7);
  gradient.addColorStop(0, '#fff8e8'); gradient.addColorStop(0.35, tint); gradient.addColorStop(1, '#543d86');
  g.fillStyle = gradient; g.beginPath(); g.moveTo(0, -7); g.bezierCurveTo(7, -6, 8, 2, 3, 5); g.lineTo(0, 3); g.lineTo(-3, 6); g.bezierCurveTo(-8, 1, -6, -6, 0, -7); g.fill();
  g.shadowBlur = 0; ellipse(g, -2, -1, 0.8, 1, '#fff6bf'); ellipse(g, 2, -1, 0.8, 1, '#fff6bf');
  g.strokeStyle = '#e5ffff'; g.lineWidth = 0.6; g.beginPath(); g.arc(0, 1, 1.7, 0.2, 2.8); g.stroke();
  ellipse(g, Math.cos(t * 3 + x) * 8, Math.sin(t * 3 + x) * 4, 1, 1, '#c7f5ff');
  ellipse(g, Math.cos(t * 3 + x + 2) * 9, Math.sin(t * 3 + x + 2) * 5, 0.7, 0.7, '#f9d5ff');
  g.restore();
}

function drawSentinel(g, x, y, t, tint, charging = false) {
  g.save(); g.translate(x + 6, y + 7); ellipse(g, 0, 5, 9, 2, 'rgba(0,0,0,.28)');
  if (charging) { g.strokeStyle = 'rgba(255,118,94,.8)'; g.lineWidth = 1.5; g.beginPath(); g.arc(0, 0, 12 + Math.sin(t * 24) * 1.5, 0, Math.PI * 2); g.stroke(); }
  g.fillStyle = '#493645'; g.beginPath(); g.ellipse(0, 0, 8, 6, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = tint; g.beginPath(); g.ellipse(0, -1, 6, 5, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#e8d4a2'; g.beginPath(); g.moveTo(-5, -4); g.lineTo(-8, -8); g.lineTo(-2, -6); g.lineTo(0, -10); g.lineTo(2, -6); g.lineTo(8, -8); g.lineTo(5, -3); g.closePath(); g.fill();
  g.fillStyle = '#372639'; g.beginPath(); g.roundRect(-4, -3, 8, 3, 1.5); g.fill();
  ellipse(g, -2, -2, 0.8, 0.9, charging ? '#fff0b3' : '#ff7284'); ellipse(g, 2, -2, 0.8, 0.9, charging ? '#fff0b3' : '#ff7284');
  g.strokeStyle = '#ebc379'; g.lineWidth = 1; g.beginPath(); g.moveTo(-4, 2); g.lineTo(-7, 5 + Math.sin(t * 12) * 1.2); g.moveTo(4, 2); g.lineTo(7, 5 + Math.sin(t * 12 + 1) * 1.2); g.stroke();
  g.restore();
}

function drawBoss(g, x, y, t, tint) {
  g.save(); g.translate(x + 6.5, y + 6); ellipse(g, 0, 6, 9, 2, 'rgba(0,0,0,.3)');
  g.fillStyle = '#41304d'; g.beginPath(); g.roundRect(-8, -2, 16, 8, 4); g.fill();
  g.fillStyle = tint; g.beginPath(); g.roundRect(-6, -9, 12, 14, 5); g.fill();
  g.fillStyle = '#593350'; g.beginPath(); g.roundRect(-8, -8, 5, 7, 2); g.roundRect(3, -8, 5, 7, 2); g.fill();
  g.fillStyle = '#e7bd73'; g.beginPath(); g.moveTo(-5, -8); g.lineTo(-7, -15); g.lineTo(-1, -11); g.lineTo(0, -17); g.lineTo(2, -11); g.lineTo(7, -15); g.lineTo(5, -8); g.closePath(); g.fill();
  g.fillStyle = '#38233d'; g.beginPath(); g.roundRect(-5, -7, 10, 7, 3); g.fill();
  ellipse(g, -2.2, -4, 1.1, 1.4, '#ff6f91'); ellipse(g, 2.2, -4, 1.1, 1.4, '#ff6f91');
  ellipse(g, 0, 1, 2.3, 2.3, PALETTE.gold); ellipse(g, 0, 1, 1, 1, '#fff7bd');
  g.strokeStyle = '#f7d9a5'; g.lineWidth = 1;
  for (const side of [-1, 1]) { g.beginPath(); g.moveTo(side * 4, 3); g.lineTo(side * (5 + Math.sin(t * 5) * 0.5), 6); g.stroke(); } g.restore();
}

function drawCandle(g, x, y, t) {
  g.fillStyle = '#d7c9b4'; g.beginPath(); g.roundRect(x, y + 2, 4, 5, 1); g.fill(); g.fillStyle = '#fff4cf'; g.fillRect(x + 1, y + 3, 1, 3);
  g.fillStyle = '#ff9e57'; g.beginPath(); g.ellipse(x + 2, y + 0.5, 1 + Math.sin(t * 10) * 0.5, 2, 0, 0, Math.PI * 2); g.fill(); ellipse(g, x + 2, y, 0.6, 1.1, '#fff1a8');
}

function drawHeart(g, x, y) {
  g.save(); g.translate(x + 2.5, y + 2.5); g.fillStyle = '#ff5876'; g.beginPath();
  g.moveTo(0, 2.2); g.bezierCurveTo(-6, -1, -2, -4, 0, -1.6); g.bezierCurveTo(2, -4, 6, -1, 0, 2.2); g.fill();
  ellipse(g, -1.1, -1.2, 0.8, 0.5, '#ffd7da'); g.restore();
}

function drawHudHeart(g, x, y, filled) {
  g.fillStyle = filled ? '#ff637d' : '#43414f';
  g.beginPath(); g.moveTo(x, y + 2); g.bezierCurveTo(x - 5, y - 2, x - 2, y - 6, x, y - 3.5);
  g.bezierCurveTo(x + 2, y - 6, x + 5, y - 2, x, y + 2); g.fill();
  if (filled) { g.fillStyle = '#ffd4db'; g.fillRect(x - 1.3, y - 3.4, 1.2, 1); }
}

function drawSigil(g, x, y, t) {
  g.save(); g.translate(x + 5, y + 5 + Math.sin(t * 3 + x) * 1.5); g.rotate(t * 0.7); g.shadowColor = '#7ce8ff'; g.shadowBlur = 8;
  g.fillStyle = '#50d5e8'; g.beginPath(); g.moveTo(0, -5); g.lineTo(4, -2); g.lineTo(3, 3); g.lineTo(0, 5); g.lineTo(-3, 3); g.lineTo(-4, -2); g.closePath(); g.fill();
  g.shadowBlur = 0; g.strokeStyle = '#e5ffff'; g.lineWidth = 0.8; g.beginPath(); g.moveTo(0, -3); g.lineTo(0, 3); g.moveTo(-2, 0); g.lineTo(2, 0); g.stroke(); g.restore();
}

function drawGuide(g, x, floor, t) {
  const y = GROUND * TILE;
  const glow = ['#8cf5ef', '#ffe18a', '#d2b7ff', '#ffbba8'][floor % 4];
  g.save(); g.translate(x, y + Math.sin(t * 2.3) * 2); g.shadowColor = glow; g.shadowBlur = 10;
  ellipse(g, 0, 0, 7, 2, 'rgba(0,0,0,.25)');
  g.fillStyle = '#67d7dc'; g.beginPath(); g.moveTo(-6, -15); g.quadraticCurveTo(-8, -26, 0, -27); g.quadraticCurveTo(8, -26, 6, -15); g.lineTo(7, -4); g.quadraticCurveTo(4, -7, 1, -3); g.quadraticCurveTo(-2, -8, -6, -3); g.closePath(); g.fill();
  g.shadowBlur = 0; ellipse(g, -2, -20, 0.8, 1.4, '#173b54'); ellipse(g, 2, -20, 0.8, 1.4, '#173b54');
  g.strokeStyle = '#d9ffff'; g.lineWidth = 1; g.beginPath(); g.arc(0, -17, 2, 0.2, 2.9); g.stroke();
  ellipse(g, -8, -26, 1, 1, '#d9ffff'); ellipse(g, 9, -19, 0.8, 0.8, '#d9ffff');
  g.restore();
  g.fillStyle = glow; g.font = '600 5px "IBM Plex Mono", monospace'; g.textAlign = 'center'; g.fillText('LUMA · E', x, y - 34);
}

function drawBackTower(g, x, baseline, w, h, theme, phase) {
  const top = baseline - h;
  const inset = w * 0.2;
  // A shaded side plane and tapered front give each distant tower a 3D silhouette.
  g.fillStyle = 'rgba(7,10,20,.62)';
  g.beginPath(); g.moveTo(x + w * 0.68, top + h * 0.12); g.lineTo(x + w, top + h * 0.2); g.lineTo(x + w, baseline); g.lineTo(x + w * 0.68, baseline - 2); g.closePath(); g.fill();
  g.fillStyle = theme.far;
  g.beginPath();
  g.moveTo(x + inset, baseline); g.lineTo(x + inset, top + h * 0.18);
  g.lineTo(x + w * 0.5, top); g.lineTo(x + w - inset, top + h * 0.18);
  g.lineTo(x + w - inset, baseline); g.closePath(); g.fill();
  g.fillStyle = 'rgba(118,150,195,.12)';
  g.beginPath(); g.moveTo(x + inset, baseline); g.lineTo(x + inset, top + h * 0.18); g.lineTo(x + w * 0.5, top); g.lineTo(x + w * 0.5, baseline); g.closePath(); g.fill();
  g.fillStyle = 'rgba(7,10,20,.35)';
  g.beginPath(); g.moveTo(x + w * 0.5, top); g.lineTo(x + w - inset, top + h * 0.18); g.lineTo(x + w - inset, baseline); g.lineTo(x + w * 0.5, baseline); g.closePath(); g.fill();
  const windowY = top + h * 0.42;
  g.fillStyle = theme.glass;
  for (const wx of [x + w * 0.35, x + w * 0.61]) {
    g.globalAlpha = 0.45 + Math.sin(phase + wx) * 0.12;
    g.beginPath(); g.roundRect(wx, windowY, Math.max(2, w * 0.12), h * 0.23, [3, 3, 0, 0]); g.fill();
  }
  g.globalAlpha = 1;
}

function drawParallaxBackground(g, cam, t, theme) {
  const sky = g.createLinearGradient(0, 0, 0, VH);
  sky.addColorStop(0, theme.sky); sky.addColorStop(0.68, theme.haze); sky.addColorStop(1, theme.near);
  g.fillStyle = sky; g.fillRect(0, 0, VW, VH);

  // Slow stars and moonlit mist sit far behind the moving castle.
  for (let i = 0; i < 30; i++) {
    const x = ((i * 83 - cam * 0.035) % (VW + 18) + VW + 18) % (VW + 18) - 9;
    const y = 9 + ((i * 47) % 68);
    g.globalAlpha = 0.24 + (Math.sin(t * 1.3 + i) + 1) * 0.16;
    g.fillStyle = '#c9e2ff'; g.fillRect(x, y, i % 5 === 0 ? 1.4 : 0.8, i % 5 === 0 ? 1.4 : 0.8);
  }
  g.globalAlpha = 1;

  const ridgeOffset = (cam * 0.1) % 300;
  g.save(); g.translate(-ridgeOffset, 0);
  for (let block = -1; block < 3; block++) {
    const x = block * 300;
    g.fillStyle = 'rgba(12,18,36,.45)';
    g.beginPath(); g.moveTo(x, 117); g.lineTo(x + 42, 76); g.lineTo(x + 76, 104); g.lineTo(x + 126, 62); g.lineTo(x + 174, 108); g.lineTo(x + 218, 81); g.lineTo(x + 300, 119); g.lineTo(x + 300, 146); g.lineTo(x, 146); g.closePath(); g.fill();
    const towers = [[18, 84, 24, 44], [72, 92, 29, 52], [143, 86, 22, 39], [196, 94, 30, 57], [258, 83, 24, 43]];
    for (let i = 0; i < towers.length; i++) {
      const [dx, base, w, h] = towers[i];
      drawBackTower(g, x + dx, base + 40, w, h, theme, t + block + i);
    }
    g.fillStyle = 'rgba(137,175,209,.12)';
    g.beginPath(); g.moveTo(x + 110, 142); g.lineTo(x + 154, 82); g.lineTo(x + 174, 142); g.closePath(); g.fill();
  }
  g.restore();

  const masonryOffset = (cam * 0.54) % 32;
  g.save(); g.translate(-masonryOffset, 0); g.globalAlpha = 0.48; g.fillStyle = theme.brick;
  for (let y = 103; y < VH; y += 14) {
    const rowShift = y % 28 ? 16 : 0;
    for (let x = -40 + rowShift; x < VW + 40; x += 32) g.fillRect(x, y, 30, 12);
  }
  g.globalAlpha = 1; g.restore();

  // Mid-depth stained-glass arches slide faster than the skyline.
  const midOffset = (cam * 0.38) % 184;
  g.save(); g.translate(-midOffset, 0);
  for (let x = -184; x < VW + 184; x += 184) {
    g.fillStyle = 'rgba(11,15,29,.35)'; g.fillRect(x + 22, 31, 29, 103);
    g.beginPath(); g.arc(x + 36.5, 31, 14.5, Math.PI, 0); g.fill();
    const glass = g.createLinearGradient(x + 24, 34, x + 48, 118);
    glass.addColorStop(0, `${theme.glass}88`); glass.addColorStop(1, `${theme.glass}12`);
    g.fillStyle = glass; g.fillRect(x + 27, 35, 19, 82);
    g.beginPath(); g.arc(x + 36.5, 35, 9.5, Math.PI, 0); g.fill();
    g.strokeStyle = 'rgba(215,231,255,.18)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(x + 36.5, 27); g.lineTo(x + 36.5, 117); g.moveTo(x + 27, 67); g.lineTo(x + 46, 67); g.stroke();
    g.fillStyle = 'rgba(197,222,255,.1)'; g.beginPath(); g.moveTo(x + 36, 37); g.lineTo(x + 43, 65); g.lineTo(x + 36, 82); g.lineTo(x + 30, 65); g.closePath(); g.fill();
  }
  g.restore();

  // Near stone ribs move at a stronger rate for a clear depth cue as the player runs.
  const nearOffset = (cam * 0.72) % 128;
  g.save(); g.translate(-nearOffset, 0);
  for (let x = -128; x < VW + 128; x += 128) {
    const rib = g.createLinearGradient(x + 2, 0, x + 15, 0);
    rib.addColorStop(0, 'rgba(7,9,18,.06)'); rib.addColorStop(0.55, 'rgba(74,82,111,.3)'); rib.addColorStop(1, 'rgba(6,8,16,.48)');
    g.fillStyle = rib; g.fillRect(x + 4, 20, 13, 127);
    g.fillStyle = 'rgba(167,184,216,.12)'; g.fillRect(x + 5, 19, 1, 129);
    g.fillStyle = 'rgba(5,8,17,.35)'; g.fillRect(x - 1, 23, 23, 3); g.fillRect(x - 1, 143, 23, 4);
  }
  g.restore();

  // Warm reflected light gives the lower wall a little atmospheric depth.
  const glow = g.createRadialGradient(VW * 0.5, 135, 4, VW * 0.5, 135, 170);
  glow.addColorStop(0, 'rgba(255,205,141,.09)'); glow.addColorStop(1, 'rgba(255,205,141,0)');
  g.fillStyle = glow; g.fillRect(0, 75, VW, VH - 75);
}

async function loadDungeonStyles() {
  if (document.querySelector('link[data-dungeon-styles]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/css/dungeon.css';
  link.dataset.dungeonStyles = 'true';
  await new Promise((resolve) => {
    link.addEventListener('load', resolve, { once: true });
    link.addEventListener('error', resolve, { once: true });
    document.head.append(link);
  });
}

const SIZE = { crawler: { w: 10, h: 6 }, bat: { w: 12, h: 6 }, wisp: { w: 10, h: 12 }, sentinel: { w: 12, h: 9 }, boss: { w: 13, h: 11 } };

export default async function play(ctx) {
  const { root, act, setStats, exit, announce, toast } = ctx;
  const { ctx: g, view, destroy: destroyCanvas } = makeCanvas(root);
  const fx = new Fx();
  let stopLoop = () => {};
  let kb = null;

  setStats([['Linting', 'project…']]);
  let scan = await ctx.scan();
  const startProblems = scan.stats.problems;
  if (!scan.groups.length) {
    results(root, { title: 'NO MONSTERS', lines: ['ESLint has nothing to complain about. The castle is already clean.'], stats: [], onExit: exit });
    return () => destroyCanvas();
  }

  await loadDungeonStyles();
  await intro(root, {
    title: 'LINT DUNGEON',
    story: `${scan.stats.problems} lint findings across ${scan.stats.files} files have become monsters. Clear a short stage of two rules, then explore a new castle wing. Every defeated monster performs the lint action you chose on the real project.`,
    guide: [
      { key: '1 + X', label: 'Fix Beam', description: 'Runs ESLint autofix for this rule. Only fixable findings take damage.' },
      { key: '2 + X', label: 'Hush Whip', description: 'Adds marked eslint-disable comments for the rule in affected files.' },
      { key: '3 + X', label: 'Quest Scroll', description: 'Records the rule in LINT_QUESTLOG.md without changing source code.' },
    ],
    note: 'Each foe is one lint rule. Pick its action before your first hit; switching after a hit restores its health. Review changes in the ledger, where lint actions can be undone.',
    variant: 'dungeon-guide',
    keys: [
      ['← →', 'run'],
      ['Z / Space / ↑', 'jump (hold for higher)'],
      ['X / J', 'use selected weapon'],
      ['1 2 3 / C', 'select a weapon'],
      ['E', 'talk to Luma near the entrance'],
    ],
    start: 'ENTER THE CASTLE',
  });

  let weapon = 'fix';
  const bar = actionBar(root, WEAPONS, (id) => {
    weapon = id;
    bar.select(id);
  });
  bar.select(weapon);

  let level;
  let foes;
  let candles;
  let pickups = [];
  let sigils = [];
  let shots = [];
  let whip = null;
  let floor = 0;
  let cam = 0;
  let hp = MAX_HP;
  let slain = 0;
  let sent = 0;
  let landed = 0;
  let over = false;
  let between = false;
  let shake = 0;
  const shelved = new Set();
  const seen = new Set(); // sections visited, for the minimap
  ctx.onImpact((impact, entry) => entry && landed++);

  let stageTotal = Math.max(1, Math.ceil(scan.groups.length / 2));
  root.classList.add('dungeon-screen');
  const player = { x: 40, y: 0, w: 8, h: 13, vx: 0, vy: 0, onGround: false, face: 1, coyote: 0, jumpBuf: 0, inv: 0, knock: 0, attackCd: 0, safe: { x: 40, y: 0 }, anim: 0 };

  function enterFloor() {
    const remainingGroups = scan.groups.filter((gr) => !shelved.has(gr.rule));
    if (!remainingGroups.length) return finish();
    const groups = remainingGroups.slice(0, 2);
    level = buildLevel(groups, `floor${floor}`);
    foes = level.foes.map((f) => {
      const hpMax = bossHp(f.group.count);
      return { ...f, ...SIZE[f.kind], vx: f.kind === 'crawler' ? 28 + floor * 5 : 0, vy: 0, baseY: f.y, hp: hpMax, max: hpMax, by: null, flash: 0, immune: 0, phase: Math.random() * 6, hop: Math.max(0.8, 2 - floor * 0.15), windup: 0, dash: 0, dashDir: 1, cooldown: 1.4 };
    });
    candles = level.candles.map((c) => ({ ...c, w: 4, h: 6, lit: true }));
    pickups = [];
    // Optional ward sigils sit above the climbable ledges, away from the main route.
    sigils = [];
    for (let section = 1; section < level.sections - 1; section++) {
      const left = section * SECTION + 2;
      const right = (section + 1) * SECTION - 2;
      for (let ty = 2; ty < GROUND; ty++) {
        let platform = -1;
        for (let tx = left; tx < right; tx++) {
          if (level.solid[ty * level.w + tx]) { platform = tx; break; }
        }
        if (platform >= 0) {
          sigils.push({ x: (platform + 1) * TILE, y: ty * TILE - 12, w: 10, h: 12, section, found: false });
          break;
        }
      }
    }
    shots = [];
    Object.assign(player, { x: 40, y: (GROUND - 2) * TILE, vx: 0, vy: 0 });
    player.safe = { x: player.x, y: player.y };
    seen.clear();
    between = false;
    const name = floorName(floor);
    announce(`Stage ${floor + 1}, ${name}: ${foes.length} foes. Clear this wing to open the next.`);
    fx.float(VW / 2, 50, `FLOOR ${floor + 1}: ${name.toUpperCase()}`, '#f4f1ea', 10);
  }

  function attack() {
    if (player.attackCd > 0 || over || between) return;
    if (weapon === 'fix') {
      player.attackCd = 0.28;
      shots.push({ kind: 'beam', x: player.x + (player.face > 0 ? player.w : -6), y: player.y + 7, w: 6, h: 4, vx: 250 * player.face, vy: 0, life: 0.55 });
    } else if (weapon === 'disable') {
      player.attackCd = 0.42;
      whip = { t: 0.22, hit: new Set() };
    } else {
      player.attackCd = 0.5;
      shots.push({ kind: 'scroll', x: player.x + 2, y: player.y + 2, w: 6, h: 6, vx: 120 * player.face, vy: -210, life: 1.3, spin: 0 });
    }
  }

  function whipBox() {
    const len = 28;
    return { x: player.face > 0 ? player.x + player.w : player.x - len, y: player.y + 4, w: len, h: 7 };
  }

  function hitFoe(foe, spell) {
    if (spell === 'fix' && !foe.group.fixable) {
      if (foe.immune <= 0) fx.float(foe.x + foe.w / 2, foe.y - 6, 'IMMUNE', '#c9bfae', 7);
      foe.immune = 0.4;
      return;
    }
    if (foe.by && foe.by !== spell) {
      foe.hp = foe.max;
      fx.float(foe.x + foe.w / 2, foe.y - 6, 'WEAPON CHANGED: HP BACK', '#c9bfae', 6);
    }
    foe.by = spell;
    foe.hp--;
    foe.flash = 0.1;
    foe.x += player.x < foe.x ? 3 : -3;
    fx.burst(foe.x + foe.w / 2, foe.y + foe.h / 2, COLOR[spell], 6, 60);
    if (foe.hp > 0) return;
    foes = foes.filter((f) => f !== foe);
    slain++;
    sent++;
    if (spell === 'log') shelved.add(foe.group.rule);
    shake = reducedMotion ? 0 : 0.15;
    fx.burst(foe.x + foe.w / 2, foe.y + foe.h / 2, COLOR[spell], 26, 110);
    const partial = spell === 'fix' && foe.group.fixable < foe.group.count;
    const verb = { fix: 'FIXED', disable: 'HUSHED', log: 'LOGGED' }[spell];
    fx.float(foe.x + foe.w / 2, foe.y - 8, `${verb} ${foe.group.rule}`, COLOR[spell], 7);
    act(foe.group.id, spell).catch(() => {});
    if (partial) toast(`${foe.group.count - foe.group.fixable} of ${foe.group.rule} need a human; they return on the next floor`);
    if (!foes.length) {
      announce('The exit door is open.');
      fx.float(level.exit.x, level.exit.y - 10, 'DOOR OPEN →', '#4f7cf0', 8);
    }
  }

  function hitCandle(c) {
    if (!c.lit) return;
    c.lit = false;
    fx.burst(c.x + 2, c.y + 2, '#f2b632', 10, 50);
    pickups.push({ x: c.x, y: c.y, w: 5, h: 5, vy: -80 });
  }

  function hurt(from) {
    if (player.inv > 0) return;
    hp--;
    player.inv = 1.3;
    player.knock = 0.3;
    // a knockback that sends you back and up
    player.vx = (player.x < from.x ? -1 : 1) * 110;
    player.vy = -170;
    shake = reducedMotion ? 0 : 0.2;
    if (hp <= 0) finish('YOU PROCRASTINATED');
  }

  async function nextFloor() {
    between = true;
    fx.float(player.x, player.y - 10, 'THE WORKER SWEEPS UP…', '#f2b632', 8);
    const until = Date.now() + 20_000;
    while (landed < sent && Date.now() < until) await new Promise((r) => setTimeout(r, 150));
    if (over) return;
    scan = await ctx.scan();
    floor++;
    stageTotal = floor + Math.ceil(scan.groups.filter((group) => !shelved.has(group.rule)).length / 2);
    enterFloor();
  }

  kb = keyboard((e) => {
    const k = e.key.toLowerCase();
    if (k === 'e' && Math.abs(player.x - 118) < 34) {
      const hints = [
        'The green crawlers yield to the Fix Beam. Purple fliers need another weapon.',
        'Look up: ledges hide ward sigils. The minimap marks each one in cyan.',
        'Big rules have boss armor. Watch their jumps, then strike between landings.',
        'Candles hide hearts, and a high route may save you on the way to the exit.',
        'The throne is close. Switch weapons freely until a foe takes its first hit.',
      ];
      const hint = hints[Math.min(floor, hints.length - 1)];
      announce(`Luma: ${hint}`);
      fx.float(118, GROUND * TILE - 42, 'LUMA: KEEP CLIMBING', '#9af8f0', 8);
    }
    if (k === 'z' || k === ' ' || k === 'arrowup' || k === 'w') player.jumpBuf = 0.12;
    if (k === 'x' || k === 'j') attack();
    const w = WEAPONS.find((x) => x.key === e.key);
    if (w) weapon = w.id;
    if (k === 'c' || k === 'k') weapon = WEAPONS[(WEAPONS.findIndex((x) => x.id === weapon) + 1) % WEAPONS.length].id;
    bar.select(weapon);
  });

  async function finish(title) {
    if (over) return;
    over = true;
    stopLoop();
    while (landed < sent) await new Promise((r) => setTimeout(r, 150));
    const after = await ctx.scan();
    results(root, {
      title: title ?? (after.stats.problems ? 'CASTLE SURVIVED' : 'CASTLE CLEANSED'),
      lines: [
        title ? 'Your hearts ran out. Everything you did really happened and stays done.' : after.stats.problems ? `${after.stats.problems} problems remain: the ones you logged for later.` : 'ESLint has nothing left to say about this project.',
        'Review the diff before you commit. Every change can be undone from the ledger.',
      ],
      stats: [
        [String(startProblems), 'problems at the start'],
        [String(after.stats.problems), 'problems now'],
        [String(slain), 'foes beaten'],
        [String(floor + 1), 'floors'],
      ],
      onExit: exit,
    });
  }

  enterFloor();
  stopLoop = loop((dt, t) => {
    if (over || !level) return;
    const k = kb.down;
    const doorOpen = !foes.length;

    // ---------- player ----------
    player.inv = Math.max(0, player.inv - dt);
    player.knock = Math.max(0, player.knock - dt);
    player.attackCd = Math.max(0, player.attackCd - dt);
    player.jumpBuf = Math.max(0, player.jumpBuf - dt);
    player.coyote = player.onGround ? 0.1 : Math.max(0, player.coyote - dt);
    const knocked = player.knock > 0;
    if (!knocked && !between) {
      const dir = (k.has('ArrowRight') || k.has('d') || k.has('D') ? 1 : 0) - (k.has('ArrowLeft') || k.has('a') || k.has('A') ? 1 : 0);
      player.vx = dir * PHYS.run;
      if (dir) player.face = dir;
    }
    if (player.jumpBuf > 0 && player.coyote > 0) {
      player.vy = -PHYS.jump;
      player.jumpBuf = 0;
      player.coyote = 0;
    }
    const holding = k.has('z') || k.has('Z') || k.has(' ') || k.has('ArrowUp') || k.has('w') || k.has('W');
    player.vy += PHYS.gravity * dt * (player.vy < 0 && !holding ? 2.4 : 1);
    player.vy = Math.min(player.vy, 420);
    const moved = moveBox(level, player, player.vx * dt, player.vy * dt);
    Object.assign(player, { x: moved.x, y: moved.y, onGround: moved.onGround });
    if (moved.onGround || moved.hitTop) player.vy = 0;
    if (moved.onGround && !knocked) player.safe = { x: player.x, y: player.y };
    player.anim += Math.abs(player.vx) * dt;
    // the exit door is a wall until the floor is clear
    if (!doorOpen && player.x + player.w > level.exit.x) player.x = level.exit.x - player.w;
    if (doorOpen && !between && player.x + player.w > level.exit.x + 4) nextFloor();
    // fell into a pit
    if (player.y > level.h * TILE + 20) {
      hp--;
      Object.assign(player, { x: player.safe.x - player.face * 18, y: player.safe.y - 4, vx: 0, vy: 0, inv: 1.2 });
      if (hp <= 0) return finish('YOU PROCRASTINATED');
    }
    seen.add(Math.floor(player.x / (SECTION * TILE)));

    // ---------- weapons ----------
    if (whip) {
      whip.t -= dt;
      const box = whipBox();
      for (const f of foes) {
        if (whip.hit.has(f) || !overlap(box, f)) continue;
        whip.hit.add(f); // one lash, one hit
        hitFoe(f, 'disable');
      }
      for (const c of candles) if (overlap(box, c)) hitCandle(c);
      if (whip.t <= 0) whip = null;
    }
    for (const s of shots) {
      s.life -= dt;
      if (s.kind === 'scroll') {
        s.vy += 600 * dt;
        s.spin += dt * 14;
      }
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      const tx = Math.floor((s.x + s.w / 2) / TILE);
      const ty = Math.floor((s.y + s.h / 2) / TILE);
      if (ty >= 0 && ty < level.h && level.solid[ty * level.w + tx]) s.life = 0;
      const foe = foes.find((f) => overlap(s, f));
      if (foe) {
        s.life = 0;
        hitFoe(foe, s.kind === 'beam' ? 'fix' : 'log');
      }
      for (const c of candles) if (overlap(s, c)) hitCandle(c);
    }
    shots = shots.filter((s) => s.life > 0);

    // ---------- foes ----------
    for (const f of foes) {
      f.flash = Math.max(0, f.flash - dt);
      f.immune = Math.max(0, f.immune - dt);
      const near = Math.abs(f.x - player.x) < 160;
      if (f.kind === 'crawler') {
        const m = moveBox(level, f, f.vx * dt, 60 * dt);
        const ahead = Math.floor((f.vx > 0 ? m.x + f.w + 1 : m.x - 1) / TILE);
        const below = Math.floor((m.y + f.h + 2) / TILE);
        if (m.hitX || !level.solid[below * level.w + ahead]) f.vx = -f.vx;
        f.x = m.x;
        f.y = m.y;
      } else if (f.kind === 'bat') {
        if (near) f.x += Math.sign(player.x - f.x) * (30 + floor * 5) * dt;
        f.y = f.baseY + Math.sin(t * 2.4 + f.phase) * 18 + (near ? Math.min(30, Math.max(-10, player.y - f.baseY)) * 0.6 : 0);
      } else if (f.kind === 'wisp') {
        if (near) f.x += Math.sign(player.x - f.x) * (18 + floor * 3) * dt;
        f.x = Math.max(TILE, Math.min(level.w * TILE - f.w - TILE, f.x));
        f.y = f.baseY + Math.sin(t * 2.8 + f.phase) * 22 + (near ? Math.min(38, Math.max(-18, player.y - f.baseY)) * 0.35 : 0);
      } else if (f.kind === 'sentinel') {
        f.cooldown = Math.max(0, f.cooldown - dt);
        f.vy += PHYS.gravity * dt;
        let dx = 0;
        if (f.windup > 0) {
          f.windup -= dt;
          if (f.windup <= 0) f.dash = 0.42;
        } else if (f.dash > 0) {
          dx = f.dashDir * (125 + floor * 7);
          f.dash -= dt;
        } else {
          if (near) dx = Math.sign(player.x - f.x) * (18 + floor * 2);
          if (near && Math.abs(player.x - f.x) < 132 && f.cooldown <= 0) {
            f.dashDir = Math.sign(player.x - f.x) || 1;
            f.windup = 0.55;
            f.cooldown = 2.1;
            fx.float(f.x + f.w / 2, f.y - 8, 'CHARGING!', '#ff9b74', 7);
          }
        }
        const m = moveBox(level, f, dx * dt, f.vy * dt);
        if (m.onGround) f.vy = 0;
        if (m.hitX) f.dash = 0;
        f.x = m.x;
        f.y = m.y;
      } else {
        f.hop -= dt;
        f.vy += PHYS.gravity * dt;
        const dir = near ? Math.sign(player.x - f.x) : 0;
        const m = moveBox(level, f, dir * (22 + floor * 3) * dt, f.vy * dt);
        if (m.onGround) {
          f.vy = 0;
          if (f.hop <= 0 && near) {
            f.vy = -230;
            f.hop = Math.max(0.9, 2.2 - floor * 0.15);
          }
        }
        f.x = m.x;
        f.y = m.y;
      }
      if (overlap(player, f)) hurt(f);
    }
    for (const p of pickups) {
      p.vy += 400 * dt;
      const m = moveBox(level, p, 0, p.vy * dt);
      p.y = m.y;
      if (m.onGround) p.vy = 0;
      if (overlap(player, p)) {
        p.taken = true;
        hp = Math.min(MAX_HP, hp + 1);
        fx.float(player.x, player.y - 6, '+1 HEART', '#c7361d', 7);
      }
    }
    pickups = pickups.filter((p) => !p.taken);
    for (const sigil of sigils) {
      if (sigil.found || !overlap(player, sigil)) continue;
      sigil.found = true;
      hp = Math.min(MAX_HP, hp + 1);
      fx.burst(sigil.x + 5, sigil.y + 5, '#50d5e8', 16, 80);
      fx.float(player.x, player.y - 8, 'WARD SIGIL + HEART', '#7ce8ff', 8);
      announce(`Ward sigil found in section ${sigil.section}. One heart restored.`);
    }
    fx.step(dt);
    shake = Math.max(0, shake - dt);
    cam += (Math.max(0, Math.min(level.w * TILE - VW, player.x - VW / 2 + player.face * 30)) - cam) * Math.min(1, dt * 6);

    // ---------- draw ----------
    const W = view.w;
    const H = view.h;
    const scale = Math.max(1, Math.min(W / VW, H / VH));
    const ox = (W - VW * scale) / 2;
    const oy = (H - VH * scale) / 2;
    const theme = THEMES[floor % THEMES.length];
    g.fillStyle = '#0e0d13';
    g.fillRect(0, 0, W, H);
    g.save();
    g.translate(ox + (shake > 0 ? (Math.random() - 0.5) * 6 : 0), oy);
    g.scale(scale, scale);
    g.beginPath();
    g.rect(0, 0, VW, VH);
    g.clip();
    // Layered sprite-like scenery shifts at several rates to create a 3D parallax view.
    drawParallaxBackground(g, cam, t, theme);
    g.translate(-Math.round(cam), 0);
    // tiles
    const tx0 = Math.floor(cam / TILE);
    for (let ty = 0; ty < level.h; ty++) {
      for (let tx = tx0; tx < tx0 + VW / TILE + 2; tx++) {
        if (!level.solid[ty * level.w + tx]) continue;
        const x = tx * TILE;
        const y = ty * TILE;
        g.fillStyle = theme.stone;
        g.fillRect(x, y, TILE, TILE);
        g.fillStyle = theme.edge;
        g.fillRect(x, y, TILE, 2);
        g.fillStyle = theme.seam;
        g.fillRect(x + (ty % 2 ? 0 : 8), y + 8, 1, 8);
        g.fillRect(x, y + 8, TILE, 1);
      }
    }
    // exit door, Metroid style: red and shut until the floor is clear
    g.fillStyle = doorOpen ? '#4f7cf0' : '#c7361d';
    g.fillRect(level.exit.x, level.exit.y, 6, 3 * TILE);
    g.fillStyle = '#1d1b16';
    g.fillRect(level.exit.x + 6, level.exit.y, 2, 3 * TILE);
    for (const c of candles) {
      if (!c.lit) continue;
      drawCandle(g, c.x, c.y, t);
    }
    drawGuide(g, 118, floor, t);
    for (const p of pickups) drawHeart(g, p.x, p.y);
    for (const sigil of sigils) if (!sigil.found) drawSigil(g, sigil.x, sigil.y, t);
    for (const f of foes) {
      // green can be fixed, plum is immune to the Fix Beam, red will not even parse
      const tint = f.flash > 0 ? '#fffdf8' : f.immune > 0 ? '#6b665c' : f.group.rule === 'parse-error' ? '#c7361d' : f.group.fixable ? '#17a673' : '#9b3d78';
      if (f.kind === 'crawler') drawCrawler(g, f.x, f.y, t, tint);
      else if (f.kind === 'bat') drawBat(g, f.x, f.y, t, tint);
      else if (f.kind === 'wisp') drawWisp(g, f.x, f.y, t, tint);
      else if (f.kind === 'sentinel') drawSentinel(g, f.x, f.y, t, tint, f.windup > 0);
      else drawBoss(g, f.x, f.y, t, tint);
      // HP pips
      for (let i = 0; i < f.max; i++) {
        g.fillStyle = i < f.hp ? (f.by ? COLOR[f.by] : '#f4f1ea') : '#3a3744';
        g.fillRect(f.x + i * 3, f.y - 14, 2, 2);
      }
    }
    for (const s of shots) {
      g.fillStyle = s.kind === 'beam' ? COLOR.fix : COLOR.log;
      if (s.kind === 'beam') g.fillRect(s.x, s.y, s.w, s.h);
      else {
        g.save();
        g.translate(s.x + 3, s.y + 3);
        g.rotate(s.spin);
        g.fillRect(-3, -2, 6, 4);
        g.fillStyle = '#fffdf8';
        g.fillRect(-2, -1, 4, 1);
        g.restore();
      }
    }
    if (whip) {
      const b = whipBox();
      g.fillStyle = COLOR.disable;
      const reach = b.w * Math.min(1, (0.22 - whip.t) / 0.08);
      g.fillRect(player.face > 0 ? b.x : b.x + b.w - reach, b.y + 1, reach, 2);
      g.fillRect(player.face > 0 ? b.x + reach - 3 : b.x + b.w - reach, b.y, 3, 4);
    }
    if (!(player.inv > 0 && !reducedMotion && Math.floor(t * 14) % 2)) {
      const running = player.onGround && Math.abs(player.vx) > 0 && Math.floor(player.anim / 8) % 2;
      drawHero(g, player.x, player.y, player.face, running, t);
    }
    fx.draw(g);
    g.restore();

    // ---------- screen-space overlay: labels, hearts, minimap ----------
    g.textAlign = 'center';
    g.font = '600 11px "IBM Plex Mono", monospace';
    for (const f of foes) {
      const sx = ox + (f.x + f.w / 2 - cam) * scale;
      if (sx < ox - 60 || sx > ox + VW * scale + 60) continue;
      const label = `${truncate(f.group.rule, 20)} ×${f.group.count}`;
      const sy = oy + (f.y - 18) * scale;
      const w = g.measureText(label).width + 10;
      g.fillStyle = 'rgba(255,253,248,0.92)';
      g.fillRect(sx - w / 2, sy - 13, w, 16);
      g.fillStyle = '#1d1b16';
      g.fillText(label, sx, sy);
    }
    g.fillStyle = 'rgba(15,17,28,.88)'; g.beginPath(); g.roundRect(ox + 8, oy + 7, 104, 26, 7); g.fill();
    g.fillStyle = '#f2ead8'; g.font = '700 7px "IBM Plex Mono", monospace'; g.textAlign = 'left'; g.fillText('HP', ox + 15, oy + 23);
    for (let i = 0; i < MAX_HP; i++) drawHudHeart(g, ox + 39 + i * 11, oy + 20, i < hp);
    const titleText = `STAGE ${String(floor + 1).padStart(2, '0')} · ${floorName(floor).toUpperCase()}`;
    g.fillStyle = 'rgba(15,17,28,.88)'; g.beginPath(); g.roundRect(ox + VW * scale / 2 - 89, oy + 7, 178, 27, 7); g.fill();
    g.fillStyle = '#fff8e8'; g.font = '700 8px "IBM Plex Mono", monospace'; g.textAlign = 'center'; g.fillText(titleText, ox + VW * scale / 2, oy + 18);
    g.fillStyle = doorOpen ? '#80d6ff' : COLOR[weapon]; g.font = '600 6px "IBM Plex Mono", monospace';
    g.fillText(doorOpen ? 'EXIT OPEN · KEEP GOING →' : `${WEAPONS.find((item) => item.id === weapon)?.label.toUpperCase()} · ${foes.length} FOE${foes.length === 1 ? '' : 'S'} LEFT`, ox + VW * scale / 2, oy + 28);
    const mw = 10;
    const mx = ox + VW * scale - level.sections * (mw + 2) - 10;
    g.fillStyle = 'rgba(15,17,28,.72)'; g.beginPath(); g.roundRect(mx - 5, oy + 6, level.sections * (mw + 2) + 10, 26, 6); g.fill();
    for (let s = 0; s < level.sections; s++) {
      const here = Math.floor(player.x / (SECTION * TILE)) === s;
      const left = foes.some((f) => f.section === s);
      g.fillStyle = here ? '#f2b632' : seen.has(s) ? '#4f7cf0' : '#2a2833';
      g.fillRect(mx + s * (mw + 2), oy + 10, mw, 7);
      if (left) {
        g.fillStyle = '#c7361d';
        g.fillRect(mx + s * (mw + 2) + 4, oy + 12, 2, 3);
      }
      if (sigils.some((sigil) => sigil.section === s && !sigil.found)) {
        g.fillStyle = '#50d5e8';
        g.fillRect(mx + s * (mw + 2) + 4, oy + 20, 2, 2);
      }
    }

    setStats([
      ['Floor', `${floor + 1}/${Math.max(stageTotal, floor + 1)} · ${floorName(floor)}`],
      ['Foes left', String(foes.length)],
      ['Beaten', String(slain)],
      ['Fixed for real', String(ctx.impact().fixed ?? 0)],
      ['Hearts', `${hp}/${MAX_HP}`],
    ]);
  });

  return () => {
    over = true;
    stopLoop();
    kb?.destroy();
    destroyCanvas();
    root.classList.remove('dungeon-screen');
  };
}
