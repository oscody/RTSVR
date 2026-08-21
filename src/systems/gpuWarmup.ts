import type { Object3D, World } from "@iwsdk/core";

/**
 * Compiles a prepared object's shader programs **before** it is first rendered.
 *
 * ## Why this exists
 *
 * `WaveSystem.prepareWaveIncrementally()` already builds each wave's aliens a few
 * at a time during the countdown, and it is close to free — the profiler's
 * `Prep | PAlien | PDrake | PMech` row reads 0.0–0.1 ms. That preparation is
 * working exactly as designed.
 *
 * But it prepares the **CPU** side only. `createPreparedAlien()` finishes with
 * `alien.object3D?.removeFromParent()`, and that detach is deliberate: an
 * attached-but-invisible alien still costs a matrix recompose over ~79 nodes
 * every frame, because `updateMatrixWorld` recurses into invisible subtrees.
 * Detaching removed that cost entirely and was the right call.
 *
 * The side effect is that a detached object is never in the render pass, so its
 * **GPU** work — program compilation, texture upload — is deferred to first
 * render, which is the moment the whole reserve is released at once.
 *
 * This closes that gap without undoing the optimisation: `compileAsync` compiles
 * an object's materials **without attaching or rendering it**, so the reserve
 * stays detached and the work lands during the idle countdown instead.
 *
 * ## Honesty about what this fixes
 *
 * A 2.5-second stall was measured at the tutorial → wave 1 handoff
 * (`devlog/plan/2026-08-20-Console-Log-Review-And-Optimisation-Plan.md`,
 * Finding 2), and shader compilation was the first hypothesis. It is **not
 * confirmed** — the tutorial already releases one of every alien type wave 1
 * uses, so those programs arguably should have compiled earlier, and the
 * profiler's `Other` bucket cannot separate compilation from GC or GPU upload.
 *
 * This is worth doing regardless, because moving compilation off the release
 * frame is correct whatever the stall turns out to be. It should not be reported
 * as the fix for that stall until a DevTools Performance trace attributes it.
 */

interface WarmupTargets {
  renderer?: {
    compileAsync?: (
      object: Object3D,
      camera: unknown,
      targetScene: unknown,
    ) => Promise<unknown>;
  };
  scene?: unknown;
  camera?: unknown;
}

let targets: WarmupTargets | null = null;
/** Counts what we warmed, so the effect can be checked rather than assumed. */
let warmedCount = 0;
let failed = false;

/** Call once from `index.ts` after `World.create` resolves. */
export function attachGpuWarmup(world: World): void {
  targets = world as unknown as WarmupTargets;
  warmedCount = 0;
  failed = false;
}

/**
 * Compile `object`'s materials now, off the render path.
 *
 * Fire-and-forget by design. The synchronous half of `compile()` runs on the
 * calling frame, which is the point: callers invoke this from the *incremental*
 * preparation loop, so the cost is already spread a few objects per frame across
 * a 30-second countdown. Awaiting it would only move the same work later.
 *
 * Safe to call with a detached object — that is the whole reason it is used here.
 */
export function warmObjectForRender(object: Object3D | null | undefined): void {
  if (!object || !targets || failed) return;
  const { renderer, scene, camera } = targets;
  if (!renderer?.compileAsync || !scene || !camera) return;
  // Same stale-matrix rule as everywhere else in this project: `compile`
  // traverses and reads transforms, and this object was assembled moments ago.
  object.updateMatrixWorld(true);
  try {
    void renderer.compileAsync(object, camera, scene).then(
      () => {},
      () => {},
    );
    warmedCount += 1;
  } catch {
    // One failure disables the rest. A warm-up that throws per alien would turn
    // a performance nicety into a spam source, and the game is correct without
    // it — the programs simply compile at release, as they did before.
    failed = true;
  }
}

/** How many objects have been pre-compiled this session, for diagnostics. */
export function gpuWarmupCount(): number {
  return warmedCount;
}
