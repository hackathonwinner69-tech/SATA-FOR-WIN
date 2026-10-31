import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GROUND, PHYS, ROWS, SECTION, TILE, buildLevel, foeKind, isSolid, moveBox, rng } from '../public/games/platformer.js';

const groups = Array.from({ length: 7 }, (_, i) => ({ id: `rule:r${i}`, rule: `r${i}`, count: i * 2 + 1, fixable: i % 2 ? i : 0 }));

test('the same rules always build the same floor', () => {
  const a = buildLevel(groups, 'floor0');
  const b = buildLevel(groups, 'floor0');
  assert.deepEqual([...a.solid], [...b.solid]);
  assert.deepEqual(a.foes.map((f) => f.x), b.foes.map((f) => f.x));
  assert.notDeepEqual([...buildLevel(groups, 'floor1').solid], [...a.solid]);
  assert.equal(rng('x')(), rng('x')());
});

test('every rule becomes exactly one foe, in a playable section', () => {
  const level = buildLevel(groups, 'f');
  assert.equal(level.foes.length, groups.length);
  for (const f of level.foes) {
    assert.ok(f.section >= 1 && f.section < level.sections - 1, 'not in the start or exit room');
    const tx = Math.floor(f.x / TILE);
    assert.ok(isSolid(level, tx, GROUND), 'never spawned over a pit');
  }
  assert.equal(foeKind({ count: 12, fixable: 0 }), 'boss');
  assert.equal(foeKind({ count: 3, fixable: 3 }), 'crawler');
  assert.equal(foeKind({ count: 3, fixable: 0 }), 'bat');
});

test('every pit can be cleared with one running jump', () => {
  const airTime = (2 * PHYS.jump) / PHYS.gravity;
  const reach = PHYS.run * airTime;
  for (let seed = 0; seed < 40; seed++) {
    const level = buildLevel(groups, `seed${seed}`);
    for (const pit of level.pits) assert.ok(pit.w * TILE + 8 < reach, `pit of ${pit.w} tiles is jumpable`);
    // the start and exit rooms are solid floor
    for (let x = 1; x < SECTION; x++) assert.ok(isSolid(level, x, GROUND));
    for (let x = level.w - SECTION; x < level.w - 1; x++) assert.ok(isSolid(level, x, GROUND));
  }
  assert.ok((PHYS.jump * PHYS.jump) / (2 * PHYS.gravity) > 3 * TILE, 'a jump clears a three-tile ledge');
});

test('boxes land on the floor, stop at walls and fall through pits', () => {
  const level = buildLevel(groups, 'f');
  const landed = moveBox(level, { x: 40, y: (GROUND - 2) * TILE, w: 8, h: 13 }, 0, 40);
  assert.equal(landed.onGround, true);
  assert.equal(landed.y, GROUND * TILE - 13);
  const wall = moveBox(level, { x: 20, y: (GROUND - 1) * TILE, w: 8, h: 13 }, -30, 0);
  assert.equal(wall.hitX, true);
  assert.equal(wall.x, TILE, 'stopped by the left wall');
  const pit = level.pits[0];
  if (pit) {
    const fall = moveBox(level, { x: pit.x * TILE + 2, y: GROUND * TILE - 13, w: 8, h: 13 }, 0, 40);
    assert.equal(fall.onGround, false);
  }
  assert.equal(isSolid(level, 5, ROWS + 3), false, 'below the world is open air');
});
