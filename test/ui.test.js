import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncate } from '../public/games/kit.js';
import { onScreen, shieldHit } from '../public/games/invaders.js';

test('truncate never splits an emoji', () => {
  assert.equal(truncate('📦📦📦📦', 3), '📦📦…');
  assert.equal(truncate('📦📦', 3), '📦📦');
  assert.equal(truncate('Substack Weekly', 9), 'Substack…');
  assert.equal(truncate('short', 10), 'short');
});

test('a person ship needs a second, separate press to trash or unsubscribe', () => {
  const ship = { shield: true };
  assert.equal(shieldHit(ship, { weapon: 'trash', press: 1 }), 'drop');
  Object.assign(ship, { shield: false, shieldPress: 1 });
  // later bullets from the same held press bounce off
  assert.equal(shieldHit(ship, { weapon: 'trash', press: 1 }), 'absorb');
  assert.equal(shieldHit(ship, { weapon: 'unsubscribe', press: 1 }), 'absorb');
  assert.equal(shieldHit(ship, { weapon: 'trash', press: 2 }), 'destroy');
});

test('gentle weapons and unshielded ships go down on the first hit', () => {
  assert.equal(shieldHit({ shield: true }, { weapon: 'archive', press: 1 }), 'destroy');
  assert.equal(shieldHit({ shield: true }, { weapon: 'keep', press: 1 }), 'destroy');
  assert.equal(shieldHit({ shield: false }, { weapon: 'trash', press: 1 }), 'destroy');
});

test('the smart bomb only sees ships inside the view', () => {
  const view = { w: 800, h: 600 };
  const ships = [
    { id: 'above', y: -50, h: 46 },
    { id: 'peeking', y: -30, h: 46 },
    { id: 'in', y: -10, h: 46 },
    { id: 'low', y: 500, h: 46 },
  ];
  assert.deepEqual(
    onScreen(ships, view).map((s) => s.id),
    ['in', 'low'],
  );
});
