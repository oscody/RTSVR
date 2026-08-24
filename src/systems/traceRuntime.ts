/**
 * Evidence for the `Other` bucket, and the browser / XR signals that might
 * explain it.
 *
 * `frameProfiler` computes `Other = Frame - Update - Render`. That subtraction
 * is kept exactly as it is. What this file adds is the answer to the next
 * question — *when Other is large, what else was happening?* — and, crucially,
 * a discipline about what that answer is allowed to claim.
 *
 * ## Evidence is not cause
 *
 * Every classification this file produces is a statement about what was
 * observed near a gap, never about what caused it. A long task that overlaps a
 * 40 ms `Other` is a strong lead; it is not proof, and the browser does not
 * tell us which function ran inside it unless it supplies attribution of its
 * own, which Quest Browser generally does not.
 *
 * The most important verdict this file can return is
 * `no-browser-side-cause-observed`. A 2.5-second callback gap with no long
 * task, no shader work, no XR transition and no memory event is not a mystery
 * to be explained away — it is a finding, and it points squarely at the layers
 * JavaScript cannot see: the XR runtime, the compositor, the driver, thermal
 * throttling. The runbook says which external tool to reach for in that case.
 *
 * ## Everything is feature-detected
 *
 * `PerformanceObserver`, the `longtask` entry type, `performance.memory`,
 * `measureUserAgentSpecificMemory`, `XRFrame.predictedDisplayTime` and the
 * `frameratechange` event are all optional. Each is probed once at attach, the
 * result is printed in the support report, and an absent one is reported as
 * unavailable rather than worked around or faked.
 */

import {
  ALLOCATION_TRACE_ENABLED,
  HITCH_FRAME_MS,
  LONG_TASK_MS,
  MEMORY_SAMPLE_SECONDS,
  OTHER_GAP_MS,
  RUNTIME_ATTRIBUTION_TRACE_ENABLED,
  RUNTIME_PREFIX,
  XR_RUNTIME_TRACE_ENABLED,
} from "./traceFlags.js";
import {
  OtherEvidence,
  Reason,
  RuntimeSignal,
  otherEvidenceName,
} from "./traceIds.js";
import {
  readEntityLifecycleCounters,
  resetEntityLifecycleCounters,
  traceRuntime,
} from "./trace.js";
import {
  diagnosticHeader,
  isTraceRecording,
  requestDump,
} from "./traceRecorder.js";

// ---------------------------------------------------------------------------
// Capability probe
// ---------------------------------------------------------------------------

interface RuntimeSupport {
  performanceObserver: boolean;
  longTaskEntries: boolean;
  eventTimingEntries: boolean;
  performanceMemory: boolean;
  measureUserAgentSpecificMemory: boolean;
  crossOriginIsolated: boolean;
  predictedDisplayTime: boolean;
  frameRateChangeEvent: boolean;
  deviceMemoryGb: number;
  hardwareConcurrency: number;
}

const support: RuntimeSupport = {
  performanceObserver: false,
  longTaskEntries: false,
  eventTimingEntries: false,
  performanceMemory: false,
  measureUserAgentSpecificMemory: false,
  crossOriginIsolated: false,
  predictedDisplayTime: false,
  frameRateChangeEvent: false,
  deviceMemoryGb: 0,
  hardwareConcurrency: 0,
};

/** What the runtime actually offered. Printed once, and in every dump header. */
export function runtimeSupportLine(): string {
  const yes = (flag: boolean): string => (flag ? "yes" : "NO");
  return (
    `PerformanceObserver ${yes(support.performanceObserver)} | ` +
    `longtask ${yes(support.longTaskEntries)} | ` +
    `event-timing ${yes(support.eventTimingEntries)} | ` +
    `performance.memory ${yes(support.performanceMemory)} (quantized, low confidence) | ` +
    `measureUserAgentSpecificMemory ${yes(support.measureUserAgentSpecificMemory)} ` +
    `(crossOriginIsolated ${yes(support.crossOriginIsolated)}) | ` +
    `XRFrame.predictedDisplayTime ${yes(support.predictedDisplayTime)} | ` +
    `frameratechange ${yes(support.frameRateChangeEvent)} | ` +
    `deviceMemory ${support.deviceMemoryGb || "n/a"}GB | ` +
    `cores ${support.hardwareConcurrency || "n/a"}`
  );
}

/**
 * Signals WebXR cannot expose, and the tool that can.
 *
 * Printed with the support report so a reader of a capture never has to wonder
 * whether a missing number was a bug in the trace.
 */
export const UNAVAILABLE_SIGNALS: readonly string[] = [
  "thermal state / throttling — OVR Metrics Tool, or `adb shell dumpsys thermalservice`",
  "CPU and GPU clock level — OVR Metrics Tool",
  "ASW / reprojection / spacewarp count — OVR Metrics Tool (Stale Frames)",
  "compositor dropped frames — OVR Metrics Tool",
  "app GPU time per frame — OVR Metrics Tool (no timer-query guarantee in Quest Browser)",
  "native / driver stalls between JS frames — Perfetto via `npm run trace:capture`",
  "process RSS and native heap — `adb shell dumpsys meminfo`",
  "which JS function ran inside a long task — only if the browser supplies attribution; Quest Browser generally does not",
];

// ---------------------------------------------------------------------------
// Long tasks
// ---------------------------------------------------------------------------

/**
 * A small ring of recent long tasks, so a hitch can be asked "did one of these
 * overlap you?" without keeping `PerformanceEntry` objects alive.
 *
 * Numbers only. The observer callback stores two doubles and returns; it never
 * allocates, never formats and never keeps the entry.
 */
const LONG_TASK_SLOTS = 32;
const longTaskStart = new Float64Array(LONG_TASK_SLOTS);
const longTaskDuration = new Float64Array(LONG_TASK_SLOTS);
/** Non-empty only when the browser supplied attribution of its own. */
const longTaskAttribution: string[] = new Array(LONG_TASK_SLOTS).fill("");
let longTaskWrites = 0;
let longTasksObserved = 0;

let observer: PerformanceObserver | null = null;

interface LongTaskAttributionEntry {
  name?: string;
  containerType?: string;
  containerName?: string;
}
interface LongTaskEntry extends PerformanceEntry {
  attribution?: readonly LongTaskAttributionEntry[];
}

function installLongTaskObserver(): void {
  if (typeof PerformanceObserver === "undefined") return;
  support.performanceObserver = true;
  const types = (
    PerformanceObserver as unknown as { supportedEntryTypes?: readonly string[] }
  ).supportedEntryTypes;
  support.longTaskEntries = Array.isArray(types) && types.includes("longtask");
  support.eventTimingEntries = Array.isArray(types) && types.includes("event");
  if (!support.longTaskEntries) return;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const slot = longTaskWrites % LONG_TASK_SLOTS;
        longTaskStart[slot] = entry.startTime;
        longTaskDuration[slot] = entry.duration;
        // Only kept when the browser gave us something. An empty string means
        // "the browser did not say", never "we did not look".
        const attribution = (entry as LongTaskEntry).attribution;
        const first = attribution && attribution.length > 0 ? attribution[0] : undefined;
        longTaskAttribution[slot] = first
          ? `${first.name ?? "?"}/${first.containerType ?? "?"}/${first.containerName ?? "?"}`
          : "";
        longTaskWrites += 1;
        longTasksObserved += 1;
        if (entry.duration >= LONG_TASK_MS) {
          traceRuntime(
            RuntimeSignal.LongTask,
            Math.round(entry.startTime),
            Math.round(entry.duration),
          );
        }
      }
    });
    observer.observe({ entryTypes: ["longtask"] });
  } catch {
    // A browser that advertises the type but refuses to observe it is reported
    // as unavailable rather than crashing the app on startup.
    support.longTaskEntries = false;
    observer = null;
  }
}

/** The worst long task overlapping `[from, to]`, or null. */
function longTaskOverlapping(
  from: number,
  to: number,
): { start: number; duration: number; attribution: string } | null {
  let best: { start: number; duration: number; attribution: string } | null = null;
  const held = Math.min(longTaskWrites, LONG_TASK_SLOTS);
  for (let index = 0; index < held; index += 1) {
    const start = longTaskStart[index];
    const end = start + longTaskDuration[index];
    if (end < from || start > to) continue;
    if (best && longTaskDuration[index] <= best.duration) continue;
    best = {
      start,
      duration: longTaskDuration[index],
      attribution: longTaskAttribution[index],
    };
  }
  return best;
}

// ---------------------------------------------------------------------------
// XR runtime signals
// ---------------------------------------------------------------------------

interface XrHost {
  renderer?: {
    xr?: {
      addEventListener?: (type: string, fn: () => void) => void;
      removeEventListener?: (type: string, fn: () => void) => void;
      getSession?: () => XRSession | null | undefined;
      getFrame?: () => XRFrame | null | undefined;
    };
  };
}

let xrHost: XrHost | null = null;
let boundSession: XRSession | null = null;
/** `performance.now()` of the most recent XR session or visibility transition. */
let lastXrEventAt = Number.NEGATIVE_INFINITY;
let lastXrEventSignal = 0;
let xrEventsObserved = 0;

const onSessionStart = (): void => noteXrEvent(RuntimeSignal.SessionStart, 0);
const onSessionEnd = (): void => {
  noteXrEvent(RuntimeSignal.SessionEnd, 0);
  unbindSessionListeners();
};
const onVisibilityChange = (): void => {
  const state = boundSession?.visibilityState ?? "";
  noteXrEvent(
    RuntimeSignal.VisibilityChange,
    state === "visible" ? 1 : state === "visible-blurred" ? 2 : 3,
  );
};
const onFrameRateChange = (): void => {
  const rate = boundSession?.frameRate ?? 0;
  noteXrEvent(RuntimeSignal.RefreshRateChange, Math.round(rate));
};
const onInputSourcesChange = (): void => {
  const count = boundSession?.inputSources?.length ?? 0;
  noteXrEvent(RuntimeSignal.InputSourcesChange, count);
};

function noteXrEvent(signal: number, value: number): void {
  lastXrEventAt = performance.now();
  lastXrEventSignal = signal;
  xrEventsObserved += 1;
  traceRuntime(signal, value, 0);
}

function bindSessionListeners(): void {
  const session = xrHost?.renderer?.xr?.getSession?.();
  if (!session || session === boundSession) return;
  unbindSessionListeners();
  boundSession = session;
  const target = session as unknown as {
    addEventListener?: (type: string, fn: () => void) => void;
    onframeratechange?: unknown;
  };
  support.frameRateChangeEvent = "onframeratechange" in session;
  target.addEventListener?.("visibilitychange", onVisibilityChange);
  target.addEventListener?.("inputsourceschange", onInputSourcesChange);
  if (support.frameRateChangeEvent) {
    target.addEventListener?.("frameratechange", onFrameRateChange);
  }
}

function unbindSessionListeners(): void {
  const session = boundSession as unknown as {
    removeEventListener?: (type: string, fn: () => void) => void;
  } | null;
  if (!session) return;
  session.removeEventListener?.("visibilitychange", onVisibilityChange);
  session.removeEventListener?.("inputsourceschange", onInputSourcesChange);
  session.removeEventListener?.("frameratechange", onFrameRateChange);
  boundSession = null;
}

/**
 * Predicted display time versus when the callback actually arrived.
 *
 * `XRFrame.predictedDisplayTime` is in the WebXR spec but IWSDK's render loop
 * calls `render()` with no arguments (`world-initializer.js:531`), so the value
 * the runtime handed the animation frame is discarded before the app sees it.
 * `renderer.xr.getFrame()` is the way back to it — when the build exposes the
 * field at all, which is probed rather than assumed.
 */
function samplePredictedDisplaySkew(): void {
  if (!support.predictedDisplayTime) return;
  const frame = xrHost?.renderer?.xr?.getFrame?.();
  const predicted = (frame as unknown as { predictedDisplayTime?: number })
    ?.predictedDisplayTime;
  if (typeof predicted !== "number") return;
  traceRuntime(
    RuntimeSignal.PredictedDisplaySkew,
    Math.round(predicted),
    Math.round(performance.now()),
  );
}

// ---------------------------------------------------------------------------
// Memory and allocation
// ---------------------------------------------------------------------------

let nextMemorySampleAt = 0;
let lastGeometries = -1;
let lastTextures = -1;
let lastPrograms = -1;
let lastEntities = -1;
let peakGeometries = 0;
let peakTextures = 0;
let peakPrograms = 0;
let peakEntities = 0;
/** Counts at the last scenario reset, for the reset-to-reset delta. */
let resetGeometries = 0;
let resetTextures = 0;
let resetPrograms = 0;
let resetEntities = 0;

interface AllocationInputs {
  geometries: number;
  textures: number;
  programs: number;
  entities: number;
}

/** Latest sample, kept so a dump can print it without re-reading the renderer. */
let lastAllocation: AllocationInputs = {
  geometries: 0,
  textures: 0,
  programs: 0,
  entities: 0,
};

/**
 * Sample the bounded allocation counters. Called once per `[Profile]` flush.
 *
 * Entity creations and disposals are real counts, taken from the lifecycle
 * calls in `trace.ts`. Renderer resources are reported as **net movement**,
 * because `renderer.info` exposes a live count and nothing else — splitting a
 * net -3 into "three disposals" would be inventing data. The distinction is in
 * the printed label, not just in this comment.
 */
export function sampleAllocations(inputs: AllocationInputs): void {
  if (!ALLOCATION_TRACE_ENABLED || !isTraceRecording()) return;
  lastAllocation = inputs;
  const entityCounters = readEntityLifecycleCounters();
  resetEntityLifecycleCounters();

  peakGeometries = Math.max(peakGeometries, inputs.geometries);
  peakTextures = Math.max(peakTextures, inputs.textures);
  peakPrograms = Math.max(peakPrograms, inputs.programs);
  peakEntities = Math.max(peakEntities, inputs.entities);

  traceRuntime(
    RuntimeSignal.AllocationSample,
    inputs.entities,
    entityCounters.created - entityCounters.destroyed,
  );
  if (lastPrograms >= 0 && inputs.programs !== lastPrograms) {
    traceRuntime(
      RuntimeSignal.ProgramCountChange,
      lastPrograms,
      inputs.programs,
    );
  }
  lastGeometries = inputs.geometries;
  lastTextures = inputs.textures;
  lastPrograms = inputs.programs;
  lastEntities = inputs.entities;
}

/** Mark the reset baseline so the reset-to-reset deltas mean something. */
export function markAllocationResetBaseline(): void {
  resetGeometries = lastAllocation.geometries;
  resetTextures = lastAllocation.textures;
  resetPrograms = lastAllocation.programs;
  resetEntities = lastAllocation.entities;
}

/** The allocation block for a dump or a periodic report. */
export function allocationLine(): string {
  if (!ALLOCATION_TRACE_ENABLED) return "";
  return (
    `Alloc ents ${lastEntities} (peak ${peakEntities}, since-reset ` +
    `${lastEntities - resetEntities}) | ` +
    `geom ${lastGeometries} (peak ${peakGeometries}, since-reset ` +
    `${lastGeometries - resetGeometries}) | ` +
    `tex ${lastTextures} (peak ${peakTextures}, since-reset ` +
    `${lastTextures - resetTextures}) | ` +
    `prog ${lastPrograms} (peak ${peakPrograms}, since-reset ` +
    `${lastPrograms - resetPrograms}) ` +
    `[renderer counts are NET movement, not create/dispose events]`
  );
}

/**
 * Optional memory sample.
 *
 * `performance.memory` is read and reported with an explicit low-confidence
 * label — the devlog records it staying quantized and unchanged for long
 * stretches on Quest, and a memory figure presented as trustworthy when it is
 * not is worse than no figure at all.
 *
 * `measureUserAgentSpecificMemory()` is the accurate one and is almost
 * certainly unavailable here: it requires cross-origin isolation, which the dev
 * server does not set. It is probed anyway, called at most once per
 * {@link MEMORY_SAMPLE_SECONDS}, and never on a hot path.
 */
export function sampleMemoryIfDue(): void {
  if (!RUNTIME_ATTRIBUTION_TRACE_ENABLED || !isTraceRecording()) return;
  const now = performance.now();
  if (now < nextMemorySampleAt) return;
  nextMemorySampleAt = now + MEMORY_SAMPLE_SECONDS * 1000;

  const memory = (performance as unknown as {
    memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number };
  }).memory;
  if (memory?.usedJSHeapSize) {
    traceRuntime(
      RuntimeSignal.MemorySample,
      Math.round(memory.usedJSHeapSize / 1024),
      Math.round((memory.totalJSHeapSize ?? 0) / 1024),
    );
  }
  if (!support.measureUserAgentSpecificMemory) return;
  const measure = (
    performance as unknown as {
      measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
    }
  ).measureUserAgentSpecificMemory;
  // Asynchronous and expensive; fire and forget, and never awaited on a frame.
  void measure?.()
    .then((result) => {
      traceRuntime(RuntimeSignal.MemorySample, Math.round(result.bytes / 1024), -1);
    })
    .catch(() => {
      support.measureUserAgentSpecificMemory = false;
    });
}

// ---------------------------------------------------------------------------
// Shader observations, pushed in by traceShader.ts
// ---------------------------------------------------------------------------

let lastShaderOpAt = Number.NEGATIVE_INFINITY;
let lastShaderOpMs = 0;
let shaderOpsObserved = 0;

/** Called by `traceShader.ts` whenever a compile or link is measured. */
export function noteShaderOperation(at: number, durationMs: number): void {
  lastShaderOpAt = at;
  lastShaderOpMs = durationMs;
  shaderOpsObserved += 1;
}

// ---------------------------------------------------------------------------
// Force census, pushed in by frameProfiler.ts
// ---------------------------------------------------------------------------

let censusAliensActive = 0;
let censusAliensWaiting = 0;
let censusUnits = 0;
let censusBuildings = 0;

/**
 * The force census, flattened to four numbers.
 *
 * Pushed in by `frameProfiler.setForceCensus` rather than pulled, so this file
 * never imports the profiler — which would be a cycle, because the profiler
 * calls {@link noteFramePeriod} on every frame.
 *
 * The existing census is reused exactly as `PerformanceSystem` computes it. No
 * second census is created.
 */
export function setCensusSnapshot(
  aliensActive: number,
  aliensWaiting: number,
  units: number,
  buildings: number,
): void {
  censusAliensActive = aliensActive;
  censusAliensWaiting = aliensWaiting;
  censusUnits = units;
  censusBuildings = buildings;
}

// ---------------------------------------------------------------------------
// The WorstOther evidence record
// ---------------------------------------------------------------------------

let worstOtherMs = 0;
let previousCallbackAt = 0;

/**
 * Called once per frame by `frameProfiler`'s wrapped `world.update`, with the
 * decomposition it has just computed.
 *
 * `otherMs` is the profiler's own `Frame - Update - Render`. This function does
 * not recompute it and does not second-guess it.
 */
export function noteFramePeriod(
  callbackAt: number,
  periodMs: number,
  updateMs: number,
  renderMs: number,
  otherMs: number,
): void {
  if (!RUNTIME_ATTRIBUTION_TRACE_ENABLED || !isTraceRecording()) {
    previousCallbackAt = callbackAt;
    return;
  }
  const previous = previousCallbackAt;
  previousCallbackAt = callbackAt;
  if (otherMs > worstOtherMs) worstOtherMs = otherMs;

  const hitch = periodMs >= HITCH_FRAME_MS;
  const gap = otherMs >= OTHER_GAP_MS;
  if (!hitch && !gap) return;

  traceRuntime(
    RuntimeSignal.CallbackGap,
    Math.round(periodMs * 100),
    Math.round(otherMs * 100),
  );
  reportWorstOther(previous, callbackAt, periodMs, updateMs, renderMs, otherMs, hitch);
}

/**
 * Classify the evidence around one gap and preserve it.
 *
 * The classification is deliberately conservative. `MultipleSignals` wins over
 * any single one, because "two things happened near this gap" is a weaker
 * statement than either alone and the reader should be told so rather than
 * handed the first match.
 */
function reportWorstOther(
  previousCallback: number,
  currentCallback: number,
  periodMs: number,
  updateMs: number,
  renderMs: number,
  otherMs: number,
  hitch: boolean,
): void {
  const longTask = longTaskOverlapping(previousCallback, currentCallback);
  const shaderNear =
    lastShaderOpAt >= previousCallback && lastShaderOpAt <= currentCallback;
  const xrNear =
    lastXrEventAt >= previousCallback && lastXrEventAt <= currentCallback;

  let signals = 0;
  if (longTask) signals += 1;
  if (shaderNear) signals += 1;
  if (xrNear) signals += 1;

  let evidence: number;
  if (signals > 1) evidence = OtherEvidence.MultipleSignals;
  else if (longTask) evidence = OtherEvidence.LongTaskObserved;
  else if (shaderNear) evidence = OtherEvidence.ShaderObserved;
  else if (xrNear) evidence = OtherEvidence.XrEventObserved;
  else evidence = OtherEvidence.NoBrowserSideCause;

  traceRuntime(
    RuntimeSignal.CallbackGap,
    Math.round(otherMs * 100),
    Math.round(periodMs * 100),
    evidence,
  );

  const attribution = longTask?.attribution
    ? ` attribution ${longTask.attribution}`
    : longTask
      ? " attribution NOT SUPPLIED by the browser"
      : "";
  const tail =
    evidence === OtherEvidence.NoBrowserSideCause
      ? " | no JS long task, no shader op and no XR transition overlapped this " +
        "gap — the cause is not visible to JavaScript; see the OVR Metrics / " +
        "logcat correlation section of the runbook"
      : "";

  console.log(
    `${RUNTIME_PREFIX} ${diagnosticHeader("WorstOther")} | ` +
      `evidence ${otherEvidenceName(evidence)} | ` +
      `prevCallback ${previousCallback.toFixed(1)} currCallback ${currentCallback.toFixed(1)} ` +
      `gap ${periodMs.toFixed(2)} = Update ${updateMs.toFixed(2)} + ` +
      `Render ${renderMs.toFixed(2)} + Other ${otherMs.toFixed(2)} | ` +
      `force ${censusAliensActive}act/${censusAliensWaiting}wait alien, ` +
      `${censusUnits} unit, ${censusBuildings} bldg | ` +
      (longTask
        ? `longTask start ${longTask.start.toFixed(1)} dur ${longTask.duration.toFixed(1)}${attribution}`
        : `longTask none (observer ${support.longTaskEntries ? "active" : "UNAVAILABLE"})`) +
      (shaderNear ? ` | shaderOp ${lastShaderOpMs.toFixed(2)}ms` : "") +
      (xrNear ? ` | xrSignal ${lastXrEventSignal}` : "") +
      ` | ${allocationLine()}${tail}`,
  );

  // Preserve the flight recorder around the gap. `Other` and hitch have their
  // own cooldowns, so a sustained bad patch produces a readable handful of
  // dumps rather than one per frame.
  requestDump(
    hitch ? Reason.HitchFrame : Reason.OtherGap,
    `evidence ${otherEvidenceName(evidence)}`,
  );
  if (longTask && hitch) {
    requestDump(Reason.LongTaskOverlap, `longTask ${longTask.duration.toFixed(1)}ms`);
  }
  if (xrNear && hitch) {
    requestDump(Reason.XrTransitionDuringHitch, `signal ${lastXrEventSignal}`);
  }
}

/** Worst `Other` seen since the last flush, then reset. */
export function flushWorstOther(): number {
  const worst = worstOtherMs;
  worstOtherMs = 0;
  return worst;
}

// ---------------------------------------------------------------------------
// Attach / dispose
// ---------------------------------------------------------------------------

let attached = false;

/**
 * Probe the runtime, install the observer and the XR listeners, and print the
 * support report once.
 *
 * Installs nothing when both {@link RUNTIME_ATTRIBUTION_TRACE_ENABLED} and
 * {@link XR_RUNTIME_TRACE_ENABLED} are off.
 */
export function attachRuntimeTracing(world: unknown): void {
  if (attached) return;
  if (!RUNTIME_ATTRIBUTION_TRACE_ENABLED && !XR_RUNTIME_TRACE_ENABLED) return;
  attached = true;
  xrHost = world as XrHost;

  support.crossOriginIsolated =
    typeof crossOriginIsolated !== "undefined" && crossOriginIsolated === true;
  support.performanceMemory =
    (performance as unknown as { memory?: unknown }).memory !== undefined;
  support.measureUserAgentSpecificMemory =
    typeof (
      performance as unknown as { measureUserAgentSpecificMemory?: unknown }
    ).measureUserAgentSpecificMemory === "function" && support.crossOriginIsolated;
  const nav = navigator as unknown as {
    deviceMemory?: number;
    hardwareConcurrency?: number;
  };
  support.deviceMemoryGb = nav.deviceMemory ?? 0;
  support.hardwareConcurrency = nav.hardwareConcurrency ?? 0;

  if (RUNTIME_ATTRIBUTION_TRACE_ENABLED) installLongTaskObserver();

  if (XR_RUNTIME_TRACE_ENABLED) {
    const xr = xrHost?.renderer?.xr;
    xr?.addEventListener?.("sessionstart", () => {
      onSessionStart();
      bindSessionListeners();
      probePredictedDisplayTime();
    });
    xr?.addEventListener?.("sessionend", onSessionEnd);
  }

  console.log(
    `${RUNTIME_PREFIX} ${diagnosticHeader("Support")} | ${runtimeSupportLine()}\n  ` +
      `unavailable through WebXR, use an external tool:\n  - ` +
      UNAVAILABLE_SIGNALS.join("\n  - "),
  );
}

function probePredictedDisplayTime(): void {
  const frame = xrHost?.renderer?.xr?.getFrame?.();
  support.predictedDisplayTime =
    !!frame &&
    typeof (frame as unknown as { predictedDisplayTime?: number })
      .predictedDisplayTime === "number";
}

/** Called once per frame by the diagnostics system. */
export function updateRuntimeTracing(): void {
  if (!attached) return;
  if (XR_RUNTIME_TRACE_ENABLED) {
    bindSessionListeners();
    samplePredictedDisplaySkew();
  }
  sampleMemoryIfDue();
}

/** Remove every observer and listener. Required by the disposal test. */
export function disposeRuntimeTracing(): void {
  observer?.disconnect();
  observer = null;
  unbindSessionListeners();
  const xr = xrHost?.renderer?.xr;
  xr?.removeEventListener?.("sessionend", onSessionEnd);
  xrHost = null;
  attached = false;
}

/** Counters for the periodic report. */
export function runtimeCountersLine(): string {
  return (
    `RuntimeObs longTasks ${longTasksObserved} | xrEvents ${xrEventsObserved} | ` +
    `shaderOps ${shaderOpsObserved}`
  );
}
