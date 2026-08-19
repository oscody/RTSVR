import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceAttackCycle,
  resolveDamage,
  type AttackCycleState,
} from "../src/systems/combatRules.ts";
import { findGridPath } from "../src/systems/navigation.ts";
import {
  INITIAL_WAVE_DELAY_SECONDS,
  advanceAlienMovement,
  advanceWaveRelease,
  advanceWaveClock,
  alienFacingYaw,
  enemyFacingYaw,
  isAdjacentToFootprint,
  resolveMatchAfterCommandCenterLoss,
  resolveMatchAfterFriendlyElimination,
  resolveMatchAfterWaveCleared,
  resolveWaveClearOutcome,
  type LocalPosition,
  type WaveReleaseState,
  type WaveClockState,
} from "../src/systems/waveRules.ts";

const angleDifference = (left: number, right: number): number =>
  Math.atan2(Math.sin(left - right), Math.cos(left - right));

test("alien facing compensates for the model's negative-Z forward axis", () => {
  assert.ok(Math.abs(angleDifference(alienFacingYaw(0, 1), Math.PI)) < 1e-9);
  assert.ok(
    Math.abs(angleDifference(alienFacingYaw(1, 0), -Math.PI / 2)) < 1e-9,
  );
  assert.ok(Math.abs(angleDifference(alienFacingYaw(0, -1), 0)) < 1e-9);
  assert.ok(
    Math.abs(angleDifference(alienFacingYaw(-1, 0), Math.PI / 2)) < 1e-9,
  );
});

test("strong alien mech uses its own forward-axis compensation", () => {
  assert.ok(
    Math.abs(angleDifference(enemyFacingYaw("strongAlienMech", 0, -1), Math.PI)) <
      1e-9,
  );
  assert.ok(
    Math.abs(angleDifference(enemyFacingYaw("alien", 0, -1), 0)) < 1e-9,
  );
});

test("wave countdown releases staged aliens and stops after defeat", () => {
  const clock: WaveClockState = {
    waveNumber: 1,
    timer: INITIAL_WAVE_DELAY_SECONDS,
    stage: "countdown",
  };
  const firstTick = INITIAL_WAVE_DELAY_SECONDS / 2;
  assert.equal(advanceWaveClock(clock, firstTick, "playing"), false);
  assert.equal(clock.timer, INITIAL_WAVE_DELAY_SECONDS - firstTick);
  assert.equal(
    advanceWaveClock(clock, INITIAL_WAVE_DELAY_SECONDS, "playing"),
    true,
  );
  assert.deepEqual(clock, { waveNumber: 1, timer: 0, stage: "active" });
  assert.equal(advanceWaveClock(clock, 1, "defeat"), false);
  assert.deepEqual(clock, { waveNumber: 1, timer: 0, stage: "stopped" });
});

test("stepped alien movement follows a legal four-neighbor BFS path", () => {
  const blocked = new Set(["1,0", "1,1", "1,2"]);
  const path = findGridPath({
    start: { x: 0, y: 0 },
    goals: [{ x: 2, y: 0 }],
    gridSize: 4,
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

  let position: LocalPosition = { x: 0, z: 0 };
  for (const waypoint of path ?? []) {
    let arrived = false;
    while (!arrived) {
      const step = advanceAlienMovement(
        position,
        { x: waypoint.x, z: waypoint.y },
        1,
        0.25,
      );
      position = { x: step.x, z: step.z };
      arrived = step.arrived;
    }
    assert.equal(blocked.has(`${position.x},${position.z}`), false);
  }
  assert.deepEqual(position, { x: 2, z: 0 });
});

test("contact cadence drains health and defeat waits for all friendlies", () => {
  assert.equal(
    isAdjacentToFootprint({ x: 9, y: 11 }, { x: 11, y: 11 }, 3),
    true,
  );
  assert.equal(
    isAdjacentToFootprint({ x: 8, y: 11 }, { x: 11, y: 11 }, 3),
    false,
  );

  const cycle: AttackCycleState = { timer: 0, cadence: 1 };
  let health = 20;
  assert.equal(advanceAttackCycle(cycle, 0.6, true), 0);
  const firstHits = advanceAttackCycle(cycle, 0.4, true);
  health = resolveDamage(health, 10, firstHits, "building").remaining;
  assert.equal(health, 10);
  const secondHits = advanceAttackCycle(cycle, 1, true);
  const lethal = resolveDamage(health, 10, secondHits, "building");
  assert.deepEqual(lethal, {
    remaining: 0,
    died: true,
    enemyKilled: false,
  });
  assert.equal(resolveMatchAfterFriendlyElimination("playing", 2), "playing");
  assert.equal(resolveMatchAfterFriendlyElimination("playing", 0), "defeat");
  assert.equal(
    resolveMatchAfterFriendlyElimination("victory", 0),
    "victory",
  );
});

test("Wave 1 victory waits for activation and zero living enemies", () => {
  assert.equal(resolveMatchAfterWaveCleared("playing", "countdown", 0), "playing");
  assert.equal(resolveMatchAfterWaveCleared("playing", "active", 1), "playing");
  assert.equal(resolveMatchAfterWaveCleared("playing", "active", 0), "victory");
  assert.equal(resolveMatchAfterWaveCleared("defeat", "active", 0), "defeat");
});

test("wave clear advances when another catalog wave exists", () => {
  assert.equal(
    resolveWaveClearOutcome("playing", "countdown", 0, true),
    "none",
  );
  assert.equal(resolveWaveClearOutcome("playing", "active", 1, true), "none");
  assert.equal(resolveWaveClearOutcome("playing", "active", 0, true), "advance");
  assert.equal(resolveWaveClearOutcome("playing", "active", 0, false), "victory");
  assert.equal(resolveWaveClearOutcome("defeat", "active", 0, true), "none");
});

test("staged wave release starts with one batch and paces reserves", () => {
  const state: WaveReleaseState = {
    releaseTimer: 0,
    releasedAlienCount: 0,
  };
  const config = { maxActiveAliens: 3, releaseIntervalSeconds: 8 };

  assert.equal(
    advanceWaveRelease(
      state,
      { activeLiving: 0, waitingReady: 9 },
      config,
      0,
    ),
    3,
  );
  assert.deepEqual(state, { releaseTimer: 8, releasedAlienCount: 3 });

  assert.equal(
    advanceWaveRelease(
      state,
      { activeLiving: 3, waitingReady: 6 },
      config,
      4,
    ),
    0,
  );
  assert.deepEqual(state, { releaseTimer: 4, releasedAlienCount: 3 });

  assert.equal(
    advanceWaveRelease(
      state,
      { activeLiving: 3, waitingReady: 6 },
      config,
      4,
    ),
    3,
  );
  assert.deepEqual(state, { releaseTimer: 8, releasedAlienCount: 6 });
});

test("staged wave release refills one reserve early after active deaths", () => {
  const state: WaveReleaseState = {
    releaseTimer: 6,
    releasedAlienCount: 3,
  };
  assert.equal(
    advanceWaveRelease(
      state,
      { activeLiving: 2, waitingReady: 6 },
      { maxActiveAliens: 3, releaseIntervalSeconds: 8 },
      1,
    ),
    1,
  );
  assert.deepEqual(state, { releaseTimer: 8, releasedAlienCount: 4 });
});

test("losing the command center ends the match on its own", () => {
  // Before 2026-08-19 this returned "playing" while any friendly survived, so a
  // player could lose their base and keep going — contradicting the game's own
  // stated loss condition.
  assert.equal(resolveMatchAfterCommandCenterLoss("playing"), "defeat");
});

test("a finished match is not re-decided by a late command-center loss", () => {
  assert.equal(resolveMatchAfterCommandCenterLoss("victory"), "victory");
  assert.equal(resolveMatchAfterCommandCenterLoss("defeat"), "defeat");
  assert.equal(resolveMatchAfterCommandCenterLoss("restarting"), "restarting");
});
