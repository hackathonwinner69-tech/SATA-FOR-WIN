// Pure rules for Budget Blocks. No DOM here, so it is unit-tested in Node.
// The well has one column per category. A merchant falls as a block; where it
// lands is the category it is filed under, and each column's stack is a bar
// of the money filed there.

export const ROWS = 12;
/** The tallest bar fills half the well, so there is always room to steer above it. */
export const MAX_BAR = 6;
export const MAX_HEARTS = 5;
/** Seconds a block rests on its column before it locks in. */
export const LOCK_DELAY = 0.35;
export const SPAWN_PAUSE = 0.3;
export const SLOW_FOR = 8;
export const PAYDAY_FOR = 10;
export const POWERS = ['slow', 'auto', 'piggy', 'payday'];
const POWER_EVERY = 4;
const STORE_MAX = 3;
/** A piggy bank found with full hearts pays this instead. */
export const PIGGY_BONUS = 500;

export const levelFor = (cleared) => 1 + Math.floor(cleared / 4);

/** The power-up the `n`th block from the queue carries (counting from 0): every fourth block has one. */
export const powerAt = (n) => (n % POWER_EVERY === POWER_EVERY - 1 ? POWERS[Math.floor(n / POWER_EVERY) % POWERS.length] : null);

/** Rows per second: each level falls a fifth faster, up to six rows a second. */
export const fallSpeed = (level) => Math.min(6, 1.2 * 1.2 ** (level - 1));

const cents = (n) => Math.round(n * 100) / 100;

/**
 * How a move is judged. A red block (possible duplicate or large charge) must
 * be flagged; filing one unflagged is an audit. Matching ChoreCade's guess is
 * smart; any other column is the player's call, which is never punished.
 */
export function judge(group, action) {
  const red = group.risk === 'high';
  if (action === 'flag') return red ? 'caught' : 'flagged';
  if (red) return 'audit';
  if (!group.suggestion) return 'placed';
  return action === group.suggestion ? 'smart' : 'override';
}

export function points({ group, outcome, combo, dropped = 0, payday = false }) {
  if (outcome === 'audit') return 0;
  const sharp = outcome === 'smart' || outcome === 'caught';
  return Math.round((100 + group.count * 10) * (sharp ? 2 : 1) * (payday ? 2 : 1) * (1 + Math.min(combo, 10) * 0.1)) + 2 * Math.round(dropped);
}

/** Bar heights in rows, square-root scaled so a payroll does not flatten the coffee. Any filed column shows. */
export function barHeights(columns, maxRows = MAX_BAR, minRows = 0.35) {
  const roots = columns.map((c) => Math.sqrt(Math.abs(c.total)));
  const top = Math.max(0, ...roots);
  return columns.map((c, i) => (c.items.length ? Math.max(minRows, top ? (roots[i] / top) * maxRows : minRows) : 0));
}

/** "$812", "$4.2K", "$17K", "$1.3M": short enough to sit on top of a column. */
export function shortMoney(v) {
  const a = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (a < 999.5) return `${sign}$${Math.round(a)}`;
  if (a < 999_500) return `${sign}$${(a / 1000).toFixed(a < 9_950 ? 1 : 0)}K`;
  return `${sign}$${(a / 1e6).toFixed(1)}M`;
}

export class Well {
  /**
   * `columns` are the category actions ({ id: 'cat:Food', label, key, color }), left to right.
   * `filed` is money already filed per column ({ 'cat:Food': -120.5 }), so the chart starts where the export is.
   */
  constructor(groups, { columns, hearts = 3, filed = {} }) {
    this.columns = columns.map((c) => {
      const before = cents(filed[c.id] ?? 0);
      const items = before ? [{ id: `earlier:${c.id}`, label: 'earlier', count: 0, total: before, earlier: true }] : [];
      return { ...c, items, total: before };
    });
    this.queue = [...groups];
    this.block = null; // { group, power, col, y, lock, touched }
    this.held = null; // { group, power }
    this.swapped = false; // hold works once per block
    this.hearts = hearts;
    this.score = 0;
    this.combo = 0;
    this.best = 0;
    this.cleared = 0; // merchants filed or flagged
    this.sorted = 0; // their transactions
    this.flagged = [];
    this.level = 1;
    this.spawned = 0;
    this.powers = { slow: 0, auto: 0 };
    this.slow = 0; // seconds of slow motion left
    this.payday = 0; // seconds of double points left
    this.pause = 0;
    this.over = null; // 'clear' once every merchant is handled, 'broke' when the hearts run out
    this.events = [];
    this.spawn();
  }

  get start() {
    return Math.floor((this.columns.length - 1) / 2);
  }

  /** Merchants not handled yet, the falling and held blocks included. */
  get left() {
    return this.queue.length + (this.block ? 1 : 0) + (this.held ? 1 : 0);
  }

  heights() {
    return barHeights(this.columns);
  }

  /** The row where a block's bottom edge stops in column `i`. */
  floor(i) {
    return ROWS - this.heights()[i];
  }

  emit(event) {
    this.events.push(event);
  }

  /** Events since the last call, oldest first. */
  drain() {
    const out = this.events;
    this.events = [];
    return out;
  }

  spawn(card = null) {
    if (this.over) return;
    if (!card && this.queue.length) card = { group: this.queue.shift(), power: powerAt(this.spawned++) };
    if (!card && this.held) [card, this.held] = [this.held, null];
    if (!card) {
      this.over = 'clear';
      this.emit({ type: 'over', reason: 'clear' });
      return;
    }
    this.block = { ...card, col: this.start, y: 0, lock: 0, touched: false };
    this.emit({ type: 'spawn', block: this.block });
  }

  step(dt, { soft = false } = {}) {
    if (this.over) return;
    this.slow = Math.max(0, this.slow - dt);
    this.payday = Math.max(0, this.payday - dt);
    const b = this.block;
    if (!b) {
      this.pause -= dt;
      if (this.pause <= 0) this.spawn();
      return;
    }
    if (soft) b.touched = true;
    const rest = this.floor(b.col) - 1;
    // Bars are scaled to the tallest one, so a take-back elsewhere can raise this column under the block.
    b.y = Math.min(b.y, rest);
    if (b.y < rest) {
      const speed = fallSpeed(this.level) * (this.slow > 0 ? 0.35 : 1) * (soft ? 8 : 1);
      b.y = Math.min(rest, b.y + speed * dt);
      b.lock = 0;
    } else if ((b.lock += dt) >= LOCK_DELAY) {
      // A block nobody steered never files itself: it bounces and comes round again.
      if (b.touched) this.resolve(this.columns[b.col].id);
      else this.miss();
    }
  }

  /** Steer one column left (-1) or right (+1). */
  move(dx) {
    return this.block ? this.jump(this.block.col + dx) : false;
  }

  /** Put the block over column `i`, unless that column's bar already reaches it. */
  jump(i) {
    const b = this.block;
    if (!b || this.over || i < 0 || i >= this.columns.length) return false;
    if (b.y + 1 > this.floor(i) + 1e-6) return false;
    b.col = i;
    b.touched = true;
    b.lock = 0;
    return true;
  }

  /** Drop the block straight down and file it. Returns the rows it fell. */
  drop() {
    const b = this.block;
    if (!b || this.over) return 0;
    const dropped = Math.max(0, this.floor(b.col) - 1 - b.y);
    b.y += dropped;
    this.resolve(this.columns[b.col].id, dropped);
    return dropped;
  }

  flag() {
    if (!this.block || this.over) return false;
    this.resolve('flag');
    return true;
  }

  /** Swap the falling block with the held one (or the next in line when nothing is held). */
  hold() {
    if (!this.block || this.over || this.swapped) return false;
    if (!this.held && !this.queue.length) return false;
    const back = this.held;
    this.held = { group: this.block.group, power: this.block.power };
    this.block = null;
    this.spawn(back);
    this.swapped = true;
    this.emit({ type: 'hold', group: this.held.group });
    return true;
  }

  useSlow() {
    if (!this.block || this.over || !this.powers.slow || this.slow > 0) return false;
    this.powers.slow--;
    this.slow = SLOW_FOR;
    this.emit({ type: 'slow' });
    return true;
  }

  /** ChoreCade's own call for the falling block: its suggested column, or a flag when it is red. */
  autopilot() {
    const b = this.block;
    if (!b || this.over || !this.powers.auto) return false;
    const action = b.group.risk === 'high' ? 'flag' : b.group.suggestion;
    const col = this.columns.findIndex((c) => c.id === action);
    if (action !== 'flag' && col < 0) return false;
    this.powers.auto--;
    if (col >= 0) b.col = col;
    this.resolve(action);
    return true;
  }

  resolve(action, dropped = 0) {
    const b = this.block;
    const { group } = b;
    const outcome = judge(group, action);
    if (outcome === 'smart' || outcome === 'caught') this.combo++;
    else if (outcome === 'audit') this.combo = 0;
    this.best = Math.max(this.best, this.combo);
    const gained = points({ group, outcome, combo: this.combo, dropped, payday: this.payday > 0 });
    this.score += gained;
    this.cleared++;
    this.sorted += group.count;
    if (action === 'flag') this.flagged.push(group);
    else {
      const column = this.columns.find((c) => c.id === action);
      column.items.push(group);
      column.total = cents(column.total + group.total);
    }
    this.block = null;
    this.emit({ type: action === 'flag' ? 'flag' : 'land', group, action, outcome, points: gained, col: b.col, y: b.y, power: b.power });
    if (outcome === 'audit') this.hurt();
    else if (b.power) this.collect(b.power);
    const level = levelFor(this.cleared);
    if (level > this.level) {
      this.level = level;
      this.emit({ type: 'level', level });
    }
    this.next();
  }

  miss() {
    const { group, col } = this.block;
    this.block = null;
    this.queue.push(group);
    this.combo = 0;
    this.emit({ type: 'miss', group, col });
    this.hurt();
    this.next();
  }

  collect(power) {
    let bonus = 0;
    if (power === 'piggy') {
      if (this.hearts < MAX_HEARTS) this.hearts++;
      else bonus = PIGGY_BONUS;
    } else if (power === 'payday') this.payday = PAYDAY_FOR;
    else this.powers[power] = Math.min(STORE_MAX, this.powers[power] + 1);
    this.score += bonus;
    this.emit({ type: 'power', power, bonus });
  }

  hurt() {
    this.hearts--;
    this.emit({ type: 'hurt', hearts: this.hearts });
    if (this.hearts > 0) return;
    this.over = 'broke';
    this.emit({ type: 'over', reason: 'broke' });
  }

  next() {
    this.swapped = false;
    this.pause = SPAWN_PAUSE;
  }

  /** Take back a merchant whose real move failed. `requeue` sends it round again. */
  unfile(groupId, requeue) {
    if (this.over) return false;
    let group = null;
    for (const c of this.columns) {
      const i = c.items.findIndex((g) => g.id === groupId && !g.earlier);
      if (i < 0) continue;
      [group] = c.items.splice(i, 1);
      c.total = cents(c.total - group.total);
    }
    const f = this.flagged.findIndex((g) => g.id === groupId);
    if (f >= 0) [group] = this.flagged.splice(f, 1);
    if (!group) return false;
    this.cleared--;
    this.sorted -= group.count;
    if (requeue) this.queue.push(group);
    return true;
  }
}
