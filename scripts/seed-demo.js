// Builds the demo sandbox: a 5,000-email inbox, a cluttered Downloads folder,
// a year of bank transactions and a small JavaScript app full of lint.
// Deterministic, so every demo plays the same. All domains are .example.
import { mkdir, rm, writeFile, utimes } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NEWSLETTERS = [
  ['Medium Daily Digest', 'noreply@medium.example', ['Stories picked for you', 'Your daily read', 'Top stories in Programming']],
  ['Product Hunt', 'hello@producthunt.example', ['Today’s top launches', 'The best new products', 'Weekly digest']],
  ['LinkedIn', 'messages-noreply@linkedin.example', ['You appeared in 14 searches', 'New jobs for you', 'People you may know']],
  ['Substack Weekly', 'digest@substack.example', ['This week on Substack', 'New posts from writers you follow']],
  ['ShopMart Deals', 'deals@shopmart.example', ['48 hours only: 60% off', 'Your cart misses you', 'Flash sale starts now']],
  ['Quora Digest', 'digest-noreply@quora.example', ['What is the best way to learn...?', 'Top answers this week']],
  ['TechCrunch Daily', 'newsletter@techcrunch.example', ['Daily Crunch: funding round-up', 'Startups to watch']],
  ['Udemy', 'udemy@email.udemy.example', ['Courses from ₹449 ends tonight', 'Learn something new today']],
  ['Pinterest', 'recommendations@pinterest.example', ['Ideas you might love', 'Popular pins this week']],
  ['Zomato', 'noreply@zomato.example', ['Hungry? 50% off tonight', 'Your weekend treats']],
  ['Hacker Newsletter', 'kale@hackernewsletter.example', ['Hacker Newsletter #712', 'Hacker Newsletter #713']],
  ['FlyAway Travel', 'offers@flyaway.example', ['Fares from $49', 'Your next getaway', 'Price drop alert']],
  ['Dev.to', 'yo@dev.example', ['DEV Digest', 'Top posts this week']],
  ['Canva', 'marketing@canva.example', ['New templates for you', 'Design something today']],
  ['Coursera', 'no-reply@coursera.example', ['Recommended courses', 'Your learning goal this week']],
];

const NOTIFIERS = [
  ['GitHub', 'notifications@github.example', ['[repo] New issue opened', '[repo] PR review requested', 'Run failed: CI']],
  ['Slack', 'notification@slack.example', ['You have 12 unread messages', 'New mention in #general']],
  ['Google Calendar', 'calendar-notification@google.example', ['Reminder: Standup @ 10am', 'Updated invitation']],
  ['Jira', 'jira@company.atlassian.example', ['[JIRA] Ticket assigned to you', '[JIRA] Status changed']],
  ['Bank Alerts', 'alerts@bank.example', ['Transaction alert', 'Your statement is ready']],
  ['Twitter', 'info@x.example', ['See what’s happening', 'You have new followers']],
  ['Dropbox', 'no-reply@dropbox.example', ['Someone shared a file with you', 'Your storage is almost full']],
  ['Vercel', 'notifications@vercel.example', ['Deployment ready', 'Deployment failed']],
];

const RECEIPTS = [
  ['Amazon Orders', 'auto-confirm@amazon.example', ['Your order has shipped', 'Your Amazon.example order receipt', 'Delivery update']],
  ['Uber Receipts', 'uber.receipts@uber.example', ['Your Tuesday evening trip receipt', 'Your trip receipt']],
  ['Spotify', 'no-reply@spotify.example', ['Your payment receipt', 'Your invoice']],
];

const PEOPLE = [
  ['Priya Sharma', 'priya.sharma@company.example'],
  ['Arjun Mehta', 'arjun@company.example'],
  ['Mom', 'mom.rai@family.example'],
  ['Rahul Verma', 'rahul.v@friends.example'],
  ['Dr. Kapoor', 'kapoor@university.example'],
  ['Neha Gupta', 'neha.gupta@company.example'],
  ['Hiring Team, Acme', 'careers@acme.example'],
  ['Sam Lee', 'sam@startup.example'],
  ['Ananya Iyer', 'ananya@friends.example'],
  ['Hackathon Organisers', 'team@hackathon.example'],
];
const PEOPLE_SUBJECTS = ['Re: project update', 'Quick question', 'Lunch tomorrow?', 'Notes from today', 'Can you review this?', 'Re: Re: plans', 'Photos from the trip', 'Interview schedule'];

function email({ name, address, subject, date, seen, unsubscribe, oneClick, body }) {
  const headers = [
    `From: "${name}" <${address}>`,
    'To: You <you@inbox.example>',
    `Subject: ${subject}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${date.getTime()}.${address}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
  ];
  if (seen) headers.push('Status: RO');
  if (unsubscribe) {
    const slug = address.split('@')[1];
    headers.push(`List-Unsubscribe: <mailto:unsubscribe@${slug}>, <https://unsubscribe.example/${slug}?u=you>`);
    if (oneClick) headers.push('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  }
  return headers.join('\r\n') + '\r\n\r\n' + body + '\r\n';
}

async function seedMail(root, rand, total) {
  const inbox = join(root, 'INBOX');
  await mkdir(inbox, { recursive: true });
  await mkdir(join(root, 'Archive'), { recursive: true });
  await mkdir(join(root, 'Trash'), { recursive: true });

  // Extra long-tail newsletters so 5,000 mails come from ~150 senders, like a real inbox.
  const tail = Array.from({ length: 110 }, (_, i) => [`Brand ${String.fromCharCode(65 + (i % 26))}${i}`, `news@brand${i}.example`, ['Weekly update', 'Special offer', 'New arrivals']]);
  const pools = [
    { list: NEWSLETTERS, weight: 0.5, unsubscribe: true },
    { list: tail, weight: 0.12, unsubscribe: true },
    { list: NOTIFIERS, weight: 0.22 },
    { list: RECEIPTS, weight: 0.08 },
    { list: PEOPLE.map(([n, a]) => [n, a, PEOPLE_SUBJECTS]), weight: 0.08, person: true },
  ];
  const now = Date.UTC(2026, 9, 30);
  const writes = [];
  for (let i = 0; i < total; i++) {
    let r = rand();
    const pool = pools.find((p) => (r -= p.weight) < 0) ?? pools[0];
    // Skew towards the first senders in each pool, the way a few senders dominate real inboxes.
    const [name, address, subjects] = pool.list[Math.floor(Math.pow(rand(), 1.8) * pool.list.length)];
    const date = new Date(now - Math.floor(rand() * 400 * 86400_000));
    const subject = subjects[Math.floor(rand() * subjects.length)];
    const raw = email({
      name,
      address,
      subject,
      date,
      seen: pool.person ? rand() < 0.9 : rand() < 0.15,
      unsubscribe: pool.unsubscribe,
      oneClick: rand() < 0.7,
      body: pool.person ? `Hi,\n\n${subject.replace(/^Re: /, '')} - let me know what you think.\n\nThanks` : `${subject}\n\nView in browser. You are receiving this because you signed up.`,
    });
    writes.push(writeFile(join(inbox, `${String(i).padStart(5, '0')}.eml`), raw));
    if (writes.length >= 200) await Promise.all(writes.splice(0));
  }
  await Promise.all(writes);
}

async function seedDownloads(root, rand) {
  await mkdir(root, { recursive: true });
  const files = [];
  const add = (name, content, daysAgo = Math.floor(rand() * 300)) =>
    files.push({ name, content: content.padEnd(2048 + Math.floor(rand() * 40000), '.'), daysAgo });
  for (let i = 0; i < 46; i++) {
    const d = new Date(Date.UTC(2026, Math.floor(rand() * 10), 1 + Math.floor(rand() * 27), Math.floor(rand() * 24), Math.floor(rand() * 60)));
    add(`Screenshot ${d.toISOString().slice(0, 10)} at ${d.toISOString().slice(11, 19).replace(/:/g, '.')}.png`, `PNG-${i}`);
  }
  for (let i = 0; i < 38; i++) add(`IMG_${4000 + i * 7}.jpg`, `JPEG-${i}`);
  for (let i = 0; i < 12; i++) add(`WhatsApp Image 2026-0${1 + (i % 9)}-1${i % 9} at 9.${10 + i}.jpeg`, `WA-${i}`);
  for (let i = 0; i < 18; i++) add(`invoice-${2026}${String(1 + (i % 12)).padStart(2, '0')}-${100 + i}.pdf`, `%PDF invoice ${i}`);
  for (const n of ['Resume_final.pdf', 'Resume_final_v2.pdf', 'Offer Letter.pdf', 'lecture-notes-week3.pdf', 'tax-2025.pdf', 'rental-agreement.docx', 'Budget 2026.xlsx', 'pitch-deck.pptx', 'meeting notes.txt', 'ideas.md', 'reading-list.txt'])
    add(n, `doc ${n}`);
  for (const n of ['node-v24.13.1-x64.msi', 'VSCodeUserSetup-x64.exe', 'Zoom_installer.exe', 'Discord-setup.exe', 'python-3.14.3-amd64.exe', 'Docker Desktop Installer.exe', 'figma-agent.dmg'])
    add(n, `MZ installer ${n}`);
  for (let i = 0; i < 9; i++) add(`project-export-${i + 1}.zip`, `PK zip ${i}`);
  for (const n of ['photos-backup.tar.gz', 'dataset.7z', 'fonts.rar']) add(n, `archive ${n}`);
  for (const n of ['podcast-ep42.mp3', 'screen-recording-0412.mp4', 'voice-note-1.m4a', 'voice-note-2.m4a', 'voice-note-3.m4a']) add(n, `media ${n}`);
  for (const n of ['app.js', 'script.py', 'data.json', 'config.yml', 'index.html', 'notebook.ipynb', 'query.sql']) add(n, `// ${n}`);
  for (const n of ['mystery.xyz', 'output.dat', 'CHANGELOG', 'temp.tmp', 'cache.bin']) add(n, `?? ${n}`);
  // Exact duplicates: the classic "(1)" downloads.
  for (const n of ['lecture-notes-week3', 'tax-2025', 'Offer Letter']) {
    const orig = files.find((f) => f.name.startsWith(n));
    files.push({ name: `${n} (1).pdf`, content: orig.content, daysAgo: 2 }, { name: `${n} (2).pdf`, content: orig.content, daysAgo: 1 });
  }
  files.push({ name: 'IMG_4007 copy.jpg', content: files.find((f) => f.name === 'IMG_4007.jpg').content, daysAgo: 3 });

  for (const f of files) {
    const path = join(root, f.name);
    await writeFile(path, f.content);
    const t = new Date(Date.now() - f.daysAgo * 86400_000);
    await utimes(path, t, t);
  }
}

async function seedExpenses(root, rand) {
  await mkdir(root, { recursive: true });
  const rows = [['Date', 'Description', 'Amount', 'Balance']];
  const tx = [];
  const add = (date, description, amount) => tx.push([date, description, amount]);
  const day = (m, d) => `2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  for (let m = 1; m <= 10; m++) {
    add(day(m, 1), 'RENT PAYMENT - OAKWOOD APTS', -1450);
    add(day(m, 3), 'NETFLIX.COM 866-579-7172 CA', -15.49);
    add(day(m, 5), 'SPOTIFY USA 877-778-1161', -10.99);
    add(day(m, 6), 'APPLE.COM/BILL ICLOUD 2TB', -9.99);
    add(day(m, 8), 'GITHUB INC SAN FRANCISCO CA', -4);
    add(day(m, 9), 'OPENAI *CHATGPT SUBSCR', -20);
    add(day(m, 11), 'PLANET FITNESS GYM MEMBERSHIP', -24.99);
    add(day(m, 12), 'COMCAST XFINITY INTERNET', -79.99);
    add(day(m, 14), `PG&E ELECTRIC UTILITY ${1000 + m}`, -(60 + Math.round(rand() * 60)));
    add(day(m, 15), 'ACME CORP PAYROLL DIRECT DEPOSIT', 3200);
    add(day(m, 28), 'ACME CORP PAYROLL DIRECT DEPOSIT', 3200);
    add(day(m, 20), 'STATE FARM INSURANCE', -112.5);
    for (let w = 0; w < 4; w++) {
      add(day(m, 2 + w * 7), `WHOLE FOODS MKT #${10200 + w}`, -(35 + Math.round(rand() * 9000) / 100));
      add(day(m, 3 + w * 7), `SQ *BLUE BOTTLE COFFEE #${w + 1}`, -(4 + Math.round(rand() * 400) / 100));
      if (rand() < 0.8) add(day(m, 4 + w * 7), 'UBER *TRIP HELP.UBER.COM', -(8 + Math.round(rand() * 2500) / 100));
      if (rand() < 0.6) add(day(m, 5 + w * 7), 'UBER EATS PENDING', -(18 + Math.round(rand() * 2500) / 100));
      if (rand() < 0.5) add(day(m, 6 + w * 7), `AMAZON MKTPLACE PMTS AMZN.COM/BILL`, -(12 + Math.round(rand() * 8000) / 100));
    }
    if (rand() < 0.5) add(day(m, 18), `SHELL OIL ${57444 + m} SAN JOSE CA`, -(40 + Math.round(rand() * 2000) / 100));
    if (rand() < 0.4) add(day(m, 22), 'AMC THEATRES 2201', -(18 + Math.round(rand() * 2000) / 100));
    if (rand() < 0.3) add(day(m, 24), 'CVS/PHARMACY #08821', -(9 + Math.round(rand() * 3000) / 100));
  }
  add(day(6, 10), 'DELTA AIR LINES ATLANTA', -642.4);
  add(day(6, 12), 'AIRBNB * HMXQ2Z9', -812.0);
  add(day(7, 2), 'AWS EMEA AWS.AMAZON.CO', -37.12);
  add(day(8, 2), 'AWS EMEA AWS.AMAZON.CO', -41.3);
  add(day(9, 2), 'AWS EMEA AWS.AMAZON.CO', -39.88);
  add(day(9, 17), 'BEST BUY 00012345', -1299.99);
  add(day(9, 17), 'BEST BUY 00012345', -1299.99); // double charge
  add(day(4, 9), 'TST* MYSTERY NOODLE BAR', -27.5);
  add(day(5, 21), 'ZELLE TO R VERMA', -60);
  add(day(10, 2), 'VENMO CASHOUT', 140);
  add(day(3, 30), 'IRS TREAS 310 TAX REF', 812.0);
  tx.sort((a, b) => a[0].localeCompare(b[0]));
  let balance = 5200;
  for (const [d, desc, amt] of tx) {
    balance += amt;
    rows.push([d, desc, amt.toFixed(2), balance.toFixed(2)]);
  }
  await writeFile(join(root, 'bank-export.csv'), rows.map((r) => r.map((c) => (/[",]/.test(c) ? `"${c}"` : c)).join(',')).join('\n') + '\n');
}

const APP_FILES = {
  'package.json': JSON.stringify({ name: 'buggy-app', version: '1.0.0', type: 'module', private: true }, null, 2) + '\n',
  'src/cart.js': `import { formatPrice } from './format.js';

var TAX_RATE = 0.08;
var unusedDiscount = 0.1;

export function cartTotal(items) {
  var total = 0;
  for (var i = 0; i < items.length; i++) {
    let item = items[i];
    if (item.qty == 0) continue;
    total = total + item.price * item.qty;
  }
  if (total > 100) return formatPrice(total * (1 + TAX_RATE));
  else return formatPrice(total);
}

export function describe(item) {
  return 'Item: ' + item.name + ' x' + item.qty;
}
`,
  'src/format.js': `export function formatPrice(n) {
  let fixed = n.toFixed(2);
  if (fixed == 'NaN') return '$0.00';
  return '$' + fixed;
}

export function pad(s, len) {
  let out = s;
  while (out.length < len) out = ' ' + out;
  return out;
}

export function label(obj) {
  return obj['name'] + ': ' + obj['value'];
}
`,
  'src/user.js': `export function greet(user) {
  var name = user.firstName + ' ' + user.lastName;
  let greeting = 'Hello, ' + name + '!';
  if (user.vip == true) greeting = greeting + ' Welcome back.';
  return greeting;
}

export function isAdmin(user) {
  if ('admin' === user.role) return true;
  else return false;
}

export function settings(user) {
  const theme = user.theme;
  const lang = user.lang;
  return { theme: theme, lang: lang, debug: debugMode };
}
`,
  'src/api.js': `export async function fetchJson(url) {
  let res = await fetch(url);
  if (!res.ok) throw new Error('Request failed: ' + res.status);
  let data = await res.json();
  return data;
}

export function retry(fn, times) {
  let attempt = 0;
  let lastError;
  while (attempt < times) {
    try {
      return fn();
    } catch (err) {
      lastError = err;
    }
    attempt++;
  }
  throw lastError;
}

export function onReady(cb) {
  document.addEventListener('DOMContentLoaded', function () { cb(); });
}
`,
  'src/legacy.js': `var config = { retries: 3, timeout: 1000 };
var cache = {};

export function get(key) {
  if (cache[key] != undefined) return cache[key];
  var value = compute(key);
  cache[key] = value;
  return value;
}

function compute(key) {
  var result = key.split('').reverse().join('');
  return result;
}

export function legacyMap(list) {
  return list.map(function (x) { return x * 2; });
}
`,
};

export async function seedDemo(dir = 'sandbox', { emails = 5000 } = {}) {
  const root = resolve(dir);
  await rm(root, { recursive: true, force: true });
  const rand = rng(42);
  await seedMail(join(root, 'mail'), rand, emails);
  await seedDownloads(join(root, 'Downloads'), rand);
  await seedExpenses(join(root, 'expenses'), rand);
  for (const [name, text] of Object.entries(APP_FILES)) {
    const path = join(root, 'buggy-app', name);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, text);
  }
  return root;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = await seedDemo(process.argv[2] ?? 'sandbox');
  console.log(`demo sandbox ready in ${root}`);
}
