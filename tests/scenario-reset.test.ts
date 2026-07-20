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
    matchStatus: "playing",
    commandCenterAlive: true,
  });
  assert.equal(isScenarioRestartRequested("defeat"), false);
  assert.equal(isScenarioRestartRequested("restarting"), true);
});

test("defeat panel exposes restart and exit actions", () => {
  const ui = readFileSync(
    new URL("../ui/match-result.uikitml", import.meta.url),
    "utf8",
  );
  assert.match(ui, /id="result-restart"/);
  assert.match(ui, /id="result-exit-vr"/);

  const system = readFileSync(
    new URL("../src/systems/matchResult.ts", import.meta.url),
    "utf8",
  );
  assert.match(system, /getElementById\("result-restart"\)/);
  assert.match(system, /setValue\(MatchState, "status", "restarting"\)/);
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
  assert.match(source, /resourceByKey\.clear\(\)/);
  assert.match(source, /cargoVisualByUnit\.clear\(\)/);
  assert.match(source, /pathByUnit\.clear\(\)/);
  assert.match(source, /setValue\(BoardTile, "terrain", "open"\)/);
  assert.match(source, /createInitialScenario\(this\.world\)/);
  assert.match(source, /resetTablet\(\)/);
});
