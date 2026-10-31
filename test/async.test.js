import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunks, lazyAsync, mapLimit } from '../src/core/async.js';
import { JobQueue } from '../src/core/queue.js';

test('bounded work keeps result order and never exceeds its concurrency', async () => {
  let active = 0, peak = 0;
  const result = await mapLimit([3, 2, 1, 0], 2, async (value, index) => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, value));
    active--;
    return [value, index];
  });
  assert.equal(peak, 2);
  assert.deepEqual(result, [[3, 0], [2, 1], [1, 2], [0, 3]]);
});

test('invalid concurrency and chunk sizes fail instead of hanging or skipping work', async () => {
  for (const value of [0, -1, 1.5, NaN, Infinity]) {
    await assert.rejects(mapLimit([1], value, () => {}), RangeError);
    assert.throws(() => chunks([1], value), RangeError);
  }
  assert.deepEqual(chunks([1, 2, 3], 2), [[1, 2], [3]]);
});

test('concurrent initialization shares its result and retries after failure', async () => {
  let attempts = 0;
  const get = lazyAsync(() => {
    if (++attempts === 1) throw new Error('temporary failure');
    return { ready: true };
  });
  const first = get();
  assert.equal(get(), first);
  await assert.rejects(first, /temporary failure/);
  const result = await get();
  assert.equal(await get(), result);
  assert.equal(attempts, 2);
});

test('failed work does not block a queue lane and idle lanes are released', async () => {
  const queue = new JobQueue();
  const order = [];
  await assert.rejects(queue.after('one', () => { throw new Error('scan failed'); }), /scan failed/);
  const job = queue.enqueue('one', 'move', async () => order.push('move'));
  await queue.after('one', () => order.push('scan'));
  await queue.drain();
  assert.equal(job.status, 'done');
  assert.deepEqual(order, ['move', 'scan']);
  assert.equal(queue.lanes.size, 0);
});
