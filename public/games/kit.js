// Bits every cabinet shares: a crisp full-size canvas, a frame loop,
// keyboard input, overlays and a little particle fizz.

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function makeCanvas(root) {
  const canvas = document.createElement('canvas');
  root.append(canvas);
  const ctx = canvas.getContext('2d');
  const view = { w: 0, h: 0 };
  const fit = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = root.getBoundingClientRect();
    view.w = r.width;
    view.h = r.height;
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  fit();
  const ro = new ResizeObserver(fit);
  ro.observe(root);
  return { canvas, ctx, view, destroy: () => ro.disconnect() };
}

export function loop(step) {
  let last = performance.now();
  let id = requestAnimationFrame(function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    step(dt, now / 1000);
    id = requestAnimationFrame(frame);
  });
  return () => cancelAnimationFrame(id);
}

export function keyboard(onPress) {
  const down = new Set();
  const kd = (e) => {
    if (e.target.closest?.('input, textarea')) return;
    if (!down.has(e.key)) onPress?.(e);
    down.add(e.key);
    if ([' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) e.preventDefault();
  };
  const ku = (e) => down.delete(e.key);
  window.addEventListener('keydown', kd);
  window.addEventListener('keyup', ku);
  return { down, destroy: () => (window.removeEventListener('keydown', kd), window.removeEventListener('keyup', ku)) };
}

/** Show a modal card over the game. `buttons` is [{label, onClick}]. */
export function overlay(root, html, buttons = []) {
  const el = document.createElement('div');
  el.className = 'overlay';
  el.innerHTML = `<div class="card">${html}<div class="actions"></div></div>`;
  const actions = el.querySelector('.actions');
  for (const b of buttons) {
    const btn = document.createElement('button');
    btn.className = b.ghost ? 'ghost' : 'big';
    btn.textContent = b.label;
    btn.style.margin = '6px';
    btn.addEventListener('click', () => {
      el.remove();
      b.onClick?.();
    });
    actions.append(btn);
  }
  root.append(el);
  el.querySelector('.big')?.focus();
  return el;
}

/** An intro card that resolves when the player presses start. */
export function intro(root, { title, story, keys, start = 'START' }) {
  return new Promise((resolve) => {
    const rows = keys.map(([k, v]) => `<span>${k.split(' ').map((x) => `<kbd>${esc(x)}</kbd>`).join(' ')}</span><span>${esc(v)}</span>`).join('');
    overlay(root, `<h2>${esc(title)}</h2><p>${esc(story)}</p><div class="keys">${rows}</div>`, [{ label: start, onClick: resolve }]);
  });
}

export function results(root, { title, lines, stats, onAgain, onExit }) {
  const cells = stats.map(([v, k]) => `<div><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('');
  overlay(root, `<h2>${esc(title)}</h2>${lines.map((l) => `<p>${esc(l)}</p>`).join('')}<div class="results">${cells}</div>`, [
    ...(onAgain ? [{ label: 'PLAY AGAIN', onClick: onAgain }] : []),
    { label: 'Back to the arcade', ghost: true, onClick: onExit },
  ]);
}

export class Fx {
  constructor() {
    this.parts = [];
    this.texts = [];
  }
  burst(x, y, color, n = 24, speed = 220) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.3 + Math.random());
      this.parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.6 + Math.random() * 0.5, color });
    }
  }
  float(x, y, text, color = '#a3e635', size = 16) {
    this.texts.push({ x, y, text, color, size, life: 1.2 });
  }
  step(dt) {
    for (const p of this.parts) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.96;
      p.vy *= 0.96;
      p.life -= dt;
    }
    for (const t of this.texts) {
      t.y -= 40 * dt;
      t.life -= dt;
    }
    this.parts = this.parts.filter((p) => p.life > 0);
    this.texts = this.texts.filter((t) => t.life > 0);
  }
  draw(ctx) {
    for (const p of this.parts) {
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life * 1.5));
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
    }
    ctx.textAlign = 'center';
    for (const t of this.texts) {
      ctx.globalAlpha = Math.max(0, Math.min(1, t.life));
      ctx.fillStyle = t.color;
      ctx.font = `800 ${t.size}px ui-monospace, Consolas, monospace`;
      ctx.fillText(t.text, t.x, t.y);
    }
    ctx.globalAlpha = 1;
  }
}

export function stars(n = 120) {
  return Array.from({ length: n }, () => ({ x: Math.random(), y: Math.random(), z: 0.2 + Math.random() * 0.8 }));
}

export function drawStars(ctx, view, field, dt, speed = 0.03) {
  ctx.fillStyle = '#cbd5ff';
  for (const s of field) {
    s.y += speed * s.z * dt;
    if (s.y > 1) s.y -= 1;
    ctx.globalAlpha = 0.25 + s.z * 0.5;
    ctx.fillRect(s.x * view.w, s.y * view.h, s.z * 2, s.z * 2);
  }
  ctx.globalAlpha = 1;
}

export function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** A button bar of actions, for mouse and touch players. */
export function actionBar(root, actions, onPick) {
  const bar = document.createElement('div');
  bar.className = 'bar';
  for (const a of actions) {
    const b = document.createElement('button');
    b.dataset.id = a.id;
    b.style.setProperty('--c', a.color ?? '#22d3ee');
    b.innerHTML = `<i></i>${a.key ? `<kbd>${esc(a.key)}</kbd>` : ''} ${esc(a.label)}`;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onPick(a.id);
    });
    bar.append(b);
  }
  root.append(bar);
  return {
    el: bar,
    select(id) {
      for (const b of bar.children) b.classList.toggle('on', b.dataset.id === id);
    },
  };
}
