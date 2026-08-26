/**
 * Every switch and threshold the development-only trace obeys, in one file with
 * **no imports of its own**.
 *
 * No imports is a design constraint, not tidiness. `traceFlags` is read by the
 * flight recorder, by the shared API, by `PerformanceSystem`, and by gameplay
 * systems that must be able to ask "is anything recording?" before they build a
 * string — so it sits at the bottom of the import graph where it cannot be the
 * middle of a cycle. Same rule, and the same reason, as `tutorialWaveGate.ts`.
 *
 * ## The flags are independent on purpose
 *
 * Each one gates a different kind of work with a different cost profile, and
 * the whole point of an A/B run on device is being able to switch one on at a
 * time. `FRAME_PROFILER_ENABLED` / `FRAME_PROFILER_LOG` are the eighth and ninth
 * members of this roster but they stay in `frameProfiler.ts` where they have
 * always lived: that file owns the `[Profile]` line, the existing capture and
 * parsing scripts depend on it byte-for-byte, and moving its switch would put a
 * new import in front of the oldest instrument in the project for no gain.
 * `isFrameProfilerEnabled()` is exported from there for the two callers that
 * need to ask.
 *
 * ## What "disabled" has to mean
 *
 * When every flag below is `false` the app must do *none* of the optional work:
 * no wrappers installed, no buffers allocated, no observers attached, no scene
 * walks, no strings built, no console output. That is asserted by
 * `tests/trace.test.ts`, because a diagnostic that costs something while
 * switched off cannot be used to measure anything.
 */

/**
 * Wrap every registered system's `update()` with invoked/completed/threw
 * recording and per-frame execution ordinals.
 *
 * Cost shape: one extra `performance.now()` and four typed-array stores per
 * system per frame — ~40 systems x 90 Hz. This is the most expensive flag and
 * the first one to switch off when comparing against a clean run.
 */
export const SYSTEM_EXECUTION_TRACE_ENABLED = true;

/**
 * Record cross-system handoffs: contract reads, decisions, rejections, state
 * changes and entity lifecycle transitions.
 *
 * Cost shape: bursty. Nothing per frame; a few events per wave release, per
 * death, per build order.
 */
export const SYSTEM_INTERACTION_TRACE_ENABLED = true;

/**
 * Browser and XR evidence around an unexplained `Other` gap: long tasks, XR
 * session and visibility transitions, callback-gap decomposition.
 */
export const RUNTIME_ATTRIBUTION_TRACE_ENABLED = true;

/**
 * Observe `compileShader` / `linkProgram` call duration on the live WebGL
 * context. Independent of {@link RUNTIME_ATTRIBUTION_TRACE_ENABLED} because it
 * is the one probe that touches the GL context, and is therefore the one most
 * worth being able to rule out on its own.
 */
export const SHADER_TRACE_ENABLED = true;

/**
 * The once-per-second force census in `PerformanceSystem` (aliens active vs
 * waiting, unit and building rosters).
 *
 * Also switched on implicitly by `FRAME_PROFILER_ENABLED`, because the
 * `[Profile]` line prints the census and must not lose fields — see
 * `performance.ts`.
 */
export const ENTITY_CENSUS_ENABLED = true;

/**
 * Bounded application-level allocation lifecycle counters — entities,
 * geometries, materials, textures, programs — sampled from data the renderer
 * and the ECS already hold. Never a global constructor patch.
 */
export const ALLOCATION_TRACE_ENABLED = true;

/**
 * WebXR session / visibility / refresh-rate / input-source listeners, and the
 * predicted-display-time probe.
 */
export const XR_RUNTIME_TRACE_ENABLED = true;

/**
 * Follow every observable trigger press from its `Pressed` tag or UIKit click
 * through to a terminal result, with a deadline for the ones that vanish.
 */
export const INTERACTION_CORRELATION_TRACE_ENABLED = true;

/**
 * Edge-triggered logging of scene-object visibility decisions — currently the
 * board's command grid (`selection.ts`).
 *
 * Added 2026-08-24 to triage reports of the grid and panel content vanishing
 * mid-session. It fires **only when a decision changes**, never per frame, and
 * the objects it watches are toggled by discrete events (selection, tablet
 * placement, scenario reset) rather than by the update loop — so its cost when
 * on is a handful of `console.log` calls per session, and zero when off.
 *
 * **Deliberately absent from {@link anyTraceEnabled} and
 * {@link traceRecorderNeeded}.** It writes straight to the console, records
 * nothing into the flight recorder and does not need it allocated, so folding
 * it into either aggregator would switch on machinery it never uses.
 */
export const VISUAL_VISIBILITY_TRACE_ENABLED = true;

/** True when at least one optional diagnostic is on. */
export function anyTraceEnabled(): boolean {
  return (
    SYSTEM_EXECUTION_TRACE_ENABLED ||
    SYSTEM_INTERACTION_TRACE_ENABLED ||
    RUNTIME_ATTRIBUTION_TRACE_ENABLED ||
    SHADER_TRACE_ENABLED ||
    ENTITY_CENSUS_ENABLED ||
    ALLOCATION_TRACE_ENABLED ||
    XR_RUNTIME_TRACE_ENABLED ||
    INTERACTION_CORRELATION_TRACE_ENABLED
  );
}

/** True when anything needs the flight recorder allocated. */
export function traceRecorderNeeded(): boolean {
  return (
    SYSTEM_EXECUTION_TRACE_ENABLED ||
    SYSTEM_INTERACTION_TRACE_ENABLED ||
    RUNTIME_ATTRIBUTION_TRACE_ENABLED ||
    SHADER_TRACE_ENABLED ||
    ALLOCATION_TRACE_ENABLED ||
    XR_RUNTIME_TRACE_ENABLED ||
    INTERACTION_CORRELATION_TRACE_ENABLED
  );
}

// ---------------------------------------------------------------------------
// Capacities. Every one of these is preallocated once and never grows.
// ---------------------------------------------------------------------------

/**
 * Events the flight recorder holds before it starts overwriting the oldest.
 *
 * **16,384, and here is the arithmetic.** The recorder holds *interesting*
 * events only — handoffs, decisions, lifecycle transitions, interactions,
 * runtime signals — not one entry per system per frame, which has its own ring
 * below. Measured event rates on this project:
 *
 * - idle countdown, no player input: ~5-15 events/s (wave clock, tutorial
 *   sample at 4 Hz, the occasional meteor)
 * - active wave, 3 aliens fighting, a build in progress: ~150-400 events/s
 *   (every damage tick is one event, every alert decision one more)
 * - worst realistic burst — wave activation releasing a full reserve while the
 *   player is clicking: ~3,000-5,000 events/s for a fraction of a second
 *
 * At the sustained heavy rate 16,384 is 40+ seconds of history; at the burst
 * rate it is 3-5 seconds, which is the window the plan asks for and comfortably
 * more than the ~1 s of context a hitch needs on either side. Memory is ~670 KB
 * across eight parallel typed arrays, allocated only when a flag is on.
 */
export const FLIGHT_RECORDER_CAPACITY = 16_384;

/**
 * The emergency snapshot the recorder copies evidence into when a trigger
 * fires, so the triggering window cannot be overwritten while the main ring
 * keeps running and while formatting is deferred.
 */
export const SNAPSHOT_CAPACITY = 129;

/** Events preserved from BEFORE the trigger. */
export const SNAPSHOT_PRE_EVENTS = 64;

/** Events recorded AFTER the trigger before the snapshot is sealed. */
export const SNAPSHOT_POST_EVENTS = 64;

/** Seal a quiet automatic snapshot instead of waiting indefinitely for events. */
export const SNAPSHOT_POST_TIMEOUT_MS = 2_000;

/**
 * Frames of per-system execution history.
 *
 * A separate fixed-size ring, because one event per system per frame is ~3,600
 * events/second on its own and would evict every interesting event in under
 * five seconds. Two bytes per system per frame instead — a status bitfield and
 * the ordinal it actually ran at — which is 384 x 64 x 2 = 48 KB and covers
 * 4.3 s at 90 Hz or 5.3 s at 72 Hz. Deviations (a throw, an explicit skip, a
 * system that did not run) additionally push a real event into the flight
 * recorder, so nothing interesting depends on this ring alone.
 */
export const EXECUTION_RING_FRAMES = 384;

/** Systems the execution ring has room for. 41 registered today. */
export const EXECUTION_RING_SLOTS = 64;

/** Interactions tracked concurrently before the oldest is force-expired. */
export const INTERACTION_SLOTS = 32;

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * A frame period at or above this preserves a snapshot.
 *
 * 30 ms is roughly 2.7 vsyncs at 90 Hz and 2.2 at 72 Hz, so it fires only when
 * at least one whole frame went unpresented — the same "the player saw a
 * stutter" bar as `MISSED_VSYNC_FACTOR` in `frameProfiler.ts`, not the ordinary
 * jitter that recalibration was written to stop counting.
 */
export const HITCH_FRAME_MS = 50;

/** An `Other` bucket at or above this preserves a `WorstOther` evidence dump. */
export const OTHER_GAP_MS = 20;

/** An observed `compileShader`/`linkProgram` call at or above this is recorded. */
export const SHADER_OP_MS = 2;

/** A long task at or above this is correlated against the frame recorder. */
export const LONG_TASK_MS = 16;

/**
 * An interaction with no terminal result after this many milliseconds is
 * reported as `timeout` and preserves a snapshot. Generous on purpose: this is
 * "the click disappeared", not "the click was slow".
 */
export const INTERACTION_DEADLINE_MS = 750;

/** Minimum seconds between two dumps carrying the same trigger reason. */
export const DUMP_COOLDOWN_SECONDS = 30;

/**
 * Every automatic dump fits: 64 pre-trigger events, the trigger, and 64 post.
 * Manual dumps use this as their bounded recent-history view.
 */
export const DUMP_MAX_LINES = 129;

/** Seconds between optional memory samples. Never per frame. */
export const MEMORY_SAMPLE_SECONDS = 15;

/** Prefix every application-owned diagnostic record shares. */
export const TRACE_PREFIX = "[Trace]";

/** Prefix for the runtime-attribution records. */
export const RUNTIME_PREFIX = "[RuntimeTrace]";

/** Prefix for a preserved flight-recorder dump. */
export const DUMP_PREFIX = "[TraceDump]";
