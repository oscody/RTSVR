import { OBJECT_TRANSITION_POOL_SIZE } from "./constants.ts";
import {
  easeInCubic,
  easeOutCubic,
  lerp,
  transitionProgress,
} from "./transitionRules.ts";

/**
 * Short scale/position transitions on objects that already exist.
 *
 * Design: `RTSVR_repos/devlog/plan/Game_balancing/2026-09-04-Mining-Death-Completion-VFX-Plan.md`,
 * phase 3.
 *
 * ## Why this is not `gameplayEffects.ts`
 *
 * That file owns *added* visuals: pooled flashes and rings it created and can
 * throw away. This file owns *existing* ones — the miner's cargo model, an
 * exhausted crystal node — objects some other system built, and whose resting
 * transform must come back exactly. Different failure mode, so a different
 * file: dropping a pooled flash costs nothing, but losing a cargo model's base
 * scale leaves a permanently wrong-sized miner.
 *
 * ## What it replaces
 *
 * A `visible = true` / `visible = false` flip. Everything here is presentation:
 * the rule that caused the flip already resolved, and nothing waits on the
 * transition finishing.
 *
 * ## Transform only, never materials
 *
 * The same rule as the meteors, for the same reason: these objects carry shared
 * `AssetManager` GLTF materials. Fading one fades every clone of it, and
 * mutating them recreates the shader churn already fixed elsewhere.
 *
 * ## Allocation
 *
 * The slot array is built once at module load. Starting a transition takes a
 * slot or, if all are busy, applies the end state immediately — which is
 * precisely the one-frame behaviour that shipped before this file existed. So
 * a full pool degrades to the old game rather than allocating inside an update.
 *
 * ## Stale objects
 *
 * A slot holds an `Object3D` reference, and the miner owning it can die
 * mid-transition. That is safe by construction rather than by bookkeeping:
 * nothing here reads the scene graph, touches materials, or disposes anything,
 * so the worst case is writing a scale onto a detached object for the third
 * of a second before the slot frees itself.
 * {@link clearObjectTransitions} covers the long tail at a scenario reset.
 * Deliberately NOT keyed on `entity.index`, which EliCS recycles.
 *
 * ## Why the system class lives next door
 *
 * `objectTransitionSystem.ts` holds the six lines that drive this file. The
 * split exists so the node test runner can import the controller: anything
 * importing `@iwsdk/core` fails at load with `document is not defined`, and
 * this file has real branching — base-scale capture, slot reuse, the
 * pool-full snap — that source-text assertions cannot check.
 */

/**
 * The little of `Object3D` this file actually touches.
 *
 * Structural rather than the real type, so the controller stays importable
 * outside a browser. `Object3D` satisfies it without any cast.
 */
export interface TransitionTarget {
  visible: boolean;
  position: { y: number };
  scale: { x: number; setScalar(value: number): void };
}

/** Growing into place, or shrinking and sinking out of it. */
type TransitionMode = "reveal" | "retreat";

interface TransitionSlot {
  active: boolean;
  object: TransitionTarget | null;
  mode: TransitionMode;
  remaining: number;
  duration: number;
  /** The resting transform, captured once and restored exactly at the end. */
  baseScale: number;
  baseY: number;
  /**
   * Where this transition starts and ends, as a FRACTION of `baseScale`.
   *
   * A fraction rather than an absolute so an interruption can begin from
   * wherever the object currently is. Interrupting from a fixed endpoint
   * instead would snap the object to full size before shrinking it — a pop, in
   * the file whose job is removing them.
   */
  fromScale: number;
  toScale: number;
  fromY: number;
  toY: number;
  /** Whether a finished retreat hides the object. */
  hideAtEnd: boolean;
}

const slots: TransitionSlot[] = [];
for (let index = 0; index < OBJECT_TRANSITION_POOL_SIZE; index += 1) {
  slots.push({
    active: false,
    object: null,
    mode: "reveal",
    remaining: 0,
    duration: 0,
    baseScale: 1,
    baseY: 0,
    fromScale: 0,
    toScale: 1,
    fromY: 0,
    toY: 0,
    hideAtEnd: true,
  });
}

/** The slot already animating this object, if any. */
function slotFor(object: TransitionTarget): TransitionSlot | null {
  for (const slot of slots) {
    if (slot.active && slot.object === object) return slot;
  }
  return null;
}

function freeSlot(): TransitionSlot | null {
  for (const slot of slots) {
    if (!slot.active) return slot;
  }
  return null;
}

/** Put the object back exactly where it rests and release the slot. */
function settle(slot: TransitionSlot, visible: boolean): void {
  const object = slot.object;
  if (object) {
    object.scale.setScalar(slot.baseScale);
    object.position.y = slot.baseY;
    object.visible = visible;
  }
  slot.active = false;
  slot.object = null;
}

/**
 * Grow an object into its resting transform.
 *
 * A no-op when the object is already visible and settled — the caller may
 * report the same state on many frames, and restarting the entrance every
 * frame would freeze it at its smallest.
 */
export function startReveal(
  object: TransitionTarget | null | undefined,
  duration: number,
  startScale: number,
  rise = 0,
): void {
  if (!object) return;
  const existing = slotFor(object);
  if (existing?.mode === "reveal") return;
  if (!existing && object.visible) return;

  const slot = existing ?? freeSlot();
  if (!slot) {
    // Pool full: snap. Same result as before this file existed.
    object.visible = true;
    return;
  }
  // Reusing a retreating slot keeps the base captured when that retreat began,
  // NOT the shrunken transform it is passing through right now.
  if (!existing) {
    slot.baseScale = object.scale.x || 1;
    slot.baseY = object.position.y;
  }
  // Interrupting? Carry on from where the object actually is. Otherwise start
  // small and low, as asked.
  slot.fromScale = existing ? object.scale.x / slot.baseScale : startScale;
  slot.fromY = existing ? object.position.y : slot.baseY - rise;
  slot.toScale = 1;
  slot.toY = slot.baseY;
  slot.active = true;
  slot.object = object;
  slot.mode = "reveal";
  slot.duration = duration;
  slot.remaining = duration;
  slot.hideAtEnd = false;
  object.scale.setScalar(slot.baseScale * slot.fromScale);
  object.position.y = slot.fromY;
  object.visible = true;
}

/**
 * Shrink and sink an object away, hiding it when the transition completes.
 *
 * A no-op on an already-hidden object: `mining.ts` clears cargo on several
 * paths that may never have shown it.
 */
export function startRetreat(
  object: TransitionTarget | null | undefined,
  duration: number,
  endScale: number,
  sink = 0,
): void {
  if (!object) return;
  const existing = slotFor(object);
  if (existing?.mode === "retreat") return;
  if (!existing && !object.visible) return;

  const slot = existing ?? freeSlot();
  if (!slot) {
    // Pool full: snap to hidden. Safe without restoring anything — reaching
    // here means the object had no slot, so it is already at its base
    // transform.
    object.visible = false;
    return;
  }
  if (!existing) {
    slot.baseScale = object.scale.x || 1;
    slot.baseY = object.position.y;
  }
  slot.fromScale = existing ? object.scale.x / slot.baseScale : 1;
  slot.fromY = existing ? object.position.y : slot.baseY;
  slot.toScale = endScale;
  slot.toY = slot.baseY - sink;
  slot.active = true;
  slot.object = object;
  slot.mode = "retreat";
  slot.duration = duration;
  slot.remaining = duration;
  slot.hideAtEnd = true;
}

/**
 * Force an object to its resting transform and the given visibility, now.
 *
 * For teardown paths — a miner losing its base, a unit dying — where a
 * transition would animate something the player is no longer looking at.
 */
export function settleObject(
  object: TransitionTarget | null | undefined,
  visible: boolean,
): void {
  if (!object) return;
  const slot = slotFor(object);
  if (slot) {
    settle(slot, visible);
    return;
  }
  object.visible = visible;
}

/**
 * Drop every transition without touching the objects.
 *
 * Called by the scenario reset, which is about to dispose the objects these
 * slots point at. Restoring a transform on something being destroyed would be
 * pointless work at the exact moment the frame is most expensive.
 *
 * **Invariant this depends on, and who can break it:** every object left
 * mid-transition here must be destroyed straight afterwards. Call this from
 * anywhere that keeps its objects alive and they stay frozen at a fractional
 * scale — and worse, the next {@link startReveal} captures that fractional
 * scale as the base and the object never returns to full size. A test asserts
 * the scenario reset is the only caller.
 */
export function clearObjectTransitions(): void {
  for (const slot of slots) {
    slot.active = false;
    slot.object = null;
  }
}

/** Diagnostic surface: how many transitions are running right now. */
export function objectTransitionsActive(): number {
  let count = 0;
  for (const slot of slots) if (slot.active) count += 1;
  return count;
}

/**
 * Advance every running transition. Driven once per frame by
 * `ObjectTransitionSystem`.
 */
export function advanceObjectTransitions(delta: number): void {
  const frameDelta = Math.max(0, delta);
  for (const slot of slots) {
    if (!slot.active) continue;
    const object = slot.object;
    if (!object) {
      slot.active = false;
      continue;
    }

    slot.remaining -= frameDelta;
    const progress = transitionProgress(slot.remaining, slot.duration);
    if (progress >= 1) {
      settle(slot, !slot.hideAtEnd);
      continue;
    }

    // Arrivals decelerate, departures accelerate. Opposite shapes, so the two
    // read as different events rather than one animation played backwards.
    const eased =
      slot.mode === "reveal" ? easeOutCubic(progress) : easeInCubic(progress);
    object.scale.setScalar(slot.baseScale * lerp(slot.fromScale, slot.toScale, eased));
    object.position.y = lerp(slot.fromY, slot.toY, eased);
  }
}
