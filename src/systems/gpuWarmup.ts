import { createSystem, type Object3D, type Texture, type World } from "@iwsdk/core";

/**
 * Queued, labelled pre-warm work for resources that would otherwise first
 * appear during a live Quest frame.
 *
 * Quest Browser does not expose `KHR_parallel_shader_compile`, so Three.js's
 * `compileAsync()` still performs its setup synchronously. One target is
 * therefore started at a time. This moves and spreads the work into setup or a
 * wave countdown instead of letting several preparation calls block one frame.
 */

interface WarmupRenderer {
  compileAsync?: (
    object: Object3D,
    camera: unknown,
    targetScene: unknown,
  ) => Promise<unknown>;
  initTexture?: (texture: Texture) => void;
}

interface WarmupTargets {
  renderer?: WarmupRenderer;
  scene?: unknown;
  camera?: unknown;
}

interface ObjectWarmupTarget {
  kind: "object";
  label: string;
  object: Object3D;
}

interface TextureWarmupTarget {
  kind: "texture";
  label: string;
  texture: Texture;
}

type WarmupTarget = ObjectWarmupTarget | TextureWarmupTarget;

let targets: WarmupTargets | null = null;
let queue: WarmupTarget[] = [];
let pendingObjects = new WeakSet<Object3D>();
let pendingTextures = new WeakSet<Texture>();
let active = false;
let warmedCount = 0;
let failedCount = 0;
let activeLabel = "";
let paused = false;

function mark(phase: "queued" | "start" | "complete" | "failed", label: string): void {
  // Custom trace events make a later Quest capture answer which application
  // resource was being prepared without turning every frame into a console log.
  if (typeof performance.mark === "function") {
    performance.mark(`gpu-warmup:${phase}:${label}`);
  }
}

/** Call once from `index.ts` after `World.create` resolves. */
export function attachGpuWarmup(world: World): void {
  targets = world as unknown as WarmupTargets;
  queue = [];
  pendingObjects = new WeakSet<Object3D>();
  pendingTextures = new WeakSet<Texture>();
  active = false;
  warmedCount = 0;
  failedCount = 0;
  activeLabel = "";
  // Every other field is cleared here, so this one must be too. A re-attach
  // that inherited `paused` from a previous world would leave warm-up silently
  // switched off for the whole session — no error, just first-use hitches
  // returning and nothing pointing at why.
  paused = false;
}

/** Queue one object's shader variants. Duplicate object requests are ignored. */
export function warmObjectForRender(
  object: Object3D | null | undefined,
  label = "unlabelled-object",
): void {
  if (!object || pendingObjects.has(object)) return;
  pendingObjects.add(object);
  queue.push({ kind: "object", label, object });
  mark("queued", label);
}

/** Queue one texture upload. Duplicate texture requests are ignored. */
export function warmTextureForRender(
  texture: Texture | null | undefined,
  label = "unlabelled-texture",
): void {
  if (!texture || pendingTextures.has(texture)) return;
  pendingTextures.add(texture);
  queue.push({ kind: "texture", label, texture });
  mark("queued", label);
}

function finish(label: string, success: boolean): void {
  active = false;
  activeLabel = "";
  if (success) {
    warmedCount += 1;
    mark("complete", label);
  } else {
    failedCount += 1;
    mark("failed", label);
  }
}

/**
 * True while a `compileAsync` is still in flight.
 *
 * Exists for one caller: a scenario reset must not dispose the scene's
 * materials while Three.js is still polling them. See {@link setGpuWarmupPaused}.
 */
export function gpuWarmupActive(): boolean {
  return active;
}

/**
 * Stop starting new warm-up targets, without dropping the queue.
 *
 * ## The crash this exists to prevent
 *
 * `compileAsync()` resolves a promise, but Three.js decides *when* by polling
 * `material.isReady` from a `setTimeout` it owns. A scenario reset that
 * disposes those materials mid-poll leaves the poll dereferencing a freed
 * program:
 *
 * ```
 * [Action] restart scenario reset requested
 * Uncaught TypeError: Cannot read properties of undefined (reading 'isReady')
 *     at checkMaterialsReady   <- three.js, inside its own setTimeout
 *     at WebGLRenderer.compileAsync
 *     at gpuWarmup.ts:143
 * ```
 *
 * Observed on a real Quest capture, 2026-09-03. **Neither the `try/catch`
 * around the call nor the promise's rejection handler can catch it** — the
 * throw happens in a timer callback, not on either path. Worse, the promise
 * then never settles, so `active` would stay true forever and the warm-up
 * queue would stall for the rest of the session.
 *
 * The only reliable fix is not to dispose while a compile is pending, so the
 * reset pauses this and waits. Paused is not cancelled: queued targets are
 * still wanted after the reset, and the module deliberately imports nothing
 * from the ECS, so the caller drives it.
 */
export function setGpuWarmupPaused(value: boolean): void {
  paused = value;
}

/** Start at most one warm-up target. Called once per normal world update. */
export function advanceGpuWarmup(): void {
  if (paused || active || !targets) return;
  const target = queue.shift();
  if (!target) return;

  const { renderer, scene, camera } = targets;
  active = true;
  activeLabel = target.label;
  mark("start", target.label);

  try {
    if (target.kind === "texture") {
      if (!renderer?.initTexture) {
        finish(target.label, false);
        return;
      }
      renderer.initTexture(target.texture);
      finish(target.label, true);
      return;
    }

    if (!renderer?.compileAsync || !scene || !camera) {
      finish(target.label, false);
      return;
    }

    // `compile()` skips invisible objects. Pool members are normally parked,
    // so make this detached/hidden target traversable just for synchronous
    // compile setup, then restore it before the renderer can draw another frame.
    const visibility: Array<[Object3D, boolean]> = [];
    target.object.traverse((child) => {
      visibility.push([child, child.visible]);
      child.visible = true;
    });
    target.object.updateMatrixWorld(true);
    let compilation: Promise<unknown>;
    try {
      compilation = renderer.compileAsync(target.object, camera, scene);
    } finally {
      for (const [child, wasVisible] of visibility) child.visible = wasVisible;
    }
    void compilation.then(
      () => finish(target.label, true),
      () => finish(target.label, false),
    );
  } catch {
    // A failed optional warm-up must never stop normal gameplay or the targets
    // queued after it. The performance mark retains the failure for the trace.
    finish(target.label, false);
  }
}

/** How many completed warm-up targets this session has processed. */
export function gpuWarmupCount(): number {
  return warmedCount;
}

/** Small diagnostic surface for a hitch record or automated test. */
export function gpuWarmupStatus(): Readonly<{
  queued: number;
  active: boolean;
  activeLabel: string;
  completed: number;
  failed: number;
}> {
  return {
    queued: queue.length,
    active,
    activeLabel,
    completed: warmedCount,
    failed: failedCount,
  };
}

/** Drives the queue after normal systems have had a chance to add targets. */
export class GpuWarmupSystem extends createSystem({}) {
  update(): void {
    advanceGpuWarmup();
  }
}
