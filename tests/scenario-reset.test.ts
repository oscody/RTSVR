import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createScenarioResetDefaults,
  isScenarioRestartRequested,
} from "../src/systems/scenarioResetRules.ts";

test("scenario reset restores initial economy, statistics, wave, and match values", () => {
  assert.deepEqual(createScenarioResetDefaults(0, 3), {
    crystals: 0,
    crystalsMined: 0,
    enemiesKilled: 0,
    waveNumber: 1,
    waveTimer: 3,
    waveStage: "countdown",
    // -1 is "nothing spawned yet". 0 cannot mean that any more: it is the
    // tutorial's own wave number, and using it as the sentinel made a restarted
    // tutorial skip spawning entirely.
    spawnedWaveNumber: -1,
    releaseTimer: 0,
    releasedAlienCount: 0,
    matchStatus: "playing",
    commandCenterAlive: true,
  });
  assert.equal(isScenarioRestartRequested("defeat"), false);
  assert.equal(isScenarioRestartRequested("restarting"), true);
});

test("shared result panel exposes victory, restart, and exit behavior", () => {
  const ui = readFileSync(
    new URL("../ui/match-result.uikitml", import.meta.url),
    "utf8",
  );
  assert.match(ui, /id="result-restart"/);
  assert.match(ui, /id="result-exit-vr"/);
  assert.match(ui, /id="result-title"/);
  assert.match(ui, /id="result-body"/);

  const system = readFileSync(
    new URL("../src/systems/matchResult.ts", import.meta.url),
    "utf8",
  );
  assert.match(system, /getElementById\("result-restart"\)/);
  assert.match(system, /setValue\(MatchState, "status", "restarting"\)/);
  assert.match(system, /status === "victory"/);
  assert.match(system, /LEVEL 1 COMPLETE/);
});

test("Phase 9 combat capability is attached on every creation path", () => {
  const state = readFileSync(
    new URL("../src/systems/state.ts", import.meta.url),
    "utf8",
  );
  assert.match(state, /createComponent\("CombatCapability"/);

  for (const relativePath of [
    "../src/systems/structures.ts",
    "../src/systems/craftFactory.ts",
    "../src/systems/buildingFactory.ts",
  ]) {
    const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
    assert.match(source, /addComponent\(CombatCapability/, relativePath);
  }

  const initial = readFileSync(
    new URL("../src/systems/structures.ts", import.meta.url),
    "utf8",
  );
  const producedCrafts = readFileSync(
    new URL("../src/systems/craftFactory.ts", import.meta.url),
    "utf8",
  );
  const producedBuildings = readFileSync(
    new URL("../src/systems/buildingFactory.ts", import.meta.url),
    "utf8",
  );
  assert.match(initial, /CombatCapability, \{ mode: "hybrid" \}/);
  assert.match(producedCrafts, /CombatCapability, \{ mode: "hybrid" \}/);
  assert.match(producedBuildings, /CombatCapability, \{ mode: "automatic" \}/);
});

test("all initial and player-created gameplay entities are scenario-owned", () => {
  for (const relativePath of [
    "../src/systems/structures.ts",
    "../src/systems/buildingFactory.ts",
    "../src/systems/craftFactory.ts",
    "../src/systems/construction.ts",
    "../src/systems/craftProduction.ts",
  ]) {
    const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
    assert.match(source, /\.addComponent\(ScenarioObject\)/, relativePath);
  }
});

test("restart clears transient state and rebuilds the initial scenario", () => {
  const source = readFileSync(
    new URL("../src/systems/scenarioReset.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /entity\.removeComponent\(RayInteractable\)/);
  assert.match(source, /entity\.dispose\(\)/);
  assert.match(source, /selectionRingByUnit\.clear\(\)/);
  assert.match(source, /attackRangeRingByUnit\.clear\(\)/);
  assert.match(source, /rangeRingByTurret\.clear\(\)/);
  assert.match(source, /resourceByKey\.clear\(\)/);
  assert.match(source, /cargoVisualByUnit\.clear\(\)/);
  assert.match(source, /pathByUnit\.clear\(\)/);
  assert.match(source, /resetBoardTerrain\(\)/);
  assert.match(source, /"spawnedWaveNumber"/);
  assert.match(source, /"releaseTimer"/);
  assert.match(source, /"releasedAlienCount"/);
  // Takes a bareStart option since the tutorial's phase 4 — the assertion is
  // that reset rebuilds the scenario at all, not the exact argument list.
  assert.match(source, /createInitialScenario\(this\.world/);
  assert.match(source, /resetTablet\(\)/);
  // Restart must re-arm the tutorial's own level, not drop back to wave 1.
  assert.match(source, /TUTORIAL_WAVE_NUMBER/);
});
