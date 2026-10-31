import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approach, bossHp, clamp, deliveryScore, inside, nearest, wallDoors } from '../public/games/arena.js';

test('approach moves at most one step and lands exactly on the target', () => {
  assert.deepEqual(approach({ x: 0, y: 0 }, { x: 10, y: 0 }, 4), { x: 4, y: 0 });
  assert.deepEqual(approach({ x: 0, y: 0 }, { x: 3, y: 4 }, 10), { x: 3, y: 4 });
  assert.deepEqual(approach({ x: 2, y: 2 }, { x: 2, y: 2 }, 5), { x: 2, y: 2 });
});

test('doors split evenly down both walls and cover the full height', () => {
  const doors = wallDoors([{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }], 800, 400, { depth: 100 });
  assert.deepEqual(
    doors.map((d) => [d.x, d.y, d.h]),
    [
      [0, 0, 200],
      [0, 200, 200],
      [700, 0, 200],
      [700, 200, 200],
    ],
  );
  assert.ok(inside({ x: 750, y: 250 }, doors[3]));
  assert.ok(!inside({ x: 400, y: 250 }, doors[3]));
});

test('nearest respects the pick-up radius', () => {
  const items = [{ x: 10, y: 0 }, { x: 50, y: 0 }];
  assert.equal(nearest({ x: 0, y: 0 }, items, 20), items[0]);
  assert.equal(nearest({ x: 100, y: 0 }, items, 20), null);
});

test('smart deliveries and streaks pay more, but streak bonus is capped', () => {
  const base = deliveryScore({ count: 10, wise: false, streak: 0 });
  assert.equal(deliveryScore({ count: 10, wise: true, streak: 0 }), base * 2);
  assert.ok(deliveryScore({ count: 10, wise: false, streak: 3 }) > base);
  assert.equal(deliveryScore({ count: 10, wise: false, streak: 50 }), deliveryScore({ count: 10, wise: false, streak: 10 }));
  assert.equal(clamp(5, 0, 3), 3);
});

test('lint bosses take more hits for bigger rules, capped at six', () => {
  assert.equal(bossHp(1), 1);
  assert.ok(bossHp(10) > bossHp(2));
  assert.equal(bossHp(100000), 6);
});
