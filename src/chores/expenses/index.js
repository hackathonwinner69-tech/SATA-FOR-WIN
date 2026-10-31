// Expense review. A bank export becomes a deck of merchant cards; each card you
// play files every transaction from that merchant into a category, and the
// categorised CSV, the report and the rules for next month are rewritten on
// the spot.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { parseCsv, toCsv } from './csv.js';

export const CATEGORIES = [
  { id: 'Food', key: '1', color: '#f97316' },
  { id: 'Transport', key: '2', color: '#38bdf8' },
  { id: 'Shopping', key: '3', color: '#e879f9' },
  { id: 'Subscriptions', key: '4', color: '#a855f7' },
  { id: 'Bills', key: '5', color: '#facc15' },
  { id: 'Travel', key: '6', color: '#14b8a6' },
  { id: 'Entertainment', key: '7', color: '#f43f5e' },
  { id: 'Health', key: '8', color: '#4ade80' },
  { id: 'Income', key: '9', color: '#22c55e' },
  { id: 'Business', key: '0', color: '#94a3b8' },
];

const HINTS = [
  [/uber eats|doordash|grubhub|deliveroo|swiggy|zomato|starbucks|coffee|cafe|pizza|burger|mcdonald|chipotle|restaurant|bakery|grocer|whole foods|trader joe|safeway|kroger|aldi|tesco/i, 'Food'],
  [/uber|lyft|ola|metro|transit|parking|shell|chevron|exxon|bp |fuel|gas station|toll/i, 'Transport'],
  [/netflix|spotify|hulu|disney|prime video|youtube premium|icloud|dropbox|github|notion|adobe|chatgpt|openai|anthropic|claude|patreon|gym membership/i, 'Subscriptions'],
  [/electric|water|utility|comcast|xfinity|verizon|at&t|t-mobile|insurance|rent|mortgage|internet/i, 'Bills'],
  [/airbnb|airlines|airways|delta|united|marriott|hilton|hotel|booking\.com|expedia/i, 'Travel'],
  [/steam|cinema|amc|ticketmaster|playstation|xbox|nintendo|concert/i, 'Entertainment'],
  [/pharmacy|cvs|walgreens|clinic|dental|doctor|hospital/i, 'Health'],
  [/payroll|salary|deposit|refund|interest paid|transfer from/i, 'Income'],
  [/aws|google cloud|heroku|vercel|digitalocean|slack|zoom|figma|linear/i, 'Business'],
  [/amazon|target|walmart|ikea|best buy|etsy|ebay|zara|h&m|nike|apple store/i, 'Shopping'],
];

/** "SQ *BLUE BOTTLE COFFEE #123 SAN FRANCISCO" -> "BLUE BOTTLE COFFEE" */
export function normalizeMerchant(description) {
  return description
    .toUpperCase()
    .replace(/^(POS|ACH|DEBIT|CREDIT|PURCHASE|CARD|VISA|MC|CHECKCARD)\s+/g, '')
    .replace(/^(SQ|TST|SP|PAYPAL|PP)\s?\*\s?/, '')
    .replace(/\*.*$/, '')
    .replace(/#\s?\d+.*/, '')
    .replace(/\b\d{3,}\b.*$/, '')
    .replace(/\s+[A-Z]{2}$/, '')
    .replace(/[^A-Z0-9&.' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 3)
    .join(' ');
}

export function guessCategory(merchant, amount) {
  for (const [re, cat] of HINTS) if (re.test(merchant)) return cat;
  return amount > 0 ? 'Income' : null;
}

function findColumn(header, names) {
  return header.findIndex((h) => names.some((n) => h.trim().toLowerCase() === n || h.trim().toLowerCase().includes(n)));
}

export function readTransactions(text) {
  const [header, ...rows] = parseCsv(text);
  const col = {
    date: findColumn(header, ['date', 'posted']),
    desc: findColumn(header, ['description', 'merchant', 'payee', 'name', 'details', 'narrative']),
    amount: findColumn(header, ['amount']),
    debit: findColumn(header, ['debit', 'withdrawal']),
    credit: findColumn(header, ['credit', 'deposit']),
  };
  if (col.date < 0 || col.desc < 0 || (col.amount < 0 && col.debit < 0)) {
    throw new Error(`could not find date/description/amount columns in: ${header.join(', ')}`);
  }
  const num = (s) => Number(String(s ?? '').replace(/[^0-9.-]/g, '')) || 0;
  const txns = rows.map((r, i) => {
    const amount = col.amount >= 0 ? num(r[col.amount]) : num(r[col.credit]) - num(r[col.debit]);
    return { row: i, date: r[col.date], description: r[col.desc], amount, merchant: normalizeMerchant(r[col.desc]) || r[col.desc] };
  });
  return { header, rows, txns };
}

function monthOf(date) {
  const d = new Date(date);
  return Number.isNaN(d.getTime()) ? String(date).slice(0, 7) : d.toISOString().slice(0, 7);
}

export function groupByMerchant(txns, rules = {}) {
  const map = new Map();
  for (const t of txns) {
    if (!map.has(t.merchant)) map.set(t.merchant, []);
    map.get(t.merchant).push(t);
  }
  const groups = [];
  for (const [merchant, list] of map) {
    const total = list.reduce((s, t) => s + t.amount, 0);
    const months = new Set(list.map((t) => monthOf(t.date)));
    const amounts = list.map((t) => t.amount);
    const mean = total / list.length;
    const spread = Math.max(...amounts) - Math.min(...amounts);
    const recurring = months.size >= 3 && list.length <= months.size + 1 && Math.abs(spread) <= Math.abs(mean) * 0.05 + 0.01;
    const seen = new Set();
    const duplicates = list.filter((t) => {
      const k = `${t.date}|${t.amount}`;
      if (seen.has(k)) return true;
      seen.add(k);
      return false;
    }).length;
    const remembered = rules[merchant];
    const guess = remembered ?? guessCategory(merchant, mean) ?? (recurring && total < 0 ? 'Subscriptions' : null);
    const flags = [];
    if (recurring) flags.push('recurring');
    if (duplicates) flags.push(`${duplicates} possible duplicate charge${duplicates > 1 ? 's' : ''}`);
    const large = !recurring && Math.min(...amounts) < -500;
    if (large) flags.push('large charge');
    groups.push({
      id: `merchant:${merchant}`,
      label: merchant,
      detail: list[0].description,
      count: list.length,
      total: Math.round(total * 100) / 100,
      kind: guess ?? 'unknown',
      suggestion: guess ? `cat:${guess}` : null,
      remembered: Boolean(remembered),
      risk: duplicates || large ? 'high' : guess ? 'low' : 'medium',
      flags,
      rows: list.map((t) => t.row),
    });
  }
  return groups.sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
}

export function createExpensesChore({ csvPath, outDir, dryRun = false }) {
  const stem = basename(csvPath, extname(csvPath));
  const out = {
    csv: join(outDir, `${stem}.categorized.csv`),
    report: join(outDir, 'expense-report.md'),
    rules: join(outDir, 'merchant-rules.json'),
    state: join(outDir, `.${stem}.assignments.json`),
  };
  let data = null; // { header, rows, txns }
  let assignments = {}; // row -> { category, flagged }

  async function loadJson(path, fallback) {
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch {
      return fallback;
    }
  }

  async function writeOutputs() {
    const header = [...data.header, 'Category', 'Needs review'];
    const rows = data.rows.map((r, i) => [...r, assignments[i]?.category ?? '', assignments[i]?.flagged ? 'yes' : '']);
    await mkdir(outDir, { recursive: true });
    await writeFile(out.csv, toCsv([header, ...rows]));
    await writeFile(out.state, JSON.stringify(assignments));

    const rules = await loadJson(out.rules, {});
    for (const t of data.txns) if (assignments[t.row]?.category) rules[t.merchant] = assignments[t.row].category;
    await writeFile(out.rules, JSON.stringify(rules, null, 2) + '\n');
    await writeFile(out.report, report());
  }

  function report() {
    const totals = {};
    let done = 0;
    const flagged = [];
    const subs = new Map();
    for (const t of data.txns) {
      const a = assignments[t.row];
      if (!a) continue;
      done++;
      if (a.category) totals[a.category] = (totals[a.category] ?? 0) + t.amount;
      if (a.flagged) flagged.push(t);
      if (a.category === 'Subscriptions') subs.set(t.merchant, Math.abs(t.amount));
    }
    const money = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(n).toFixed(2);
    const lines = [
      `# Expense report: ${basename(csvPath)}`,
      '',
      `Reviewed ${done} of ${data.txns.length} transactions with ChoreCade on ${new Date().toISOString().slice(0, 10)}.`,
      '',
      '| Category | Total |',
      '| --- | ---: |',
      ...Object.entries(totals)
        .sort((a, b) => a[1] - b[1])
        .map(([c, v]) => `| ${c} | ${money(v)} |`),
      '',
    ];
    if (subs.size) {
      const monthly = [...subs.values()].reduce((s, v) => s + v, 0);
      lines.push(`## Subscriptions (${money(-monthly)} a month, ${money(-monthly * 12)} a year)`, '');
      for (const [m, v] of subs) lines.push(`- ${m}: ${money(-v)}`);
      lines.push('');
    }
    if (flagged.length) {
      lines.push(`## Needs review (${flagged.length})`, '');
      for (const t of flagged) lines.push(`- ${t.date} ${t.description} ${money(t.amount)}`);
      lines.push('');
    }
    return lines.join('\n');
  }

  return {
    id: 'expenses',
    title: 'Receipt Rush',
    chore: 'Review your expenses',
    target: csvPath,
    actions: [...CATEGORIES.map((c) => ({ id: `cat:${c.id}`, label: c.id, key: c.key, color: c.color })), { id: 'flag', label: 'Flag for review', key: 'F', color: '#ef4444' }],
    outputs: out,

    async scan() {
      data = readTransactions(await readFile(csvPath, 'utf8'));
      assignments = await loadJson(out.state, {});
      const rules = await loadJson(out.rules, {});
      const open = data.txns.filter((t) => !assignments[t.row]);
      const groups = groupByMerchant(open, rules);
      return {
        groups,
        stats: { transactions: data.txns.length, open: open.length, merchants: groups.length, spend: Math.round(data.txns.reduce((s, t) => s + Math.min(t.amount, 0), 0)) },
      };
    },

    async apply(group, action) {
      if (!data) await this.scan();
      const flag = action === 'flag';
      const category = flag ? null : action.replace(/^cat:/, '');
      if (!flag && !CATEGORIES.some((c) => c.id === category)) throw new Error(`unknown category ${category}`);
      if (dryRun) return { affected: group.rows.length, summary: `[dry run] would file ${group.label} under ${category ?? 'review'}`, impact: {}, undo: null };
      const previous = Object.fromEntries(group.rows.map((r) => [r, assignments[r] ?? null]));
      for (const r of group.rows) assignments[r] = { category: category ?? assignments[r]?.category ?? null, flagged: flag };
      await writeOutputs();
      return {
        affected: group.rows.length,
        summary: flag ? `flagged ${group.label} for review` : `filed ${group.rows.length} × ${group.label} under ${category}`,
        impact: { categorized: group.rows.length, dollars: Math.abs(group.total), ...(flag ? { flagged: 1 } : {}) },
        undo: { previous },
      };
    },

    async undo({ previous }) {
      if (!data) await this.scan();
      for (const [r, a] of Object.entries(previous)) {
        if (a) assignments[r] = a;
        else delete assignments[r];
      }
      await writeOutputs();
      return { restored: Object.keys(previous).length, summary: `un-filed ${Object.keys(previous).length} transactions` };
    },
  };
}
