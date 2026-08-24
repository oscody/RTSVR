/**
 * The shared trace API — the twelve functions gameplay systems call.
 *
 * Everything here is a thin, allocation-free wrapper over
 * `traceRecorder.recordEvent`. The rules a caller has to know:
 *
 * 1. **Trace important events only.** Contract-related reads, decisions,
 *    rejections, state changes, cross-system handoffs, player commands, entity
 *    lifecycle changes, unexpected failures, runtime events near a hitch. Not
 *    every property access, not position, not animation.
 * 2. **Pass numbers.** Ids come from `traceIds.ts`. Never pass a string, an
 *    entity, an `Object3D` or anything the recorder would have to hold onto.
 * 3. **A normal decision is not a failure.** `traceDecision(Reason.ActiveCapReached, …)`
 *    records the reasoning and preserves nothing. Only `traceContract(…, false, …)`
 *    and the failure-band reasons preserve a snapshot.
 *
 * Each function early-returns on a single module-level boolean, so a build with
 * the flags off pays one predictable branch per call site and nothing else.
 */

import {
  ALLOCATION_TRACE_ENABLED,
  INTERACTION_CORRELATION_TRACE_ENABLED,
  RUNTIME_ATTRIBUTION_TRACE_ENABLED,
  SYSTEM_EXECUTION_TRACE_ENABLED,
  SYSTEM_INTERACTION_TRACE_ENABLED,
} from "./traceFlags.js";
import {
  Lifecycle,
  Reason,
  TraceKind,
  isLegalLifecycleTransition,
} from "./traceIds.js";
import {
  currentTraceSlot,
  flushPendingDump,
  isTraceRecording,
  meters,
  recordEvent,
  recordSystemSkipped,
  requestDump,
} from "./traceRecorder.js";
import { systemNameFor } from "./traceSystemIds.js";

/**
 * Per-entity lifecycle stage, so a transition can be validated against what
 * came before without any system having to remember it.
 *
 * A flat `Uint8Array` rather than a `Map<number, number>`, and that is the
 * point: **entity indices are pooled and reused**, so a Map keyed on one leaks
 * onto whatever entity claims the index next unless every disposal path deletes
 * — a rule this project has been bitten by more than once. A fixed array has no
 * such failure mode. A missed `traceEntityDestroyed` costs one stale byte that
 * the next `traceEntityCreated` on that index overwrites, instead of a wrong
 * answer that survives.
 *
 * Sized well past `elics`'s default 1,000-entity capacity.
 */
const LIFECYCLE_TABLE_SIZE = 4096;
const lifecycleByEntity = new Uint8Array(LIFECYCLE_TABLE_SIZE);

/** Correlation ids. Monotonic, never reused within a session. */
let nextCorrelation = 1;

export function newCorrelationId(): number {
  nextCorrelation = (nextCorrelation + 1) >>> 0;
  if (nextCorrelation === 0) nextCorrelation = 1;
  return nextCorrelation;
}

/** True when the interaction trace is on AND the recorder exists. */
export function isInteractionTraceOn(): boolean {
  return SYSTEM_INTERACTION_TRACE_ENABLED && isTraceRecording();
}

/** True when anything at all is being recorded. Cheap guard for callers. */
export function isTraceOn(): boolean {
  return isTraceRecording();
}

// ---------------------------------------------------------------------------
// Reads, writes, decisions, state
// ---------------------------------------------------------------------------

/** A read that a contract depends on. Never an ordinary property access. */
export function traceRead(state: number, value: number, revision = 0): void {
  if (!SYSTEM_INTERACTION_TRACE_ENABLED || !isTraceRecording()) return;
  const at = performance.now();
  recordEvent(TraceKind.Read, state, 0, value, value, Reason.None, 0, revision, at);
  meters.record.add(performance.now() - at);
}

/** A write another system is expected to observe. */
export function traceWrite(
  state: number,
  oldValue: number,
  newValue: number,
  revision = 0,
): void {
  if (!SYSTEM_INTERACTION_TRACE_ENABLED || !isTraceRecording()) return;
  const at = performance.now();
  recordEvent(
    TraceKind.Write,
    state,
    0,
    oldValue,
    newValue,
    Reason.None,
    0,
    revision,
    at,
  );
  meters.record.add(performance.now() - at);
}

/**
 * A decision, with the reason it went that way.
 *
 * This is the workhorse. An expected gating decision — the cap is full, the
 * tutorial budget is spent, nothing is affordable — is recorded here and
 * preserves nothing, which is what makes the trace readable: a reader can see
 * the system reasoning correctly rather than having to infer it from silence.
 */
export function traceDecision(
  reason: number,
  result = 0,
  subject = 0,
  corr = 0,
): void {
  if (!SYSTEM_INTERACTION_TRACE_ENABLED || !isTraceRecording()) return;
  const at = performance.now();
  recordEvent(TraceKind.Decision, subject, 0, 0, result, reason, corr, 0, at);
  meters.record.add(performance.now() - at);
}

/** A state transition, with old and new value and the revision it landed on. */
export function traceStateChange(
  state: number,
  oldValue: number,
  newValue: number,
  reason: number = Reason.None,
  revision = 0,
): void {
  if (!SYSTEM_INTERACTION_TRACE_ENABLED || !isTraceRecording()) return;
  const at = performance.now();
  recordEvent(
    TraceKind.StateChange,
    state,
    0,
    oldValue,
    newValue,
    reason,
    0,
    revision,
    at,
  );
  meters.record.add(performance.now() - at);
}

// ---------------------------------------------------------------------------
// Entity lifecycle
// ---------------------------------------------------------------------------

/**
 * An entity now exists.
 *
 * `stage` defaults to `Created`, which is the second step of the alien
 * lifecycle; a caller that genuinely wants to record the `Requested` step calls
 * {@link traceEntityRequested} first.
 */
export function traceEntityCreated(
  entityIndex: number,
  entityKind: number,
  stage: number = Lifecycle.Created,
  reason: number = Reason.None,
): void {
  if (!SYSTEM_INTERACTION_TRACE_ENABLED || !isTraceRecording()) return;
  const at = performance.now();
  const previous =
    entityIndex >= 0 && entityIndex < LIFECYCLE_TABLE_SIZE
      ? lifecycleByEntity[entityIndex]
      : Lifecycle.None;
  if (entityIndex >= 0 && entityIndex < LIFECYCLE_TABLE_SIZE) {
    lifecycleByEntity[entityIndex] = stage;
  }
  recordEvent(
    TraceKind.EntityCreated,
    entityIndex,
    entityKind,
    previous,
    stage,
    reason,
    0,
    0,
    at,
  );
  entitiesCreated += 1;
  meters.record.add(performance.now() - at);
}

/** An alien has been asked for but does not exist yet. */
export function traceEntityRequested(
  requestId: number,
  entityKind: number,
  reason: number = Reason.None,
): void {
  if (!SYSTEM_INTERACTION_TRACE_ENABLED || !isTraceRecording()) return;
  const at = performance.now();
  recordEvent(
    TraceKind.EntityTransition,
    requestId,
    entityKind,
    Lifecycle.None,
    Lifecycle.Requested,
    reason,
    0,
    0,
    at,
  );
  meters.record.add(performance.now() - at);
}

/**
 * An entity moved between lifecycle stages.
 *
 * The previous stage comes from the table, not the caller, so a system cannot
 * report a transition it did not actually make. An illegal pair records the
 * transition anyway — losing the evidence would be worse — and additionally
 * preserves a snapshot under `Reason.InvalidLifecycle`.
 */
export function traceEntityTransition(
  entityIndex: number,
  entityKind: number,
  nextStage: number,
  reason: number = Reason.None,
): void {
  if (!SYSTEM_INTERACTION_TRACE_ENABLED || !isTraceRecording()) return;
  const at = performance.now();
  const inTable = entityIndex >= 0 && entityIndex < LIFECYCLE_TABLE_SIZE;
  const previous = inTable ? lifecycleByEntity[entityIndex] : Lifecycle.None;
  if (inTable) lifecycleByEntity[entityIndex] = nextStage;
  recordEvent(
    TraceKind.EntityTransition,
    entityIndex,
    entityKind,
    previous,
    nextStage,
    reason,
    0,
    0,
    at,
  );
  meters.record.add(performance.now() - at);
  if (!isLegalLifecycleTransition(previous, nextStage)) {
    requestDump(
      Reason.InvalidLifecycle,
      `entity ${entityIndex} kind ${entityKind}: ${previous} -> ${nextStage}`,
    );
  }
}

/** An entity is gone. Clears its lifecycle cell so a recycled index is clean. */
export function traceEntityDestroyed(
  entityIndex: number,
  entityKind: number,
  reason: number = Reason.None,
): void {
  if (!SYSTEM_INTERACTION_TRACE_ENABLED || !isTraceRecording()) return;
  const at = performance.now();
  const inTable = entityIndex >= 0 && entityIndex < LIFECYCLE_TABLE_SIZE;
  const previous = inTable ? lifecycleByEntity[entityIndex] : Lifecycle.None;
  if (inTable) lifecycleByEntity[entityIndex] = Lifecycle.None;
  recordEvent(
    TraceKind.EntityDestroyed,
    entityIndex,
    entityKind,
    previous,
    Lifecycle.Destroyed,
    reason,
    0,
    0,
    at,
  );
  entitiesDestroyed += 1;
  meters.record.add(performance.now() - at);
}

/** The lifecycle stage the trace believes an entity is in. Test-facing. */
export function tracedLifecycleStage(entityIndex: number): number {
  if (entityIndex < 0 || entityIndex >= LIFECYCLE_TABLE_SIZE) {
    return Lifecycle.None;
  }
  return lifecycleByEntity[entityIndex];
}

/** Forget every entity's lifecycle. Called by scenario reset, and by tests. */
export function resetTracedLifecycles(): void {
  lifecycleByEntity.fill(Lifecycle.None);
}

// ---------------------------------------------------------------------------
// Skips and errors
// ---------------------------------------------------------------------------

/**
 * "I ran, and I deliberately did nothing."
 *
 * The profiler wrapper can see that a system was invoked and that it returned,
 * but it cannot see that the system decided its work was not needed — a fast
 * early return and a full pass look identical from outside. This is the only
 * way that distinction gets into the trace, so a system that returns early on a
 * normal condition should say so.
 */
export function traceSkipped(reason: number): void {
  if (!SYSTEM_EXECUTION_TRACE_ENABLED || !isTraceRecording()) return;
  const at = performance.now();
  const slot = currentTraceSlot();
  if (slot >= 0) recordSystemSkipped(slot);
  recordEvent(TraceKind.Skipped, 0, 0, 0, 0, reason, 0, 0, at);
  meters.record.add(performance.now() - at);
}

/**
 * An unexpected failure. Preserves a snapshot.
 *
 * Never swallows anything: the caller rethrows, and this only records.
 */
export function traceError(reason: number, subject = 0, note = ""): void {
  if (!isTraceRecording()) return;
  const at = performance.now();
  recordEvent(TraceKind.Error, subject, 0, 0, 0, reason, 0, 0, at);
  meters.record.add(performance.now() - at);
  requestDump(reason, note);
}

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

/**
 * Record a contract check.
 *
 * A pass is recorded too, and cheaply — the trace is far more useful when it
 * shows the cap being respected on the frames it was respected, because that is
 * what makes the one frame it was not stand out.
 */
export function traceContract(
  contract: number,
  passed: boolean,
  observed: number,
  limit: number,
  reason: number = Reason.None,
  note = "",
): void {
  if (!isTraceRecording()) return;
  const at = performance.now();
  recordEvent(
    passed ? TraceKind.ContractPass : TraceKind.ContractFail,
    contract,
    0,
    limit,
    observed,
    reason,
    0,
    0,
    at,
  );
  meters.contract.add(performance.now() - at);
  if (!passed) requestDump(reason === Reason.None ? Reason.ContractTimingMissed : reason, note);
}

// ---------------------------------------------------------------------------
// Interactions and runtime
// ---------------------------------------------------------------------------

/** One stage of one correlated interaction. Called by `traceInteraction.ts`. */
export function traceInteraction(
  corr: number,
  stage: number,
  target: number,
  handedness: number,
  terminal: number,
  reason: number = Reason.None,
): void {
  if (!INTERACTION_CORRELATION_TRACE_ENABLED || !isTraceRecording()) return;
  const at = performance.now();
  recordEvent(
    TraceKind.Interaction,
    target,
    stage,
    handedness,
    terminal,
    reason,
    corr,
    0,
    at,
  );
  meters.interaction.add(performance.now() - at);
}

/** A browser, shader, memory or XR signal. */
export function traceRuntime(
  signal: number,
  a: number,
  b: number,
  evidence = 0,
): void {
  if (
    !(RUNTIME_ATTRIBUTION_TRACE_ENABLED || ALLOCATION_TRACE_ENABLED) ||
    !isTraceRecording()
  ) {
    return;
  }
  const at = performance.now();
  recordEvent(TraceKind.Runtime, signal, evidence, a, b, Reason.None, 0, 0, at);
  meters.runtime.add(performance.now() - at);
}

/** Ask for a dump by hand. Exposed for the console and for tests. */
export function traceManualDump(note = "manual"): boolean {
  // Manual inspection is intentionally synchronous: preserve what is available
  // now, then print it before the DevTools expression returns. Automatic
  // triggers keep their post-trigger collection window and deferred formatting.
  const accepted = requestDump(Reason.ManualDump, note, false);
  if (accepted) flushPendingDump(systemNameFor);
  return accepted;
}

// ---------------------------------------------------------------------------
// Allocation lifecycle counters
// ---------------------------------------------------------------------------

/**
 * ECS entity create/destroy counts, derived from the lifecycle calls above
 * rather than from a patched constructor.
 *
 * The plan asks for "created during interval / disposed during interval", and
 * for entities that is genuinely knowable because every creation and every
 * teardown already announces itself here. For renderer resources it is not —
 * `renderer.info` reports a live count and nothing else — so those are reported
 * as net movement and labelled as such in `traceRuntime.ts`. Guessing that a
 * net -3 means three disposals and no creations would be a fabrication.
 */
let entitiesCreated = 0;
let entitiesDestroyed = 0;

export function readEntityLifecycleCounters(): {
  created: number;
  destroyed: number;
} {
  return { created: entitiesCreated, destroyed: entitiesDestroyed };
}

/** Reset the interval counters. Called once per allocation sample. */
export function resetEntityLifecycleCounters(): void {
  entitiesCreated = 0;
  entitiesDestroyed = 0;
}
