import {
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  Vector3,
  type Object3D,
  type World,
} from "@iwsdk/core";
import {
  TUTORIAL_RING_COLOR,
  TUTORIAL_RING_OPACITY,
  TUTORIAL_RING_RADIUS,
  TUTORIAL_RING_THICKNESS_RATIO,
  TUTORIAL_RING_WEDGES,
  TUTORIAL_RING_WEDGE_GAP,
  TUTORIAL_RING_Y_OFFSET,
  TUTORIAL_CUE_RENDER_ORDER,
} from "./constants.ts";
import { makeNonInteractive } from "./sharedGeometry.js";
import { boardState } from "./state.js";
import {
  attachTutorialVisualPool,
  createTutorialVisualPool,
  detachTutorialVisualPool,
} from "./tutorialVisualPool.js";

/**
 * The tutorial's gaze ring: a flat ring on the ground that fills while the
 * player looks at the thing it surrounds, and drains when they look away.
 *
 * Design: `RTSVR_repos/devlog/plan/2026-08-09-Tutorial-System-Plan.md`, under
 * "Future features — implementation review".
 *
 * **Why wedges rather than one arc.** An arc that grows needs its geometry
 * rebuilt every time the progress changes, which allocates inside `update()` and
 * breaks this project's standing no-allocation rule. Instead the ring is N
 * fixed wedges, built once, shown or hidden by progress. The quantisation reads
 * as a segmented progress ring rather than as a defect — and it is free.
 *
 * Flat on the ground, like the selection and range rings, because that is the
 * established vocabulary for "this board object is the subject" and because the
 * player is looking down at a table-height board.
 */

const wedges: Mesh[] = [];
let ringMaterial: MeshBasicMaterial | null = null;
let ringGeometries: RingGeometry[] = [];
/**
 * Anchor + detachable container. The wedges are plain children of `pool.group`
 * rather than entities — see `tutorialVisualPool.ts`.
 */
const pool = createTutorialVisualPool("TutorialRing");
/** Captured from TutorialSystem.init — meshes must be entities, not bare adds. */
let ringWorld: World | null = null;
/** How many wedges are currently shown, so a repaint only happens on change. */
let shownWedges = -1;
/** The radius currently applied, so scaling only happens on change. */
let builtRadius = -1;

const tmpLocal = new Vector3();

/** Called once from TutorialSystem.init. Mirrors combatEffects' effectsWorld. */
export function attachTutorialRingWorld(world: World): void {
  ringWorld = world;
}

function ensureRing(): boolean {
  // Builds once, then RE-ATTACHES after a detach so a Restart reuses the
  // same 24 wedges instead of accumulating a second ring.
  if (!attachTutorialVisualPool(pool, ringWorld)) return false;
  if (wedges.length > 0) return true;

  wedges.length = 0;
  ringGeometries = [];
  // One material for every wedge: they are identical, and sharing keeps the
  // draw-call category honest about what this costs.
  ringMaterial = new MeshBasicMaterial({
    color: TUTORIAL_RING_COLOR,
    transparent: true,
    opacity: TUTORIAL_RING_OPACITY,
    depthWrite: false,
    // Above the card and through the scene, same as the cones — see
    // TUTORIAL_CUE_RENDER_ORDER.
    depthTest: false,
    // NormalBlending + toneMapped:false: additive VFX render WHITE over the
    // bright Martian ground, which would cost the ring its tutorial hue.
    toneMapped: false,
  });

  const step = (Math.PI * 2) / TUTORIAL_RING_WEDGES;
  // Built at UNIT radius and scaled to fit its subject.
  //
  // Rebuilding the geometry per radius was the first approach and it leaked:
  // `removeFromParent()` detaches the mesh but the ECS entity survives, so the
  // tutorial accumulated 24 more wedge entities every time it focused something
  // a different size. Scaling has no such cost, allocates nothing, and takes
  // the stroke with it so a small subject does not get a ring that is mostly
  // stroke.
  for (let index = 0; index < TUTORIAL_RING_WEDGES; index += 1) {
    const geometry = new RingGeometry(
      1 - TUTORIAL_RING_THICKNESS_RATIO,
      1,
      4,
      1,
      index * step,
      step * (1 - TUTORIAL_RING_WEDGE_GAP),
    );
    ringGeometries.push(geometry);
    const wedge = new Mesh(geometry, ringMaterial);
    makeNonInteractive(wedge);
    wedge.name = `TutorialRingWedge_${index}`;
    wedge.rotateX(-Math.PI / 2);
    wedge.visible = false;
    wedge.frustumCulled = false;
    wedge.renderOrder = TUTORIAL_CUE_RENDER_ORDER;
    wedge.userData.drawCat = "tutorial";
    // Plain child of the pool, not an entity: TransformSystem re-parents
    // entities every frame and would undo the detach.
    pool.group.add(wedge);
    wedges.push(wedge);
  }
  builtRadius = -1;
  shownWedges = -1;
  return true;
}

/**
 * Show the ring around a world position, filled to `progress` (0..1).
 *
 * Call every frame it should be up. Wedge visibility is only touched when the
 * count changes, so a still ring costs one comparison.
 */
export function showTutorialRing(
  target: Vector3,
  progress: number,
  radius: number = TUTORIAL_RING_RADIUS,
): void {
  if (!ensureRing()) return;
  const rootObject = boardState.boardRoot?.object3D;
  if (!rootObject) return;

  if (Math.abs(radius - builtRadius) > 1e-4) {
    builtRadius = radius;
    // The wedges lie in their own XY plane and are then rotated flat, so this
    // scales the ring's radius rather than squashing it.
    for (const wedge of wedges) wedge.scale.set(radius, radius, 1);
  }

  tmpLocal.copy(target);
  rootObject.worldToLocal(tmpLocal);

  const clamped = Math.max(0, Math.min(1, progress));
  const lit = Math.round(clamped * TUTORIAL_RING_WEDGES);
  for (let index = 0; index < wedges.length; index += 1) {
    const wedge = wedges[index];
    // Y is the ring's own offset above the board, not the target's height: the
    // ring lies on the ground around the thing, it does not float at its centre.
    wedge.position.set(tmpLocal.x, TUTORIAL_RING_Y_OFFSET, tmpLocal.z);
    if (shownWedges !== lit) wedge.visible = index < lit;
  }
  shownWedges = lit;
}

/** Park it. Cheap enough to call unconditionally every frame. */
export function hideTutorialRing(): void {
  if (shownWedges === 0) return;
  for (const wedge of wedges) wedge.visible = false;
  shownWedges = 0;
}

/** Scenario reset: park and rewind. The wedges are pooled, so nothing is freed. */
export function clearTutorialRing(): void {
  hideTutorialRing();
  shownWedges = -1;
}

/** Remove the ring from the live scene, keeping its GPU resources. */
export function detachTutorialRing(): void {
  detachTutorialVisualPool(pool);
}

/** Current ring radius, for tests and debugging. */
export function tutorialRingRadius(): number {
  return builtRadius;
}

/** Genuine teardown only — a rebuilt board root orphans the old wedges. */
export function disposeTutorialRing(): void {
  detachTutorialVisualPool(pool);
  for (const wedge of wedges) wedge.removeFromParent();
  for (const geometry of ringGeometries) geometry.dispose();
  ringMaterial?.dispose();
  wedges.length = 0;
  ringGeometries = [];
  ringMaterial = null;
  pool.anchor = null;
  pool.builtFor = null;
  shownWedges = -1;
  builtRadius = -1;
}
