/**
 * Following one player action from the first thing that can be observed to the
 * last, and noticing the ones that vanish.
 *
 * ## What is actually observable, and what is not
 *
 * The app never touches an `XRInputSource` itself. Its whole input surface is
 * IWSDK's: `InputSystem` raycasts over private descendant arrays and publishes
 * the result as transient `Hovered` / `Pressed` tags, and UIKit dispatches
 * pointer events to element listeners. So the honest picture is:
 *
 * ```
 * XR input ──▶ [ raycast + hit test ]──▶ Pressed tag ──▶ app handler ──▶ …
 *                    NOT OBSERVABLE          first observable boundary
 * ```
 *
 * Two consequences the rest of this file is built around:
 *
 * - **The candidate count for a pick cannot be recorded.** It lives inside
 *   `InputSystem.rayDescendants`, which is private. The profiler's `RayMesh`
 *   figure is a per-flush total of ray-testable meshes, not a per-pick count,
 *   and pretending otherwise would be inventing a number. It is recorded as
 *   unavailable.
 * - **A press that never reaches a handler is invisible from the inside.** The
 *   only way to see it is a deadline: open a correlation the moment something
 *   observable happens, and fail it if no terminal result arrives. That is what
 *   {@link sweepInteractions} does, and it is the reason
 *   `Contract.ClickReachesTerminalResult` has timing `eventual`.
 *
 * ## Rays and hovers are deliberately not logged
 *
 * A controller ray moves every frame and a hover target changes many times a
 * second. Recording either would drown the flight recorder in exactly the
 * events nobody investigating a hitch wants. Only presses, grabs, releases and
 * the selection or target changes they cause are recorded.
 */

import {
  INTERACTION_DEADLINE_MS,
  INTERACTION_SLOTS,
  INTERACTION_CORRELATION_TRACE_ENABLED,
} from "./traceFlags.js";
import {
  Contract,
  Handedness,
  InteractionStage,
  Reason,
  Terminal,
} from "./traceIds.js";
import { newCorrelationId, traceInteraction } from "./trace.js";
import { isTraceRecording, traceFrame } from "./traceRecorder.js";
import { checkContract } from "./traceContracts.js";

/** Minimal shape of the input manager this file reads. Nothing private. */
interface TraceInputSource {
  handedness?: string;
  targetRayMode?: string;
}
interface TraceGamepad {
  getButtonPressed?: (id: string) => boolean;
}
interface TraceXrInput {
  gamepads?: Record<string, TraceGamepad | undefined>;
  getPrimaryInputSource?: (
    handedness: "left" | "right",
  ) => TraceInputSource | undefined;
}
interface TraceInputHost {
  input?: { xr?: TraceXrInput };
}

let host: TraceInputHost | null = null;

/** Give the tracer the world so it can sample which hand pressed. */
export function attachInteractionTracing(world: unknown): void {
  if (!INTERACTION_CORRELATION_TRACE_ENABLED) return;
  host = world as TraceInputHost;
}

// --- slot table ------------------------------------------------------------

const corrById = new Uint32Array(INTERACTION_SLOTS);
const startedAt = new Float64Array(INTERACTION_SLOTS);
const startedFrame = new Int32Array(INTERACTION_SLOTS);
const handOf = new Uint8Array(INTERACTION_SLOTS);
const targetOf = new Int32Array(INTERACTION_SLOTS);
/** Bitmask of `InteractionStage` values already recorded, for the report. */
const stagesSeen = new Uint16Array(INTERACTION_SLOTS);
const active = new Uint8Array(INTERACTION_SLOTS);
/** Interactions dropped because every slot was busy. Never silent. */
let overflowed = 0;

function claimSlot(): number {
  for (let slot = 0; slot < INTERACTION_SLOTS; slot += 1) {
    if (active[slot] === 0) return slot;
  }
  // Force-expire the oldest. A slot table that fills up means interactions are
  // not terminating, which is itself the finding — so the eviction is reported
  // as a lost interaction rather than quietly reused.
  let oldest = 0;
  for (let slot = 1; slot < INTERACTION_SLOTS; slot += 1) {
    if (startedAt[slot] < startedAt[oldest]) oldest = slot;
  }
  overflowed += 1;
  closeSlot(oldest, Terminal.Timeout, Reason.InteractionLost, true);
  return oldest;
}

function slotFor(corr: number): number {
  for (let slot = 0; slot < INTERACTION_SLOTS; slot += 1) {
    if (active[slot] === 1 && corrById[slot] === corr) return slot;
  }
  return -1;
}

function closeSlot(
  slot: number,
  terminal: number,
  reason: number,
  reportContract: boolean,
): void {
  if (active[slot] === 0) return;
  active[slot] = 0;
  const corr = corrById[slot];
  const elapsedMs = performance.now() - startedAt[slot];
  const elapsedFrames = traceFrame() - startedFrame[slot];
  traceInteraction(
    corr,
    InteractionStage.Terminal,
    targetOf[slot],
    handOf[slot],
    terminal,
    reason,
  );
  // Elapsed time and the stages that were actually reached ride on a second
  // record rather than being crammed into the first, so the terminal event
  // keeps one meaning per field.
  traceInteraction(
    corr,
    InteractionStage.Terminal,
    Math.round(elapsedMs * 1000),
    handOf[slot],
    Math.max(0, elapsedFrames),
    stagesSeen[slot],
  );
  if (reportContract) {
    checkContract(
      Contract.ClickReachesTerminalResult,
      terminal === Terminal.Success ||
        terminal === Terminal.Blocked ||
        terminal === Terminal.RejectedWithReason ||
        terminal === Terminal.RayMiss ||
        terminal === Terminal.ButtonMiss,
      terminal,
      Terminal.Success,
      Reason.InteractionTimeout,
    );
  }
}

// --- handedness ------------------------------------------------------------

/**
 * Which hand is pressing, when that can be established.
 *
 * Reads only public API: `gamepads.{left,right}.getButtonPressed('xr-standard-trigger')`
 * and `getPrimaryInputSource(handedness)`. Outside an immersive session, or when
 * neither trigger reads as pressed (a hand pinch routes through a different
 * path), this answers `Unknown` rather than guessing — a wrong hand in a trace
 * is worse than an absent one.
 */
function sampleHandedness(): number {
  const xr = host?.input?.xr;
  if (!xr) return Handedness.Screen;
  const gamepads = xr.gamepads;
  const leftDown = gamepads?.left?.getButtonPressed?.("xr-standard-trigger");
  const rightDown = gamepads?.right?.getButtonPressed?.("xr-standard-trigger");
  if (leftDown && !rightDown) return Handedness.Left;
  if (rightDown && !leftDown) return Handedness.Right;
  if (leftDown && rightDown) return Handedness.Unknown;
  const left = xr.getPrimaryInputSource?.("left");
  const right = xr.getPrimaryInputSource?.("right");
  if (right && !left) return Handedness.Right;
  if (left && !right) return Handedness.Left;
  return Handedness.Unknown;
}

// --- public API ------------------------------------------------------------

/**
 * A board, unit, enemy, building or site press was observed.
 *
 * Called from `InteractionSystem`'s `Pressed` qualify subscriptions — the first
 * moment the application can see anything. The raycast that produced this tag
 * already happened inside `InputSystem`, so it is recorded as a hit with an
 * unavailable candidate count, not as something this code watched.
 */
export function beginWorldInteraction(targetEntityIndex: number): number {
  if (!INTERACTION_CORRELATION_TRACE_ENABLED || !isTraceRecording()) return 0;
  const corr = newCorrelationId();
  const slot = claimSlot();
  const hand = sampleHandedness();
  corrById[slot] = corr;
  startedAt[slot] = performance.now();
  startedFrame[slot] = traceFrame();
  handOf[slot] = hand;
  targetOf[slot] = targetEntityIndex;
  stagesSeen[slot] = InteractionStage.XrInput | InteractionStage.Raycast;
  active[slot] = 1;
  traceInteraction(
    corr,
    InteractionStage.XrInput,
    targetEntityIndex,
    hand,
    Terminal.Pending,
  );
  // Candidate count is deliberately absent: it is private to InputSystem.
  traceInteraction(
    corr,
    InteractionStage.Raycast,
    targetEntityIndex,
    hand,
    Terminal.Pending,
  );
  return corr;
}

/**
 * A UIKit element handler was entered.
 *
 * `buttonId` is a stable numeric hash of the element id, assigned by
 * {@link uiButtonId}, so the trace stores a number and the dump can still name
 * the button.
 */
export function beginUiInteraction(buttonId: number): number {
  if (!INTERACTION_CORRELATION_TRACE_ENABLED || !isTraceRecording()) return 0;
  const corr = newCorrelationId();
  const slot = claimSlot();
  const hand = sampleHandedness();
  corrById[slot] = corr;
  startedAt[slot] = performance.now();
  startedFrame[slot] = traceFrame();
  handOf[slot] = hand;
  targetOf[slot] = buttonId;
  stagesSeen[slot] =
    InteractionStage.XrInput |
    InteractionStage.UiBoundary |
    InteractionStage.ButtonHandler;
  active[slot] = 1;
  traceInteraction(
    corr,
    InteractionStage.UiBoundary,
    buttonId,
    hand,
    Terminal.Pending,
  );
  traceInteraction(
    corr,
    InteractionStage.ButtonHandler,
    buttonId,
    hand,
    Terminal.Pending,
  );
  return corr;
}

/** Record one intermediate stage of an open interaction. */
export function noteInteractionStage(
  corr: number,
  stage: number,
  value = 0,
  reason: number = Reason.None,
): void {
  if (corr === 0 || !INTERACTION_CORRELATION_TRACE_ENABLED) return;
  const slot = slotFor(corr);
  if (slot < 0) return;
  stagesSeen[slot] |= stage;
  traceInteraction(corr, stage, value, handOf[slot], Terminal.Pending, reason);
}

/** Close an interaction with its terminal result. */
export function finishInteraction(
  corr: number,
  terminal: number,
  reason: number = Reason.None,
): void {
  if (corr === 0 || !INTERACTION_CORRELATION_TRACE_ENABLED) return;
  const slot = slotFor(corr);
  if (slot < 0) return;
  closeSlot(slot, terminal, reason, true);
}

/**
 * Fail every interaction past its deadline. Called once per frame.
 *
 * `INTERACTION_DEADLINE_MS` is generous — this is "the click disappeared", not
 * "the click was slow" — and the failure is the only signal available for the
 * unobservable raycast/UIKit middle.
 */
export function sweepInteractions(): void {
  if (!INTERACTION_CORRELATION_TRACE_ENABLED || !isTraceRecording()) return;
  const now = performance.now();
  for (let slot = 0; slot < INTERACTION_SLOTS; slot += 1) {
    if (active[slot] === 0) continue;
    if (now - startedAt[slot] < INTERACTION_DEADLINE_MS) continue;
    closeSlot(slot, Terminal.Timeout, Reason.InteractionTimeout, true);
  }
}

/**
 * Abandon every open interaction, without calling it a failure.
 *
 * A scenario reset or an XR session ending is a legitimate reason for a click
 * in flight to have nowhere to land, so these close as `blocked` with the
 * cause, and no contract failure and no dump. Re-entering a session simply
 * starts fresh: correlation ids are monotonic for the whole page lifetime, so
 * an id from before the exit can never be confused with one after it.
 */
export function clearInteractions(reason: number): void {
  if (!INTERACTION_CORRELATION_TRACE_ENABLED) return;
  for (let slot = 0; slot < INTERACTION_SLOTS; slot += 1) {
    if (active[slot] === 0) continue;
    closeSlot(slot, Terminal.Blocked, reason, false);
  }
}

/** Interactions currently in flight. Test-facing. */
export function openInteractionCount(): number {
  let count = 0;
  for (let slot = 0; slot < INTERACTION_SLOTS; slot += 1) count += active[slot];
  return count;
}

/** Interactions evicted for lack of a slot. Reported in dumps. */
export function overflowedInteractionCount(): number {
  return overflowed;
}

// --- button ids ------------------------------------------------------------

/**
 * A stable number for a UIKit element id, plus the reverse table for dumps.
 *
 * Assigned on first sight, in binding order, which is deterministic because
 * `TabletSystem.bind` runs once over a fixed list. Ids are not stable ACROSS
 * builds the way system ids are, which is fine: a button id only ever has to be
 * readable within the session that produced the capture, and the reverse table
 * is printed with the dump.
 */
const buttonIds = new Map<string, number>();
const buttonNames: string[] = [""];

export function uiButtonId(elementId: string): number {
  const existing = buttonIds.get(elementId);
  if (existing !== undefined) return existing;
  const id = buttonNames.length;
  buttonNames.push(elementId);
  buttonIds.set(elementId, id);
  return id;
}

export function uiButtonName(id: number): string {
  return buttonNames[id] ?? `button-${id}`;
}

/** `id:name` pairs for the dump header. */
export function uiButtonTable(): string {
  const parts: string[] = [];
  for (let id = 1; id < buttonNames.length; id += 1) {
    parts.push(`${id}:${buttonNames[id]}`);
  }
  return parts.join(" ");
}
