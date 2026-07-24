import assert from "node:assert/strict";
import test from "node:test";

import {
  getNextWaveSpec,
  getWaveSpec,
  hasWaveSpec,
  resolveWaveSpawns,
  type WaveSpec,
} from "../src/systems/waveCatalog.ts";

test("wave catalog exposes the next wave for progression", () => {
  assert.equal(hasWaveSpec(1), true);
  assert.equal(hasWaveSpec(2), true);
  assert.equal(hasWaveSpec(3), false);
  assert.equal(getNextWaveSpec(1)?.waveNumber, 2);
  assert.equal(getNextWaveSpec(2), undefined);
});

test("Wave 1 resolves deterministic legal edge spawns", () => {
  const spec = getWaveSpec(1);
  assert.ok(spec);

  const first = resolveWaveSpawns(spec, { canSpawnAt: () => true });
  const second = resolveWaveSpawns(spec, { canSpawnAt: () => true });
  const expectedCount = spec.groups.reduce((sum, group) => sum + group.count, 0);

  assert.equal(first.length, expectedCount);
  assert.deepEqual(second, first);
  assert.equal(new Set(first.map(({ x, y }) => `${x},${y}`)).size, first.length);
  assert.ok(first.every(({ x, y }) => x === 0 || x === 23 || y === 0 || y === 23));
  assert.equal(
    first.filter(({ enemy }) => enemy === "alien").length,
    spec.groups.find(({ enemy }) => enemy === "alien")?.count,
  );
  assert.equal(
    first.filter(({ enemy }) => enemy === "alienDrake").length,
    spec.groups.find(({ enemy }) => enemy === "alienDrake")?.count,
  );
  assert.equal(
    first.filter(({ enemy }) => enemy === "strongAlienMech").length,
    spec.groups.find(({ enemy }) => enemy === "strongAlienMech")?.count,
  );
  assert.equal(first.find(({ enemy }) => enemy === "strongAlienMech")?.yawDeg, 180);
});

test("wave spawn resolver skips blocked cells and keeps spacing", () => {
  const spec: WaveSpec = {
    waveNumber: 1,
    groups: [{ enemy: "alien", count: 3, edges: ["north"], minSpacingTiles: 3 }],
  };
  const blocked = new Set(["0,0", "1,0", "2,0", "3,0"]);
  const spawns = resolveWaveSpawns(spec, {
    canSpawnAt: (x, y) => !blocked.has(`${x},${y}`),
  });

  assert.deepEqual(
    spawns.map(({ x, y }) => [x, y]),
    [
      [4, 0],
      [7, 0],
      [10, 0],
    ],
  );
});
