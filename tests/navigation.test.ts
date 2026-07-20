import assert from "node:assert/strict";
import test from "node:test";

import { findApproachTile } from "../src/systems/navigation.ts";

test("approaches the facing edge of a blocked 3x3 building", () => {
  const blocked = new Set<string>();
  for (let y = 10; y <= 12; y += 1) {
    for (let x = 10; x <= 12; x += 1) blocked.add(`${x},${y}`);
  }

  const result = findApproachTile({
    target: { x: 11, y: 11 },
    from: { x: 11, y: 16 },
    gridSize: 24,
    canStandAt: (x, y) => !blocked.has(`${x},${y}`),
  });

  assert.deepEqual(result, { x: 11, y: 13 });
});

test("approaches an occupied piece from the mover-facing side", () => {
  const result = findApproachTile({
    target: { x: 8, y: 8 },
    from: { x: 8, y: 12 },
    gridSize: 24,
    canStandAt: (x, y) => x !== 8 || y !== 8,
  });

  assert.deepEqual(result, { x: 8, y: 9 });
});

test("skips another occupied approach tile", () => {
  const unavailable = new Set(["8,8", "8,9"]);
  const result = findApproachTile({
    target: { x: 8, y: 8 },
    from: { x: 8, y: 12 },
    gridSize: 24,
    canStandAt: (x, y) => !unavailable.has(`${x},${y}`),
  });

  assert.ok(result);
  assert.notDeepEqual(result, { x: 8, y: 9 });
  assert.equal(Math.max(Math.abs(result.x - 8), Math.abs(result.y - 8)), 1);
});
