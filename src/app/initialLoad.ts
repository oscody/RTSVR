/**
 * Bookkeeping for "is the game presentable yet", feeding the HTML loading
 * overlay a single 0..1 number.
 *
 * ## What this is not
 *
 * **Not a loader.** Assets keep loading through `AssetManager` exactly as
 * before; this only counts. Ported from `vr_examples/brushspace`, minus its
 * `fetchArrayBufferWithProgress` — that hooks a raw `fetch` of one large binary,
 * and RTSVR has no such fetch to hook.
 *
 * ## Why it lives in `src/app/` rather than `src/systems/`
 *
 * These run **before `World.create()` resolves**. They cannot be registered,
 * paused, profiled or toggled the way the ~70 files in `src/systems/` can, and
 * filing them alongside things that can would invite someone to try.
 *
 * ## The rule that must not be dropped
 *
 * Every reporting site completes its task in a `finally`. Brushspace states the
 * requirement as *"the landing page must never wait on a failed download"* —
 * without it, one 404 leaves an opaque overlay covering the app forever, and
 * that failure is indistinguishable from a hang.
 */

export interface InitialLoadTaskSpec {
  id: string;
  weight: number;
}

type InitialLoadListener = (progress: number) => void;

export class InitialLoadTracker {
  private readonly weights = new Map<string, number>();
  private readonly fractions = new Map<string, number>();
  private readonly listeners = new Set<InitialLoadListener>();
  private resolveDone!: () => void;
  private resolved = false;

  /** Resolves once every task reaches completion. */
  readonly whenDone: Promise<void>;

  constructor(tasks: readonly InitialLoadTaskSpec[]) {
    for (const task of tasks) {
      this.weights.set(task.id, task.weight);
      this.fractions.set(task.id, 0);
    }
    this.whenDone = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
  }

  /** Overall weighted progress in [0, 1]. */
  get progress(): number {
    let total = 0;
    let done = 0;
    for (const [id, weight] of this.weights) {
      total += weight;
      done += weight * (this.fractions.get(id) ?? 0);
    }
    return total > 0 ? done / total : 1;
  }

  get done(): boolean {
    for (const fraction of this.fractions.values()) {
      if (fraction < 1) return false;
    }
    return true;
  }

  /**
   * Report partial progress for a task.
   *
   * Clamped to [0, 1] and **monotonic**: a bar that goes backwards reads as a
   * bug even when the load underneath it is perfectly healthy.
   */
  setProgress(id: string, fraction: number): void {
    const current = this.fractions.get(id);
    if (current === undefined) return;
    const next = Math.min(Math.max(fraction, current), 1);
    if (next === current) return;
    this.fractions.set(id, next);
    this.emit();
  }

  /** Mark a task finished. **Call this from failure paths too.** */
  complete(id: string): void {
    this.setProgress(id, 1);
  }

  /** Subscribe to progress changes; invoked immediately with the current value. */
  subscribe(listener: InitialLoadListener): () => void {
    this.listeners.add(listener);
    listener(this.progress);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const progress = this.progress;
    for (const listener of this.listeners) listener(progress);
    if (!this.resolved && this.done) {
      this.resolved = true;
      this.resolveDone();
    }
  }
}

/**
 * The four things the player is actually waiting for, weighted by how long each
 * takes rather than by how interesting it is.
 *
 * | Task | Weight | Reported from |
 * | --- | ---: | --- |
 * | `assets` | 8 | the shared `LoadingManager` — see {@link attachAssetLoadProgress} |
 * | `mesh-merge` | 3 | `optimizeLoadedAssets`, per key across 31 GLBs |
 * | `world` | 1 | `World.create()` resolving |
 * | `scenario` | 1 | `createInitialScenario` completing (D4's "presentable") |
 *
 * **Every one of these is a real signal.** Nothing here is timer-driven: a
 * progress bar that is secretly a `setInterval` is a lie the next person has to
 * discover. The overlay falls back to an indeterminate sweep whenever no
 * partials arrive, which is honest about not knowing rather than inventing a
 * number.
 */
export const initialLoad = new InitialLoadTracker([
  { id: "assets", weight: 8 },
  { id: "mesh-merge", weight: 3 },
  { id: "world", weight: 1 },
  { id: "scenario", weight: 1 },
]);

/**
 * Report real asset-preload progress.
 *
 * ## What the probe found (D5)
 *
 * `AssetManager.preloadAssets(manifest)` takes **no** progress callback
 * (`@iwsdk/core/dist/asset/asset-manager.js:49`). But `AssetManager.init` builds
 * a shared three.js `LoadingManager` (`:41`) and hands it to every loader, and
 * that manager **is** public API — `static loadingManager: LoadingManager` is
 * declared in the shipped `.d.ts`. `LoadingManager.onProgress` fires per item
 * with `(url, loaded, total)`, which is exactly the signal needed.
 *
 * Nothing in IWSDK assigns `onProgress`, so taking it does not clobber a
 * handler. Verified by grep across the asset package.
 *
 * ## Why it polls
 *
 * The manager does not exist until `AssetManager.init` runs *inside*
 * `World.create()`, so there is nothing to attach to at call time. Polling
 * catches it within a few milliseconds, and asset loading is network-bound
 * across 31 GLBs, so nothing meaningful is missed.
 *
 * **`setTimeout`, not `requestAnimationFrame`.** rAF is throttled to a stop in
 * a background tab, so a page opened in a background tab — which is exactly
 * what happens when someone middle-clicks a link — would never attach and would
 * report no progress at all. This is a poll, not an animation.
 *
 * Degrades rather than breaks: if the manager never appears, `assets` simply
 * never reports partials and the bar keeps its indeterminate sweep. The boot's
 * `finally` still completes the task, so the overlay always leaves.
 */
export function attachAssetLoadProgress(
  getManager: () => { onProgress?: unknown } | undefined,
  deadlineMs = 10000,
): void {
  const started = Date.now();
  const tryAttach = (): void => {
    const manager = getManager();
    if (!manager) {
      if (Date.now() - started > deadlineMs) return;
      setTimeout(tryAttach, 16);
      return;
    }
    (
      manager as { onProgress: (u: string, l: number, t: number) => void }
    ).onProgress = (_url, loaded, total) => {
      if (!(total > 0)) return;
      // Monotonic and clamped by the tracker, which matters here: the manager
      // counts every item it ever sees, so `total` grows as background and
      // runtime loads join the queue and the raw ratio can dip.
      initialLoad.setProgress("assets", loaded / total);
    };
  };
  tryAttach();
}
