// Pure logic for the lane runner: which gates a merchant gets, and the road's
// perspective. No DOM, so it is unit-tested in Node.

/** Pick three gate actions for a merchant: the suggestion, one other category, and Flag. */
export function gatesFor(group, categories, rand = Math.random) {
  const cats = categories.filter((c) => c !== group.suggestion);
  const other = cats[Math.floor(rand() * cats.length)];
  const first = group.suggestion && group.suggestion !== 'flag' ? group.suggestion : cats.filter((c) => c !== other)[Math.floor(rand() * (cats.length - 1))];
  const gates = [first, other, 'flag'];
  // Shuffle so the right answer is not always in the same lane.
  for (let i = gates.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [gates[i], gates[j]] = [gates[j], gates[i]];
  }
  return gates;
}

/** Map depth z (1 = horizon, 0 = the runner) to screen y and scale. */
export function project(z, { horizon, bottom }) {
  const p = Math.max(0, Math.min(1, 1 - z)) ** 2;
  return { y: horizon + (bottom - horizon) * p, s: 0.12 + 0.88 * p };
}

/** Centre x of a lane (0, 1, 2) at screen y on a road that widens towards the viewer. */
export function laneX(lane, y, { width, horizon, bottom }) {
  const t = (y - horizon) / (bottom - horizon);
  const road = width * (0.1 + 0.78 * t);
  return width / 2 + (lane - 1) * (road / 3);
}

export function runScore({ count, wise, fast, streak }) {
  return Math.round((100 + count * 6) * (wise ? 2 : 1) * (fast ? 1.25 : 1) * (1 + Math.min(streak, 12) * 0.1));
}
