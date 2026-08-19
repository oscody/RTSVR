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
} from "./constants.ts";
import { makeNonInteractive } from "./sharedGeometry.js";
import { boardState } from "./state.js";

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

let arrowMesh: Mesh | null = null;
let arrowGeometry: ConeGeometry | null = null;
let arrowMaterial: MeshBasicMaterial | null = null;
/** The board root the mesh currently hangs off, so a reset rebuild is detected. */
let pooledRoot: Object3D | null = null;
/** Seconds since the arrow was built — drives bob and spin. */
let animationClock = 0;
/** Captured from TutorialSystem.init — the mesh must be an entity, not a bare add(). */
let arrowWorld: World | null = null;

const tmpLocal = new Vector3();

/** Called once from TutorialSystem.init. Mirrors combatEffects' effectsWorld. */
export function attachTutorialArrowWorld(world: World): void {
  arrowWorld = world;
}

function ensureArrow(): Mesh | null {
  const root = boardState.boardRoot;
  const rootObject = root?.object3D ?? null;
  if (!root || !rootObject || !arrowWorld) return null;
  if (pooledRoot === rootObject && arrowMesh) return arrowMesh;

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

  arrowMesh = new Mesh(arrowGeometry, arrowMaterial);
  makeNonInteractive(arrowMesh);
  arrowMesh.name = "TutorialArrow";
  arrowMesh.visible = false;
  arrowMesh.renderOrder = 3;
  // Its own draw-call category, so the tutorial's cost stays visible in the
  // profiler's Draw line rather than hiding in the "static" bucket.
  arrowMesh.userData.drawCat = "tutorial";
  // No ScenarioObject: reset should park this, not dispose it.
  arrowWorld.createTransformEntity(arrowMesh, { parent: root });
  pooledRoot = rootObject;
  return arrowMesh;
}

/**
 * Hover the arrow over a world position. Call every frame it should be up.
 *
 * `delta` drives bob and spin; `target` is the world-space point being pointed
 * at, and the cone's tip stops TUTORIAL_ARROW_TIP_GAP short of it.
 */
export function showTutorialArrow(target: Vector3, delta: number): void {
  const mesh = ensureArrow();
  const rootObject = boardState.boardRoot?.object3D;
  if (!mesh || !rootObject) return;

  animationClock += Math.max(0, delta);
  const bob =
    Math.sin(animationClock * TUTORIAL_ARROW_BOB_HZ * Math.PI * 2) *
    TUTORIAL_ARROW_BOB;

  tmpLocal.copy(target);
  rootObject.worldToLocal(tmpLocal);
  tmpLocal.y += TUTORIAL_ARROW_TIP_GAP + TUTORIAL_ARROW_BOB + bob;
  mesh.position.copy(tmpLocal);
  mesh.rotation.y = animationClock * TUTORIAL_ARROW_SPIN;
  mesh.visible = true;
}

/** Park it. Cheap enough to call unconditionally every frame. */
export function hideTutorialArrow(): void {
  if (arrowMesh?.visible) arrowMesh.visible = false;
}

/**
 * Scenario reset. The mesh is pooled under the board root, so this parks and
 * rewinds it rather than disposing — the next match reuses the same cone.
 */
export function clearTutorialArrow(): void {
  animationClock = 0;
  if (!arrowMesh) return;
  arrowMesh.visible = false;
  arrowMesh.rotation.y = 0;
}

/**
 * Drop the GPU resources. Only for a genuine teardown — the board root going
 * away — since a rebuilt root leaves the old mesh orphaned and unreachable.
 */
export function disposeTutorialArrow(): void {
  arrowMesh?.removeFromParent();
  arrowGeometry?.dispose();
  arrowMaterial?.dispose();
  arrowMesh = null;
  arrowGeometry = null;
  arrowMaterial = null;
  pooledRoot = null;
  animationClock = 0;
}
