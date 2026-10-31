// Receipt Rush. Merchant cards arrive against the clock; filing one files
// every transaction from that merchant, and the budget on the right is the
// real report being written as you play.
import { esc, intro, keyboard, results } from './kit.js';
import { fmt } from '../js/api.js';

const STYLE = `
.rr { position:absolute; inset:0; display:grid; grid-template-columns:minmax(0,1fr) minmax(260px,340px); gap:18px; padding:18px; }
.rr-main { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:16px; min-width:0; }
.rr-deck { position:relative; width:min(440px,100%); height:250px; }
.rr-card { position:absolute; inset:0; background:linear-gradient(160deg,#1c2747,#0f1629); border:1px solid #2b3b63; border-radius:18px; padding:22px; display:flex; flex-direction:column; gap:8px; box-shadow:0 30px 60px -30px #000; transition:transform .25s, opacity .25s; touch-action:none; cursor:grab; user-select:none; }
.rr-card.ghost { transform:translateY(10px) scale(.96); opacity:.5; pointer-events:none; }
.rr-card.out-r { transform:translateX(130%) rotate(18deg); opacity:0; }
.rr-card.out-l { transform:translateX(-130%) rotate(-18deg); opacity:0; }
.rr-card.out-u { transform:translateY(-120%); opacity:0; }
.rr-merchant { font:800 24px ui-monospace,Consolas,monospace; letter-spacing:.02em; word-break:break-word; }
.rr-desc { color:#8a97b8; font:12px ui-monospace,Consolas,monospace; }
.rr-amount { font:800 34px ui-monospace,Consolas,monospace; }
.rr-amount.in { color:#4ade80 } .rr-amount.out { color:#fda4af }
.rr-flags { display:flex; gap:6px; flex-wrap:wrap; }
.rr-flags span { font-size:11px; padding:2px 8px; border-radius:999px; background:#3b0d18; color:#fda4af; border:1px solid #f43f5e55; }
.rr-flags span.rec { background:#2e1065; color:#d8b4fe; border-color:#a855f755; }
.rr-guess { margin-top:auto; font-size:13px; color:#8a97b8; }
.rr-guess b { color:var(--c,#22d3ee); }
.rr-timer { width:min(440px,100%); height:6px; background:#141d36; border-radius:99px; overflow:hidden; }
.rr-timer i { display:block; height:100%; background:linear-gradient(90deg,#f43f5e,#fbbf24,#a3e635); transform-origin:left; }
.rr-cats { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:8px; width:min(640px,100%); }
.rr-cats button { background:#0f1629; border:1px solid #22304f; border-radius:10px; padding:9px 4px; font:12px ui-monospace,Consolas,monospace; color:#e6ecff; }
.rr-cats button:hover, .rr-cats button.sug { border-color:var(--c); box-shadow:0 0 0 1px var(--c), 0 0 16px -6px var(--c); }
.rr-cats kbd { margin-right:4px; }
.rr-side { background:#0f1629; border:1px solid #22304f; border-radius:14px; padding:16px; overflow:auto; }
.rr-side h4 { margin:0 0 10px; font:700 13px ui-monospace,Consolas,monospace; color:#8a97b8; }
.rr-row { margin:8px 0; font-size:12px; }
.rr-row div { display:flex; justify-content:space-between; font-family:ui-monospace,Consolas,monospace; }
.rr-row i { display:block; height:6px; border-radius:99px; background:var(--c); margin-top:4px; transition:width .3s; }
.rr-subs { margin-top:16px; padding-top:12px; border-top:1px solid #22304f; font-size:12px; color:#d8b4fe; font-family:ui-monospace,Consolas,monospace; }
.rr-hint { color:#8a97b8; font-size:12px; text-align:center; }
@media (max-width: 760px) { .rr { grid-template-columns:1fr; overflow:auto; } .rr-cats { grid-template-columns:repeat(3,minmax(0,1fr)); } }
`;

export default async function play(ctx) {
  const { root, chore, act, setStats, exit } = ctx;
  const style = document.createElement('style');
  style.textContent = STYLE;
  root.append(style);
  setStats([['Scanning', 'transactions…']]);
  const scan = await ctx.scan();
  const deck = [...scan.groups];
  const cats = chore.actions.filter((a) => a.id.startsWith('cat:'));
  const colorOf = Object.fromEntries(chore.actions.map((a) => [a.id, a.color]));

  if (!deck.length) {
    results(root, { title: 'ALL FILED', lines: ['Every transaction in this export already has a category.'], stats: [], onExit: exit });
    return () => {};
  }

  await intro(root, {
    title: 'RECEIPT RUSH',
    story: `${scan.stats.open} unfiled transactions from ${deck.length} merchants. Each card is one merchant: file it and every charge from them is filed. Beat the clock to keep your streak. The categorised CSV, a report and next month's rules are rewritten after every card.`,
    keys: [
      ['Space', 'accept the suggestion (or swipe right)'],
      ['1 … 0', 'pick a category'],
      ['F', 'flag for review (or swipe up)'],
      ['S', 'skip, it comes back later (or swipe left)'],
    ],
  });

  const ui = document.createElement('div');
  ui.className = 'rr';
  ui.innerHTML = `<div class="rr-main">
      <div class="rr-deck"></div>
      <div class="rr-timer"><i></i></div>
      <div class="rr-cats">${cats.map((c) => `<button data-a="${esc(c.id)}" style="--c:${esc(c.color)}"><kbd>${esc(c.key)}</kbd>${esc(c.label)}</button>`).join('')}</div>
      <div class="rr-hint">Swipe right = accept · up = flag · left = skip</div>
    </div>
    <aside class="rr-side"><h4>YOUR BUDGET, AS IT IS WRITTEN</h4><div class="rr-bars"></div><div class="rr-subs"></div></aside>`;
  root.append(ui);
  const deckEl = ui.querySelector('.rr-deck');
  const timerEl = ui.querySelector('.rr-timer i');

  const tally = {};
  const subs = new Map();
  let score = 0;
  let streak = 0;
  let filed = 0;
  let skipped = 0;
  let card = null;
  let deadline = 0;
  let budget = 7;
  let raf = 0;
  let done = false;

  function renderSide() {
    const entries = Object.entries(tally).sort((a, b) => a[1] - b[1]);
    const max = Math.max(1, ...entries.map(([, v]) => Math.abs(v)));
    ui.querySelector('.rr-bars').innerHTML =
      entries
        .map(
          ([cat, v]) =>
            `<div class="rr-row" style="--c:${esc(colorOf[`cat:${cat}`])}"><div><span>${esc(cat)}</span><span>${fmt.money(v)}</span></div><i style="width:${(Math.abs(v) / max) * 100}%"></i></div>`,
        )
        .join('') || '<p class="rr-hint">File a card to start your report.</p>';
    const monthly = [...subs.values()].reduce((s, v) => s + v, 0);
    ui.querySelector('.rr-subs').textContent = subs.size ? `🔁 ${subs.size} subscriptions found: ${fmt.money(monthly)}/mo · ${fmt.money(monthly * 12)}/yr` : '';
  }

  function cardHtml(group) {
    const sug = group.suggestion;
    const flags = group.flags.map((f) => `<span class="${f === 'recurring' ? 'rec' : ''}">${esc(f)}</span>`).join('');
    return `<div class="rr-merchant">${esc(group.label)}</div>
      <div class="rr-desc">${esc(group.detail)} · ${group.count} transaction${group.count > 1 ? 's' : ''}</div>
      <div class="rr-amount ${group.total >= 0 ? 'in' : 'out'}">${fmt.money(group.total)}</div>
      <div class="rr-flags">${flags}</div>
      <div class="rr-guess" style="--c:${esc(colorOf[sug] ?? '#94a3b8')}">${sug ? `ChoreCade guesses <b>${esc(sug.slice(4))}</b>${group.remembered ? ' (from your rules)' : ''}` : 'No idea what this is. Your call.'}</div>`;
  }

  function deal() {
    deckEl.innerHTML = '';
    if (!deck.length) return finish();
    if (deck[1]) {
      const ghost = document.createElement('div');
      ghost.className = 'rr-card ghost';
      ghost.innerHTML = cardHtml(deck[1]);
      deckEl.append(ghost);
    }
    card = { group: deck.shift(), el: document.createElement('div') };
    card.el.className = 'rr-card';
    card.el.innerHTML = cardHtml(card.group);
    deckEl.append(card.el);
    for (const b of ui.querySelectorAll('.rr-cats button')) b.classList.toggle('sug', b.dataset.a === card.group.suggestion);
    budget = Math.max(3.5, 7 - filed * 0.08);
    deadline = performance.now() + budget * 1000;
    drag(card);
  }

  function resolve(action, dir = 'r') {
    if (!card || done) return;
    const { group, el } = card;
    card = null;
    el.classList.add(`out-${dir}`);
    if (action === 'skip') {
      deck.push(group);
      skipped++;
      streak = 0;
    } else {
      const wise = action === group.suggestion;
      const fast = deadline - performance.now() > (budget * 1000) / 2;
      streak = wise || fast ? streak + 1 : 0;
      score += Math.round((100 + group.count * 5) * (wise ? 2 : 1) * (fast ? 1.5 : 1) * (1 + streak * 0.1));
      filed += group.count;
      if (action.startsWith('cat:')) {
        const cat = action.slice(4);
        tally[cat] = (tally[cat] ?? 0) + group.total;
        if (cat === 'Subscriptions' && group.flags.includes('recurring')) subs.set(group.label, Math.abs(group.total / group.count));
      }
      act(group.id, action).catch(() => {});
      renderSide();
    }
    setTimeout(deal, 180);
  }

  function drag(c) {
    let start = null;
    c.el.addEventListener('pointerdown', (e) => {
      start = { x: e.clientX, y: e.clientY };
      c.el.setPointerCapture(e.pointerId);
      c.el.style.transition = 'none';
    });
    c.el.addEventListener('pointermove', (e) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      c.el.style.transform = `translate(${dx}px, ${Math.min(0, dy)}px) rotate(${dx / 20}deg)`;
    });
    c.el.addEventListener('pointerup', (e) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      start = null;
      c.el.style.transition = '';
      c.el.style.transform = '';
      if (dy < -90 && Math.abs(dy) > Math.abs(dx)) resolve('flag', 'u');
      else if (dx > 110 && c.group.suggestion) resolve(c.group.suggestion, 'r');
      else if (dx < -110) resolve('skip', 'l');
    });
  }

  ui.querySelector('.rr-cats').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) resolve(b.dataset.a);
  });

  const kb = keyboard((e) => {
    if (!card) return;
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'enter') {
      if (card.group.suggestion) resolve(card.group.suggestion);
      return;
    }
    if (k === 'f') return resolve('flag', 'u');
    if (k === 's' || k === 'arrowleft') return resolve('skip', 'l');
    const cat = cats.find((c) => c.key === k);
    if (cat) resolve(cat.id);
  });

  function tick() {
    if (done) return;
    if (card) {
      const left = Math.max(0, deadline - performance.now()) / (budget * 1000);
      timerEl.style.transform = `scaleX(${left})`;
      if (left <= 0) resolve('skip', 'l');
    }
    setStats([
      ['Score', score.toLocaleString()],
      ['Streak', streak > 1 ? `×${streak}` : '-'],
      ['Merchants left', String(deck.length + (card ? 1 : 0))],
      ['Transactions filed', `${filed} / ${scan.stats.open}`],
      ['Skipped', String(skipped)],
    ]);
    raf = requestAnimationFrame(tick);
  }

  function finish() {
    done = true;
    const monthly = [...subs.values()].reduce((s, v) => s + v, 0);
    results(root, {
      title: 'BOOKS BALANCED',
      lines: [
        `Your categorised CSV, expense-report.md and merchant-rules.json are in ${chore.target.replace(/[\\/][^\\/]+$/, '')}.`,
        subs.size ? `You are paying ${fmt.money(monthly * 12)} a year across ${subs.size} subscriptions.` : '',
      ].filter(Boolean),
      stats: [
        [score.toLocaleString(), 'score'],
        [filed.toLocaleString(), 'transactions filed'],
        [String(subs.size), 'subscriptions'],
      ],
      onExit: exit,
    });
  }

  renderSide();
  deal();
  raf = requestAnimationFrame(tick);
  return () => {
    done = true;
    cancelAnimationFrame(raf);
    kb.destroy();
  };
}
