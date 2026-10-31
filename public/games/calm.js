// Calm mode: the same chore with no timer and no canvas. A plain table of
// groups, a native <select> per row and an Apply button, so it works with a
// keyboard, a screen reader, a switch device or simply a tired brain.
import { esc } from './kit.js';

export default async function calm(ctx) {
  const { root, chore, act, announce, setStats } = ctx;
  const label = Object.fromEntries(chore.actions.map((a) => [a.id, a.label]));
  let groups = [];
  let handled = 0;
  // The root outlives this session and is reused by the next game, so its listeners must go when we leave.
  const listening = new AbortController();
  const { signal } = listening;

  const tags = (g) => {
    const out = [];
    if (g.risk === 'high') out.push(`<span class="tag warn">${g.kind === 'person' ? 'a person' : 'check this'}</span>`);
    for (const f of g.flags ?? []) out.push(`<span class="tag${/duplicate|large/.test(f) ? ' warn' : ''}">${esc(f)}</span>`);
    if (g.aiSuggested) out.push('<span class="tag">Claude suggests</span>');
    return out.join('');
  };

  const options = (g) =>
    (g.suggestion ? '' : '<option value="">Choose…</option>') +
    chore.actions.map((a) => `<option value="${esc(a.id)}"${a.id === g.suggestion ? ' selected' : ''}>${esc(a.label)}${a.id === g.suggestion ? ' (suggested)' : ''}</option>`).join('');

  const lowRisk = () => groups.filter((g) => !g.done && g.risk === 'low' && g.suggestion);
  const rowOf = (i) => root.querySelector(`tr[data-i="${i}"]`);

  function render(scan) {
    groups = scan.groups;
    handled = 0;
    root.innerHTML = `<div class="calm">
    <div class="calm-head">
      <p>${groups.length} groups, ${scan.stats.remaining.toLocaleString()} ${esc(chore.unit)}. Each row is one group: pick an action and press Apply. Nothing happens until you do, and every change can be undone from the ledger.</p>
      <button class="btn" type="button" id="calm-all"></button>
    </div>
    <table>
      <caption>${esc(chore.chore)}</caption>
      <thead><tr><th scope="col">Group</th><th scope="col" class="num">Items</th><th scope="col">Action</th><th scope="col"><span class="sr-only">Apply</span></th></tr></thead>
      <tbody>${groups
        .map(
          (g, i) => `<tr data-i="${i}">
            <th scope="row">${esc(g.label)}${tags(g)}<br><small>${esc(g.detail ?? '')}</small></th>
            <td class="num">${g.count.toLocaleString()}</td>
            <td><label class="sr-only" for="act-${i}">Action for ${esc(g.label)}</label><select id="act-${i}">${options(g)}</select></td>
            <td><button class="btn quiet" type="button" data-apply="${i}"${g.suggestion ? '' : ' disabled'}>Apply</button><span class="row-err"></span></td>
          </tr>`,
        )
        .join('')}</tbody>
    </table>
  </div>`;
    refresh();
    root.querySelector('select')?.focus();
  }

  const refresh = () => {
    const allBtn = root.querySelector('#calm-all');
    if (!allBtn) return;
    const n = lowRisk().length;
    allBtn.textContent = `Apply suggestions to ${n} low-risk group${n === 1 ? '' : 's'}`;
    allBtn.disabled = n === 0;
    setStats([
      ['Handled', `${handled} / ${groups.length}`],
      ['Left', `${groups.length - handled}`],
    ]);
  };

  async function rescan() {
    root.innerHTML = '<div class="calm"><p>Scanning again…</p></div>';
    try {
      render(await ctx.scan());
      announce('That group had changed, so the list was scanned again.');
    } catch (err) {
      root.innerHTML = `<div class="calm"><p>Could not scan: ${esc(err.message)}</p></div>`;
      announce(`Could not scan: ${err.message}`);
    }
  }

  /** Put a row back the way it was so the move can be tried again. */
  function failed(g, i, message) {
    g.done = false;
    handled--;
    const row = rowOf(i);
    row.classList.remove('done');
    row.querySelector('select').disabled = false;
    const btn = row.querySelector('button');
    btn.disabled = false;
    btn.textContent = 'Retry';
    row.querySelector('.row-err').textContent = message;
    refresh();
  }

  async function apply(i, action) {
    const g = groups[i];
    if (!g || g.done || !action) return;
    g.done = true;
    handled++;
    const row = rowOf(i);
    row.classList.add('done');
    row.querySelector('select').disabled = true;
    row.querySelector('.row-err').textContent = '';
    const btn = row.querySelector('button');
    btn.disabled = true;
    btn.textContent = 'Queued';
    refresh();
    let job;
    try {
      job = await act(g.id, action);
    } catch (err) {
      // A move that half-happened left the group changed; only a fresh scan knows what is left of it.
      if (err.status === 409) return rescan();
      failed(g, i, err.message);
      announce(`Could not apply to ${g.label}: ${err.message}`);
      return;
    }
    ctx.landed(job).then((end) => {
      if (signal.aborted || groups[i] !== g) return;
      if (end.status === 'failed') failed(g, i, end.error);
      else btn.textContent = 'Done';
    });
  }

  root.addEventListener('change', (e) => {
    if (e.target.tagName !== 'SELECT') return;
    const row = e.target.closest('tr');
    row.querySelector('button').disabled = !e.target.value || groups[row.dataset.i].done;
  }, { signal });
  root.addEventListener('click', async (e) => {
    if (e.target.closest('#calm-all')) {
      const batch = lowRisk();
      announce(`Applying suggestions to ${batch.length} groups`);
      for (const g of batch) {
        if (!groups.includes(g)) break; // rescanned part-way through
        await apply(groups.indexOf(g), g.suggestion);
      }
      return;
    }
    const i = e.target.closest('[data-apply]')?.dataset.apply;
    if (i === undefined) return;
    const action = root.querySelector(`#act-${i}`).value;
    announce(`${label[action]}: ${groups[i].label}`);
    apply(Number(i), action);
  }, { signal });

  root.innerHTML = '<div class="calm"><p>Scanning…</p></div>';
  try {
    render(await ctx.scan());
  } catch (err) {
    listening.abort();
    throw err;
  }
  return () => listening.abort();
}
