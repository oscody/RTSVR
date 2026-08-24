/**
 * The flight recorder: two fixed-size preallocated rings, an emergency
 * snapshot, the dump triggers, and the meters that report what all of it cost.
 *
 * Nothing here knows about gameplay. `trace.ts` is the API gameplay systems
 * call; this file is the storage underneath it.
 *
 * ## Two rings, not one
 *
 * **The event ring** holds *interesting* events — handoffs, decisions,
 * lifecycle transitions, interactions, runtime signals. Bursty, a few thousand
 * per second at worst. {@link FLIGHT_RECORDER_CAPACITY} events.
 *
 * **The execution ring** holds one status byte and one ordinal byte per system
 * per frame. Recording that as events instead would be ~3,600 events/second on
 * its own and would evict every interesting event within a few seconds — so it
 * gets its own ring, sized in FRAMES. A deviation (a throw, an explicit skip, a
 * system that did not run) additionally pushes a real event into the event
 * ring, so nothing that matters depends on the execution ring alone.
 *
 * ## Nothing is formatted on the recording path
 *
 * An event is fifteen integer stores into fifteen preallocated typed arrays.
 * No object is created, no string is built, nothing is logged. Text appears
 * exactly once, in {@link formatEvent}, and only for the events a dump prints.
 *
 * ## Nothing is allocated when the trace is off
 *
 * The arrays are created by {@link installTraceRecorder}, which returns
 * immediately when every flag in `traceFlags.ts` is false. Every entry point
 * below early-returns on a single boolean, so the disabled cost is one
 * predictable branch.
 */

import {
  DUMP_COOLDOWN_SECONDS,
  DUMP_MAX_LINES,
  DUMP_PREFIX,
  EXECUTION_RING_FRAMES,
  EXECUTION_RING_SLOTS,
  FLIGHT_RECORDER_CAPACITY,
  SNAPSHOT_CAPACITY,
  SNAPSHOT_POST_EVENTS,
  SNAPSHOT_POST_TIMEOUT_MS,
  SNAPSHOT_PRE_EVENTS,
  SYSTEM_EXECUTION_TRACE_ENABLED,
  traceRecorderNeeded,
} from "./traceFlags.js";
import {
  Reason,
  TraceKind,
  contractName,
  entityKindName,
  handednessName,
  InteractionStage,
  interactionStageName,
  kindName,
  lifecycleName,
  otherEvidenceName,
  reasonName,
  runtimeSignalName,
  terminalName,
} from "./traceIds.js";

// ---------------------------------------------------------------------------
// Event storage
// ---------------------------------------------------------------------------

/**
 * One event, spread across fifteen parallel typed arrays.
 *
 * Structure-of-arrays rather than an array of objects, for the reason the whole
 * file exists: an array of 16,384 objects is 16,384 allocations and a
 * generational-GC liability on the exact frames a hitch is being investigated.
 * Parallel typed arrays are one allocation each, at install, forever.
 */
interface EventBuffer {
  readonly capacity: number;
  /** `performance.now()` milliseconds. Float64 because ms precision matters. */
  readonly at: Float64Array;
  readonly frame: Int32Array;
  readonly seq: Uint32Array;
  readonly kind: Uint8Array;
  readonly sysId: Uint8Array;
  readonly regIndex: Uint8Array;
  /** Entity index, state id, contract id or runtime-signal id, per kind. */
  readonly subject: Int32Array;
  /** Entity kind, lifecycle stage, interaction stage or terminal, per kind. */
  readonly subjectKind: Uint8Array;
  readonly oldValue: Int32Array;
  readonly newValue: Int32Array;
  readonly reason: Uint16Array;
  readonly corr: Uint32Array;
  readonly wave: Int16Array;
  readonly waveStage: Uint8Array;
  readonly revision: Int32Array;
  /** Total writes ever. `index = writes % capacity`. */
  writes: number;
}

function createEventBuffer(capacity: number): EventBuffer {
  return {
    capacity,
    at: new Float64Array(capacity),
    frame: new Int32Array(capacity),
    seq: new Uint32Array(capacity),
    kind: new Uint8Array(capacity),
    sysId: new Uint8Array(capacity),
    regIndex: new Uint8Array(capacity),
    subject: new Int32Array(capacity),
    subjectKind: new Uint8Array(capacity),
    oldValue: new Int32Array(capacity),
    newValue: new Int32Array(capacity),
    reason: new Uint16Array(capacity),
    corr: new Uint32Array(capacity),
    wave: new Int16Array(capacity),
    waveStage: new Uint8Array(capacity),
    revision: new Int32Array(capacity),
    writes: 0,
  };
}

/** Copy one slot from one buffer to another. Used only when a trigger fires. */
function copyEvent(
  from: EventBuffer,
  fromIndex: number,
  to: EventBuffer,
  toIndex: number,
): void {
  to.at[toIndex] = from.at[fromIndex];
  to.frame[toIndex] = from.frame[fromIndex];
  to.seq[toIndex] = from.seq[fromIndex];
  to.kind[toIndex] = from.kind[fromIndex];
  to.sysId[toIndex] = from.sysId[fromIndex];
  to.regIndex[toIndex] = from.regIndex[fromIndex];
  to.subject[toIndex] = from.subject[fromIndex];
  to.subjectKind[toIndex] = from.subjectKind[fromIndex];
  to.oldValue[toIndex] = from.oldValue[fromIndex];
  to.newValue[toIndex] = from.newValue[fromIndex];
  to.reason[toIndex] = from.reason[fromIndex];
  to.corr[toIndex] = from.corr[fromIndex];
  to.wave[toIndex] = from.wave[fromIndex];
  to.waveStage[toIndex] = from.waveStage[fromIndex];
  to.revision[toIndex] = from.revision[fromIndex];
}

// ---------------------------------------------------------------------------
// Execution ring
// ---------------------------------------------------------------------------

/** Status bits stored per (frame, system) cell. */
export const ExecStatus = {
  NotInvoked: 0,
  Invoked: 1,
  Completed: 2,
  Threw: 4,
  Skipped: 8,
} as const;

interface ExecutionRing {
  /** `EXECUTION_RING_FRAMES * EXECUTION_RING_SLOTS` status bytes. */
  readonly status: Uint8Array;
  /** The ordinal each system actually ran at within its frame, 1-based. */
  readonly ordinal: Uint8Array;
  readonly frameNo: Int32Array;
  readonly seqBase: Uint32Array;
  /** Row currently being written. */
  row: number;
  /** Frames written ever, so a partially-filled ring reads correctly. */
  rows: number;
  /** Systems that have begun this frame. */
  ordinalCounter: number;
}

// ---------------------------------------------------------------------------
// Overhead meters
// ---------------------------------------------------------------------------

/**
 * Per-frame cost of one category of diagnostic work.
 *
 * Reported as **milliseconds per frame** — average over the flush window, and
 * the worst single frame — so the numbers sit on the same scale as `Update`,
 * `Render` and `Other` in the `[Profile]` block they print beside. A per-event
 * average would be a number nobody could compare against anything.
 */
class Meter {
  private frameMs = 0;
  private windowSum = 0;
  private windowMax = 0;
  private frames = 0;

  add(ms: number): void {
    this.frameMs += ms;
  }

  endFrame(): void {
    if (this.frameMs > this.windowMax) this.windowMax = this.frameMs;
    this.windowSum += this.frameMs;
    this.frames += 1;
    this.frameMs = 0;
  }

  /** Average ms/frame and worst frame for the window, then reset. */
  flush(): { avg: number; max: number } {
    const avg = this.frames > 0 ? this.windowSum / this.frames : 0;
    const max = this.windowMax;
    this.windowSum = 0;
    this.windowMax = 0;
    this.frames = 0;
    return { avg, max };
  }

  /** Non-destructive peek, for a dump header. */
  currentFrameMs(): number {
    return this.frameMs;
  }
}

export const meters = {
  record: new Meter(),
  interaction: new Meter(),
  contract: new Meter(),
  runtime: new Meter(),
  shader: new Meter(),
};

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let installed = false;
/** The single boolean every hot entry point branches on. */
let recording = false;

let events: EventBuffer | null = null;
let snapshot: EventBuffer | null = null;
let execution: ExecutionRing | null = null;

/**
 * Monotonic sequence across every diagnostic record, frame or no frame.
 *
 * This is the `diagnostic-global-sequence` the plan asks for: a record emitted
 * outside an active frame carries `frame = -1` and this number, so it still
 * orders correctly against everything else in a capture.
 */
let sequence = 0;
let frameNumber = -1;
let inFrame = false;

/** Events overwritten before they could be read, plus any refused outright. */
let dropped = 0;
/** Events recorded since the last flush, for the events-per-second report. */
let eventsThisWindow = 0;
let windowStartedAt = 0;

/** Set by the execution wrapper so every event knows who emitted it. */
let currentSysId = 0;
let currentRegIndex = 0;

/** Set once per frame by WaveSystem, so every event carries wave context. */
let currentWave = 0;
let currentWaveStage = 0;

/** Per-reason cooldown, in `performance.now()` ms. Reasons are < 256. */
const lastDumpAt = new Float64Array(256);
/** Dumps suppressed by cooldown, reported so a storm is never silent. */
let suppressedDumps = 0;
/** Dump requests refused because an earlier snapshot is still being preserved. */
let busyDumps = 0;

/** A snapshot is filling (post-trigger events still being collected). */
let snapshotFilling = false;
let snapshotPostRemaining = 0;
/** `performance.now()` at the synthetic trigger event. */
let snapshotTriggerAt = 0;
/** A sealed snapshot is waiting to be formatted and printed. */
let dumpPending = false;
let dumpTriggerReason = 0;
let dumpTriggerFrame = -1;
let dumpTriggerSeq = 0;
let dumpTriggerAt = 0;
let dumpTriggerNote = "";
let lastDumpMs = 0;
let dumpsPrinted = 0;

// ---------------------------------------------------------------------------
// Install / teardown
// ---------------------------------------------------------------------------

/**
 * Allocate the rings. Call once, from `installFrameProfiler`.
 *
 * Returns `false` and allocates nothing when every diagnostic flag is off,
 * which is the property `tests/trace.test.ts` pins.
 */
export function installTraceRecorder(): boolean {
  if (installed) return recording;
  installed = true;
  if (!traceRecorderNeeded()) return false;

  events = createEventBuffer(FLIGHT_RECORDER_CAPACITY);
  snapshot = createEventBuffer(SNAPSHOT_CAPACITY);
  if (SYSTEM_EXECUTION_TRACE_ENABLED) {
    execution = {
      status: new Uint8Array(EXECUTION_RING_FRAMES * EXECUTION_RING_SLOTS),
      ordinal: new Uint8Array(EXECUTION_RING_FRAMES * EXECUTION_RING_SLOTS),
      frameNo: new Int32Array(EXECUTION_RING_FRAMES),
      seqBase: new Uint32Array(EXECUTION_RING_FRAMES),
      row: -1,
      rows: 0,
      ordinalCounter: 0,
    };
  }
  windowStartedAt = performance.now();
  recording = true;
  return true;
}

/** Release every buffer and observer-visible flag. Used by tests. */
export function disposeTraceRecorder(): void {
  recording = false;
  installed = false;
  events = null;
  snapshot = null;
  execution = null;
  sequence = 0;
  frameNumber = -1;
  inFrame = false;
  dropped = 0;
  eventsThisWindow = 0;
  snapshotFilling = false;
  snapshotPostRemaining = 0;
  snapshotTriggerAt = 0;
  dumpPending = false;
  dumpTriggerAt = 0;
  dumpsPrinted = 0;
  suppressedDumps = 0;
  busyDumps = 0;
  lastDumpMs = 0;
  lastDumpAt.fill(0);
}

/** True when the rings exist and events are being stored. */
export function isTraceRecording(): boolean {
  return recording;
}

// ---------------------------------------------------------------------------
// Frame and context
// ---------------------------------------------------------------------------

/** Called at the top of the wrapped `world.update`. */
export function beginTraceFrame(now = performance.now()): void {
  if (!recording) return;
  frameNumber += 1;
  inFrame = true;
  // The post-trigger window is bounded by time as well as event count. This
  // check is intentionally frame-driven so an idle game cannot leave a dump
  // unsealed forever merely because no further trace event arrives.
  sealSnapshotIfTimedOut(now);
  const ring = execution;
  if (!ring) return;
  ring.row = (ring.row + 1) % EXECUTION_RING_FRAMES;
  ring.rows += 1;
  ring.ordinalCounter = 0;
  const base = ring.row * EXECUTION_RING_SLOTS;
  ring.status.fill(ExecStatus.NotInvoked, base, base + EXECUTION_RING_SLOTS);
  ring.ordinal.fill(0, base, base + EXECUTION_RING_SLOTS);
  ring.frameNo[ring.row] = frameNumber;
  ring.seqBase[ring.row] = sequence;
}

/** Called at the bottom of the wrapped `world.update`. */
export function endTraceFrame(): void {
  if (!recording) return;
  inFrame = false;
  meters.record.endFrame();
  meters.interaction.endFrame();
  meters.contract.endFrame();
  meters.runtime.endFrame();
  meters.shader.endFrame();
}

/** The frame a record belongs to; -1 outside an active frame, as specified. */
export function traceFrame(): number {
  return inFrame ? frameNumber : -1;
}

/** The next global sequence number. Never reused within a session. */
export function nextSequence(): number {
  sequence = (sequence + 1) >>> 0;
  return sequence;
}

export function traceSequence(): number {
  return sequence;
}

/**
 * Wave context stamped onto every event, published once per frame by
 * `WaveSystem` so no other caller has to pass it.
 */
export function setTraceWaveContext(waveNumber: number, stageId: number): void {
  currentWave = waveNumber;
  currentWaveStage = stageId;
}

/** Which system is currently executing, for attribution. */
export function setTraceSystemContext(sysId: number, regIndex: number): void {
  currentSysId = sysId;
  currentRegIndex = regIndex;
}

export function currentTraceSystemId(): number {
  return currentSysId;
}

/** The execution-ring slot of the system currently running, or -1. */
export function currentTraceSlot(): number {
  return inFrame ? currentRegIndex : -1;
}

/**
 * The shared record header every application-owned diagnostic line carries.
 *
 * `monotonicTimeMs` is the join key. It is the same clock `performance.mark()`
 * uses, which `scripts/capture-trace.mjs` records under `blink.user_timing`, so
 * a `[Trace]` line and a Perfetto slice can be lined up without guessing. It is
 * also what the OVR Metrics Tool / logcat correlation procedure in the runbook
 * anchors on.
 */
export function diagnosticHeader(source: string): string {
  return `mono ${performance.now().toFixed(1)} frame ${traceFrame()} seq ${sequence} src ${source}`;
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/**
 * Store one event.
 *
 * Every argument is a number and every store is into a preallocated array, so
 * this allocates nothing and formats nothing. The caller measures its own cost
 * into `meters.record`; this function deliberately does not call
 * `performance.now()` itself, because at the rates involved the clock read
 * would be a measurable fraction of the work being measured.
 */
export function recordEvent(
  kind: number,
  subject: number,
  subjectKind: number,
  oldValue: number,
  newValue: number,
  reason: number,
  corr: number,
  revision: number,
  at: number,
): void {
  const buffer = events;
  if (!buffer) return;
  const index = buffer.writes % buffer.capacity;
  if (buffer.writes >= buffer.capacity) dropped += 1;
  buffer.at[index] = at;
  buffer.frame[index] = inFrame ? frameNumber : -1;
  buffer.seq[index] = nextSequence();
  buffer.kind[index] = kind;
  buffer.sysId[index] = currentSysId;
  buffer.regIndex[index] = currentRegIndex;
  buffer.subject[index] = subject;
  buffer.subjectKind[index] = subjectKind;
  buffer.oldValue[index] = oldValue;
  buffer.newValue[index] = newValue;
  buffer.reason[index] = reason;
  buffer.corr[index] = corr;
  buffer.wave[index] = currentWave;
  buffer.waveStage[index] = currentWaveStage;
  buffer.revision[index] = revision;
  buffer.writes += 1;
  eventsThisWindow += 1;

  if (snapshotFilling) appendToSnapshot(buffer, index);
}

// ---------------------------------------------------------------------------
// Execution ring
// ---------------------------------------------------------------------------

/** A system is about to run. Returns the ordinal it ran at. */
export function recordSystemBegin(slot: number): number {
  const ring = execution;
  if (!ring || slot < 0 || slot >= EXECUTION_RING_SLOTS) return 0;
  const cell = ring.row * EXECUTION_RING_SLOTS + slot;
  ring.ordinalCounter += 1;
  ring.status[cell] = ExecStatus.Invoked;
  ring.ordinal[cell] = Math.min(255, ring.ordinalCounter);
  return ring.ordinalCounter;
}

/** A system finished, one way or the other. */
export function recordSystemEnd(slot: number, completed: boolean): void {
  const ring = execution;
  if (!ring || slot < 0 || slot >= EXECUTION_RING_SLOTS) return;
  const cell = ring.row * EXECUTION_RING_SLOTS + slot;
  ring.status[cell] |= completed ? ExecStatus.Completed : ExecStatus.Threw;
}

/** A system ran but explicitly declined to do its work. */
export function recordSystemSkipped(slot: number): void {
  const ring = execution;
  if (!ring || slot < 0 || slot >= EXECUTION_RING_SLOTS) return;
  const cell = ring.row * EXECUTION_RING_SLOTS + slot;
  ring.status[cell] |= ExecStatus.Skipped;
}

/** Status bits for one system on one of the last `EXECUTION_RING_FRAMES`. */
export function executionStatusAt(rowsBack: number, slot: number): number {
  const ring = execution;
  if (!ring || ring.rows === 0) return ExecStatus.NotInvoked;
  const row =
    (ring.row - rowsBack + EXECUTION_RING_FRAMES * 2) % EXECUTION_RING_FRAMES;
  return ring.status[row * EXECUTION_RING_SLOTS + slot];
}

/** The order systems actually ran in, most recent complete frame first. */
export function executionOrderLine(
  rowsBack: number,
  nameForSlot: (slot: number) => string,
): string {
  const ring = execution;
  if (!ring || ring.rows === 0) return "";
  const row =
    (ring.row - rowsBack + EXECUTION_RING_FRAMES * 2) % EXECUTION_RING_FRAMES;
  const base = row * EXECUTION_RING_SLOTS;
  const entries: Array<{ ordinal: number; text: string }> = [];
  for (let slot = 0; slot < EXECUTION_RING_SLOTS; slot += 1) {
    const status = ring.status[base + slot];
    if (status === ExecStatus.NotInvoked) continue;
    const marks =
      (status & ExecStatus.Threw ? "!" : "") +
      (status & ExecStatus.Skipped ? "~" : "") +
      (status & ExecStatus.Completed ? "" : "?");
    entries.push({
      ordinal: ring.ordinal[base + slot],
      text: `${nameForSlot(slot)}${marks}`,
    });
  }
  entries.sort((left, right) => left.ordinal - right.ordinal);
  return `frame ${ring.frameNo[row]} seq ${ring.seqBase[row]} | ${entries
    .map((entry) => entry.text)
    .join(" > ")}`;
}

// ---------------------------------------------------------------------------
// Triggers and snapshots
// ---------------------------------------------------------------------------

/**
 * Preserve the flight recorder around a trigger.
 *
 * The evidence is copied immediately — before anything is formatted, before
 * anything is printed — because the alternative is losing it to the next burst
 * while a string is being built. Formatting is deferred to
 * {@link flushPendingDump}, which normally runs on the profiler's ~1 Hz tick.
 *
 * Automatic triggers copy the 64 events immediately before their synthetic
 * trigger, preserve that trigger, and collect at most 64 later events. A
 * frame-driven two-second deadline seals quiet captures too. Manual exports do
 * not call this function: they format a bounded live-ring view synchronously
 * and leave any automatic snapshot untouched.
 *
 * Returns `true` when a snapshot was started, `false` when a snapshot is
 * already filling/awaiting export or an automatic trigger is cooled down.
 */
export function requestDump(reason: number, note = ""): boolean {
  if (!recording || !events || !snapshot) return false;

  // A snapshot owns the emergency buffer until it is exported. Replacing it
  // loses the original trigger and makes a sustained slowdown starve every
  // dump forever, so later requests must leave it untouched.
  if (snapshotFilling || dumpPending) {
    busyDumps += 1;
    return false;
  }

  const now = performance.now();
  const slot = reason & 0xff;
  // A zero entry means this reason has never produced a dump. Do not suppress
  // the first real trigger merely because the process is younger than the
  // cooldown interval.
  if (
    lastDumpAt[slot] !== 0 &&
    now - lastDumpAt[slot] < DUMP_COOLDOWN_SECONDS * 1000
  ) {
    suppressedDumps += 1;
    return false;
  }
  lastDumpAt[slot] = now;

  // Calculate the pre-trigger range BEFORE recording the synthetic trigger.
  // The copied window is therefore always: previous events, trigger, later
  // events — never a tail that happens to exclude what caused the dump.
  const preHeld = Math.min(events.writes, events.capacity);
  const preTake = Math.min(preHeld, SNAPSHOT_PRE_EVENTS);
  const preFirstWrite = events.writes - preTake;
  recordEvent(TraceKind.Trigger, reason, 0, 0, 0, reason, 0, 0, now);

  const buffer = events;
  const triggerIndex = (buffer.writes - 1) % buffer.capacity;
  snapshot.writes = 0;
  for (let offset = 0; offset < preTake; offset += 1) {
    const from = (preFirstWrite + offset) % buffer.capacity;
    copyEvent(buffer, from, snapshot, offset);
    snapshot.writes += 1;
  }
  copyEvent(buffer, triggerIndex, snapshot, snapshot.writes);
  snapshot.writes += 1;

  snapshotFilling = SNAPSHOT_POST_EVENTS > 0;
  snapshotPostRemaining = SNAPSHOT_POST_EVENTS;
  snapshotTriggerAt = now;
  dumpTriggerReason = reason;
  dumpTriggerFrame = buffer.frame[triggerIndex];
  dumpTriggerSeq = buffer.seq[triggerIndex];
  dumpTriggerAt = buffer.at[triggerIndex];
  dumpTriggerNote = note;
  if (!snapshotFilling) dumpPending = true;
  return true;
}

/** Bounded post-trigger recording: copy through until the budget is spent. */
function appendToSnapshot(from: EventBuffer, fromIndex: number): void {
  const target = snapshot;
  if (!target) return;
  if (target.writes < target.capacity) {
    copyEvent(from, fromIndex, target, target.writes);
    target.writes += 1;
  }
  snapshotPostRemaining -= 1;
  if (snapshotPostRemaining > 0 && target.writes < target.capacity) return;
  snapshotFilling = false;
  dumpPending = true;
}

/** Seal a quiet automatic snapshot after its bounded post-trigger time window. */
export function sealSnapshotIfTimedOut(now = performance.now()): boolean {
  if (
    !snapshotFilling ||
    now - snapshotTriggerAt < SNAPSHOT_POST_TIMEOUT_MS
  ) {
    return false;
  }
  snapshotFilling = false;
  snapshotPostRemaining = 0;
  dumpPending = true;
  return true;
}

/** True while a sealed snapshot is waiting to be printed. */
export function hasPendingDump(): boolean {
  return dumpPending;
}

/**
 * Format and print a sealed snapshot.
 *
 * Called from `PerformanceSystem`'s ~1 Hz tick, deliberately: formatting a
 * few thousand events allocates strings, and doing that on the hitching frame
 * would corrupt the very measurement being preserved. The cost lands in
 * `TraceDumpMs` on the next `[Profile]` line.
 */
export function flushPendingDump(nameForSystem: (id: number) => string): void {
  if (!dumpPending || !snapshot) return;
  dumpPending = false;
  const started = performance.now();
  const buffer = snapshot;
  const held = Math.min(buffer.writes, buffer.capacity);
  // Automatic snapshots are capped at 129, equal to DUMP_MAX_LINES. Never
  // trim this ordered pre/trigger/post window: the trigger is the evidence.
  const lines = formatEventWindow(buffer, 0, held, nameForSystem);
  const header =
    `${DUMP_PREFIX} ${diagnosticHeader("TraceDump")} | ` +
    `trigger ${reasonName(dumpTriggerReason)} at mono ${dumpTriggerAt.toFixed(1)} ` +
    `frame ${dumpTriggerFrame} seq ${dumpTriggerSeq} | events ${held}` +
    (dumpTriggerNote ? ` | ${dumpTriggerNote}` : "");
  console.log(`${header}\n${lines.join("\n")}`);
  dumpsPrinted += 1;
  lastDumpMs = performance.now() - started;
  dumpTriggerNote = "";
}

/**
 * Print recent live recorder history without touching an automatic snapshot.
 * This is intentionally the only synchronous formatting path and is reached
 * exclusively by the explicit DevTools command.
 */
export function printManualDump(
  note: string,
  nameForSystem: (id: number) => string,
): boolean {
  const buffer = events;
  if (!recording || !buffer) return false;
  const started = performance.now();
  const held = Math.min(buffer.writes, buffer.capacity);
  const take = Math.min(held, DUMP_MAX_LINES);
  const firstWrite = buffer.writes - take;
  const lines = formatEventWindow(buffer, firstWrite, take, nameForSystem);
  const elided = held - take;
  const header =
    `${DUMP_PREFIX} ${diagnosticHeader("TraceDump")} | ` +
    `trigger ${reasonName(Reason.ManualDump)} at mono ${started.toFixed(1)} ` +
    `frame ${traceFrame()} seq ${sequence} | events ${take}` +
    (elided > 0 ? ` (${elided} earlier events elided)` : "") +
    (note ? ` | ${note}` : "");
  try {
    console.log(`${header}\n${lines.join("\n")}`);
  } catch {
    return false;
  }
  dumpsPrinted += 1;
  lastDumpMs = performance.now() - started;
  return true;
}

/** Format a chronological range from either the live ring or compact snapshot. */
function formatEventWindow(
  buffer: EventBuffer,
  firstWrite: number,
  count: number,
  nameForSystem: (id: number) => string,
): string[] {
  const lines: string[] = [];
  for (let offset = 0; offset < count; offset += 1) {
    lines.push(formatEvent(buffer, (firstWrite + offset) % buffer.capacity, nameForSystem));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Formatting — the only place a trace event becomes text
// ---------------------------------------------------------------------------

function formatEvent(
  buffer: EventBuffer,
  index: number,
  nameForSystem: (id: number) => string,
): string {
  const kind = buffer.kind[index];
  const head =
    `${buffer.at[index].toFixed(1)} f${buffer.frame[index]} ` +
    `s${buffer.seq[index]} [${buffer.regIndex[index]}]` +
    `${nameForSystem(buffer.sysId[index])} ${kindName(kind)}`;
  const wave =
    buffer.wave[index] !== 0 || buffer.waveStage[index] !== 0
      ? ` w${buffer.wave[index]}/${buffer.waveStage[index]}`
      : "";
  const corr = buffer.corr[index] !== 0 ? ` corr#${buffer.corr[index]}` : "";
  const isInteractionTiming =
    kind === TraceKind.Interaction &&
    buffer.subjectKind[index] === InteractionStage.Terminal &&
    buffer.revision[index] === 1;
  const why =
    !isInteractionTiming && buffer.reason[index] !== Reason.None
      ? ` reason=${reasonName(buffer.reason[index])}`
      : "";
  const rev =
    !isInteractionTiming && buffer.revision[index] !== 0
      ? ` rev=${buffer.revision[index]}`
      : "";

  let body: string;
  switch (kind) {
    case TraceKind.EntityCreated:
    case TraceKind.EntityDestroyed:
      body =
        ` e#${buffer.subject[index]} ${entityKindName(buffer.subjectKind[index])}`;
      break;
    case TraceKind.EntityTransition:
      body =
        ` e#${buffer.subject[index]} ${entityKindName(buffer.subjectKind[index])} ` +
        `${lifecycleName(buffer.oldValue[index])} -> ${lifecycleName(buffer.newValue[index])}`;
      break;
    case TraceKind.ContractPass:
    case TraceKind.ContractFail:
      body =
        ` ${contractName(buffer.subject[index])} ` +
        `observed=${buffer.newValue[index]} limit=${buffer.oldValue[index]}`;
      break;
    case TraceKind.Interaction:
      body = isInteractionTiming
        ? ` elapsed=${(buffer.subject[index] / 1000).toFixed(1)}ms ` +
          `frames=${buffer.newValue[index]} stages=0x${buffer.reason[index].toString(16)}`
        : ` ${interactionStageName(buffer.subjectKind[index])} ` +
          `target=${buffer.subject[index]} ` +
          `hand=${handednessName(buffer.oldValue[index])} ` +
          `result=${terminalName(buffer.newValue[index])}`;
      break;
    case TraceKind.Runtime:
      body =
        ` ${runtimeSignalName(buffer.subject[index])} ` +
        `a=${buffer.oldValue[index]} b=${buffer.newValue[index]}` +
        (buffer.subjectKind[index] !== 0
          ? ` evidence=${otherEvidenceName(buffer.subjectKind[index])}`
          : "");
      break;
    case TraceKind.SystemMap:
      body = ` slots=${buffer.newValue[index]}`;
      break;
    case TraceKind.Trigger:
      body = "";
      break;
    default:
      body =
        ` id=${buffer.subject[index]}` +
        (buffer.oldValue[index] !== buffer.newValue[index]
          ? ` ${buffer.oldValue[index]} -> ${buffer.newValue[index]}`
          : ` = ${buffer.newValue[index]}`);
      break;
  }
  return `${head}${body}${why}${rev}${wave}${corr}`;
}

// ---------------------------------------------------------------------------
// Reporting into [Profile]
// ---------------------------------------------------------------------------

export interface TraceCostReport {
  recordAvg: number;
  recordMax: number;
  interactionAvg: number;
  interactionMax: number;
  contractAvg: number;
  contractMax: number;
  runtimeAvg: number;
  runtimeMax: number;
  shaderAvg: number;
  shaderMax: number;
  events: number;
  eventsPerSecond: number;
  dropped: number;
  capacity: number;
  /** Seconds the ring would hold at the observed rate. */
  bufferSeconds: number;
  dumpMs: number;
  dumps: number;
  suppressed: number;
  busy: number;
}

/** Read and reset the window counters. Called once per `[Profile]` flush. */
export function flushTraceCost(): TraceCostReport | null {
  if (!recording) return null;
  const now = performance.now();
  const windowSeconds = Math.max(0.001, (now - windowStartedAt) / 1000);
  windowStartedAt = now;
  const rate = eventsThisWindow / windowSeconds;
  const record = meters.record.flush();
  const interaction = meters.interaction.flush();
  const contract = meters.contract.flush();
  const runtime = meters.runtime.flush();
  const shader = meters.shader.flush();
  const report: TraceCostReport = {
    recordAvg: record.avg,
    recordMax: record.max,
    interactionAvg: interaction.avg,
    interactionMax: interaction.max,
    contractAvg: contract.avg,
    contractMax: contract.max,
    runtimeAvg: runtime.avg,
    runtimeMax: runtime.max,
    shaderAvg: shader.avg,
    shaderMax: shader.max,
    events: events?.writes ?? 0,
    eventsPerSecond: rate,
    dropped,
    capacity: FLIGHT_RECORDER_CAPACITY,
    bufferSeconds: rate > 0 ? FLIGHT_RECORDER_CAPACITY / rate : Infinity,
    dumpMs: lastDumpMs,
    dumps: dumpsPrinted,
    suppressed: suppressedDumps,
    busy: busyDumps,
  };
  eventsThisWindow = 0;
  return report;
}

/** The `[Profile]`-appended trace-cost line. Empty when nothing is recording. */
export function formatTraceCostLine(report: TraceCostReport | null): string {
  if (!report) return "";
  const held = Number.isFinite(report.bufferSeconds)
    ? report.bufferSeconds.toFixed(1)
    : "inf";
  return (
    `Trace Rec ${report.recordAvg.toFixed(2)}/${report.recordMax.toFixed(2)} | ` +
    `Int ${report.interactionAvg.toFixed(2)}/${report.interactionMax.toFixed(2)} | ` +
    `Con ${report.contractAvg.toFixed(2)}/${report.contractMax.toFixed(2)} | ` +
    `Run ${report.runtimeAvg.toFixed(2)}/${report.runtimeMax.toFixed(2)} | ` +
    `Shd ${report.shaderAvg.toFixed(2)}/${report.shaderMax.toFixed(2)} | ` +
    `Ev ${report.events} @${report.eventsPerSecond.toFixed(0)}/s | ` +
    `Drop ${report.dropped} | Cap ${report.capacity} (${held}s) | ` +
    `Dump ${report.dumpMs.toFixed(1)}ms x${report.dumps}` +
    (report.suppressed > 0 ? ` | Cooled ${report.suppressed}` : "") +
    (report.busy > 0 ? ` | Busy ${report.busy}` : "")
  );
}
