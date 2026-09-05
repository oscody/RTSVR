/**
 * Pure easing and progress maths for every short in-world transition.
 *
 * Separated from the systems for the reason the plan gives: the lifecycle
 * maths is where clamping and zero/negative-delta bugs live, and it can be
 * tested exhaustively here without a WebGL context or a board. No imports,
 * same rule as the other `*Rules` modules.
 *
 * Was `meteorTransitionRules.ts` until phase 3. It was renamed when the cargo,
 * deposit and node-depletion transitions needed the same four functions:
 * `mining.ts` importing its easing from a file named after meteors would have
 * been a lie about who owns this maths.
 *
 * Design: `RTSVR_repos/devlog/plan/Game_balancing/2026-09-04-Mining-Death-Completion-VFX-Plan.md`,
 * phases 2 and 3.
 */

/**
 * How far through a transition we are, as 0..1.
 *
 * `remaining` counts DOWN, which is how every other timer in the meteor system
 * works, so this converts rather than inventing a second convention.
 *
 * Clamped at both ends on purpose:
 * - A frame long enough to overshoot drives `remaining` negative, which would
 *   otherwise produce a progress above 1 and scale a rock past its real size on
 *   the last frame of its entrance.
 * - A `duration` of zero would divide by zero; it answers 1, which reads as
 *   "already finished" and lets the caller settle immediately.
 */
export function transitionProgress(remaining: number, duration: number): number {
  if (!(duration > 0)) return 1;
  const elapsed = duration - remaining;
  if (elapsed <= 0) return 0;
  if (elapsed >= duration) return 1;
  return elapsed / duration;
}

/**
 * Ease-out cubic: fast at first, settling at the end.
 *
 * For arrivals. A rock that decelerates into its hover position reads as
 * arriving; a linear one reads as being dragged.
 */
export function easeOutCubic(t: number): number {
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const inverted = 1 - clamped;
  return 1 - inverted * inverted * inverted;
}

/**
 * Ease-in cubic: slow at first, accelerating away.
 *
 * For departures. The rock lingers just long enough to be noticed leaving,
 * then goes quickly — the opposite shape to an arrival, which is what makes
 * the two read as different events rather than one animation played backwards.
 */
export function easeInCubic(t: number): number {
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return clamped * clamped * clamped;
}

/** Linear blend, clamped through the eased progress its callers pass. */
export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/**
 * Scale and Y for a materialising rock.
 *
 * Starts small and below its hover height, arriving at full size in place.
 */
export function materializePose(
  progress: number,
  startScale: number,
  floatY: number,
  rise: number,
): { scale: number; y: number } {
  const eased = easeOutCubic(progress);
  return {
    scale: lerp(startScale, 1, eased),
    y: lerp(floatY - rise, floatY, eased),
  };
}

/**
 * Scale and Y for a departing rock.
 *
 * Shrinks toward nothing while sinking, from wherever it currently rests —
 * which may be mid-air if the match ended during the fall.
 */
export function departPose(
  progress: number,
  fromY: number,
  sink: number,
): { scale: number; y: number } {
  const eased = easeInCubic(progress);
  return {
    // Never exactly 0: a zero scale collapses the matrix and some drivers warn
    // on a degenerate transform. The rock is invisible well before this.
    scale: lerp(1, 0.01, eased),
    y: fromY - sink * eased,
  };
}
