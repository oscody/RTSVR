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
  TUTORIAL_RING_THICKNESS,
  TUTORIAL_RING_THICKNESS_RATIO,
  TUTORIAL_RING_WEDGES,
  TUTORIAL_RING_WEDGE_GAP,
  TUTORIAL_RING_Y_OFFSET,
  TUTORIAL_CUE_RENDER_ORDER,
} from "./constants.ts";
import { makeNonInteractive } from "./sharedGeometry.js";
import { boardState } from "./state.js";

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
/** The board root the wedges hang off, so a rebuilt root is detected. */
let pooledRoot: Object3D | null = null;
/** Captured from TutorialSystem.init — meshes must be entities, not bare adds. */
let ringWorld: World | null = null;
/** How many wedges are currently shown, so a repaint only happens on change. */
let shownWedges = -1;
/**
 * The radius the current wedges were built at.
 *
 * Geometry has to be rebuilt when the subject's size changes — a ring sized for
 * a 3-tile command center is wrong around a 1-tile alien. Rebuilt only when the
 * radius actually changes (once per beat, not per frame), which is what keeps
 * this off the no-allocation-in-update rule.
 */
let builtRadius = -1;

const tmpLocal = new Vector3();

/** Called once from TutorialSystem.init. Mirrors combatEffects' effectsWorld. */
export function attachTutorialRingWorld(world: World): void {
  ringWorld = world;
}

function ensureRing(radius: number): boolean {
  const root = boardState.boardRoot;
  const rootObject = root?.object3D ?? null;
  if (!root || !rootObject || !ringWorld) return false;
  const sameRadius = Math.abs(radius - builtRadius) < 1e-4;
  if (pooledRoot === rootObject && wedges.length > 0 && sameRadius) return true;

  // Rebuilding for a new radius: drop the old geometries rather than leaking
  // one set per subject the tutorial ever focuses.
  for (const geometry of ringGeometries) geometry.dispose();
  for (const wedge of wedges) wedge.removeFromParent();
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
  // Thickness scales with radius so a small subject does not get a ring that is
  // mostly stroke.
  const thickness = Math.max(
    TUTORIAL_RING_THICKNESS * 0.5,
    radius * TUTORIAL_RING_THICKNESS_RATIO,
  );
  for (let index = 0; index < TUTORIAL_RING_WEDGES; index += 1) {
    const geometry = new RingGeometry(
      Math.max(0.001, radius - thickness),
      radius,
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
    // No ScenarioObject: reset parks these, it does not dispose them.
    ringWorld.createTransformEntity(wedge, { parent: root });
    wedges.push(wedge);
  }
  pooledRoot = rootObject;
  builtRadius = radius;
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
  if (!ensureRing(radius)) return;
  const rootObject = boardState.boardRoot?.object3D;
  if (!rootObject) return;

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

/** Current ring radius, for tests and debugging. */
export function tutorialRingRadius(): number {
  return builtRadius;
}

/** Genuine teardown only — a rebuilt board root orphans the old wedges. */
export function disposeTutorialRing(): void {
  for (const wedge of wedges) wedge.removeFromParent();
  for (const geometry of ringGeometries) geometry.dispose();
  ringMaterial?.dispose();
  wedges.length = 0;
  ringGeometries = [];
  ringMaterial = null;
  pooledRoot = null;
  shownWedges = -1;
  builtRadius = -1;
}
