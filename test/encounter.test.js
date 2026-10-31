import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attackLength, checkText, flavour, hits, monsterFor, patternFor, spawnBullets } from '../public/games/encounter.js';

const netflix = { label: 'NETFLIX.COM', count: 10, total: -154.9, flags: ['recurring'], detail: 'NETFLIX.COM 866-579-7172 CA' };
const bestBuy = { label: 'BEST BUY', count: 2, total: -2599.98, flags: ['1 possible duplicate charge', 'large charge'] };
const coffee = { label: 'BLUE BOTTLE COFFEE', count: 40, total: -251.03, flags: [] };
const noodle = { label: 'MYSTERY NOODLE BAR', count: 1, total: -27.5, flags: [] };

test('each merchant always gets the same symmetric monster with two eyes', () => {
  const a = monsterFor('NETFLIX.COM');
  assert.deepEqual(a, monsterFor('NETFLIX.COM'));
  assert.notDeepEqual(a, monsterFor('SPOTIFY USA'));
  assert.equal(a.length, 10);
  for (const row of a) {
    assert.equal(row.length, 12);
    assert.equal(row.replace(/[em]/g, 'b'), [...row.replace(/[em]/g, 'b')].reverse().join(''), 'mirror symmetric');
  }
  assert.equal(a.join('').split('e').length - 1, 2);
});

test('the attack fits the merchant', () => {
  assert.equal(patternFor(netflix), 'spiral');
  assert.equal(patternFor(bestBuy), 'boulders');
  assert.equal(patternFor(coffee), 'rain');
  assert.equal(patternFor(noodle), 'sweep');
  assert.ok(attackLength(bestBuy) > attackLength(noodle), 'pricier merchants fight longer');
  assert.ok(attackLength({ total: -1e9 }) <= 6, 'but never forever');
});

test('flavour and CHECK text tell you what you are about to file', () => {
  assert.match(flavour(netflix), /renews itself every month/);
  assert.match(flavour(bestBuy), /-\$2,599\.98/);
  assert.match(checkText(bestBuy), /2 charges, -\$2,599\.98 in all\. 1 possible duplicate charge, large charge\./);
  assert.match(checkText(noodle), /1 charge,/);
});

test('every pattern fires into the box on its own clock', () => {
  const box = { x: 100, y: 100, w: 110, h: 80 };
  for (const pattern of ['spiral', 'boulders', 'rain', 'sweep']) {
    const state = {};
    let fired = 0;
    for (let i = 0; i < 120; i++) fired += spawnBullets(pattern, state, 1 / 60, box, () => 0.5).length;
    assert.ok(fired > 0, `${pattern} fires`);
    assert.ok(fired < 60, `${pattern} leaves gaps to dodge through`);
  }
  assert.ok(hits({ x: 0, y: 0, r: 3 }, { x: 4, y: 0, r: 2 }));
  assert.ok(!hits({ x: 0, y: 0, r: 3 }, { x: 10, y: 0, r: 2 }));
});
