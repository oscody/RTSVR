import { Group, type Entity, type Object3D, type World } from "@iwsdk/core";
import { boardState } from "./state.js";

/**
 * Attach/detach lifecycle for one tutorial visual layer (arrows, ring, paths,
 * turn cue, card).
 *
 * ## Why there are two levels instead of one
 *
 * The obvious implementation — make each pooled mesh an entity and call
 * `removeFromParent()` on it when the tutorial ends — **does not work**, and
 * fails silently rather than loudly.
 *
 * `TransformSystem.update()` iterates every entity with a `Transform` **every
 * frame** and re-parents it (`@iwsdk/core/dist/transform/transform.js:201-204`):
 *
 * ```js
 * else if (parentObject !== object.parent) {
 *   parentObject.add(object);   // parent changed in Transform
 * }
 * ```
 *
 * So a detached entity is put straight back into the scene on the next frame.
 * Clearing `Transform.parent` instead is worse: the `!parentObject` branch
 * re-parents it to the scene root *and* logs a warning per entity per frame.
 * Removing the `Transform` component entirely runs `detachFromEntity`, which
 * redefines `position`/`quaternion`/`scale` as **non-writable** — the visual
 * would come back frozen.
 *
 * Hence: **only the anchor is an entity.** The pool `Group` and every mesh
 * under it are plain `Object3D`s the ECS never sees, so detaching the pool
 * actually sticks. The anchor stays attached and costs one object.
 *
 * This mirrors `meteorSystem.ts:134-140`, where a `holder` entity carries plain
 * `spinner` and `trail` children, and it keeps the project rule that scene
 * content hangs off an entity rather than a bare `scene.add()`.
 *
 * **Both levels keep an identity transform and must continue to.** Callers such
 * as `showTutorialArrow` convert world points with
 * `boardState.boardRoot.object3D.worldToLocal(...)` and then assign straight to
 * a pooled mesh's `position`. That is only correct while anchor and group add
 * no transform of their own, so never move, rotate or scale either one.
 *
 * ## What detach means
 *
 * Removed from the live scene — so it costs no traversal, no draw call and no
 * raycast — while the meshes, geometries and materials stay in memory. A
 * Restart re-attaches the same objects instead of allocating new ones, which
 * is what keeps a replay free of both duplicate visuals and a fresh
 * shader-compilation hitch.
 */
export interface TutorialVisualPool {
  /** The detachable container. A plain `Group`, deliberately never an entity. */
  readonly group: Group;
  /** The anchor entity the group hangs off while attached. */
  anchor: Entity | null;
  /** Board root the anchor was built for, so a board rebuild is detected. */
  builtFor: Object3D | null;
  /** True while `group` is in the live scene. */
  attached: boolean;
  /** Anchored to the scene instead of the board root. */
  readonly persistent: boolean;
}

/**
 * `persistent` pools hang off the scene rather than the board root, for cues
 * that belong to the player rather than to the board (the turn cue, the
 * spotlight). They have no board-rebuild detection because there is no board
 * root to rebuild under them.
 */
export function createTutorialVisualPool(
  name: string,
  persistent = false,
): TutorialVisualPool {
  const group = new Group();
  group.name = name;
  return { group, anchor: null, builtFor: null, attached: false, persistent };
}

/**
 * Make the pool live, building the anchor on first use and re-attaching an
 * existing pool on every use after that.
 *
 * Returns `false` when the board root does not exist yet, which is the caller's
 * signal to skip this frame — the same contract the old `ensure*` guards had.
 *
 * A board rebuild (scenario reset re-creating `boardRoot`) is detected via
 * `builtFor` and drops the stale anchor so the caller rebuilds its meshes.
 */
export function attachTutorialVisualPool(
  pool: TutorialVisualPool,
  world: World | null,
): boolean {
  if (!world) return false;
  const root = pool.persistent ? null : boardState.boardRoot;
  const rootObject = pool.persistent ? null : (root?.object3D ?? null);
  if (!pool.persistent && (!root || !rootObject)) return false;

  // The board was rebuilt under us: the old anchor points into a dead tree.
  if (!pool.persistent && pool.builtFor !== null && pool.builtFor !== rootObject) {
    pool.group.removeFromParent();
    pool.anchor = null;
    pool.builtFor = null;
    pool.attached = false;
  }

  if (!pool.anchor) {
    const holder = new Group();
    holder.name = `${pool.group.name}Anchor`;
    pool.anchor = pool.persistent
      ? world.createTransformEntity(holder, { persistent: true })
      : world.createTransformEntity(holder, { parent: root! });
    pool.builtFor = rootObject;
  }

  const anchorObject = pool.anchor.object3D;
  if (!anchorObject) return false;
  if (pool.group.parent !== anchorObject) {
    anchorObject.add(pool.group);
  }
  pool.attached = true;
  return true;
}

/**
 * Remove the pool from the live scene, keeping its meshes and GPU resources.
 *
 * Idempotent: calling it on an already-detached or never-built pool does
 * nothing, which is what lets "skip" fire it without knowing whether the
 * player ever reached the drill that would have built the visuals.
 */
export function detachTutorialVisualPool(pool: TutorialVisualPool): void {
  if (!pool.attached) return;
  pool.group.removeFromParent();
  pool.attached = false;
}

/** True when the pool has been built at least once and is currently live. */
export function tutorialVisualPoolLive(pool: TutorialVisualPool): boolean {
  return pool.attached && pool.anchor !== null;
}
