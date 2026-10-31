// Calm mode: the same chore with no timer and no canvas. A plain table of
// groups, a native <select> per row and an Apply button, so it works with a
// keyboard, a screen reader, a switch device or simply a tired brain.
import { esc } from './kit.js';

export default async function calm(ctx) {
  const { root, chore, act, announce, setStats } = ctx;
  root.innerHTML = '<div class="calm"><p>Scanning…</p></div>';
  const scan = await ctx.scan();
  const groups = scan.groups;
  const label = Object.fromEntries(chore.actions.map((a) => [a.id, a.label]));
  let handled = 0;

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
            <td><button class="btn quiet" type="button" data-apply="${i}"${g.suggestion ? '' : ' disabled'}>Apply</button></td>
          </tr>`,
        )
        .join('')}</tbody>
    </table>
  </div>`;

  const allBtn = root.querySelector('#calm-all');
  const refresh = () => {
    const n = lowRisk().length;
    allBtn.textContent = `Apply suggestions to ${n} low-risk group${n === 1 ? '' : 's'}`;
    allBtn.disabled = n === 0;
    setStats([
      ['Handled', `${handled} / ${groups.length}`],
      ['Left', `${groups.length - handled}`],
    ]);
  };

  async function apply(i, action) {
    const g = groups[i];
    if (g.done || !action) return;
    g.done = true;
    handled++;
    const row = root.querySelector(`tr[data-i="${i}"]`);
    row.classList.add('done');
    row.querySelector('select').disabled = true;
    const btn = row.querySelector('button');
    btn.disabled = true;
    btn.textContent = 'Queued';
    try {
      await act(g.id, action);
      btn.textContent = 'Done';
    } catch {
      btn.textContent = 'Failed';
    }
    refresh();
  }

  root.addEventListener('change', (e) => {
    if (e.target.tagName !== 'SELECT') return;
    const row = e.target.closest('tr');
    row.querySelector('button').disabled = !e.target.value || groups[row.dataset.i].done;
  });
  root.addEventListener('click', (e) => {
    const i = e.target.closest('[data-apply]')?.dataset.apply;
    if (i === undefined) return;
    const action = root.querySelector(`#act-${i}`).value;
    apply(Number(i), action);
    announce(`${label[action]}: ${groups[i].label}`);
  });
  allBtn.addEventListener('click', async () => {
    const batch = lowRisk();
    announce(`Applying suggestions to ${batch.length} groups`);
    for (const g of batch) await apply(groups.indexOf(g), g.suggestion);
  });

  refresh();
  root.querySelector('select')?.focus();
  return () => {};
}
