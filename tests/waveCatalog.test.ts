import assert from "node:assert/strict";
import test from "node:test";

import {
  getWaveSpec,
  resolveWaveSpawns,
  type WaveSpec,
} from "../src/systems/waveCatalog.ts";

test("Wave 1 resolves deterministic legal edge spawns", () => {
  const spec = getWaveSpec(1);
  assert.ok(spec);

  const first = resolveWaveSpawns(spec, { canSpawnAt: () => true });
  const second = resolveWaveSpawns(spec, { canSpawnAt: () => true });

  assert.equal(first.length, 13);
  assert.deepEqual(second, first);
  assert.equal(new Set(first.map(({ x, y }) => `${x},${y}`)).size, first.length);
  assert.ok(first.every(({ x, y }) => x === 0 || x === 23 || y === 0 || y === 23));
  assert.equal(first.filter(({ enemy }) => enemy === "alien").length, 11);
  assert.equal(first.filter(({ enemy }) => enemy === "alienDrake").length, 1);
  assert.equal(first.filter(({ enemy }) => enemy === "strongAlienMech").length, 1);
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
