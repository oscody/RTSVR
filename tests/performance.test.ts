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

test("the profiler readout is off the tablet, but still measured and logged", () => {
  const markup = source("ui/rts-tablet.uikitml");
  const tablet = source("src/systems/tablet.ts");
  const frameProfiler = source("src/systems/frameProfiler.ts");

  // Removed 2026-08-20. It was a developer readout in 8px type that the player
  // cannot read, laid out every second by the system that owned 96% of the
  // worst frames in a 236-second capture.
  //
  // The test this replaces asserted the strip sat OUTSIDE every view — which is
  // precisely why it painted on all five tabs. It had pinned the defect as a
  // requirement, so removing the strip made it fail. Worth remembering: a test
  // can lock in the bug as firmly as the behaviour.
  assert.doesNotMatch(markup, /id="settings-performance"/);
  assert.doesNotMatch(markup, /id="settings-frame-profile-/);
  assert.doesNotMatch(markup, /performance-profile-text/);
  assert.doesNotMatch(tablet, /settings-frame-profile/);
  assert.doesNotMatch(tablet, /getFrameProfileHudLines/);
  // Repainting the tablet once a second purely to redraw the readout is gone
  // with it — the perf revision no longer feeds the dirty guard.
  assert.doesNotMatch(tablet, /RuntimePerformance/);

  // ...but the measurement itself is untouched, and still goes to the console
  // once per second. That is now the ONLY way to read these numbers.
  assert.match(frameProfiler, /FRAME_PROFILER_ENABLED = true/);
  assert.match(frameProfiler, /FRAME_PROFILER_LOG = true/);
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
  // Was `this.createPreparedAlien(this.pendingSpawns[...])`. Now routed through
  // `buildAlienSafely`, which is the same per-frame drain with a guard around
  // it — countdown preparation builds the bulk of every wave, so an unguarded
  // throw here escaped WaveSystem.update and killed the frame.
  assert.match(wave, /this\.buildAlienSafely\(this\.pendingSpawns\[this\.spawnCursor\]\)/);
  assert.match(wave, /slowestBuildAsset = spawn\.asset/);
  assert.match(wave, /slowestBuildName = spawn\.name/);
  assert.match(wave, /alien\.object3D\.visible = true/);
  assert.match(wave, /alien\.addComponent\(RayInteractable\)/);

  assert.match(enemyFactory, /holder\.visible = false/);
  assert.doesNotMatch(enemyFactory, /\.addComponent\(RayInteractable\)/);
  assert.equal(enemyFactory.match(/setFromObject\(model\)/g)?.length, 1);
});

test("GPU warm-up is queued, labelled, and covers first-use effect resources", () => {
  const gpuWarmup = source("src/systems/gpuWarmup.ts");
  const index = source("src/index.ts");
  const wave = source("src/systems/wave.ts");
  const combatEffects = source("src/systems/combatEffects.ts");
  const meteor = source("src/systems/meteorSystem.ts");
  const underAttack = source("src/systems/underAttackVfx.ts");

  assert.match(gpuWarmup, /class GpuWarmupSystem/);
  assert.match(gpuWarmup, /advanceGpuWarmup\(\)/);
  assert.match(gpuWarmup, /performance\.mark\(`gpu-warmup:/);
  assert.match(gpuWarmup, /initTexture/);
  assert.match(index, /registerSystem\(GpuWarmupSystem\)/);
  assert.match(wave, /warmObjectForRender\(alien\.object3D, `alien:\$\{spawn\.asset\}`\)/);
  assert.match(combatEffects, /"combat-bolt"/);
  assert.match(combatEffects, /"combat-flash"/);
  assert.match(meteor, /"meteor:base"/);
  assert.match(meteor, /"meteor:impact"/);
  assert.match(underAttack, /warmTextureForRender\(lockedTexture/);
  assert.match(underAttack, /warmTextureForRender\(attackTexture/);
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

  // The rows are built the same way; they are just no longer painted onto the
  // tablet. Row CONTENT is asserted against the profiler's own row definitions
  // rather than against markup, which is where it always belonged — the markup
  // assertions were testing the display, not the measurement.
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
  // It must lead the reading, not trail it. Asserted as the ORDER of the
  // header composition rather than one literal expression: the previous form
  // matched `hudLines = [contextLine, ...lines]` exactly and broke when the
  // force census was inserted between the two, despite the ordering it exists
  // to protect being unchanged.
  assert.match(profiler, /\[buildContextLine\(\), \.\.\.buildForceLines\(\)\]/);
  assert.match(profiler, /hudLines = \[\.\.\.header, \.\.\.lines\]/);

  // Live enemy count is published by PerformanceSystem on the same sample tick.
  // Gated on the census since 2026-08-24 — with every diagnostic off the query
  // walk must not happen, so the published value is 0 rather than a count
  // nobody paid for. The source of the count is unchanged.
  assert.match(state, /enemiesAlive: \{ type: Types\.Int16/);
  assert.match(
    performance,
    /"enemiesAlive",\s+censusEnabled \? this\.queries\.aliens\.entities\.size : 0/,
  );
});

test("profiler reports active aliens separately from waiting reserves", () => {
  const profiler = readFileSync(
    new URL("src/systems/frameProfiler.ts", ROOT),
    "utf8",
  );
  const performance = readFileSync(
    new URL("src/systems/performance.ts", ROOT),
    "utf8",
  );

  // `enemiesAlive` on the context line is `aliens.entities.size`, which counts
  // hidden reserves — during a countdown it reads 19 with nothing on the board.
  // That ambiguity is why a 2026-08-23 attempt to show the wave cap being
  // violated in the field had to be retracted. The census must publish the
  // count the `maxActiveAliens` cap actually governs.
  assert.match(profiler, /aliensActive: number/);
  assert.match(profiler, /aliensWaiting: number/);
  assert.match(profiler, /Force alien \$\{c\.aliensActive\} act \$\{c\.aliensWaiting\} wait/);

  // Same rule as WaveSystem.activeLivingAlienCount: alive, and not "waiting".
  assert.match(
    performance,
    /if \(alien\.getValue\(WaveUnit, "stage"\) === "waiting"\) \{\s+census\.aliensWaiting \+= 1;/,
  );
  assert.match(performance, /census\.aliensActive \+= 1;/);

  // Dead-but-unreaped entities must not inflate any roster for the frame or two
  // before cleanup runs.
  assert.match(performance, /getValue\(Health, "current"\) \?\? 0\) <= 0\) continue;/);
});

test("force census keeps fixed columns so a log stays greppable", () => {
  const performance = readFileSync(
    new URL("src/systems/performance.ts", ROOT),
    "utf8",
  );

  // Zeroing the known kinds rather than clearing the map is what keeps every
  // sample's columns identical across a 700-sample session; a kind that fell to
  // zero must print `0`, not vanish and read as missing data.
  assert.match(performance, /function resetCounts/);
  assert.match(performance, /for \(const kind of counts\.keys\(\)\) counts\.set\(kind, 0\)/);

  // Turrets are Buildings in this codebase, not Units — but they lead the
  // building columns because they are the count most often being checked.
  assert.match(performance, /const BUILDING_KIND_ORDER = \[\s+"turret",/);

  // An unlisted kind must still be counted and named, so adding a craft cannot
  // silently drop it from the roster.
  assert.match(performance, /counts\.set\(kind, \(counts\.get\(kind\) \?\? 0\) \+ 1\)/);
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
