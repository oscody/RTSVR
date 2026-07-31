import assert from "node:assert/strict";
import test from "node:test";

import {
  ReusableGridPathfinder,
  findApproachTile,
  findGridPath,
} from "../src/systems/navigation.ts";

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

test("BFS routes around blocked cells to the nearest work tile", () => {
  const blocked = new Set(["1,0", "1,1", "1,2"]);
  const path = findGridPath({
    start: { x: 0, y: 0 },
    goals: [{ x: 2, y: 0 }],
    gridSize: 5,
    canStandAt: (x, y) => !blocked.has(`${x},${y}`),
  });

  assert.deepEqual(path, [
    { x: 0, y: 1 },
    { x: 0, y: 2 },
    { x: 0, y: 3 },
    { x: 1, y: 3 },
    { x: 2, y: 3 },
    { x: 2, y: 2 },
    { x: 2, y: 1 },
    { x: 2, y: 0 },
  ]);
});

test("BFS returns null when every route is sealed", () => {
  const path = findGridPath({
    start: { x: 1, y: 1 },
    goals: [{ x: 3, y: 3 }],
    gridSize: 5,
    canStandAt: (x, y) => !["1,0", "2,1", "1,2", "0,1"].includes(`${x},${y}`),
  });

  assert.equal(path, null);
});

test("reusable BFS chooses the nearest reachable target in one search", () => {
  const pathfinder = new ReusableGridPathfinder(5);
  const goals = new Int32Array(25);
  goals.fill(-1);
  goals[4] = 40;
  goals[10] = 20;

  const found = pathfinder.findPathToAny(0, 0, goals, () => true);

  assert.equal(found, true);
  assert.equal(pathfinder.goalValue, 20);
  assert.equal(pathfinder.pathLength, 2);
  assert.deepEqual(Array.from(pathfinder.path.slice(0, 2)), [5, 10]);
});

test("reusable BFS clears prior search state without allocating new buffers", () => {
  const pathfinder = new ReusableGridPathfinder(5);
  const goals = new Int32Array(25);
  goals.fill(-1);
  goals[10] = 20;
  assert.equal(pathfinder.findPathToAny(0, 0, goals, () => true), true);
  const pathBuffer = pathfinder.path;

  goals.fill(-1);
  goals[4] = 40;
  assert.equal(
    pathfinder.findPathToAny(0, 0, goals, (x, y) => x !== 2 || y !== 0),
    true,
  );

  assert.equal(pathfinder.path, pathBuffer);
  assert.equal(pathfinder.goalValue, 40);
  assert.deepEqual(
    Array.from(pathfinder.path.slice(0, pathfinder.pathLength)),
    [1, 6, 7, 8, 3, 4],
  );
});
