/** Run work with bounded concurrency, preserving input order. */
export async function mapLimit(items, limit, fn) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('concurrency must be a positive integer');
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function chunks(items, size) {
  if (!Number.isInteger(size) || size < 1) throw new RangeError('chunk size must be a positive integer');
  const result = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

/** Share initialization across callers, but allow a failed attempt to be retried. */
export function lazyAsync(build) {
  let ready;
  return () => {
    ready ??= Promise.resolve().then(build).catch((error) => {
      ready = undefined;
      throw error;
    });
    return ready;
  };
}
