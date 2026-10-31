import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gatesFor, laneX, project, runScore } from '../public/games/lanes.js';

const CATS = ['cat:Food', 'cat:Transport', 'cat:Shopping', 'cat:Bills'];

function seq(...values) {
  let i = 0;
  return () => values[i++ % values.length];
}

test('every wave offers the suggestion, one other category and Flag', () => {
  for (let i = 0; i < 50; i++) {
    const gates = gatesFor({ suggestion: 'cat:Food' }, CATS);
    assert.equal(gates.length, 3);
    assert.ok(gates.includes('cat:Food'));
    assert.ok(gates.includes('flag'));
    assert.equal(new Set(gates).size, 3, 'no duplicate gates');
  }
});

test('merchants with no guess still get two distinct categories', () => {
  for (let i = 0; i < 50; i++) {
    const gates = gatesFor({ suggestion: null }, CATS);
    const cats = gates.filter((g) => g !== 'flag');
    assert.equal(cats.length, 2);
    assert.notEqual(cats[0], cats[1]);
  }
});

test('the right answer moves between lanes', () => {
  const lanes = new Set();
  for (const r of [0, 0.4, 0.8]) lanes.add(gatesFor({ suggestion: 'cat:Bills' }, CATS, seq(r, r, r)).indexOf('cat:Bills'));
  assert.ok(lanes.size > 1);
});

test('perspective: the horizon is small and far, the runner big and near', () => {
  const geo = { width: 900, horizon: 200, bottom: 800 };
  const far = project(1, geo);
  const near = project(0, geo);
  assert.equal(far.y, 200);
  assert.equal(near.y, 800);
  assert.ok(near.s > far.s);
  assert.equal(laneX(1, 500, geo), 450, 'the middle lane is centred');
  assert.ok(laneX(2, 800, geo) - laneX(0, 800, geo) > laneX(2, 200, geo) - laneX(0, 200, geo), 'the road widens');
});

test('smart, fast picks score more', () => {
  const base = runScore({ count: 10, wise: false, fast: false, streak: 0 });
  assert.ok(runScore({ count: 10, wise: true, fast: true, streak: 0 }) > base * 2);
});
