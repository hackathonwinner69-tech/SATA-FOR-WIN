import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_BAR, MAX_HEARTS, PIGGY_BONUS, ROWS, SLOW_FOR, Well, barHeights, fallSpeed, judge, levelFor, points, powerAt, shortMoney } from '../public/games/well.js';

const COLUMNS = [
  { id: 'cat:Food', label: 'Food', key: '1' },
  { id: 'cat:Bills', label: 'Bills', key: '2' },
  { id: 'cat:Travel', label: 'Travel', key: '3' },
];

let n = 0;
function merchant(label, { count = 2, total = -20, suggestion = 'cat:Food', risk = 'low' } = {}) {
  return { id: `merchant:${label}:${n++}`, label, count, total, suggestion, risk, flags: [] };
}

/** Advance the well by `seconds` in frame-sized steps. */
function run(well, seconds, opts) {
  for (let t = 0; t < seconds; t += 0.05) well.step(0.05, opts);
  return well.drain();
}

const types = (events) => events.map((e) => e.type);

test('red blocks must be flagged, and only a matched guess is smart', () => {
  const red = merchant('BEST BUY', { risk: 'high', suggestion: 'cat:Food' });
  assert.equal(judge(red, 'flag'), 'caught');
  assert.equal(judge(red, 'cat:Food'), 'audit');
  assert.equal(judge(merchant('UBER'), 'flag'), 'flagged');
  assert.equal(judge(merchant('UBER'), 'cat:Food'), 'smart');
  assert.equal(judge(merchant('UBER'), 'cat:Bills'), 'override');
  assert.equal(judge(merchant('NOODLE BAR', { suggestion: null, risk: 'medium' }), 'cat:Bills'), 'placed');
});

test('smart moves, paydays and drops pay more; the combo bonus is capped and audits pay nothing', () => {
  const group = merchant('UBER', { count: 4 });
  const base = points({ group, outcome: 'override', combo: 0 });
  assert.equal(base, 140);
  assert.equal(points({ group, outcome: 'smart', combo: 0 }), base * 2);
  assert.equal(points({ group, outcome: 'caught', combo: 0, payday: true }), base * 4);
  assert.equal(points({ group, outcome: 'override', combo: 0, dropped: 5 }), base + 10);
  assert.equal(points({ group, outcome: 'smart', combo: 50 }), points({ group, outcome: 'smart', combo: 10 }));
  assert.equal(points({ group, outcome: 'audit', combo: 3, dropped: 9 }), 0);
});

test('bars are square-root scaled, the tallest fills MAX_BAR and any filed column shows', () => {
  const heights = barHeights([
    { total: -400, items: [1] },
    { total: -100, items: [1] },
    { total: 0, items: [] },
    { total: 0, items: [1] },
    { total: -0.5, items: [1] },
  ]);
  assert.equal(heights[0], MAX_BAR);
  assert.equal(heights[1], MAX_BAR / 2);
  assert.equal(heights[2], 0);
  assert.equal(heights[3], 0.35);
  assert.equal(heights[4], 0.35);
  assert.deepEqual(barHeights([{ total: 0, items: [] }]), [0]);
});

test('money is short enough for a column top', () => {
  assert.equal(shortMoney(812), '$812');
  assert.equal(shortMoney(-45.37), '-$45');
  assert.equal(shortMoney(999.6), '$1.0K');
  assert.equal(shortMoney(4160), '$4.2K');
  assert.equal(shortMoney(9960), '$10K');
  assert.equal(shortMoney(-17238), '-$17K');
  assert.equal(shortMoney(1_300_000), '$1.3M');
});

test('levels come every four merchants and each one falls faster, up to a cap', () => {
  assert.deepEqual([0, 3, 4, 8].map(levelFor), [1, 1, 2, 3]);
  assert.ok(fallSpeed(2) > fallSpeed(1));
  assert.equal(fallSpeed(99), 6);
});

test('a block nobody steered bounces back, costs a heart and files nothing', () => {
  const coffee = merchant('BLUE BOTTLE');
  const well = new Well([coffee, merchant('UBER')], { columns: COLUMNS });
  assert.equal(well.block.col, 1);
  const events = run(well, ROWS / fallSpeed(1) + 1);
  assert.ok(types(events).includes('miss'));
  assert.equal(well.hearts, 2);
  assert.deepEqual(well.queue.map((g) => g.label), ['BLUE BOTTLE']);
  assert.ok(well.columns.every((c) => !c.items.length));
  assert.equal(well.cleared, 0);
});

test('a steered block lands in its column and is filed there', () => {
  const coffee = merchant('BLUE BOTTLE', { total: -30.5 });
  const well = new Well([coffee, merchant('UBER')], { columns: COLUMNS });
  assert.ok(well.jump(0));
  const events = run(well, ROWS / fallSpeed(1) + 1);
  const land = events.find((e) => e.type === 'land');
  assert.equal(land.action, 'cat:Food');
  assert.equal(land.outcome, 'smart');
  assert.equal(well.columns[0].total, -30.5);
  assert.deepEqual(well.columns[0].items, [coffee]);
  assert.equal(well.combo, 1);
  assert.equal(well.block.group.label, 'UBER', 'the next block falls after a short pause');
});

test('a hard drop files at once and pays for the rows it fell', () => {
  const well = new Well([merchant('RENT', { suggestion: 'cat:Bills', count: 1 })], { columns: COLUMNS });
  const dropped = well.drop();
  assert.equal(dropped, ROWS - 1);
  const land = well.drain().find((e) => e.type === 'land');
  assert.equal(land.action, 'cat:Bills');
  assert.equal(land.points, Math.round(110 * 2 * 1.1) + 2 * (ROWS - 1));
  run(well, 1);
  assert.equal(well.over, 'clear');
});

test('filing a red block is an audit; flagging it is a catch', () => {
  const well = new Well([merchant('BEST BUY', { risk: 'high' }), merchant('AIRBNB', { risk: 'high' })], { columns: COLUMNS });
  well.drop();
  assert.equal(well.drain().find((e) => e.type === 'land').outcome, 'audit');
  assert.equal(well.hearts, 2);
  assert.equal(well.combo, 0);
  run(well, 0.5);
  assert.ok(well.flag());
  const flag = well.drain().find((e) => e.type === 'flag');
  assert.equal(flag.outcome, 'caught');
  assert.equal(well.combo, 1);
  assert.deepEqual(well.flagged.map((g) => g.label), ['AIRBNB']);
});

test('hold swaps once per block and gives the held block back later', () => {
  const well = new Well([merchant('A'), merchant('B'), merchant('C')], { columns: COLUMNS });
  assert.ok(well.hold());
  assert.equal(well.held.group.label, 'A');
  assert.equal(well.block.group.label, 'B');
  assert.equal(well.hold(), false, 'only once until the block lands');
  well.drop();
  run(well, 0.5);
  assert.equal(well.block.group.label, 'C');
  assert.ok(well.hold());
  assert.equal(well.block.group.label, 'A');
  assert.equal(well.held.group.label, 'C');
});

test('the last merchant comes out of hold by itself, and hold needs something to swap with', () => {
  const well = new Well([merchant('A'), merchant('B')], { columns: COLUMNS });
  well.hold();
  well.drop();
  run(well, 0.5);
  assert.equal(well.block.group.label, 'A');
  assert.equal(well.held, null);
  assert.equal(well.hold(), false);
  well.drop();
  run(well, 0.5);
  assert.equal(well.over, 'clear');
});

test('every fourth block carries a power-up, won by a clean move and lost to an audit', () => {
  const groups = Array.from({ length: 8 }, (_, i) => merchant(`M${i}`, { risk: i === 7 ? 'high' : 'low' }));
  const well = new Well(groups, { columns: COLUMNS });
  const powers = [];
  for (let i = 0; i < 8; i++) {
    powers.push(well.block.power);
    well.jump(0);
    well.drop();
    run(well, 0.5);
  }
  assert.deepEqual(powers, [null, null, null, 'slow', null, null, null, 'auto']);
  assert.deepEqual([11, 15, 19].map(powerAt), ['piggy', 'payday', 'slow']);
  assert.equal(well.powers.slow, 1);
  assert.equal(well.powers.auto, 0, 'the red eighth block was filed unflagged');
});

test('slow motion lasts SLOW_FOR seconds and needs a charge', () => {
  const well = new Well([merchant('A'), merchant('B')], { columns: COLUMNS });
  assert.equal(well.useSlow(), false);
  well.powers.slow = 1;
  assert.ok(well.useSlow());
  well.jump(0);
  run(well, 1);
  assert.ok(Math.abs(well.block.y - fallSpeed(1) * 0.35) < 0.1);
  run(well, SLOW_FOR);
  assert.equal(well.slow, 0);
});

test('autopilot files to the suggestion, flags red blocks and refuses merchants with no guess', () => {
  const unknown = merchant('MYSTERY', { suggestion: null, risk: 'medium' });
  const well = new Well([merchant('DELTA', { suggestion: 'cat:Travel' }), merchant('AIRBNB', { risk: 'high' }), unknown], { columns: COLUMNS });
  well.powers.auto = 3;
  assert.ok(well.autopilot());
  const land = well.drain().find((e) => e.type === 'land');
  assert.deepEqual([land.action, land.col, land.outcome], ['cat:Travel', 2, 'smart']);
  run(well, 0.5);
  assert.ok(well.autopilot());
  assert.equal(well.drain().find((e) => e.type === 'flag').outcome, 'caught');
  run(well, 0.5);
  assert.equal(well.autopilot(), false);
  assert.equal(well.powers.auto, 1);
});

test('a column whose bar reaches the block cannot be steered into', () => {
  const well = new Well([merchant('PAYROLL', { total: 64000, suggestion: 'cat:Food' }), merchant('COFFEE')], { columns: COLUMNS });
  well.jump(0);
  well.drop();
  run(well, 0.5);
  well.block.y = ROWS - 2;
  assert.equal(well.jump(0), false);
  assert.equal(well.block.col, 1);
  assert.ok(well.jump(2));
});

test('the columns start from money filed before, which is charted but never counted as cleared', () => {
  const well = new Well([merchant('UBER')], { columns: COLUMNS, filed: { 'cat:Bills': -400, 'cat:Travel': -100.004, 'cat:Nope': -5 } });
  assert.deepEqual(well.columns.map((c) => c.total), [0, -400, -100]);
  assert.equal(well.columns[1].items[0].earlier, true);
  assert.deepEqual(well.heights(), [0, MAX_BAR, MAX_BAR / 2]);
  assert.equal(well.unfile('earlier:cat:Bills', true), false, 'only merchants played this round can be taken back');
  assert.deepEqual([well.cleared, well.sorted, well.columns[1].total], [0, 0, -400]);
});

test('a piggy bank adds a heart, or pays a bonus when the hearts are full', () => {
  const piggyAt = Array.from({ length: 12 }, (_, i) => i).find((i) => powerAt(i) === 'piggy');
  const groups = Array.from({ length: piggyAt + 1 }, (_, i) => merchant(`M${i}`));
  const well = new Well(groups, { columns: COLUMNS, hearts: MAX_HEARTS });
  for (let i = 0; i < piggyAt; i++) {
    well.jump(0);
    well.drop();
    run(well, 0.5);
  }
  assert.equal(well.block.power, 'piggy');
  const before = well.score;
  well.jump(0);
  well.drop();
  const events = well.drain();
  const land = events.find((e) => e.type === 'land');
  assert.deepEqual(events.find((e) => e.type === 'power'), { type: 'power', power: 'piggy', bonus: PIGGY_BONUS });
  assert.equal(well.score, before + land.points + PIGGY_BONUS);
  assert.equal(well.hearts, MAX_HEARTS);
});

test('a block whose column rises under it is lifted onto the bar instead of sinking into it', () => {
  const big = merchant('BIG', { total: -900 });
  const well = new Well([big, merchant('SMALL', { total: -100 }), merchant('NEXT')], { columns: COLUMNS });
  well.jump(0);
  well.drop();
  run(well, 0.5);
  well.jump(1);
  well.drop();
  run(well, 0.5);
  assert.equal(well.floor(1), ROWS - MAX_BAR / 3);
  well.jump(1);
  well.block.y = well.floor(1) - 1;
  // Taking BIG back leaves SMALL as the tallest bar, so column 1 grows to MAX_BAR under the block.
  assert.ok(well.unfile(big.id, false));
  well.step(0.01);
  assert.equal(well.block.y, ROWS - MAX_BAR - 1);
});

test('running out of hearts ends the round', () => {
  const well = new Well([merchant('A', { risk: 'high' })], { columns: COLUMNS, hearts: 1 });
  well.drain();
  well.drop();
  assert.deepEqual(types(well.drain()), ['land', 'hurt', 'over']);
  assert.equal(well.over, 'broke');
  assert.equal(well.drop(), 0);
});

test('a merchant whose real move failed is taken back and can come round again', () => {
  const rent = merchant('RENT', { suggestion: 'cat:Bills', total: -1450, count: 1 });
  const well = new Well([rent, merchant('UBER')], { columns: COLUMNS });
  well.drop();
  assert.equal(well.columns[1].total, -1450);
  assert.ok(well.unfile(rent.id, true));
  assert.equal(well.columns[1].total, 0);
  assert.deepEqual(well.columns[1].items, []);
  assert.equal(well.cleared, 0);
  assert.equal(well.queue.at(-1), rent);
  assert.equal(well.unfile('merchant:nobody', true), false);
});
