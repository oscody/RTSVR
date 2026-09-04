import { type World } from "@iwsdk/core";
import {
  GameStats,
  MatchState,
  RuntimePerformance,
  WaveSource,
  boardState,
} from "./state.js";
import { WaveSystem } from "./wave.js";
import { gpuWarmupLine } from "./gpuWarmup.js";
import {
  beginResourceInterval,
  renderTargetLine,
  resourceLifetimeLine,
} from "./resourceLifetime.js";
import { readEntityLifecycleTotals } from "./trace.js";
import { advanceSettledSnapshot } from "./resourceCycle.js";
import { SYSTEM_EXECUTION_TRACE_ENABLED,
  DIAGNOSTICS_ENABLED,
} from "./traceFlags.js";
import { Reason, TraceKind } from "./traceIds.js";
import {
  beginTraceFrame,
  diagnosticHeader,
  endTraceFrame,
  flushPendingDump,
  flushTraceCost,
  formatTraceCostLine,
  installTraceRecorder,
  isTraceRecording,
  meters,
  recordEvent,
  recordSystemBegin,
  recordSystemEnd,
  setTraceSystemContext,
} from "./traceRecorder.js";
import {
  NO_SYSTEM_ID,
  registerSystemIdentities,
  registrationIndexFor,
  reportSystemMap,
  systemIdFor,
  systemNameFor,
} from "./traceSystemIds.js";
import {
  allocationLine,
  attachRuntimeTracing,
  noteFramePeriod,
  sampleAllocations,
  setCensusSnapshot,
} from "./traceRuntime.js";
import { attachShaderTracing } from "./traceShader.js";
import { attachInteractionTracing } from "./traceInteraction.js";
import { exposeTraceConsoleHandles } from "./traceDiagnosticsSystem.js";

// Lightweight per-system frame profiler. Wraps the update() of EVERY registered
// system and records how long each takes, so on-device pauses can be attributed
// to a system instead of guessed at. Nothing is logged to the console —
// PerformanceSystem (performance.ts) calls flushFrameProfile() on its FPS sample
// tick to refresh the HUD text, which the tablet's Settings tab shows via
// getFrameProfileHud(). Flip FRAME_PROFILER_ENABLED off to disable.
const FRAME_PROFILER_ENABLED = DIAGNOSTICS_ENABLED;

/**
 * Whether the `[Profile]` instrument is on.
 *
 * Exported because `PerformanceSystem` gates the force census on it: the census
 * feeds the `[Profile]` line, so switching the profiler off must switch the
 * census off too, independently of `ENTITY_CENSUS_ENABLED`. The flag itself
 * stays here rather than moving to `traceFlags.ts` — this file has owned the
 * `[Profile]` output since long before the trace existed, and the capture
 * scripts key on it.
 */
export function isFrameProfilerEnabled(): boolean {
  return FRAME_PROFILER_ENABLED;
}
// Mirror each flush to the console (~1 Hz) so profiler readings can be copied
// out of `chrome://inspect` DevTools rather than transcribed from video frames.
// Filter the DevTools console by "[Profile]" to isolate them. Turn off to keep
// the console quiet — the tablet HUD is unaffected either way.
const FRAME_PROFILER_LOG = true;
// Any system not named in HUD_ROWS falls back to this many per line.
const HUD_PER_LINE = 6;
// Fixed HUD rows, in display order. Systems are grouped by what they do so a
// line can be scanned as a unit; the previous layout packed them 6-at-a-time in
// registration order and let the tablet word-wrap mid-row, which split labels
// across lines and made the block unreadable on device.
const PREPARATION_ROW = ["Prep", "PAlien", "PDrake", "PMech", "Spawn", "Wave"] as const;
const CORE_ROW = ["Path", "Tablet", "Input", "PanelUI", "ScreenSpaceUI"] as const;
const POINTER_ROW = ["CanvasPointer", "Grab", "Transform", "Visibility", "Environment"] as const;
const SIM_ROW = ["Movement", "Combat", "CombatEffects"] as const;
const BATTLE_ANIM_ROW = ["AlienAnim", "CommandCenterAnim", "TurretAnim"] as const;
const UNIT_ROW = ["UnitAnim", "Mining", "MinerAnim"] as const;
const PRODUCTION_ROW = ["Construction", "CraftProduction", "CraftVisualRise"] as const;
const WORLD_ROW = ["Level", "Audio", "Follow", "Board", "Sky", "Structures"] as const;
const SESSION_ROW = ["Performance", "Interaction", "Meteor", "MatchResult", "ScenarioReset"] as const;
// Named so the tutorial's cost has a deliberate home rather than landing in the
// leftover bucket, which was one entry away from spilling past the tablet's
// 16-row cap (tablet.ts PROFILE_ROW_COUNT) and being silently dropped on device.
const TUTORIAL_ROW = ["Tutorial", "CommandCenterHud"] as const;
const HUD_ROWS: readonly (readonly string[])[] = [
  PREPARATION_ROW,
  CORE_ROW,
  POINTER_ROW,
  SIM_ROW,
  BATTLE_ANIM_ROW,
  UNIT_ROW,
  PRODUCTION_ROW,
  WORLD_ROW,
  SESSION_ROW,
  TUTORIAL_ROW,
];
// Whole-frame decomposition. The per-system rows only cover system.update();
// the actual frame also spends time in renderer.render() and in
// compositor/GPU-wait/GC that no system wraps. Frame = Update + Render + Other,
// so a large Other with small Update/Render means the cost is off-CPU (render
// submit, GPU, WebXR compositor, or a GC pause) — the profiler's old blind spot.
const DIAG_ROW = ["Frame", "Update", "Render", "Other"] as const;

// Scene-weight counters (max over the sample window), sampled in the render
// wrapper from renderer.info (three.js resets it per render, so the values are
// this-frame). Draw calls/triangles = GPU submit load; Objs/Mesh (once-per-flush
// scene traversal) = matrix-traversal weight, which counts hidden reserves too.
let maxDrawCalls = 0;
let maxTriangles = 0;
let liveGeometries = 0;
let liveTextures = 0;
let livePrograms = 0;
let sceneObjectCount = 0;
/**
 * Frames since `renderer.info` was last read.
 *
 * The totals above are refreshed inside the render wrapper, so anything that
 * reads them from `world.update` — a scenario reset, for instance — is looking
 * at the PREVIOUS frame. At a post-teardown snapshot that matters enormously:
 * the geometry count still includes everything the teardown just disposed, and
 * a reader who does not know that will conclude nothing was released.
 *
 * Reported as `rendererSampleAgeFrames` so the number carries its own caveat.
 */
let rendererSampleAgeFrames = 0;
let sceneMeshCount = 0;
// Minimal Object3D shape for the once-per-flush category walk.
interface WalkNode {
  type?: string;
  visible?: boolean;
  userData?: { drawCat?: string };
  children?: WalkNode[];
  raycast?: unknown;
}
let rayTestableMeshes = 0;

// A mesh has opted out of hit-testing when its own `raycast` differs from the
// one it inherits from the prototype — the shape `disableModelRaycast` and the
// decorative opt-outs use (`child.raycast = () => {}`).
function isRaycastDisabled(node: WalkNode): boolean {
  const own = node.raycast;
  if (typeof own !== "function") return false;
  const proto = Object.getPrototypeOf(node) as { raycast?: unknown } | null;
  return proto ? own !== proto.raycast : false;
}
let profiledScene: WalkNode | null = null;
// Per-frame decomposition state (see DIAG_ROW).
let lastUpdateStart = 0;
let lastUpdateMs = 0;
let lastRenderMs = 0;

// The renderer, kept so the XR session's frame rate can be read at flush time.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let profiledRenderer: any = null;
// Refresh rate the XR session is actually running at, and the per-frame budget
// it implies. Both are 0 until an immersive session reports a rate.
//
// This is not cosmetic. Every "is this frame over budget" judgement in the
// devlog has had to ASSUME 72 Hz, and a Quest that quietly settles on 90 (or
// drops to half rate after a missed deadline) makes every one of those readings
// wrong by 25% in the direction that hides a problem. Recording the real number
// with the reading is Phase 0 item 1 of
// plan/2026-08-21-Quest-Level-3-Performance-Remediation-Plan.md.
let xrRefreshHz = 0;
let frameBudgetMs = 0;
// Logged once per distinct rate: the device can change it mid-session, and a
// half-rate drop is the signature of the compositor punishing a missed deadline
// (three reproductions on record). A line in the console at the moment it
// changes is the only way to see that in a capture.
let loggedRefreshHz = 0;
// Frames that MISSED A VSYNC, within this flush window.
//
// **Recalibrated 2026-08-23 — the first version of this counter was
// misleading.** It counted any period strictly greater than the budget, which
// at 90 Hz reported 57-67% of frames "over budget" while the trace showed only
// 2.4% actually missing a deadline. The app presents at ~88 fps against a
// 90 Hz target, so the *typical* interval is a hair over the nominal 11.111 ms
// and a strict `>` counts ordinary jitter as a fault. Two consequences: the
// number was alarming for no reason, and it could not be compared with the
// plan's figures, which measure callback *duration* rather than frame period.
//
// A frame is only counted now when the period is at least 1.5x the budget,
// which means at least one whole vsync went unpresented and the compositor had
// to show the previous image again — the thing a player actually sees. On the
// 2026-08-23 14:05 capture this yields ~2.4%, matching the trace's independent
// 2.36% for intervals over 16.67 ms.
const MISSED_VSYNC_FACTOR = 1.5;
let framesMissingVsync = 0;
let framesThisWindow = 0;

/**
 * Read the immersive session's frame rate, and log it whenever it changes.
 *
 * `XRSession.frameRate` is the rate the runtime has actually selected, which is
 * not necessarily the highest one `supportedFrameRates` offers. Outside an
 * immersive session there is no honest answer — the desktop preview runs at
 * whatever the monitor does — so the values stay 0 and the HUD omits them
 * rather than inventing 72 (same rule as the heap sampler above).
 */
function sampleXrRefreshRate(): void {
  const session = profiledRenderer?.xr?.getSession?.();
  const rate = typeof session?.frameRate === "number" ? session.frameRate : 0;
  if (rate <= 0) {
    xrRefreshHz = 0;
    frameBudgetMs = 0;
    loggedRefreshHz = 0;
    return;
  }
  xrRefreshHz = rate;
  frameBudgetMs = 1000 / rate;
  if (FRAME_PROFILER_LOG && rate !== loggedRefreshHz) {
    const supported: number[] = Array.isArray(session?.supportedFrameRates)
      ? Array.from(session.supportedFrameRates as ArrayLike<number>)
      : [];
    const offered = supported.length ? ` | Supported ${supported.join("/")}` : "";
    const previous = loggedRefreshHz > 0 ? ` (was ${loggedRefreshHz})` : "";
    console.log(
      `[Profile] XR refresh ${rate} Hz${previous} | ` +
        `Budget ${(1000 / rate).toFixed(2)} ms${offered}`,
    );
    loggedRefreshHz = rate;
  }
}
// The profiler's own once-per-second flush cost (scene.traverse + string build),
// surfaced as `Prof` so the observer's overhead is visible rather than hidden
// inside the Performance row that calls flush. Per-frame wrapping overhead (the
// perf.now() pairs) is negligible and already folded into `Update`.
let lastFlushMs = 0;
/** Wall clock of the previous flush, for the settled snapshot's own timer. */
let lastSettledTickMs = 0;

interface ProfSlot {
  label: string;
  short: string;
  frames: number;
  totalMs: number;
  maxMs: number;
  /** This frame's value, so a worst-Update frame can be decomposed coherently. */
  lastMs: number;
}

// Per-slot maxima are independent: the worst Tablet and the worst Input can come
// from different frames in the same window, so they cannot be added and cannot
// be attributed. Snapshot every slot's THIS-FRAME value at the moment `Update`
// sets a new window maximum, giving one coherent breakdown of one real frame.
let worstUpdateMs = 0;
let worstUpdateParts: { short: string; ms: number }[] = [];

const slots: ProfSlot[] = [];
let installed = false;
// Compact summary for the tablet HUD (worst-frame ms per system),
// refreshed each time PerformanceSystem flushes. Read via getFrameProfileHud().
let hudLine = "";
// Same content as hudLine, split per row. The tablet renders one span per entry
// because UIKit ignores "\n" inside a text element — a single span word-wraps
// the whole block and splits labels mid-row, which is unreadable on device.
let hudLines: string[] = [];

// Scene/session context for the top of every reading: which level, how fast it
// ran, and how loaded the board was. Every value is read from a singleton that
// PerformanceSystem writes on the same sample tick as this flush, so the numbers
// belong to the same window as the timings below them.
function buildContextLine(): string {
  const perf = boardState.runtimePerformance;
  const wave = boardState.waveSource;
  const stats = boardState.gameStats;
  if (!perf && !wave) return "";
  const fps = Math.round(perf?.getValue(RuntimePerformance, "fps") ?? 0);
  const avg = perf?.getValue(RuntimePerformance, "averageFrameMs") ?? 0;
  const worst = perf?.getValue(RuntimePerformance, "worstFrameMs") ?? 0;
  const moving = perf?.getValue(RuntimePerformance, "movingEntities") ?? 0;
  const alive = perf?.getValue(RuntimePerformance, "enemiesAlive") ?? 0;
  const killed = stats?.getValue(GameStats, "enemiesKilled") ?? 0;
  const level = wave?.getValue(WaveSource, "waveNumber") ?? 0;
  const stage = wave?.getValue(WaveSource, "stage") ?? "";
  // Refresh rate and the budget it implies, plus how many frames in this window
  // missed it. Omitted outside an immersive session, where there is no real
  // number to report — see sampleXrRefreshRate.
  let budget = "";
  if (xrRefreshHz > 0) {
    budget = ` | ${xrRefreshHz}Hz Budget ${frameBudgetMs.toFixed(1)}`;
    if (framesThisWindow > 0) {
      const pct = (framesMissingVsync / framesThisWindow) * 100;
      budget +=
        ` | Miss ${framesMissingVsync}/${framesThisWindow} (${pct.toFixed(1)}%)`;
    }
  }
  return (
    `Lvl ${level}${stage ? ` ${stage}` : ""} | FPS ${fps}${budget} | ` +
    `Avg ${avg.toFixed(1)} | Worst ${worst.toFixed(1)} | ` +
    `Enemies ${alive} alive / ${killed} killed | Moving ${moving}`
  );
}

function slotFor(label: string, short: string): ProfSlot {
  for (const slot of slots) if (slot.label === label) return slot;
  const slot: ProfSlot = {
    label,
    short,
    frames: 0,
    totalMs: 0,
    maxMs: 0,
    lastMs: 0,
  };
  slots.push(slot);
  return slot;
}

function record(slot: ProfSlot, ms: number): void {
  slot.frames += 1;
  slot.totalMs += ms;
  slot.lastMs = ms;
  if (ms > slot.maxMs) slot.maxMs = ms;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapUpdate(system: any, label: string, short: string): void {
  if (!system || typeof system.update !== "function") return;
  const slot = slotFor(label, short);
  const original = system.update.bind(system);
  system.update = (delta: number, time: number) => {
    const start = performance.now();
    original(delta, time);
    record(slot, performance.now() - start);
  };
}

/**
 * The execution-tracing variant of {@link wrapUpdate}.
 *
 * **One wrapper, not two.** The plan is explicit that the existing profiler
 * timer must be reused rather than a second timer added around every
 * `system.update()`, so this is not an extra layer over `wrapUpdate` — it is
 * the alternative to it, chosen at install time. `installFrameProfiler` calls
 * exactly one of the two per system, which is also why a system can never end
 * up wrapped twice.
 *
 * What it adds over the plain wrapper:
 *
 * - `setTraceSystemContext` before the call, so every event this system emits
 *   is attributed to it without any caller passing an id.
 * - `recordSystemBegin` / `recordSystemEnd`, which give the execution ring the
 *   invoked / completed / threw triple and the ordinal the system actually ran
 *   at this frame.
 * - `try` / `catch` / `finally`, so a throw is recorded, **the timing is still
 *   recorded** (the plain wrapper loses it), and the original error is
 *   rethrown untouched. A diagnostic must never hide or change a failure.
 *
 * The wrapper cannot know whether a system *semantically* skipped its work —
 * an early return and a full pass look identical from out here. A system says
 * so itself by calling `traceSkipped(reason)`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapUpdateTraced(system: any, label: string, short: string): void {
  if (!system || typeof system.update !== "function") return;
  const slot = slotFor(label, short);
  const original = system.update.bind(system);
  const systemId = systemIdFor(label);
  const registrationIndex = registrationIndexFor(label);
  system.update = (delta: number, time: number) => {
    setTraceSystemContext(systemId, registrationIndex);
    recordSystemBegin(registrationIndex);
    const start = performance.now();
    let completed = false;
    try {
      original(delta, time);
      completed = true;
    } catch (error) {
      const at = performance.now();
      recordEvent(
        TraceKind.SystemThrew,
        systemId,
        0,
        registrationIndex,
        0,
        Reason.SystemError,
        0,
        0,
        at,
      );
      // Rethrown below by the bare `throw`; the finally still runs, so the
      // timing and the completion status are recorded either way.
      throw error;
    } finally {
      const ended = performance.now();
      record(slot, ended - start);
      recordSystemEnd(registrationIndex, completed);
      setTraceSystemContext(NO_SYSTEM_ID, 0);
      // The wrapper's own cost, measured after the system's time is banked so
      // it never inflates the system's own number.
      meters.record.add(performance.now() - ended);
    }
  };
}

// Wrap a named method (even a private one) so a spike inside a system can be
// isolated — e.g. wave spawning, which only costs on its activation frame.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapMethod(system: any, method: string, label: string, short: string): void {
  if (!system || typeof system[method] !== "function") return;
  const slot = slotFor(label, short);
  const original = system[method].bind(system);
  system[method] = (...args: unknown[]) => {
    const start = performance.now();
    const result = original(...args);
    record(slot, performance.now() - start);
    return result;
  };
}

interface MethodProfileDescriptor {
  label: string;
  short: string;
}

// Profile one method into different slots based on its arguments. Wave enemy
// construction uses this to reveal which model type caused a preparation hitch.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapMethodByArgument(
  system: any,
  method: string,
  describe: (args: unknown[]) => MethodProfileDescriptor,
): void {
  if (!system || typeof system[method] !== "function") return;
  const original = system[method].bind(system);
  system[method] = (...args: unknown[]) => {
    const descriptor = describe(args);
    const slot = slotFor(descriptor.label, descriptor.short);
    const start = performance.now();
    const result = original(...args);
    record(slot, performance.now() - start);
    return result;
  };
}

function waveBuildDescriptor(args: unknown[]): MethodProfileDescriptor {
  const enemy = (args[0] as { enemy?: string } | undefined)?.enemy;
  switch (enemy) {
    case "alien":
      return { label: "WaveSystem.build.alien", short: "PAlien" };
    case "alienDrake":
      return { label: "WaveSystem.build.alienDrake", short: "PDrake" };
    case "strongAlienMech":
      return { label: "WaveSystem.build.strongAlienMech", short: "PMech" };
    default:
      return { label: "WaveSystem.build.unknown", short: "PUnknown" };
  }
}

/**
 * Rebuild the compact worst-frame-ms-per-system HUD line and reset the
 * accumulators. Called by PerformanceSystem on its sample tick so the tablet
 * text and the FPS sample share one cadence. Nothing is logged to the console.
 */
export function flushFrameProfile(): void {
  if (!installed || slots.length === 0) return;
  const flushStart = performance.now();
  // Before buildContextLine reads them: picks up an entered/exited session and
  // logs a line if the device changed the rate under us.
  sampleXrRefreshRate();

  // One walk per flush (~1 Hz). It does two jobs: (1) total scene-graph weight
  // (Objs/Mesh, incl. hidden reserves — matrix-traversal cost), and (2) VISIBLE
  // meshes bucketed by `userData.drawCat` (a per-category draw-call proxy: ~1
  // call per visible mesh, no auto-batch). Invisible subtrees are skipped for
  // the category buckets because the renderer skips them (no draw call), but
  // still counted for Objs/Mesh. Category is the nearest tagged ancestor.
  // It also counts (3) ray-testable meshes: `Input` is raycasting, so this is to
  // the input cost what the Draw buckets are to the draw-call cost. A mesh is
  // counted unless something replaced its `raycast` method — which is exactly
  // what `disableModelRaycast` and the decorative opt-outs do. Upper bound: a
  // mesh only really costs if it also sits under a RayInteractable ancestor.
  const drawBuckets = new Map<string, number>();
  if (profiledScene) {
    let objects = 0;
    let meshes = 0;
    let rayTestable = 0;
    const walk = (node: WalkNode, cat: string, visible: boolean): void => {
      objects += 1;
      const isMesh = node.type === "Mesh" || node.type === "SkinnedMesh";
      if (isMesh) meshes += 1;
      const tagged = node.userData?.drawCat;
      const nextCat = typeof tagged === "string" ? tagged : cat;
      const nextVisible = visible && node.visible !== false;
      if (isMesh && nextVisible) {
        drawBuckets.set(nextCat, (drawBuckets.get(nextCat) ?? 0) + 1);
        if (!isRaycastDisabled(node)) rayTestable += 1;
      }
      const children = node.children;
      if (children) {
        for (const child of children) walk(child, nextCat, nextVisible);
      }
    };
    walk(profiledScene, "static", true);
    sceneObjectCount = objects;
    sceneMeshCount = meshes;
    rayTestableMeshes = rayTestable;
  }
  // "Draw:" line — visible meshes per category, biggest first, plus the total
  // (compare `TotalMeshes` against `Calls` on the counts line to gauge how good
  // the proxy is). Label stays ASCII: the tablet's font atlas has no "Σ" glyph,
  // so a sigma renders on-device as an unreadable missing-glyph box.
  let drawLine = "";
  let drawTotal = 0;
  if (drawBuckets.size > 0) {
    for (const n of drawBuckets.values()) drawTotal += n;
    drawLine =
      "Draw " +
      [...drawBuckets.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([cat, n]) => `${cat} ${n}`)
        .join(" | ");
  }
  const countsLine = maxDrawCalls > 0 || sceneObjectCount > 0
    ? `Calls ${maxDrawCalls} | Tris ${Math.round(maxTriangles / 1000)}k | ` +
      `Objs ${sceneObjectCount} | Mesh ${sceneMeshCount} | ` +
      `Ents ${liveEntities}${entityDelta} | ` +
      (heapMb > 0
        ? `Heap ${heapMb.toFixed(0)}mb min ${heapCycleMinMb.toFixed(0)}` +
          (heapPreviousCycleMinMb > 0
            ? `/prev ${heapPreviousCycleMinMb.toFixed(0)}`
            : "") +
          " | "
        : "") +
      `Geom ${liveGeometries} | Prog ${livePrograms} | ` +
      `Prof ${lastFlushMs.toFixed(2)}`
    : "";

  // "WorstUpd" — one real frame, decomposed. Unlike the per-slot maxima below,
  // these numbers came from the same frame and therefore add up.
  const worstUpdateLine =
    worstUpdateMs > 0
      ? `WorstUpd ${worstUpdateMs.toFixed(1)} = ` +
        worstUpdateParts
          .slice(0, 6)
          .map((part) => `${part.short} ${part.ms.toFixed(1)}`)
          .join(" | ")
      : "";

  // "Avg" — sustained cost for the three UI slots, so a steady 6 ms can be told
  // apart from a one-frame 6 ms spike. `frames`/`totalMs` were already being
  // collected and discarded here.
  const avgFor = (short: string): string => {
    const slot = slots.find((candidate) => candidate.short === short);
    if (!slot || slot.frames === 0) return "";
    return `${short} ${(slot.totalMs / slot.frames).toFixed(1)}`;
  };
  const avgLine =
    "Avg " +
    ["Update", "Tablet", "Input", "PanelUI"]
      .map(avgFor)
      .filter((part) => part.length > 0)
      .join(" | ");

  const partsByShort = new Map<string, string>();
  for (const slot of slots) {
    partsByShort.set(slot.short, `${slot.short} ${slot.maxMs.toFixed(1)}`);
    slot.frames = 0;
    slot.totalMs = 0;
    slot.maxMs = 0;
    slot.lastMs = 0;
  }
  worstUpdateMs = 0;
  worstUpdateParts = [];

  const priorityShorts = new Set<string>([
    ...DIAG_ROW,
    ...HUD_ROWS.flat(),
  ]);
  const rowLine = (row: readonly string[]): string =>
    row
      .map((short) => partsByShort.get(short))
      .filter((part): part is string => part !== undefined)
      .join(" | ");
  // The draw-bucket total leads the whole-frame decomposition so the two
  // "how much work was this frame" numbers sit on one line.
  const diagLine = [
    drawTotal > 0 ? `TotalMeshes ${drawTotal}` : "",
    rowLine(DIAG_ROW),
  ]
    .filter((part) => part.length > 0)
    .join(" | ");
  const coreLine = [rowLine(CORE_ROW), `RayMesh ${rayTestableMeshes}`]
    .filter((part) => part.length > 0)
    .join(" | ");
  const lines = [
    countsLine,
    drawLine,
    diagLine,
    worstUpdateLine,
    coreLine,
    avgLine,
    rowLine(PREPARATION_ROW),
    ...HUD_ROWS.slice(2).map(rowLine),
  ].filter((line) => line.length > 0);
  const remaining = slots
    .filter((slot) => !priorityShorts.has(slot.short))
    .map((slot) => partsByShort.get(slot.short))
    .filter((part): part is string => part !== undefined);
  for (let i = 0; i < remaining.length; i += HUD_PER_LINE) {
    lines.push(remaining.slice(i, i + HUD_PER_LINE).join(" | "));
  }
  // New rows are APPENDED. Every pre-existing `[Profile]` field keeps its name,
  // its position within its own row and its meaning, so the ADB/CDP capture and
  // the parsing scripts keep working with no change.
  sampleAllocations({
    geometries: liveGeometries,
    textures: liveTextures,
    programs: livePrograms,
    entities: liveEntities,
  });
  const traceCostLine = formatTraceCostLine(flushTraceCost());
  if (traceCostLine.length > 0) lines.push(traceCostLine);
  const allocLine = allocationLine();
  if (allocLine.length > 0) lines.push(allocLine);
  hudLines = lines;
  hudLine = lines.join("\n");
  // Context first: without it a reading is a wall of milliseconds with no way to
  // know which level, how loaded the scene was, or what the frame rate actually
  // was — so two captures cannot be compared. Sourced from the singletons
  // PerformanceSystem already publishes on this same flush tick.
  // Context, then the force census, then the timings. Both are scene state
  // rather than milliseconds, so they belong together above the cost rows.
  const header = buildContextLine()
    ? [buildContextLine(), ...buildForceLines()]
    : buildForceLines();
  if (header.length > 0) {
    hudLines = [...header, ...lines];
    hudLine = hudLines.join("\n");
  }
  // Close the resource delta window here, after the rows above have been built
  // from it. Resetting earlier would zero the numbers this flush is reporting.
  beginResourceInterval();

  // The deferred `post-settled` snapshot. Driven from the flush rather than a
  // system because it must be the LAST thing in the frame that reads the
  // counters — a system would have to be ordered against every other one, and
  // this is already the once-per-second tick everything else reports on.
  const nowMs = performance.now();
  const settledDelta =
    lastSettledTickMs === 0 ? 0 : (nowMs - lastSettledTickMs) / 1000;
  lastSettledTickMs = nowMs;
  const status = boardState.waveSource?.getValue(MatchState, "status") ?? "";
  // Anything but `restarting` is a scenario that exists. `awaiting-start` is
  // deliberately included: a rebuilt board sitting at the gate is settled, and
  // requiring `playing` would defer the snapshot until the player moved.
  advanceSettledSnapshot(settledDelta, status !== "restarting");

  // Mirror the HUD to the console so it can be read over `chrome://inspect`
  // remote debugging instead of transcribed from a video frame. One grouped
  // entry per flush (~1 Hz) so a whole reading copies in a single selection,
  // and one prefix so it filters cleanly in DevTools.
  if (FRAME_PROFILER_LOG) {
    // `[Profile] t+<seconds>s` is unchanged and still leads the line; the shared
    // correlation header is appended after it, which is additive metadata that
    // an existing parser keying on the prefix simply ignores.
    console.log(
      `[Profile] t+${(performance.now() / 1000).toFixed(1)}s | ` +
        `${diagnosticHeader("Profile")}\n${hudLine}`,
    );
  }

  // Deferred dump formatting, deliberately here: building a few thousand
  // strings on the frame a hitch is happening would corrupt the very
  // measurement being preserved. The cost lands in TraceDumpMs next flush.
  if (isTraceRecording()) flushPendingDump(systemNameFor);

  maxDrawCalls = 0;
  maxTriangles = 0;
  framesMissingVsync = 0;
  framesThisWindow = 0;
  // Measure the profiler's own flush cost (traverse + string build). Shown as
  // `Prof` on the next flush's counts line, so it never distorts the same
  // frame's numbers. The per-frame Performance row still includes this because
  // PerformanceSystem.update() calls flush, but `Prof` isolates how much of it
  // is the profiler versus the FPS sampler.
  lastFlushMs = performance.now() - flushStart;
}

/** Compact profiler summary for the tablet HUD (empty until first flush). */
export function getFrameProfileHud(): string {
  return hudLine;
}

/** One entry per HUD row, for renderers that need real line breaks. */
export function getFrameProfileHudLines(): readonly string[] {
  return hudLines;
}

// Short HUD label from a class name: drop the "System" suffix and abbreviate
// "Animation" so the line stays narrow (e.g. AlienAnimationSystem -> AlienAnim).
function shortName(className: string): string {
  return className.replace(/System$/, "").replace(/Animation/g, "Anim");
}

// Wrap world.update (the once-per-frame call that runs every system) so the
// whole-loop CPU cost is one number, and derive the frame period + off-CPU
// "Other" from successive calls. world.update runs, then renderer.render runs;
// the next world.update begins the next frame, so at its start the previous
// frame's period is known and can be split into Update + Render + Other.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapWorldUpdate(world: any): void {
  if (!world || typeof world.update !== "function") return;
  const frameSlot = slotFor("Frame", "Frame");
  const updateSlot = slotFor("Update", "Update");
  const otherSlot = slotFor("Other", "Other");
  const original = world.update.bind(world);
  world.update = (delta: number, time: number) => {
    const start = performance.now();
    // Ages BEFORE systems run, so anything reading the totals during this
    // update sees an age of at least 1 — which is the truth.
    rendererSampleAgeFrames += 1;
    beginTraceFrame();
    if (lastUpdateStart !== 0) {
      const period = start - lastUpdateStart;
      const otherMs = Math.max(0, period - lastUpdateMs - lastRenderMs);
      record(frameSlot, period);
      record(otherSlot, otherMs);
      // `Other` is still `Frame - Update - Render`, computed exactly where it
      // always was. This only hands the finished decomposition to the runtime
      // layer, which decides whether it is worth preserving evidence for.
      noteFramePeriod(start, period, lastUpdateMs, lastRenderMs, otherMs);
      // Counted against the real budget, not an assumed one. Skipped entirely
      // when no XR session has reported a rate, because "over 13.9 ms" is
      // meaningless on a desktop preview running at an unknown refresh.
      if (frameBudgetMs > 0) {
        framesThisWindow += 1;
        if (period > frameBudgetMs * MISSED_VSYNC_FACTOR) {
          framesMissingVsync += 1;
        }
      }
    }
    lastUpdateStart = start;
    original(delta, time);
    lastUpdateMs = performance.now() - start;
    record(updateSlot, lastUpdateMs);
    // Every system slot's lastMs is now this frame's value (they all ran inside
    // original()), so this is the one moment a coherent decomposition exists.
    // Render/Other are excluded: they happen outside world.update, so their
    // lastMs would be the previous frame's and would not belong to this Update.
    if (lastUpdateMs > worstUpdateMs) {
      worstUpdateMs = lastUpdateMs;
      worstUpdateParts = [];
      for (const slot of slots) {
        if (DIAG_ROW.includes(slot.short as (typeof DIAG_ROW)[number])) continue;
        if (slot.lastMs > 0) {
          worstUpdateParts.push({ short: slot.short, ms: slot.lastMs });
        }
      }
      worstUpdateParts.sort((a, b) => b.ms - a.ms);
    }
    endTraceFrame();
  };
}

// Wrap renderer.render to time the render pass (CPU submit cost) and sample
/**
 * Live ECS entities carrying a Transform, and how that has moved since the last
 * flush.
 *
 * **`Objs` cannot see a leak of the kind this exists to catch.** It walks the
 * SCENE GRAPH, so anything detached with `removeFromParent()` vanishes from it
 * — while the ECS entity that owned it lives on forever. That is exactly how
 * the tutorial ring leaked 24 entities per subject size with every existing
 * instrument reading normal.
 *
 * The delta is the useful half. An absolute count means little (a wave legitimately
 * adds entities); a count that only ever climbs across resets does not.
 */
let liveEntities = 0;
let entityDelta = "";
let lastFlushEntities = -1;

/**
 * JS heap, and the lowest value seen — the post-GC floor.
 *
 * The current figure sawtooths with collection and says almost nothing on its
 * own. **The per-cycle minimum is the leak detector**: garbage that can be
 * collected pulls the heap back down to roughly where the cycle started, so a
 * minimum that climbs from one reset cycle to the next is memory that cannot be
 * reclaimed. Compared across cycles, not across the session — see
 * {@link beginHeapCycle} for why a session-wide floor could never show this.
 *
 * This is the counterpart to `Ents` for the *other* invisible failure — not
 * "objects nobody freed" but "allocation in a per-frame path". A `Box3` rebuilt
 * every frame never shows up in system timings at 0.1 ms resolution; it shows up
 * here, as a floor that will not settle.
 *
 * Chrome-only (`performance.memory`); silently absent elsewhere rather than
 * faked, because a fabricated memory number is worse than none.
 */
let heapMb = 0;
let heapCycleMinMb = 0;
let heapPreviousCycleMinMb = 0;

function sampleHeap(): void {
  const memory = (performance as { memory?: { usedJSHeapSize: number } }).memory;
  if (!memory) return;
  heapMb = memory.usedJSHeapSize / (1024 * 1024);
  heapCycleMinMb =
    heapCycleMinMb === 0 ? heapMb : Math.min(heapCycleMinMb, heapMb);
}

/**
 * Close the current heap cycle and start a new one. Called on scenario reset.
 *
 * ## Why the old "floor" could not do this
 *
 * It was one running `Math.min` over the whole session:
 *
 * ```js
 * heapFloorMb = heapFloorMb === 0 ? heapMb : Math.min(heapFloorMb, heapMb);
 * ```
 *
 * A running minimum is monotonically non-increasing, so it **could never
 * climb** — while the comment above it claimed a climbing floor was the leak
 * signal. The stated detector could not fire, and a 2026-09-03 capture was read
 * as "heap 61 -> 98mb but the floor held at 61, so nothing leaked". That
 * conclusion was unfounded: the floor holding was arithmetic, not evidence.
 *
 * Per-cycle minima can climb, because each cycle starts its own minimum. Two
 * identical scenarios whose post-GC floors differ is the signal that was being
 * looked for. It needs a cycle boundary to exist at all, which is why this is
 * called rather than derived.
 */
export function beginHeapCycle(): void {
  if (heapCycleMinMb > 0) heapPreviousCycleMinMb = heapCycleMinMb;
  heapCycleMinMb = 0;
}

/**
 * What is actually on the board: aliens fighting vs waiting, and the friendly
 * force broken down by kind.
 *
 * **Why `aliensActive` is the headline and `enemiesAlive` is not.** The context
 * line's `Enemies N alive` is `aliens.entities.size` — every alien entity,
 * *including hidden reserves*. During a countdown that reads 19 when nothing is
 * on the board, and it is why a 2026-08-23 attempt to prove the wave cap was
 * being violated in the field had to be retracted: the number could not tell an
 * active alien from a waiting one. `aliensActive` is the count the
 * `maxActiveAliens` cap governs (alive AND `stage !== "waiting"`, the same rule
 * as `WaveSystem.activeLivingAlienCount`), so it is the one that can confirm
 * the cap on device.
 *
 * Every field is a plain counter written once per flush (~1 Hz) into a
 * preallocated structure — no per-frame work and no allocation, so this cannot
 * become the thing it is measuring.
 */
export interface ForceCensus {
  aliensActive: number;
  aliensWaiting: number;
  /** Active aliens only, keyed by the short label shown in the log. */
  aliensByKind: Map<string, number>;
  units: number;
  unitsByKind: Map<string, number>;
  buildings: number;
  buildingsByKind: Map<string, number>;
  /**
   * Crystals banked right now, and the running total ever mined.
   *
   * Added 2026-09-03. Nothing recorded the economy before: the profiler had
   * FPS, rosters, draw calls and heap, and the action log recorded *that* a
   * unit was produced but never what it cost or what was left. Mining deposits
   * do reach the trace, but `[TraceDump]` only prints around a hitch — a
   * 742s match logged 20 of roughly 180 deposits, so income could not be
   * reconstructed either.
   *
   * That made the balance question unanswerable: a run that ends with 8
   * turrets and 2 units looks identical whether the player *chose* turrets or
   * was too crystal-starved to field anything else. Both need a balance to
   * tell apart, and this line is sampled once a second, unconditionally.
   *
   * -1 means "no game state yet" — distinct from a real balance of 0, which is
   * exactly what a match starts with (`STARTING_CRYSTALS = 0`).
   */
  crystals: number;
  crystalsMined: number;
}

let forceCensus: ForceCensus | null = null;

/** Called once per flush by PerformanceSystem, which owns the queries. */
export function setForceCensus(census: ForceCensus): void {
  forceCensus = census;
  // Pushed, not pulled: `traceRuntime` calls back into this file every frame,
  // so it must not import it. Four numbers from the census PerformanceSystem
  // already computed — no second census is created.
  setCensusSnapshot(
    census.aliensActive,
    census.aliensWaiting,
    census.units,
    census.buildings,
  );
}

/**
 * `kind count` pairs in the order the census declares them.
 *
 * Zero-count kinds are printed rather than skipped, deliberately: fixed columns
 * every sample mean a kind's series can be pulled out of a 700-sample log with
 * a column-oriented grep, and a kind falling to zero shows as `0` instead of
 * vanishing — which reads as missing data.
 */
function kindParts(counts: Map<string, number>): string {
  const parts: string[] = [];
  for (const [kind, count] of counts) parts.push(`${kind} ${count}`);
  return parts.join(" ");
}

let lastEntityCreated = 0;
let lastEntityDestroyed = 0;

/** `EntityLife created=11 destroyed=46 net=-35 live=153` — per flush. */
function entityLifeLine(): string {
  const totals = readEntityLifecycleTotals();
  const created = totals.created - lastEntityCreated;
  const destroyed = totals.destroyed - lastEntityDestroyed;
  lastEntityCreated = totals.created;
  lastEntityDestroyed = totals.destroyed;
  return (
    `EntityLife created=${created} destroyed=${destroyed} ` +
    `net=${created - destroyed >= 0 ? "+" : ""}${created - destroyed} ` +
    `live=${liveEntities} [traced gameplay entities, not every SDK entity]`
  );
}

function buildForceLines(): string[] {
  const c = forceCensus;
  if (!c) return [];
  // Filtered, because two of these return "" when diagnostics are off and an
  // empty string in this array becomes a blank line in the HUD and the console
  // capture. The profiler and diagnostics flags move together today, so this is
  // a guard against them being separated rather than a live bug.
  return [
    `Force alien ${c.aliensActive} act ${c.aliensWaiting} wait | ` +
      `unit ${c.units} | bldg ${c.buildings}`,
    // Warm-up state, so a queue that never drains or an `active` that never
    // clears is visible in the periodic line instead of only in a crash.
    gpuWarmupLine(),
    // One row per scope that has anything, omitted entirely while nothing is
    // instrumented — so this costs no log space until Phase 2 lands.
    ...resourceLifetimeLine(),
    // Always printed, unlike the scope rows: `rt(external)=unavailable` is the
    // whole point, and a row that vanished when the app owns no render targets
    // would read as "there are none" rather than "we cannot see them".
    renderTargetLine(),
    // Gameplay entities created and destroyed since the previous flush, with
    // the live count beside them. `Ents` alone is a NET figure: a second that
    // creates eleven and destroys eleven looks identical to a second where
    // nothing happened, which is exactly the churn/leak distinction the
    // resource rows exist to make for GPU memory.
    entityLifeLine(),
    `Roster ${kindParts(c.aliensByKind)} | ${kindParts(c.unitsByKind)} | ` +
      kindParts(c.buildingsByKind) +
      (c.crystals < 0
        ? ""
        : ` | crystals ${c.crystals} mined ${c.crystalsMined}`),
  ].filter((line) => line !== "");
}

/**
 * Renderer totals as last sampled, with how stale they are.
 *
 * Net live counts, not create/dispose events — five created and five disposed
 * leaves this unchanged. That is why the app-side tracker exists; this is the
 * external cross-check, useful for spotting resources the app never registered.
 */
export function rendererTotals(): Readonly<{
  geometries: number;
  textures: number;
  programs: number;
  sampleAgeFrames: number;
}> {
  return {
    geometries: liveGeometries,
    textures: liveTextures,
    programs: livePrograms,
    sampleAgeFrames: rendererSampleAgeFrames,
  };
}

/** Called once per flush by PerformanceSystem, which owns the query. */
export function setLiveEntityCount(count: number): void {
  liveEntities = count;
  if (lastFlushEntities >= 0 && count !== lastFlushEntities) {
    const change = count - lastFlushEntities;
    entityDelta = ` (${change > 0 ? "+" : ""}${change})`;
  } else {
    entityDelta = "";
  }
  lastFlushEntities = count;
  sampleHeap();
}

// draw calls / triangles / resource counts from renderer.info. three.js resets
// info at the start of render() (info.autoReset defaults true), so reading it
// right after the original call reflects the frame just drawn.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapRender(world: any): void {
  const renderer = world?.renderer;
  if (!renderer || typeof renderer.render !== "function") return;
  profiledScene = world.scene ?? null;
  profiledRenderer = renderer;
  const renderSlot = slotFor("Render", "Render");
  const original = renderer.render.bind(renderer);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  renderer.render = (scene: any, camera: any) => {
    const start = performance.now();
    original(scene, camera);
    lastRenderMs = performance.now() - start;
    record(renderSlot, lastRenderMs);
    const info = renderer.info;
    if (info) {
      if (info.render.calls > maxDrawCalls) maxDrawCalls = info.render.calls;
      if (info.render.triangles > maxTriangles) {
        maxTriangles = info.render.triangles;
      }
      liveGeometries = info.memory?.geometries ?? liveGeometries;
      liveTextures = info.memory?.textures ?? liveTextures;
      livePrograms = info.programs?.length ?? livePrograms;
      rendererSampleAgeFrames = 0;
    }
  };
}

/**
 * Wrap EVERY registered system's update() plus WaveSystem's preparation and
 * spawn methods, plus world.update / renderer.render for the whole-frame
 * decomposition (Frame/Update/Render/Other) and scene-weight counts. Nested wave
 * timings separate countdown work from activation and identify the enemy model
 * responsible for construction spikes.
 */
export function installFrameProfiler(world: World): void {
  if (!FRAME_PROFILER_ENABLED || installed) return;
  installed = true;
  slotFor("Frame", "Frame");
  slotFor("Update", "Update");
  slotFor("Render", "Render");
  slotFor("Other", "Other");
  slotFor("WaveSystem.prepare", "Prep");
  slotFor("WaveSystem.build.alien", "PAlien");
  slotFor("WaveSystem.build.alienDrake", "PDrake");
  slotFor("WaveSystem.build.strongAlienMech", "PMech");
  slotFor("WaveSystem.spawn", "Spawn");
  slotFor("WaveSystem.pathfind", "Path");

  // `world.getSystems()` returns the live array `world.update` iterates, in
  // execution order, so the position IS the registration index. Reading it
  // here rather than counting `registerSystem` calls in `index.ts` means a
  // system added later is picked up with no second list to keep in step.
  const systems = world.getSystems();
  const names = systems.map((system) => system.constructor.name);
  registerSystemIdentities(names);
  const tracing = installTraceRecorder();

  for (let index = 0; index < systems.length; index += 1) {
    const name = names[index];
    // Exactly one of the two wrappers per system. Nothing is wrapped twice,
    // and a build with execution tracing off gets the original wrapper
    // byte-for-byte.
    if (tracing && SYSTEM_EXECUTION_TRACE_ENABLED) {
      wrapUpdateTraced(systems[index], name, shortName(name));
    } else {
      wrapUpdate(systems[index], name, shortName(name));
    }
  }
  const wave = world.getSystem(WaveSystem);
  wrapMethod(wave, "prepareWaveIncrementally", "WaveSystem.prepare", "Prep");
  wrapMethodByArgument(wave, "createPreparedAlien", waveBuildDescriptor);
  wrapMethod(wave, "spawnWaveIfNeeded", "WaveSystem.spawn", "Spawn");
  wrapMethod(wave, "findNearestTargetPath", "WaveSystem.pathfind", "Path");
  wrapWorldUpdate(world);
  wrapRender(world);

  if (!tracing) return;
  // Attachments come after the wrappers so the runtime probe reports against
  // the same renderer and context the profiler is measuring.
  attachInteractionTracing(world);
  attachRuntimeTracing(world);
  attachShaderTracing(world);
  reportSystemMap();
  exposeTraceConsoleHandles();
}
