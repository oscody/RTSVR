import assert from "node:assert/strict";
import test from "node:test";

import {
  getNextWaveSpec,
  getWaveSpec,
  hasWaveSpec,
  resolveWavePacing,
  resolveWaveSpawnGroups,
  resolveWaveSpawns,
  type WaveSpec,
} from "../src/systems/waveCatalog.ts";

test("wave catalog exposes the next wave for progression", () => {
  assert.equal(hasWaveSpec(1), true);
  assert.equal(hasWaveSpec(2), true);
  assert.equal(hasWaveSpec(3), true);
  assert.equal(hasWaveSpec(4), true);
  assert.equal(hasWaveSpec(5), true);
  assert.equal(hasWaveSpec(6), true);
  assert.equal(hasWaveSpec(7), false);
  assert.equal(getNextWaveSpec(1)?.waveNumber, 2);
  assert.equal(getNextWaveSpec(2)?.waveNumber, 3);
  assert.equal(getNextWaveSpec(3)?.waveNumber, 4);
  assert.equal(getNextWaveSpec(4)?.waveNumber, 5);
  assert.equal(getNextWaveSpec(5)?.waveNumber, 6);
  assert.equal(getNextWaveSpec(6), undefined);
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

test("Wave 2 is composed from a higher threat budget and difficulty multipliers", () => {
  const wave1 = getWaveSpec(1);
  const wave2 = getWaveSpec(2);
  assert.ok(wave1);
  assert.ok(wave2);

  const wave1Threat = threatTotal(resolveWaveSpawnGroups(wave1));
  const wave2Groups = resolveWaveSpawnGroups(wave2);
  const wave2Threat = threatTotal(wave2Groups);
  const wave2Spawns = resolveWaveSpawns(wave2, { canSpawnAt: () => true });

  assert.equal(wave2.threatBudget?.budget, 24);
  assert.ok(wave2Threat > wave1Threat);
  assert.equal(wave2Threat, wave2.threatBudget?.budget);
  assert.ok(wave2Groups.some(({ enemy }) => enemy === "strongAlienMech"));
  assert.ok(wave2Groups.some(({ enemy }) => enemy === "alienDrake"));
  assert.ok(wave2Groups.some(({ enemy }) => enemy === "alien"));
  assert.deepEqual(resolveWavePacing(wave2), {
    maxActiveAliens: 3,
    releaseIntervalSeconds: 12.75,
  });
  assert.ok(wave2Spawns.every(({ healthMultiplier }) => healthMultiplier === 1.25));
  assert.ok(wave2Spawns.every(({ speedMultiplier }) => speedMultiplier === 1.1));
});

test("Wave 3 is a stronger budget wave", () => {
  const wave2 = getWaveSpec(2);
  const wave3 = getWaveSpec(3);
  assert.ok(wave2);
  assert.ok(wave3);

  const wave2Threat = threatTotal(resolveWaveSpawnGroups(wave2));
  const wave3Groups = resolveWaveSpawnGroups(wave3);
  const wave3Threat = threatTotal(wave3Groups);
  const wave3Spawns = resolveWaveSpawns(wave3, { canSpawnAt: () => true });

  assert.equal(wave3.threatBudget?.budget, 34);
  assert.ok(wave3Threat > wave2Threat);
  assert.equal(wave3Threat, wave3.threatBudget?.budget);
  assert.ok(wave3Groups.some(({ enemy }) => enemy === "strongAlienMech"));
  assert.ok(wave3Groups.some(({ enemy }) => enemy === "alienDrake"));
  assert.ok(wave3Groups.some(({ enemy }) => enemy === "alien"));
  assert.deepEqual(resolveWavePacing(wave3), {
    maxActiveAliens: 3,
    releaseIntervalSeconds: 11.25,
  });
  assert.ok(wave3Spawns.every(({ healthMultiplier }) => healthMultiplier === 1.45));
  assert.ok(wave3Spawns.every(({ speedMultiplier }) => speedMultiplier === 1.18));
});

test("Waves 4 through 6 keep increasing budget and difficulty", () => {
  const wave3 = getWaveSpec(3);
  const wave4 = getWaveSpec(4);
  const wave5 = getWaveSpec(5);
  const wave6 = getWaveSpec(6);
  assert.ok(wave3);
  assert.ok(wave4);
  assert.ok(wave5);
  assert.ok(wave6);

  const wave3Threat = threatTotal(resolveWaveSpawnGroups(wave3));
  const wave4Threat = threatTotal(resolveWaveSpawnGroups(wave4));
  const wave5Threat = threatTotal(resolveWaveSpawnGroups(wave5));
  const wave6Groups = resolveWaveSpawnGroups(wave6);
  const wave6Threat = threatTotal(wave6Groups);
  const wave6Spawns = resolveWaveSpawns(wave6, { canSpawnAt: () => true });

  assert.deepEqual(
    [wave4.threatBudget?.budget, wave5.threatBudget?.budget, wave6.threatBudget?.budget],
    [46, 60, 76],
  );
  assert.ok(wave4Threat > wave3Threat);
  assert.ok(wave5Threat > wave4Threat);
  assert.ok(wave6Threat > wave5Threat);
  assert.equal(wave6Threat, wave6.threatBudget?.budget);
  assert.ok(wave6Groups.some(({ enemy }) => enemy === "strongAlienMech"));
  assert.ok(wave6Groups.some(({ enemy }) => enemy === "alienDrake"));
  assert.ok(wave6Groups.some(({ enemy }) => enemy === "alien"));
  assert.deepEqual(resolveWavePacing(wave6), {
    maxActiveAliens: 8,
    releaseIntervalSeconds: 10.4,
  });
  assert.ok(wave6Spawns.every(({ healthMultiplier }) => healthMultiplier === 2.35));
  assert.ok(wave6Spawns.every(({ speedMultiplier }) => speedMultiplier === 1.42));
});

test("wave spawn resolver skips blocked cells and keeps spacing", () => {
  const spec: WaveSpec = {
    waveNumber: 1,
    maxActiveAliens: 3,
    releaseIntervalSeconds: 8,
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

function threatTotal(groups: ReturnType<typeof resolveWaveSpawnGroups>): number {
  const costs = { alien: 1, alienDrake: 2, strongAlienMech: 4 };
  return groups.reduce((sum, group) => sum + group.count * costs[group.enemy], 0);
}
