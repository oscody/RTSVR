import {
  ConeGeometry,
  Mesh,
  MeshBasicMaterial,
  Vector3,
  type Object3D,
  type World,
} from "@iwsdk/core";
import {
  TUTORIAL_ARROW_BOB,
  TUTORIAL_ARROW_BOB_HZ,
  TUTORIAL_ARROW_COLOR,
  TUTORIAL_ARROW_HEIGHT,
  TUTORIAL_ARROW_RADIUS,
  TUTORIAL_ARROW_SPIN,
  TUTORIAL_ARROW_TIP_GAP,
  TUTORIAL_ARROW_POOL,
  TUTORIAL_ARROW_BOB_PHASE,
  TUTORIAL_CUE_RENDER_ORDER,
} from "./constants.ts";
import { makeNonInteractive } from "./sharedGeometry.js";
import { boardState } from "./state.js";
import { trackResource } from "./resourceLifetime.js";
import {
  attachTutorialVisualPool,
  createTutorialVisualPool,
  detachTutorialVisualPool,
} from "./tutorialVisualPool.js";

/**
 * The tutorial's pointing layer: one cone that hovers point-down over whatever
 * the card is currently talking about.
 *
 * A helper module rather than a system — TutorialSystem already runs at the
 * right time and owns the target, so a second system would only need the same
 * state a frame later. Mirrors `combatEffects.ts`.
 *
 * Design: `RTSVR_repos/devlog/plan/2026-08-09-Tutorial-System-Plan.md`.
 *
 * **Why a cone and not a billboarded chevron.** The under-attack beacon shipped
 * as a flat quad, looked right in the desktop preview, and was invisible on
 * Quest: edge-on to a standing player, a plane is a line. A cone of revolution
 * has no edge-on angle, so it needs no billboarding to stay readable. The spin
 * below is liveliness, not legibility.
 */

/**
 * A small pool. Some instructions are about a relationship — "send this craft to
 * those crystals" — and one cone can only ever name one end of it.
 */
const arrowMeshes: Mesh[] = [];
let arrowGeometry: ConeGeometry | null = null;
let arrowMaterial: MeshBasicMaterial | null = null;
/**
 * Anchor + detachable container. The cones are plain children of `pool.group`,
 * not entities — see `tutorialVisualPool.ts` for why that is what makes
 * detaching stick.
 */
const pool = createTutorialVisualPool("TutorialArrows");
/** Seconds since the arrow was built — drives bob and spin. */
let animationClock = 0;
/** Captured from TutorialSystem.init — the mesh must be an entity, not a bare add(). */
let arrowWorld: World | null = null;

const tmpLocal = new Vector3();

/** Called once from TutorialSystem.init. Mirrors combatEffects' effectsWorld. */
export function attachTutorialArrowWorld(world: World): void {
  arrowWorld = world;
}

function ensureArrows(): boolean {
  // Builds on first use and RE-ATTACHES on every use after a detach, so a
  // Restart reuses these cones instead of allocating a second set.
  if (!attachTutorialVisualPool(pool, arrowWorld)) return false;
  if (arrowMeshes.length > 0) return true;

  arrowGeometry = new ConeGeometry(
    TUTORIAL_ARROW_RADIUS,
    TUTORIAL_ARROW_HEIGHT,
    16,
  );
  // Point-down, with the origin at the TIP rather than the centre, so callers
  // pass the position of the thing being pointed at and the gap is the only
  // offset. Getting this wrong reads as the arrow pointing at empty air just
  // above the target.
  arrowGeometry.rotateX(Math.PI);
  arrowGeometry.translate(0, TUTORIAL_ARROW_HEIGHT / 2, 0);
  trackResource(arrowGeometry, {
    kind: "geometry",
    scope: "session",
    label: "tutorial-arrow",
  });

  arrowMaterial = new MeshBasicMaterial({
    color: TUTORIAL_ARROW_COLOR,
    // NormalBlending and toneMapped:false: additive VFX render WHITE over the
    // bright Martian ground under tone mapping, which would cost the arrow the
    // tutorial hue that distinguishes it from every gameplay marker.
    toneMapped: false,
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
  });
  // Built once and reused by every drill's arrow, so a count above 1 means
  // the cue is being rebuilt rather than repointed.
trackResource(arrowMaterial, { kind: "material", scope: "session", label: "tutorial-arrow" });

  for (let index = 0; index < TUTORIAL_ARROW_POOL; index += 1) {
    const mesh = new Mesh(arrowGeometry, arrowMaterial);
    makeNonInteractive(mesh);
    mesh.name = `TutorialArrow_${index}`;
    mesh.visible = false;
    // Above the card, and through the scene: a pointer that the label covers,
    // or that a hill hides, is not pointing at anything.
    mesh.renderOrder = TUTORIAL_CUE_RENDER_ORDER;
    arrowMaterial!.depthTest = false;
    // Its own draw-call category, so the tutorial's cost stays visible in the
    // profiler's Draw line rather than hiding in the "static" bucket.
    mesh.userData.drawCat = "tutorial";
    // Plain child of the pool, not its own entity: `TransformSystem` would
    // re-attach an entity every frame and defeat the detach.
    pool.group.add(mesh);
    arrowMeshes.push(mesh);
  }
  return true;
}

/** Remove the cones from the live scene, keeping their GPU resources. */
export function detachTutorialArrows(): void {
  detachTutorialVisualPool(pool);
}

/**
 * Hover the arrow over a world position. Call every frame it should be up.
 *
 * `delta` drives bob and spin; `target` is the world-space point being pointed
 * at, and the cone's tip stops TUTORIAL_ARROW_TIP_GAP short of it.
 */
/** Advance the shared bob/spin clock. Call once per frame, before showing. */
export function tickTutorialArrows(delta: number): void {
  animationClock += Math.max(0, delta);
}

/**
 * Hover cone `slot` over a world position.
 *
 * Slots bob out of phase with each other: two cones rising and falling in
 * lockstep read as one mechanism blinking, rather than as two separate things
 * being pointed at.
 */
export function showTutorialArrow(slot: number, target: Vector3): void {
  if (!ensureArrows()) return;
  const mesh = arrowMeshes[slot];
  const rootObject = boardState.boardRoot?.object3D;
  if (!mesh || !rootObject) return;

  const phase = slot * TUTORIAL_ARROW_BOB_PHASE;
  const bob =
    Math.sin(animationClock * TUTORIAL_ARROW_BOB_HZ * Math.PI * 2 + phase) *
    TUTORIAL_ARROW_BOB;

  tmpLocal.copy(target);
  rootObject.worldToLocal(tmpLocal);
  tmpLocal.y += TUTORIAL_ARROW_TIP_GAP + TUTORIAL_ARROW_BOB + bob;
  mesh.position.copy(tmpLocal);
  mesh.rotation.y = animationClock * TUTORIAL_ARROW_SPIN + phase;
  mesh.visible = true;
}

/** Park every cone from `slot` on. Cheap enough to call every frame. */
export function hideTutorialArrowsFrom(slot: number): void {
  for (let index = slot; index < arrowMeshes.length; index += 1) {
    if (arrowMeshes[index].visible) arrowMeshes[index].visible = false;
  }
}

/** Park all of them. */
export function hideTutorialArrow(): void {
  hideTutorialArrowsFrom(0);
}

/** How many cones the pool can show at once. */
export function tutorialArrowCapacity(): number {
  return TUTORIAL_ARROW_POOL;
}

/**
 * Scenario reset. The mesh is pooled under the board root, so this parks and
 * rewinds it rather than disposing — the next match reuses the same cone.
 */
export function clearTutorialArrow(): void {
  animationClock = 0;
  for (const mesh of arrowMeshes) {
    mesh.visible = false;
    mesh.rotation.y = 0;
  }
}

/**
 * Drop the GPU resources. Only for a genuine teardown — the board root going
 * away — since a rebuilt root leaves the old mesh orphaned and unreachable.
 */
export function disposeTutorialArrow(): void {
  detachTutorialVisualPool(pool);
  for (const mesh of arrowMeshes) mesh.removeFromParent();
  arrowGeometry?.dispose();
  arrowMaterial?.dispose();
  arrowMeshes.length = 0;
  arrowGeometry = null;
  arrowMaterial = null;
  pool.anchor = null;
  pool.builtFor = null;
  animationClock = 0;
}
