import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { resolvePerformanceSample } from "../src/systems/performanceRules.ts";

const ROOT = new URL("../", import.meta.url);

function source(path: string): string {
  return readFileSync(new URL(path, ROOT), "utf8");
}

test("performance samples report a 72 Hz frame budget", () => {
  const sample = resolvePerformanceSample(1, 72, 1 / 60);

  assert.equal(sample.fps, 72);
  assert.ok(Math.abs(sample.averageFrameMs - 13.8889) < 0.001);
  assert.ok(Math.abs(sample.worstFrameMs - 16.6667) < 0.001);
});

test("XR runtime code does not schedule its own animation frame loop", () => {
  const runtimeFiles = [
    "src/index.ts",
    "src/systems/alienAnimation.ts",
    "src/systems/commandCenterAnimation.ts",
    "src/systems/minerAnimation.ts",
    "src/systems/tablet.ts",
    "src/systems/turretAnimation.ts",
    "src/systems/unitAnimation.ts",
    "src/systems/wave.ts",
  ];

  for (const file of runtimeFiles) {
    assert.doesNotMatch(source(file), /requestAnimationFrame/);
  }
});

test("hot animation systems reuse their live-controller sets", () => {
  const animationFiles = [
    "src/systems/alienAnimation.ts",
    "src/systems/commandCenterAnimation.ts",
    "src/systems/minerAnimation.ts",
    "src/systems/turretAnimation.ts",
    "src/systems/unitAnimation.ts",
  ];

  for (const file of animationFiles) {
    const code = source(file);
    assert.match(code, /private readonly liveAnimated\w+ = new Set<number>\(\)/);
    assert.doesNotMatch(
      code,
      /update\(delta: number\): void \{[\s\S]*?const liveAnimated\w+ = new Set/,
    );
    assert.doesNotMatch(
      code,
      /for \(const \[entityIndex, controller\] of controllers\)/,
    );
  }
});

test("board uses one ray target over a continuous ground surface", () => {
  const board = source("src/systems/board.ts");
  const interaction = source("src/systems/interaction.ts");
  const state = source("src/systems/state.ts");

  assert.equal(board.match(/\.addComponent\(RayInteractable\)/g)?.length, 1);
  assert.match(board, /name = "BoardGround"/);
  assert.doesNotMatch(board, /terrain\.scene\.clone/);
  assert.match(board, /\.addComponent\(BoardSurface\)/);
  assert.doesNotMatch(board, /\.addComponent\(BoardTile/);
  assert.match(board, /worldToGrid\(localHit\.x, localHit\.z\)/);
  assert.match(
    interaction,
    /pressedBoard: \{ required: \[BoardSurface, Pressed\] \}/,
  );
  assert.match(state, /terrainByKey: new Map<string, BoardTerrain>\(\)/);
});

test("health bars keep their headset-verified geometry sizing path", () => {
  const healthBar = source("src/systems/healthBar.ts");

  assert.doesNotMatch(healthBar, /bar\.scale\.x\s*=/);
  assert.match(healthBar, /new BoxGeometry\(width, 0\.012/);
  assert.match(healthBar, /new BoxGeometry\(width, 0\.016/);
  assert.match(healthBar, /fill\.scale\.x = Math\.max\(0\.001, ratio\)/);
  assert.match(healthBar, /fill\.position\.x = -\(width \* \(1 - ratio\)\) \/ 2/);
});

test("tablet exposes live headset performance diagnostics", () => {
  const markup = source("ui/rts-tablet.uikitml");
  const tablet = source("src/systems/tablet.ts");
  const frameProfiler = source("src/systems/frameProfiler.ts");

  assert.match(markup, /id="settings-performance"/);
  // One span per profiler row: UIKit ignores "\n" inside a text element, so a
  // single span word-wraps the block and splits labels mid-row.
  assert.match(markup, /id="settings-frame-profile-1"/);
  assert.match(markup, /id="settings-frame-profile-12"/);
  assert.match(frameProfiler, /"prepareWaveIncrementally", "WaveSystem\.prepare", "Prep"/);
  assert.match(frameProfiler, /"createPreparedAlien", waveBuildDescriptor/);
  assert.match(
    frameProfiler,
    /PREPARATION_ROW = \["Prep", "PAlien", "PDrake", "PMech", "Spawn", "Wave"\]/,
  );
  assert.match(
    frameProfiler,
    /CORE_ROW = \["Path", "Tablet", "Input", "PanelUI", "ScreenSpaceUI"\]/,
  );
  assert.match(
    frameProfiler,
    /"findNearestTargetPath", "WaveSystem\.pathfind", "Path"/,
  );
  assert.match(frameProfiler, /remaining\.slice\(i, i \+ HUD_PER_LINE\)/);
  for (const label of ["PAlien", "PDrake", "PMech"]) {
    assert.match(frameProfiler, new RegExp(`short: "${label}"`));
  }
  const performanceIndex = markup.indexOf('id="settings-performance"');
  for (const view of ["overview", "build", "crafts", "units", "settings"]) {
    assert.ok(
      performanceIndex < markup.indexOf(`id="${view}-view"`),
      `performance diagnostics should remain outside the ${view} view`,
    );
  }
  assert.match(tablet, /RuntimePerformance/);
  assert.match(tablet, /movingEntities/);
});

test("waves prepare incrementally while reserves stay cheap", () => {
  const constants = source("src/systems/constants.ts");
  const structures = source("src/systems/structures.ts");
  const wave = source("src/systems/wave.ts");
  const enemyFactory = structures.slice(
    structures.indexOf("export function createEnemyEntity"),
    structures.indexOf("export function createInitialScenario"),
  );

  assert.match(constants, /WAVE_PREP_PER_FRAME = 1/);
  assert.match(wave, /this\.prepareWaveIncrementally\(source\)/);
  assert.match(wave, /this\.spawnCursor \+ WAVE_PREP_PER_FRAME/);
  assert.match(wave, /this\.createPreparedAlien\(this\.pendingSpawns/);
  assert.match(wave, /slowestBuildAsset = spawn\.asset/);
  assert.match(wave, /slowestBuildName = spawn\.name/);
  assert.match(wave, /alien\.object3D\.visible = true/);
  assert.match(wave, /alien\.addComponent\(RayInteractable\)/);

  assert.match(enemyFactory, /holder\.visible = false/);
  assert.doesNotMatch(enemyFactory, /\.addComponent\(RayInteractable\)/);
  assert.equal(enemyFactory.match(/setFromObject\(model\)/g)?.length, 1);
});

test("alien pathfinding is bounded, shared, and follows cached routes", () => {
  const constants = source("src/systems/constants.ts");
  const navigation = source("src/systems/navigation.ts");
  const wave = source("src/systems/wave.ts");

  assert.match(constants, /ALIEN_PATHFINDS_PER_FRAME = 1/);
  assert.match(navigation, /class ReusableGridPathfinder/);
  assert.match(navigation, /goalByCell: Int32Array/);
  assert.match(wave, /private readonly routeByAlien = new Map<number, AlienRoute>/);
  assert.match(wave, /this\.rebuildNavigationOccupancy\(\)/);
  assert.match(wave, /pathfindsRemaining = ALIEN_PATHFINDS_PER_FRAME/);
  assert.match(wave, /if \(pathfindsRemaining <= 0\) continue/);
  assert.match(wave, /this\.resumeCachedRoute\(alien, currentTarget\)/);
  assert.match(wave, /this\.pathfinder\.findPathToAny/);
  assert.doesNotMatch(wave, /findPathToTarget/);
});
