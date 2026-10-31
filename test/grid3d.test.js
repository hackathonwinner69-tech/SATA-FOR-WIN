import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aimTarget, gridRows, hullHalf, project, shotHits, worldX } from '../public/games/grid3d.js';

const geo = { width: 1000, horizon: 400, bottom: 840 };

test('the horizon is far, small and centred; the player row is near and wide', () => {
  const far = project(1, 1, geo);
  const near = project(1, 0, geo);
  assert.equal(far.y, 400);
  assert.equal(near.y, 840);
  assert.ok(near.s > far.s * 5);
  assert.ok(near.x - 500 > (far.x - 500) * 5, 'the road widens towards you');
  assert.equal(project(0, 0.5, geo).x, 500, 'the centre line stays centred');
});

test('the mouse maps back onto the player row', () => {
  for (const x of [-0.8, -0.2, 0, 0.5, 0.9]) assert.ok(Math.abs(worldX(project(x, 0, geo).x, geo) - x) < 1e-9);
  assert.equal(worldX(-500, geo), -1, 'clamped to the road');
});

test('shots hit a ship at the same depth within its width, and only then', () => {
  const ship = { x: 0.2, z: 0.5, half: 0.1 };
  assert.ok(shotHits({ x: 0.25, z: 0.52 }, ship));
  assert.ok(!shotHits({ x: 0.4, z: 0.5 }, ship), 'too far sideways');
  assert.ok(!shotHits({ x: 0.2, z: 0.3 }, ship), 'not there yet');
  assert.ok(hullHalf(500) > hullHalf(2), 'big senders are bigger targets');
  assert.ok(hullHalf(1e9) <= 0.2);
});

test('aim assist picks the nearest ship roughly in line, never one off to the side', () => {
  const near = { x: 0.1, z: 0.3, half: 0.1 };
  const far = { x: 0, z: 0.8, half: 0.1 };
  const wide = { x: 0.9, z: 0.1, half: 0.1 };
  assert.equal(aimTarget(0, [far, near, wide]), near);
  assert.equal(aimTarget(-0.9, [far, near]), null);
});

test('grid rows scroll towards the viewer and wrap', () => {
  const a = gridRows(0);
  const b = gridRows(0.5);
  assert.equal(a.length, 14);
  assert.ok(b.every((z, i) => z < a[i]), 'rows move closer as the offset grows');
  assert.ok(a.every((z) => z <= 1 && z > 0));
});
