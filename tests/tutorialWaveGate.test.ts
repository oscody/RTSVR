import assert from "node:assert/strict";
import test from "node:test";

import {
  clearTutorialWaveGate,
  isTutorialGoverningWaves,
  setTutorialWaveGate,
  tutorialHoldsCountdown,
  tutorialReleaseAllowance,
  tutorialSpawnAnchor,
} from "../src/systems/tutorialWaveGate.ts";
import { getWaveSpec, getNextWaveSpec } from "../src/systems/waveCatalog.ts";
import { tutorialGovernsWaves } from "../src/systems/tutorialRules.ts";

/**
 * The gate is the tutorial's only reach into the wave system, which is the
 * game's core loop. These tests are less about the tutorial working and more
 * about it being INCAPABLE of changing a normal match while switched off.
 */

test("a cleared gate is invisible to the wave system", () => {
  clearTutorialWaveGate();
  assert.equal(isTutorialGoverningWaves(), false);
  assert.equal(tutorialHoldsCountdown(), false);
  assert.equal(tutorialSpawnAnchor(), null);
  // Infinity, so the caller's Math.min against it is a no-op rather than a cap.
  assert.equal(tutorialReleaseAllowance(0), Number.POSITIVE_INFINITY);
  assert.equal(tutorialReleaseAllowance(999), Number.POSITIVE_INFINITY);
});

test("a gate that is not governing ignores whatever else it was told", () => {
  // Belt and braces: even with a hold and a budget set, `governing: false`
  // must produce today's behaviour, because that flag is the one the disabled
  // path relies on.
  setTutorialWaveGate({
    governing: false,
    holdsCountdown: true,
    releaseBudget: 0,
    spawnAnchor: { x: 0, y: 0 },
  });
  assert.equal(tutorialHoldsCountdown(), false);
  assert.equal(tutorialReleaseAllowance(0), Number.POSITIVE_INFINITY);
  assert.equal(tutorialSpawnAnchor(), null);
  clearTutorialWaveGate();
});

test("the allowance is what is left of the budget, never negative", () => {
  setTutorialWaveGate({
    governing: true,
    holdsCountdown: false,
    releaseBudget: 2,
    spawnAnchor: null,
  });
  assert.equal(tutorialReleaseAllowance(0), 2);
  assert.equal(tutorialReleaseAllowance(1), 1);
  assert.equal(tutorialReleaseAllowance(2), 0);
  // More released than budgeted can happen after a restart mid-wave; it must
  // clamp rather than go negative and re-open the gate via a sign flip.
  assert.equal(tutorialReleaseAllowance(5), 0);
  clearTutorialWaveGate();
});

test("wave 0 exists as a spec but is not in the normal ladder", () => {
  clearTutorialWaveGate();
  const tutorial = getWaveSpec(0);
  assert.ok(tutorial, "wave 0 must resolve to a spec");
  assert.equal(tutorial!.waveNumber, 0);
  assert.equal(tutorial!.maxActiveAliens, 1);
  assert.equal(tutorial!.groups?.length, 3);

  // The whole disabled-path guarantee: wave 1 is unchanged, and nothing walking
  // the ladder can reach wave 0.
  assert.equal(getWaveSpec(1)?.waveNumber, 1);
  assert.equal(getWaveSpec(1)?.groups?.length, 3);
  assert.notEqual(getNextWaveSpec(0)?.waveNumber, 0);
  assert.equal(getNextWaveSpec(0)?.waveNumber, 1);
});

test("clearing wave 0 advances into the normal ladder", () => {
  assert.equal(getNextWaveSpec(0)?.waveNumber, 1);
  assert.equal(getNextWaveSpec(1)?.waveNumber, 2);
});

test("the first alien's spawn tile follows the anchor", () => {
  clearTutorialWaveGate();
  // No anchor: plain edge selection, no declared tile.
  assert.equal(getWaveSpec(0)!.groups![0].spawnTile, undefined);

  setTutorialWaveGate({
    governing: true,
    holdsCountdown: true,
    releaseBudget: 0,
    spawnAnchor: { x: 0, y: 0 },
  });
  assert.deepEqual(getWaveSpec(0)!.groups![0].spawnTile, { x: 0, y: 0 });
  // Only the anchored group gets one — the later two come from their edges.
  assert.equal(getWaveSpec(0)!.groups![1].spawnTile, undefined);
  assert.equal(getWaveSpec(0)!.groups![2].spawnTile, undefined);
  clearTutorialWaveGate();
});

test("no normal wave shares the tutorial's wave number", () => {
  // The meteor shower (and anything else keyed on "are we on the tutorial
  // level") suppresses itself when waveNumber === TUTORIAL_WAVE_NUMBER. If a
  // catalog wave ever took 0, it would silently lose its ambient effects.
  for (let wave = 1; wave <= 12; wave += 1) {
    assert.notEqual(getWaveSpec(wave)?.waveNumber, 0);
  }
  assert.equal(getWaveSpec(0)?.waveNumber, 0);
});

test("a finished tutorial lets go of the wave system entirely", () => {
  // The bug this pins: the gate kept governing after the script ended, with a
  // budget equal to the tutorial's own roster (3). Wave 1 has 11 aliens and
  // resets its released count on spawn, so the gate released 3 and then stopped
  // forever — countdown over, nothing attacking, wave uncleanable.
  assert.equal(tutorialGovernsWaves(true, 0), true, "running: governs");
  assert.equal(tutorialGovernsWaves(true, 4), true, "still running: governs");
  assert.equal(tutorialGovernsWaves(true, -1), false, "finished: lets go");
  assert.equal(tutorialGovernsWaves(false, 2), false, "disabled: never governs");
});

test("the tutorial's budget is smaller than a real wave, which is why this matters", () => {
  // If these were the same size the bug would have been invisible.
  const tutorialTotal = getWaveSpec(0)!.groups!.reduce((n, g) => n + g.count, 0);
  const waveOneTotal = getWaveSpec(1)!.groups!.reduce((n, g) => n + g.count, 0);
  assert.ok(
    tutorialTotal < waveOneTotal,
    `tutorial ${tutorialTotal} vs wave 1 ${waveOneTotal}`,
  );
});
