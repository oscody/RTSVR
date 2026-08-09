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

test("profiler reports one coherent worst-Update frame, averages, and ray targets", () => {
  const profiler = source("src/systems/frameProfiler.ts");
  const markup = source("ui/rts-tablet.uikitml");
  const tablet = source("src/systems/tablet.ts");

  // Per-slot maxima can come from different frames and cannot be added. The
  // worst-Update snapshot captures one real frame so its parts do add up.
  assert.match(profiler, /lastMs: number/);
  assert.match(profiler, /slot\.lastMs = ms/);
  assert.match(profiler, /if \(lastUpdateMs > worstUpdateMs\)/);
  assert.match(profiler, /WorstUpd \$\{worstUpdateMs\.toFixed\(1\)\}/);
  // Render/Other run outside world.update, so their lastMs belongs to the
  // previous frame and must be excluded from the breakdown.
  assert.match(profiler, /if \(DIAG_ROW\.includes/);

  // frames/totalMs were already collected and discarded; surface the average so
  // a sustained cost can be told apart from a one-frame spike.
  assert.match(profiler, /slot\.totalMs \/ slot\.frames/);
  assert.match(profiler, /"Avg " \+/);

  // Input is raycasting, so count ray-testable meshes the way Draw counts
  // visible ones.
  assert.match(profiler, /RayMesh \$\{rayTestableMeshes\}/);
  assert.match(profiler, /function isRaycastDisabled/);

  // The HUD must have room for the two new rows.
  const rows = markup.match(/id="settings-frame-profile-\d+"/g) ?? [];
  assert.ok(rows.length >= 16, `expected >=16 profile rows, found ${rows.length}`);
  assert.match(tablet, /PROFILE_ROW_COUNT = 16/);
  assert.match(markup, /settings-frame-profile-4[^>]*>WorstUpd --</);
  assert.match(
    markup,
    /settings-frame-profile-5[^>]*>Path -- \| Tablet -- \| Input -- \| PanelUI -- \| ScreenSpaceUI -- \| RayMesh --</,
  );
  assert.match(
    markup,
    /settings-frame-profile-6[^>]*>Avg Update -- \| Tablet -- \| Input -- \| PanelUI --</,
  );
  assert.match(profiler, /const coreLine = \[rowLine\(CORE_ROW\), `RayMesh /);
  assert.match(
    profiler,
    /coreLine,\s+avgLine,\s+rowLine\(PREPARATION_ROW\),/,
  );
});

test("profiler readings are copyable from chrome://inspect DevTools", () => {
  const profiler = readFileSync(
    new URL("src/systems/frameProfiler.ts", ROOT),
    "utf8",
  );

  // Readings must be readable over remote debugging, not only transcribed from
  // video frames — video cannot show console warnings or call stacks at all.
  assert.match(profiler, /const FRAME_PROFILER_LOG = /);
  assert.match(profiler, /if \(FRAME_PROFILER_LOG\)/);
  // One grouped entry per flush, with a filterable prefix.
  assert.match(profiler, /\[Profile\] t\+/);
  assert.match(profiler, /\$\{hudLine\}/);
});

test("profiler readings open with session context", () => {
  const profiler = readFileSync(
    new URL("src/systems/frameProfiler.ts", ROOT),
    "utf8",
  );
  const state = readFileSync(new URL("src/systems/state.ts", ROOT), "utf8");
  const performance = readFileSync(
    new URL("src/systems/performance.ts", ROOT),
    "utf8",
  );

  // A wall of milliseconds cannot be compared between captures without knowing
  // the level, the frame rate and how loaded the board was.
  assert.match(profiler, /function buildContextLine/);
  assert.match(profiler, /Lvl \$\{level\}/);
  assert.match(profiler, /FPS \$\{fps\}/);
  assert.match(profiler, /Enemies \$\{alive\} alive \/ \$\{killed\} killed/);
  assert.match(profiler, /Moving \$\{moving\}/);
  // It must lead the reading, not trail it.
  assert.match(profiler, /hudLines = \[contextLine, \.\.\.lines\]/);

  // Live enemy count is published by PerformanceSystem on the same sample tick.
  assert.match(state, /enemiesAlive: \{ type: Types\.Int16/);
  assert.match(performance, /"enemiesAlive",\s+this\.queries\.aliens\.entities\.size/);
});

test("tablet skips unchanged element writes", () => {
  const tablet = readFileSync(new URL("src/systems/tablet.ts", ROOT), "utf8");

  // setProperties allocates and dirties UIKit layout. A render touches ~43
  // elements of which typically one or two changed, and PanelUI was measured as
  // a fixed ~6.8ms burst about twice a second — scene-independent, so it is the
  // rewrite itself. Skipping unchanged writes is the direct attack on that.
  assert.match(tablet, /lastSetText = new WeakMap<object, string>/);
  assert.match(tablet, /lastSetProps = new WeakMap<object, string>/);
  assert.match(tablet, /if \(this\.lastSetText\.get\(target\) === text\) return;/);
  assert.match(tablet, /if \(this\.lastSetProps\.get\(target\) === signature\) return;/);

  // Keyed on the element, never the id: ids repeat across pages
  // (`craft-name-${slot}`) and a WeakMap cannot go stale on a rebuilt document.
  assert.doesNotMatch(tablet, /lastSetText = new Map<string/);

  // The repetitive per-render writes must go through the guard, not raw
  // setProperties. A few one-shot writes may remain unguarded.
  const guarded = (tablet.match(/this\.setProps\(/g) ?? []).length;
  const raw = (tablet.match(/\?\.setProperties\(\{/g) ?? []).length;
  assert.ok(guarded >= 12, `expected >=12 guarded writes, found ${guarded}`);
  assert.ok(raw <= 4, `expected <=4 raw setProperties left, found ${raw}`);
});

test("decoration is not ray-testable, pick targets still are", () => {
  const read = (f: string) => readFileSync(new URL(f, ROOT), "utf8");
  const shared = read("src/systems/sharedGeometry.ts");
  const structures = read("src/systems/structures.ts");
  const board = read("src/systems/board.ts");

  // Input is the only sustained cost (~3.5-4.5 ms every frame) and it scales
  // with ray-testable meshes, so decoration must opt out at creation.
  assert.match(shared, /export function makeNonInteractive/);

  // D1: friendly models hand hit-testing to their box proxy, as enemies do.
  assert.match(structures, /export function disableModelRaycast/);
  for (const f of ["src/systems/craftFactory.ts", "src/systems/buildingFactory.ts"]) {
    assert.match(read(f), /disableModelRaycast\(model\)/, f);
  }

  // D2: decoration nobody can click.
  for (const f of [
    "src/systems/healthBar.ts",
    "src/systems/selection.ts",
    "src/systems/combatEffects.ts",
    "src/systems/meteorSystem.ts",
    "src/systems/construction.ts",
    "src/systems/craftProduction.ts",
    "src/systems/board.ts",
  ]) {
    assert.match(read(f), /makeNonInteractive\(/, f);
  }

  // The board's single pick volume must stay hit-testable — switching it off
  // would silently break tile selection with no error anywhere.
  assert.doesNotMatch(board, /makeNonInteractive\(boardSurface\)/);
  // Same for the tablet's grab handle.
  assert.doesNotMatch(read("src/systems/tablet.ts"), /makeNonInteractive\(handle\)/);
});

