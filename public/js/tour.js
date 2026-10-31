// Own the tour's state, listeners and timers independently of the arcade floor.
const TITLES = ['Welcome to ChoreCade!', 'The Game Cabinets', 'Progress Tracking', 'The Ledger', 'Google Integration', 'The Four Games', "You're Ready!"];

export function setupTour() {
  const get = (id) => document.getElementById(id);
  const overlay = get('tour-overlay');
  if (!overlay) return;
  const steps = [...overlay.querySelectorAll('.tour-step')];
  const listeners = new AbortController();
  let step = 0;
  let open = false;
  let highlighted = [];
  let highlightTimer;

  function clearHighlights() {
    clearTimeout(highlightTimer);
    for (const element of highlighted) element.classList.remove('tour-highlighted');
    highlighted = [];
  }

  function show(index) {
    if (!steps.length) return;
    step = Math.max(0, Math.min(index, steps.length - 1));
    clearHighlights();
    steps.forEach((element, i) => element.classList.toggle('hidden', i !== step));
    get('tour-step-num').textContent = step + 1;
    get('tour-total').textContent = steps.length;
    get('tour-prev').disabled = step === 0;
    get('tour-next').textContent = step === steps.length - 1 ? 'Finish' : 'Next →';
    get('tour-title').textContent = TITLES[step] ?? TITLES[0];
    const target = steps[step].querySelector('.tour-highlight')?.dataset.target;
    if (target) highlightTimer = setTimeout(() => {
      if (!open) return;
      highlighted = [...document.querySelectorAll(target)];
      for (const element of highlighted) element.classList.add('tour-highlighted');
    }, 150);
  }

  function start() {
    clearTimeout(automaticTimer);
    if (open) return;
    open = true;
    overlay.classList.remove('hidden');
    document.body.classList.add('tour-open');
    show(0);
    get('tour-close').focus();
  }

  function close() {
    clearTimeout(automaticTimer);
    if (!open) return;
    open = false;
    clearHighlights();
    overlay.classList.add('hidden');
    document.body.classList.remove('tour-open');
    get('tour-btn')?.focus();
  }

  const next = () => step === steps.length - 1 ? close() : show(step + 1);
  const on = (element, type, handler) => element?.addEventListener(type, handler, { signal: listeners.signal });
  for (const [id, action] of [['tour-btn', start], ['tour-close', close], ['tour-next', next], ['tour-prev', () => show(step - 1)]]) {
    on(get(id), 'click', action);
  }
  on(overlay, 'click', (event) => {
    if (event.target === overlay || event.target.classList.contains('tour-backdrop')) close();
  });
  on(document, 'keydown', (event) => {
    if (!open) return;
    if (event.key === 'Escape') close();
    else if (event.key === 'ArrowRight') next();
    else if (event.key === 'ArrowLeft') show(step - 1);
    else return; // Let Enter activate the focused button normally.
    event.preventDefault();
  });
  const automaticTimer = setTimeout(start, 500);
  return () => {
    close();
    clearHighlights();
    listeners.abort();
  };
}
