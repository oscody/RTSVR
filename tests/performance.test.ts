import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
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
  // Follows the build mode with everything else — see traceFlags.
  assert.match(frameProfiler, /FRAME_PROFILER_ENABLED = DIAGNOSTICS_ENABLED;/);
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

test("the diagnostics switch resolves correctly for every build shape", () => {
  // Behavioural, not textual: the exact expression from `traceFlags.ts` and
  // `actionLog.ts`, evaluated against the env shapes each build actually
  // produces. Vite emits `import.meta.env` as a real object (`PROD:!0` appears
  // in the bundle), and plain node leaves it undefined.
  const resolve = (env: Record<string, unknown> | undefined): boolean => {
    const override = String(env?.VITE_DIAGNOSTICS ?? "").toLowerCase();
    return override === "on"
      ? true
      : override === "off"
        ? false
        : (env?.PROD as boolean | undefined) !== true;
  };

  assert.equal(resolve({ DEV: true, PROD: false }), true, "dev server: on");
  assert.equal(resolve({ DEV: false, PROD: true }), false, "production build: off");
  assert.equal(resolve({ PROD: true, VITE_DIAGNOSTICS: "on" }), true, "prod + override on");
  assert.equal(resolve({ PROD: false, VITE_DIAGNOSTICS: "off" }), false, "dev + override off");
  assert.equal(resolve({ PROD: true, VITE_DIAGNOSTICS: "ON" }), true, "override is case-insensitive");
  // Absent env (the strip-types test runner, any plain-node import) must behave
  // like development. A tool that is not a build should not silently go quiet.
  assert.equal(resolve(undefined), true, "no env: on");
  // An unrecognised override falls through to the build default rather than
  // being treated as "off" — a typo must not silence a playtest build.
  assert.equal(resolve({ PROD: false, VITE_DIAGNOSTICS: "yes" }), true, "typo falls through");

  // And both files must implement exactly this.
  const read = (p: string): string =>
    readFileSync(new URL(`../src/systems/${p}`, import.meta.url), "utf8");
  for (const file of ["traceFlags.ts", "actionLog.ts"]) {
    const src = read(file);
    assert.match(src, /=== "on"\s*\?\s*true/, `${file}: missing the on override`);
    assert.match(src, /=== "off"\s*\?\s*false/, `${file}: missing the off override`);
    assert.match(src, /\(buildEnv\?\.PROD as boolean \| undefined\) !== true/, `${file}: wrong default`);
  }
});

test("no console.log escapes the diagnostics switch", () => {
  // The gap this closes: turning logging off gated the 11 named flags and
  // missed four separate `console.log` sources — `[ProgramChurn]` streaming
  // every ~600 frames, `[MeshMerge]` at boot, `[GridVisual]`, and `[WaveBuild]`.
  // A "quiet" build was still writing to the console.
  //
  // Grepping by hand is exactly what failed, so it is a test now.
  //
  // `console.warn` and `console.error` are deliberately NOT covered: a wave
  // that fails to build, or an audio context that will swallow playback, must
  // still report in a quiet build. Silence is for diagnostics, not for faults.
  const dir = new URL("../src/", import.meta.url);
  const offenders: string[] = [];

  const walk = (rel: string): void => {
    for (const entry of readdirSync(new URL(rel, dir), { withFileTypes: true })) {
      const path = `${rel}${entry.name}`;
      if (entry.isDirectory()) {
        walk(`${path}/`);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      const src = readFileSync(new URL(path, dir), "utf8");
      // The trace subsystem is gated by INSTALLATION, not by an inline check:
      // nothing in `trace*.ts` runs unless `installTraceRecorder()` /
      // `installTraceDiagnostics()` were called, and those are behind the
      // switch. Verified empirically — a `VITE_DIAGNOSTICS=off` run emits no
      // `[Trace]` or `[RuntimeTrace]` line at all.
      if (entry.name.startsWith("trace")) continue;

      // Modules whose entire output is switch-gated at the top, or that guard
      // each call inline.
      // `transparentPassProbe.ts` is installation-gated the same way `trace*.ts`
      // is: `installTransparentPassProbe()` returns before hooking anything or
      // allocating a ring when its flag is off, and nothing else in the module
      // is reachable without that hook. Both halves of that claim are pinned in
      // "the log sources that needed hand-wiring are actually wired" below,
      // because an exemption nobody checks is how the four original offenders
      // got in.
      const selfGated =
        /const (ACTION_LOG_ENABLED|FRAME_PROFILER_ENABLED|PROGRAM_CHURN_ENABLED)/.test(src) ||
        /TRANSPARENT_PASS_TRACE_ENABLED/.test(src) ||
        /DIAGNOSTICS_ENABLED/.test(src);
      if (selfGated) continue;
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        if (!/\bconsole\.log\(/.test(line)) return;
        offenders.push(`${path}:${i + 1}`);
      });
    }
  };
  walk("");

  assert.deepEqual(
    offenders,
    [],
    `these console.log calls are not behind the diagnostics switch:\n  ${offenders.join("\n  ")}`,
  );
});

test("the log sources that needed hand-wiring are actually wired", () => {
  // The sweep above is weaker than it looks: it exempts any file that MENTIONS
  // `DIAGNOSTICS_ENABLED`, so a file that imports the switch and then ignores it
  // passes. Both of these did exactly that and both reverts went green.
  //
  // Asserting a file mentions a guard says nothing about whether the guard is
  // reached — the same lesson as the missed alien-build site and the losing-only
  // MatchEnd paths. So these two are pinned specifically.
  const read = (p: string): string =>
    readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

  // ProgramChurn had its own hardcoded flag and streamed every ~600 frames.
  assert.match(
    read("systems/programChurn.ts"),
    /const PROGRAM_CHURN_ENABLED = DIAGNOSTICS_ENABLED;/,
    "ProgramChurn must follow the switch, not its own constant",
  );

  // meshMerge's `verbose` parameter was hardcoded `true` at the only call site,
  // which made it not a switch at all. Feeding it the build mode is what
  // silences ~30 lines of boot output.
  assert.match(
    read("index.ts"),
    /optimizeLoadedAssets\(Object\.keys\(assets\), DIAGNOSTICS_ENABLED,/,
    "mesh-merge verbosity must follow the switch, not be hardcoded true",
  );

  // The one merge line that is deliberately outside `verbose` still has to be
  // inside the build switch — "even when verbose is off" is not "always".
  assert.match(
    read("systems/meshMerge.ts"),
    /if \(twoPass\.length > 0 && DIAGNOSTICS_ENABLED\)/,
  );

  // The transparent-pass witness earns its exemption from the sweep above by
  // being unreachable when the switch is off, so both halves are pinned here.
  // It hooks `scene.onAfterRender` — the one diagnostic that sits inside the
  // render path — so "inert when off" has to mean the hook is never installed,
  // not merely that it returns early once per frame.
  assert.match(
    read("systems/traceFlags.ts"),
    /const TRANSPARENT_PASS_TRACE_ENABLED = DIAGNOSTICS_ENABLED;/,
    "the witness must follow the build switch, not its own constant",
  );
  assert.match(
    read("systems/transparentPassProbe.ts"),
    /if \(!TRANSPARENT_PASS_TRACE_ENABLED \|\| installed\) return;/,
    "install must bail before hooking the renderer or allocating the ring",
  );
  // Same exemption, same obligation: the raster witness adds a draw and a pool
  // of GL queries, so "inert when off" has to mean neither is ever created.
  assert.match(
    read("systems/transparentRasterProbe.ts"),
    /if \(!TRANSPARENT_PASS_TRACE_ENABLED \|\| installed\) return;/,
    "install must bail before adding the probe mesh or creating queries",
  );
});

test("the profiler logs the crystal balance, not just the roster", () => {
  // The 2026-09-03 capture could not answer its own question. A run ending
  // with 8 turrets and 2 units reads identically whether the player CHOSE
  // turrets or was too crystal-starved to field anything else — and nothing in
  // 79k lines recorded a balance. Mining deposits do reach the trace, but
  // `[TraceDump]` only prints around a hitch: 20 deposits were logged out of
  // roughly 180 that a 742s match with three miners must have made.
  const profiler = source("src/systems/frameProfiler.ts");
  const performance = source("src/systems/performance.ts");

  assert.match(profiler, /crystals: number;/, "ForceCensus must carry the balance");
  assert.match(profiler, /crystalsMined: number;/);
  assert.match(
    profiler,
    /crystals \$\{c\.crystals\} mined \$\{c\.crystalsMined\}/,
    "the Roster line must print them",
  );

  // The balance lives on GameState, the running total on GameStats — two
  // separate singletons. Reading both from one is the mistake to prevent.
  assert.match(performance, /getValue\(GameState, "crystals"\)/);
  assert.match(performance, /getValue\(GameStats, "crystalsMined"\)/);

  // -1 is "no board yet", which must stay distinct from a real balance of 0 —
  // the value every match legitimately starts at.
  assert.match(profiler, /c\.crystals < 0/, "a missing board must not print as a balance");
});

test("a scenario reset waits for an in-flight GPU compile", () => {
  // Restart used to throw, on a real Quest, 2026-09-03:
  //   Uncaught TypeError: Cannot read properties of undefined (reading 'isReady')
  //       at checkMaterialsReady   <- three.js, inside its own setTimeout
  // Disposing the scene while `compileAsync` is still polling its materials
  // dereferences a freed program. The throw lands in a timer, so neither the
  // try/catch nor the promise rejection handler can see it.
  const reset = source("src/systems/scenarioReset.ts");
  const warmup = source("src/systems/gpuWarmup.ts");

  assert.match(warmup, /if \(paused \|\| active \|\| !targets\) return;/,
    "a paused warm-up must not start new targets");
  assert.match(warmup, /export function gpuWarmupActive\(\)/);

  assert.match(reset, /setGpuWarmupPaused\(true\)/, "the reset must pause warm-up");
  assert.match(reset, /if \(gpuWarmupActive\(\)\)/, "and wait while one is in flight");
  // Bounded: a compile that never settles is exactly what the crash causes, and
  // a restart the player cannot perform is worse than the error it avoids.
  assert.match(reset, /RESET_WARMUP_WAIT_FRAMES/);
  assert.match(reset, /setGpuWarmupPaused\(false\)/, "and release it again");
  // In a `finally`: a reset that throws must still hand warm-up back, or the
  // session loses first-use compilation on top of the original failure.
  assert.match(
    reset,
    /finally \{\s*setGpuWarmupPaused\(false\);/,
    "the release must be in a finally, not a plain call after resetScenario",
  );

  // `attachGpuWarmup` clears every other field of module state. Missing this
  // one leaves a re-attached world with warm-up silently switched off — no
  // error, just first-use hitches back and nothing pointing at why.
  const attach = warmup.slice(
    warmup.indexOf("export function attachGpuWarmup"),
  );
  const body = attach.slice(0, attach.indexOf("\n}"));
  for (const field of ["queue", "active", "warmedCount", "paused"]) {
    assert.match(
      body,
      new RegExp(`\\b${field} = `),
      `attachGpuWarmup must reset "${field}"`,
    );
  }

  // Pausing only works because the reset runs first in the frame.
  const index = source("src/index.ts");
  const resetAt = index.indexOf("registerSystem(ScenarioResetSystem)");
  const warmupAt = index.indexOf("registerSystem(GpuWarmupSystem)");
  assert.ok(resetAt > 0 && warmupAt > 0);
  assert.ok(
    resetAt < warmupAt,
    "ScenarioResetSystem must be registered before GpuWarmupSystem, or the " +
      "pause lands a frame too late and a compile can still start during teardown",
  );
});

test("GPU warm-up compiles synchronously when the device cannot report readiness", () => {
  // Section E of the disposal-tracking plan. Three.js's compileAsync is:
  //     const materials = this.compile(scene, camera, targetScene);  // all the work
  //     return new Promise(resolve => { ...poll material.isReady()... });
  // Every shader is compiled by that first SYNCHRONOUS line. The promise only
  // confirms readiness — and without KHR_parallel_shader_compile (Quest) Three
  // cannot ask, so it falls back to setTimeout(check, 10) and guesses. That
  // window is what a scenario reset disposed into, producing:
  //     Uncaught TypeError: Cannot read properties of undefined (reading 'isReady')
  // Taking the synchronous path removes the window rather than narrowing it.
  const warmup = source("src/systems/gpuWarmup.ts");

  assert.match(warmup, /KHR_parallel_shader_compile/, "the extension must be probed");
  assert.match(
    warmup,
    /if \(!parallelCompileAvailable \|\| !renderer\.compileAsync\)/,
    "absent extension must take the synchronous branch",
  );
  assert.match(warmup, /renderer\.compile\?\.\(target\.object, camera, scene\)/);

  // Probed once at attach: it cannot change for a live context, and repeat
  // misses on extensions.get() warn.
  const attach = warmup.slice(warmup.indexOf("export function attachGpuWarmup"));
  assert.match(
    attach.slice(0, attach.indexOf("\n}")),
    /parallelCompileAvailable = /,
    "the probe belongs in attach, not in the per-target path",
  );
});

test("a scenario reset drops queued warm-up targets before disposing anything", () => {
  const warmup = source("src/systems/gpuWarmup.ts");
  const reset = source("src/systems/scenarioReset.ts");

  assert.match(warmup, /export function clearGpuWarmupQueue/);
  // Stale membership would make a legitimate re-queue after the rebuild look
  // like a duplicate and be silently ignored.
  const clear = warmup.slice(warmup.indexOf("export function clearGpuWarmupQueue"));
  const body = clear.slice(0, clear.indexOf("\n}"));
  assert.match(body, /pendingObjects = new WeakSet/, "membership sets must be rebuilt");
  assert.match(body, /pendingTextures = new WeakSet/);

  // Order matters: clearing after disposal would have already retained the
  // dead objects for a frame.
  const clearAt = reset.indexOf("clearGpuWarmupQueue(");
  const disposeAt = reset.indexOf("this.resetScenario(source)");
  assert.ok(clearAt > 0 && disposeAt > 0);
  assert.ok(clearAt < disposeAt, "the queue must be cleared before teardown");
});

test("the heap leak signal can actually rise", () => {
  // The old field was one running Math.min over the whole session, so it was
  // monotonically non-increasing — it COULD NOT CLIMB — while the comment above
  // it called a climbing floor the leak signal. A 2026-09-03 capture was read as
  // "heap 61 -> 98mb, floor held at 61, nothing leaked". That was arithmetic,
  // not evidence.
  const profiler = source("src/systems/frameProfiler.ts");

  // Checked against CODE, not the file: the doc comment deliberately quotes the
  // old line to explain why it was wrong, and that explanation should survive.
  const code = profiler.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(
    code,
    /heapFloorMb/,
    "the session-wide floor must be gone from live code, not merely renamed around",
  );
  assert.match(profiler, /export function beginHeapCycle/);

  // Scoped to the function body: `/heapCycleMinMb = 0;/` also matches the
  // top-level `let heapCycleMinMb = 0`, so a boundary that never resets the
  // minimum would still have passed — the exact regression this guards.
  const begin = profiler.slice(profiler.indexOf("export function beginHeapCycle"));
  const body = begin.slice(0, begin.indexOf("\n}"));
  assert.match(body, /heapPreviousCycleMinMb = heapCycleMinMb/, "carry the old minimum");
  assert.match(body, /heapCycleMinMb = 0/, "and restart the new one");

  // A boundary that nothing calls leaves the minimum session-wide again.
  const reset = source("src/systems/scenarioReset.ts");
  assert.match(reset, /beginHeapCycle\(\)/, "the reset must open a new heap cycle");
});

test("combat warm-up duplicates are released, but only once that is free", () => {
  // The 2026-09-03 Quest capture reported `temporaryOutstanding=4` after every
  // teardown — two geometries and two materials built by `queueCombatWarmup()`
  // to compile the shader before the first shot, and never disposed.
  //
  // They cannot be disposed right after warming. Three.js refcounts programs
  // (`releaseProgram` destroys at `usedTimes === 0`), so releasing the only
  // material holding the compiled program destroys it and the real pool
  // recompiles — the warm-up would have bought nothing.
  const effects = source("src/systems/combatEffects.ts");

  assert.match(effects, /function releaseCombatWarmupResources/);
  const release = effects.slice(effects.indexOf("function releaseCombatWarmupResources"));
  const body = release.slice(0, release.indexOf("\n}"));

  // Condition 1: the pool must hold the same program first.
  assert.match(
    body,
    /boltSlots\.length === 0 \|\| flashSlots\.length === 0/,
    "must wait for the real pool, or the program refcount hits zero",
  );
  // Condition 2: nothing may still be queued to compile these.
  assert.match(
    body,
    /warmup\.active \|\| warmup\.queued > 0/,
    "a queued target would be handed a disposed material",
  );
  assert.match(body, /geometry\.dispose\(\)/);
  assert.match(body, /material.*dispose\(\)|entry\.dispose\(\)/);

  // The condition that was WRONG on 2026-09-04 and is the point of this test:
  // a pool that merely exists has acquired nothing. Three.js reaches
  // `getProgram` only from `compile()` or a real render, and pool meshes are
  // built `visible = false` — so the program had to be handed over explicitly
  // before the duplicates could be released, or the first shot recompiled.
  const ensure = effects.slice(effects.indexOf("function ensurePool"));
  const ensureBody = ensure.slice(0, ensure.indexOf("\n}"));
  assert.match(
    ensureBody,
    /warmObjectForRender\(boltSlots\[0\]\?\.mesh/,
    "the pool must be warmed so it acquires the program",
  );
  assert.match(ensureBody, /warmObjectForRender\(flashSlots\[0\]\?\.mesh/);
  // Queued before `pooledRoot` is set, so the very first release attempt sees a
  // non-empty queue and waits.
  assert.ok(
    ensureBody.indexOf("warmObjectForRender(boltSlots[0]") <
      ensureBody.indexOf("pooledRoot = rootObject"),
    "the pool warm-up must be queued before the pool is marked ready",
  );

  // Retried every frame, not on the next shot. A player who fires once and
  // never again would otherwise keep the duplicates for the whole session,
  // because the queue is still draining at the moment of that single shot.
  const update = effects.slice(effects.indexOf("  update(delta: number): void {"));
  const updateBody = update.slice(0, update.indexOf("\n  }"));
  assert.match(
    updateBody,
    /releaseCombatWarmupResources\(\)/,
    "release must be driven from update(), not from the shot path",
  );
});

test("the render-target and entity-life rows are actually emitted", () => {
  // Both existed with no runtime caller — the 2026-09-04 review found
  // `renderTargetLine()` reachable only from its own test, and the entity
  // lifecycle counters recorded but never printed in readable form.
  const profiler = source("src/systems/frameProfiler.ts");
  assert.match(profiler, /renderTargetLine\(\),/, "must be in the profile rows");
  assert.match(profiler, /entityLifeLine\(\),/);

  // Unlike the scope rows, the render-target row must NOT be omitted when the
  // app owns none: "0" reads as "there are none", and the point of the line is
  // that external ones are unavailable rather than absent.
  const build = profiler.slice(profiler.indexOf("function buildForceLines"));
  assert.doesNotMatch(
    build.slice(0, build.indexOf("\n}")),
    /renderTargetLine\(\)[^,]*\?/,
    "the render-target row must be unconditional",
  );
});

test("entity life is a per-flush delta, taken without disturbing the trace", () => {
  const trace = source("src/systems/trace.ts");
  // The interval counters belong to the allocation trace, which zeroes them on
  // its own schedule. A second consumer sharing them would race — whichever
  // read first would empty the other's window.
  assert.match(trace, /export function readEntityLifecycleTotals/);
  const totals = trace.slice(trace.indexOf("export function readEntityLifecycleTotals"));
  assert.doesNotMatch(
    totals.slice(0, totals.indexOf("\n}")),
    /=\s*0/,
    "the totals reader must not reset anything",
  );

  const profiler = source("src/systems/frameProfiler.ts");
  const line = profiler.slice(profiler.indexOf("function entityLifeLine"));
  const body = line.slice(0, line.indexOf("\n}"));
  assert.match(body, /totals\.created - lastEntityCreated/, "a delta, not a total");
  assert.match(body, /lastEntityCreated = totals\.created/, "and the window advances");
  // `Ents` is a NET count: eleven created and eleven destroyed looks identical
  // to nothing happening. That distinction is the reason this row exists.
  assert.match(body, /traced gameplay entities/, "must state what it counts");
});
