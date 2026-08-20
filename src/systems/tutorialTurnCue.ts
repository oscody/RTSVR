import {
  BufferGeometry,
  Float32BufferAttribute,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  Vector3,
  type World,
} from "@iwsdk/core";
import {
  TUTORIAL_CUE_RENDER_ORDER,
  TUTORIAL_TURN_CUE_COLOR,
  TUTORIAL_TURN_CUE_DISTANCE,
  TUTORIAL_TURN_CUE_DROP,
  TUTORIAL_TURN_CUE_HIDE_DOT,
  TUTORIAL_TURN_CUE_OFFSET,
  TUTORIAL_TURN_CUE_PULSE,
  TUTORIAL_TURN_CUE_PULSE_HZ,
  TUTORIAL_TURN_CUE_SIZE,
} from "./constants.ts";
import { makeNonInteractive } from "./sharedGeometry.js";

/**
 * "It is behind you" — a chevron at the edge of view pointing which way to turn.
 *
 * The meet beat rings whatever just arrived, but an alien can land anywhere on a
 * 24x24 board and a ring you cannot see teaches nothing. Without this the beat
 * asks the player to look at something while giving them no way to find it.
 *
 * **Viewer-relative and per frame**, unlike the card. The card is placed on text
 * change and left alone because a panel welded to your head is unreadable; this
 * is the opposite — it exists only to be chased, and it vanishes the moment the
 * subject is in front of you.
 *
 * Parented to the player rather than the board, so it survives the board root
 * being rebuilt on reset and needs no scenario cleanup.
 */

let cueMesh: Mesh | null = null;
let cueGeometry: BufferGeometry | null = null;
let cueMaterial: MeshBasicMaterial | null = null;
let attached = false;
let clock = 0;

const tmpCamera = new Vector3();
const tmpForward = new Vector3();
const tmpToSubject = new Vector3();
const tmpRight = new Vector3();

/** A flat triangle in the XY plane facing +Z and pointing +X. */
function makeCueGeometry(): BufferGeometry {
  const s = TUTORIAL_TURN_CUE_SIZE;
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new Float32BufferAttribute([-s * 0.6, s, 0, -s * 0.6, -s, 0, s, 0, 0], 3),
  );
  geometry.computeVertexNormals();
  return geometry;
}

/** Called once from TutorialSystem.init. */
export function attachTutorialTurnCue(world: World): void {
  if (attached) return;
  cueGeometry = makeCueGeometry();
  cueMaterial = new MeshBasicMaterial({
    color: TUTORIAL_TURN_CUE_COLOR,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
    // The left-hand cue is the same mesh mirrored, which reverses its winding —
    // DoubleSide is what keeps that from turning it invisible. (Back-face
    // culling has eaten one flat glyph in this feature already.)
    side: DoubleSide,
  });
  cueMesh = new Mesh(cueGeometry, cueMaterial);
  makeNonInteractive(cueMesh);
  cueMesh.name = "TutorialTurnCue";
  cueMesh.visible = false;
  cueMesh.frustumCulled = false;
  cueMesh.renderOrder = TUTORIAL_CUE_RENDER_ORDER;
  cueMesh.userData.drawCat = "tutorial";
  world.createTransformEntity(cueMesh, { persistent: true });
  attached = true;
}

/**
 * Point the player toward `subjectWorld`, or hide if they are already facing it.
 *
 * `camera` is the viewer; everything is computed flattened to the ground plane,
 * because "turn left" is a yaw instruction and pitch would only confuse it.
 */
export function showTutorialTurnCue(
  cameraWorld: Vector3,
  cameraForward: Vector3,
  subjectWorld: Vector3 | null,
  delta: number,
): void {
  const mesh = cueMesh;
  if (!mesh) {
    console.warn("[TurnCueDiag] no mesh");
    return;
  }
  if (!subjectWorld) {
    hideTutorialTurnCue();
    return;
  }

  tmpCamera.copy(cameraWorld);
  tmpForward.copy(cameraForward);
  tmpForward.y = 0;
  tmpToSubject.copy(subjectWorld).sub(tmpCamera);
  tmpToSubject.y = 0;
  if (tmpForward.lengthSq() < 1e-6 || tmpToSubject.lengthSq() < 1e-6) {
    hideTutorialTurnCue();
    return;
  }
  tmpForward.normalize();
  tmpToSubject.normalize();

  // Already facing it: the ring can be seen, so the cue has done its job.
  if (tmpForward.dot(tmpToSubject) >= TUTORIAL_TURN_CUE_HIDE_DOT) {
    hideTutorialTurnCue();
    return;
  }

  // Which way is shorter to turn. `right = forward x up` for a Y-up,
  // right-handed space — written out rather than guessed, because the first
  // version had this backwards AND the side sign backwards, which cancelled
  // into correct behaviour and would have misled the next reader completely.
  tmpRight.set(-tmpForward.z, 0, tmpForward.x);
  const side = tmpRight.dot(tmpToSubject) >= 0 ? 1 : -1;

  clock += Math.max(0, delta);
  const pulse =
    1 + Math.sin(clock * TUTORIAL_TURN_CUE_PULSE_HZ * Math.PI * 2) * TUTORIAL_TURN_CUE_PULSE;

  mesh.position
    .copy(tmpCamera)
    .addScaledVector(tmpForward, TUTORIAL_TURN_CUE_DISTANCE)
    .addScaledVector(tmpRight, TUTORIAL_TURN_CUE_OFFSET * side);
  mesh.position.y = tmpCamera.y - TUTORIAL_TURN_CUE_DROP;
  // Face the viewer, then mirror for the left-hand side so the point leads.
  mesh.rotation.set(0, Math.atan2(-tmpForward.x, -tmpForward.z), 0);
  mesh.scale.set(side * pulse, pulse, pulse);
  mesh.visible = true;
}

/** Park it. Cheap enough to call unconditionally every frame. */
export function hideTutorialTurnCue(): void {
  if (cueMesh?.visible) cueMesh.visible = false;
}

/** Scenario reset. */
export function clearTutorialTurnCue(): void {
  hideTutorialTurnCue();
  clock = 0;
}
