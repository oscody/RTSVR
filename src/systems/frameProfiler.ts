import { type World } from "@iwsdk/core";
import { WaveSystem } from "./wave.js";

// Lightweight per-system frame profiler. Wraps the update() of EVERY registered
// system and records how long each takes, so on-device pauses can be attributed
// to a system instead of guessed at. Nothing is logged to the console —
// PerformanceSystem (performance.ts) calls flushFrameProfile() on its FPS sample
// tick to refresh the HUD text, which the tablet's Settings tab shows via
// getFrameProfileHud(). Flip FRAME_PROFILER_ENABLED off to disable.
const FRAME_PROFILER_ENABLED = true;
// General systems use 6 per line after the two fixed diagnostic rows.
const HUD_PER_LINE = 6;
const PREPARATION_ROW = ["Prep", "PAlien", "PDrake", "PMech", "Spawn"] as const;
const CORE_ROW = ["Wave", "Path", "Tablet", "Input", "PanelUI"] as const;
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
let livePrograms = 0;
let sceneObjectCount = 0;
let sceneMeshCount = 0;
// Minimal Object3D shape for the once-per-flush category walk.
interface WalkNode {
  type?: string;
  visible?: boolean;
  userData?: { drawCat?: string };
  children?: WalkNode[];
}
let profiledScene: WalkNode | null = null;
// Per-frame decomposition state (see DIAG_ROW).
let lastUpdateStart = 0;
let lastUpdateMs = 0;
let lastRenderMs = 0;
// The profiler's own once-per-second flush cost (scene.traverse + string build),
// surfaced as `Prof` so the observer's overhead is visible rather than hidden
// inside the Performance row that calls flush. Per-frame wrapping overhead (the
// perf.now() pairs) is negligible and already folded into `Update`.
let lastFlushMs = 0;

interface ProfSlot {
  label: string;
  short: string;
  frames: number;
  totalMs: number;
  maxMs: number;
}

const slots: ProfSlot[] = [];
let installed = false;
// Compact summary for the tablet HUD (worst-frame ms per system),
// refreshed each time PerformanceSystem flushes. Read via getFrameProfileHud().
let hudLine = "";

function slotFor(label: string, short: string): ProfSlot {
  for (const slot of slots) if (slot.label === label) return slot;
  const slot: ProfSlot = { label, short, frames: 0, totalMs: 0, maxMs: 0 };
  slots.push(slot);
  return slot;
}

function record(slot: ProfSlot, ms: number): void {
  slot.frames += 1;
  slot.totalMs += ms;
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

  // One walk per flush (~1 Hz). It does two jobs: (1) total scene-graph weight
  // (Objs/Mesh, incl. hidden reserves — matrix-traversal cost), and (2) VISIBLE
  // meshes bucketed by `userData.drawCat` (a per-category draw-call proxy: ~1
  // call per visible mesh, no auto-batch). Invisible subtrees are skipped for
  // the category buckets because the renderer skips them (no draw call), but
  // still counted for Objs/Mesh. Category is the nearest tagged ancestor.
  const drawBuckets = new Map<string, number>();
  if (profiledScene) {
    let objects = 0;
    let meshes = 0;
    const walk = (node: WalkNode, cat: string, visible: boolean): void => {
      objects += 1;
      const isMesh = node.type === "Mesh" || node.type === "SkinnedMesh";
      if (isMesh) meshes += 1;
      const tagged = node.userData?.drawCat;
      const nextCat = typeof tagged === "string" ? tagged : cat;
      const nextVisible = visible && node.visible !== false;
      if (isMesh && nextVisible) {
        drawBuckets.set(nextCat, (drawBuckets.get(nextCat) ?? 0) + 1);
      }
      const children = node.children;
      if (children) {
        for (const child of children) walk(child, nextCat, nextVisible);
      }
    };
    walk(profiledScene, "static", true);
    sceneObjectCount = objects;
    sceneMeshCount = meshes;
  }
  // "Draw:" line — visible meshes per category, biggest first, plus the total
  // (compare against `Calls` on the counts line to gauge how good the proxy is).
  let drawLine = "";
  if (drawBuckets.size > 0) {
    let sum = 0;
    for (const n of drawBuckets.values()) sum += n;
    drawLine =
      "Draw " +
      [...drawBuckets.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([cat, n]) => `${cat} ${n}`)
        .join(" | ") +
      ` | Σ${sum}`;
  }
  const countsLine = maxDrawCalls > 0 || sceneObjectCount > 0
    ? `Calls ${maxDrawCalls} | Tris ${Math.round(maxTriangles / 1000)}k | ` +
      `Objs ${sceneObjectCount} | Mesh ${sceneMeshCount} | ` +
      `Geom ${liveGeometries} | Prog ${livePrograms} | ` +
      `Prof ${lastFlushMs.toFixed(2)}`
    : "";

  const partsByShort = new Map<string, string>();
  for (const slot of slots) {
    partsByShort.set(slot.short, `${slot.short} ${slot.maxMs.toFixed(1)}`);
    slot.frames = 0;
    slot.totalMs = 0;
    slot.maxMs = 0;
  }

  const priorityShorts = new Set<string>([
    ...DIAG_ROW,
    ...PREPARATION_ROW,
    ...CORE_ROW,
  ]);
  const rowLine = (row: readonly string[]): string =>
    row
      .map((short) => partsByShort.get(short))
      .filter((part): part is string => part !== undefined)
      .join(" | ");
  const lines = [
    countsLine,
    drawLine,
    rowLine(DIAG_ROW),
    rowLine(PREPARATION_ROW),
    rowLine(CORE_ROW),
  ].filter((line) => line.length > 0);
  const remaining = slots
    .filter((slot) => !priorityShorts.has(slot.short))
    .map((slot) => partsByShort.get(slot.short))
    .filter((part): part is string => part !== undefined);
  for (let i = 0; i < remaining.length; i += HUD_PER_LINE) {
    lines.push(remaining.slice(i, i + HUD_PER_LINE).join(" | "));
  }
  hudLine = lines.join("\n");

  maxDrawCalls = 0;
  maxTriangles = 0;
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
    if (lastUpdateStart !== 0) {
      const period = start - lastUpdateStart;
      record(frameSlot, period);
      record(otherSlot, Math.max(0, period - lastUpdateMs - lastRenderMs));
    }
    lastUpdateStart = start;
    original(delta, time);
    lastUpdateMs = performance.now() - start;
    record(updateSlot, lastUpdateMs);
  };
}

// Wrap renderer.render to time the render pass (CPU submit cost) and sample
// draw calls / triangles / resource counts from renderer.info. three.js resets
// info at the start of render() (info.autoReset defaults true), so reading it
// right after the original call reflects the frame just drawn.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapRender(world: any): void {
  const renderer = world?.renderer;
  if (!renderer || typeof renderer.render !== "function") return;
  profiledScene = world.scene ?? null;
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
      livePrograms = info.programs?.length ?? livePrograms;
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
  for (const system of world.getSystems()) {
    const name = system.constructor.name;
    wrapUpdate(system, name, shortName(name));
  }
  const wave = world.getSystem(WaveSystem);
  wrapMethod(wave, "prepareWaveIncrementally", "WaveSystem.prepare", "Prep");
  wrapMethodByArgument(wave, "createPreparedAlien", waveBuildDescriptor);
  wrapMethod(wave, "spawnWaveIfNeeded", "WaveSystem.spawn", "Spawn");
  wrapMethod(wave, "findNearestTargetPath", "WaveSystem.pathfind", "Path");
  wrapWorldUpdate(world);
  wrapRender(world);
}
