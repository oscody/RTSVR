/**
 * The tutorial's hold on the moving world.
 *
 * Deliberately imports **nothing** — same discipline as `tutorialWaveGate.ts`.
 * `wave.ts`, `combat.ts` and `alienAnimation.ts` read it; `tutorial.ts` writes
 * it. A module with no imports cannot be the middle of a cycle however the
 * graph grows.
 *
 * **The freeze ends when the player looks, not on a timer.** That is what makes
 * it a gate rather than a cutscene: it cannot be missed and cannot be waited
 * out, and the action that ends it is the action being taught.
 *
 * Which also means there is **no timeout**, so every way of leaving the beat
 * must release it — dormancy, the settings toggle, and restart. A frozen match
 * with a player who never looks is a soft-lock, and that is worse than the
 * feature is good.
 */

let frozen = false;

/** Written by TutorialSystem. */
export function setTutorialFreeze(active: boolean): void {
  frozen = active;
}

/**
 * Is the world held still?
 *
 * Three systems ask this, and all three must agree. Freezing movement but not
 * the animation mixers leaves aliens marching on the spot, which reads as a bug
 * rather than as frozen time.
 */
export function isTutorialFrozen(): boolean {
  return frozen;
}
