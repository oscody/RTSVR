import {
  BufferGeometry,
  Float32BufferAttribute,
  Mesh,
  MeshBasicMaterial,
  Vector3,
  type Object3D,
  type World,
} from "@iwsdk/core";
import {
  TUTORIAL_CUE_RENDER_ORDER,
  TUTORIAL_PATH_COLOR,
  TUTORIAL_PATH_MIN_LENGTH,
  TUTORIAL_PATH_OPACITY,
  TUTORIAL_PATH_POOL,
  TUTORIAL_PATH_SIZE,
  TUTORIAL_PATH_SPACING,
  TUTORIAL_PATH_SPEED,
  TUTORIAL_PATH_Y_OFFSET,
} from "./constants.ts";
import { makeNonInteractive } from "./sharedGeometry.js";
import { boardState } from "./state.js";

/**
 * The Living Path: chevrons flowing along the ground from a unit to where it is
 * going.
 *
 * Design: `RTSVR_repos/devlog/plan/2026-08-09-Tutorial-System-Plan.md`, under
 * "Future features — implementation review", 2b.
 *
 * **The path starts at the unit's CURRENT position**, not at where it set off.
 * That is what makes "the path disappears behind the unit" free rather than a
 * calculation: there is never any path behind it to hide. It also keeps chevron
 * spacing constant in world units as the journey shortens, instead of
 * compressing them into the remaining gap.
 *
 * A straight segment — see `TUTORIAL_PATH_SPACING` for why that is correct
 * rather than a compromise.
 */

const chevrons: Mesh[] = [];
let pathGeometry: BufferGeometry | null = null;
let pathMaterial: MeshBasicMaterial | null = null;
let pooledRoot: Object3D | null = null;
let pathWorld: World | null = null;
/** Flow offset, in world units along the segment. */
let flow = 0;
/** How many chevrons are currently up, so hiding only touches what changed. */
let shown = 0;

const tmpFrom = new Vector3();
const tmpTo = new Vector3();
const tmpDir = new Vector3();

/** Called once from TutorialSystem.init. */
export function attachTutorialPathWorld(world: World): void {
  pathWorld = world;
}

/**
 * An OPEN chevron — a `>` with the middle cut out — lying flat and pointing
 * along +Z, so a yaw aligns it with the segment.
 *
 * Two arms, two triangles each. A solid triangle was tried first and reads as a
 * blob at this scale; a row of blobs reads as debris rather than as direction.
 *
 * **Vertex order matters.** Wind each triangle back-left → tip → back-right and
 * the normal points +Y; reverse any of them and back-face culling hides that
 * piece from every angle a player can look from — no error, correct transform,
 * simply absent. That cost an hour the first time.
 */
function makeChevronGeometry(): BufferGeometry {
  const w = TUTORIAL_PATH_SIZE; // half-width
  const d = w * 0.62; // half-depth: tip forward, tails back
  const t = w * 0.34; // arm thickness, measured along the back edge
  // How far forward the notch cuts, as a fraction of the depth. Together with
  // `t` this is what makes the glyph a chevron rather than a wedge: at 0 the
  // notch only reaches the midline and the shape is still 67% solid, which
  // reads as a blob. Half the depth brings it to ~50%, matching the art.
  const notch = d * 0.5;
  // Outer: back-left A, tip B, back-right C. Inner: D, notch E, F.
  const A: [number, number] = [-w, -d];
  const B: [number, number] = [0, d];
  const C: [number, number] = [w, -d];
  const D: [number, number] = [-w + t, -d];
  const E: [number, number] = [0, notch];
  const F: [number, number] = [w - t, -d];
  const v = (p: [number, number]): number[] => [p[0], 0, p[1]];
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new Float32BufferAttribute(
      [
        ...v(A), ...v(B), ...v(E),
        ...v(A), ...v(E), ...v(D),
        ...v(B), ...v(C), ...v(F),
        ...v(B), ...v(F), ...v(E),
      ],
      3,
    ),
  );
  geometry.computeVertexNormals();
  return geometry;
}

function ensurePath(): boolean {
  const root = boardState.boardRoot;
  const rootObject = root?.object3D ?? null;
  if (!root || !rootObject || !pathWorld) return false;
  if (pooledRoot === rootObject && chevrons.length > 0) return true;

  chevrons.length = 0;
  pathGeometry = makeChevronGeometry();
  pathMaterial = new MeshBasicMaterial({
    color: TUTORIAL_PATH_COLOR,
    transparent: true,
    opacity: TUTORIAL_PATH_OPACITY,
    depthWrite: false,
    // Above the card and through the scene, like the cones and the ring — a
    // direction the label covers is not directing anyone.
    depthTest: false,
    // NormalBlending + toneMapped:false, per the additive-washout rule.
    toneMapped: false,
  });

  for (let index = 0; index < TUTORIAL_PATH_POOL; index += 1) {
    const mesh = new Mesh(pathGeometry, pathMaterial);
    makeNonInteractive(mesh);
    mesh.name = `TutorialPathChevron_${index}`;
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = TUTORIAL_CUE_RENDER_ORDER;
    mesh.userData.drawCat = "tutorial";
    // No ScenarioObject: reset parks these rather than disposing them.
    pathWorld.createTransformEntity(mesh, { parent: root });
    chevrons.push(mesh);
  }
  pooledRoot = rootObject;
  shown = 0;
  return true;
}

/**
 * Draw a path from `fromWorld` to `toWorld`. Call every frame it should be up.
 *
 * Chevrons flow toward the destination at a constant world speed and constant
 * world spacing, so the path reads the same whether the unit has 1 tile or 12
 * to go.
 */
export function showTutorialPath(
  fromWorld: Vector3,
  toWorld: Vector3,
  delta: number,
): void {
  if (!ensurePath()) return;
  const rootObject = boardState.boardRoot?.object3D;
  if (!rootObject) return;

  tmpFrom.copy(fromWorld);
  tmpTo.copy(toWorld);
  rootObject.worldToLocal(tmpFrom);
  rootObject.worldToLocal(tmpTo);
  tmpDir.copy(tmpTo).sub(tmpFrom);
  tmpDir.y = 0;
  const length = tmpDir.length();
  // Nearly arrived: a couple of chevrons jittering on top of the unit reads as
  // a glitch, not as direction.
  if (length < TUTORIAL_PATH_MIN_LENGTH) {
    hideTutorialPath();
    return;
  }
  tmpDir.divideScalar(length);

  flow = (flow + Math.max(0, delta) * TUTORIAL_PATH_SPEED) % TUTORIAL_PATH_SPACING;
  const yaw = Math.atan2(tmpDir.x, tmpDir.z);

  let used = 0;
  for (let index = 0; index < chevrons.length; index += 1) {
    const distance = flow + index * TUTORIAL_PATH_SPACING;
    if (distance >= length) break;
    const mesh = chevrons[index];
    mesh.position.set(
      tmpFrom.x + tmpDir.x * distance,
      TUTORIAL_PATH_Y_OFFSET,
      tmpFrom.z + tmpDir.z * distance,
    );
    mesh.rotation.y = yaw;
    mesh.visible = true;
    used += 1;
  }
  for (let index = used; index < shown; index += 1) chevrons[index].visible = false;
  shown = used;
}

/** Park it. Cheap enough to call unconditionally every frame. */
export function hideTutorialPath(): void {
  if (shown === 0) return;
  for (const mesh of chevrons) mesh.visible = false;
  shown = 0;
}

/** Scenario reset: park and rewind the flow. */
export function clearTutorialPath(): void {
  hideTutorialPath();
  flow = 0;
}

/** Genuine teardown only. */
export function disposeTutorialPath(): void {
  for (const mesh of chevrons) mesh.removeFromParent();
  pathGeometry?.dispose();
  pathMaterial?.dispose();
  chevrons.length = 0;
  pathGeometry = null;
  pathMaterial = null;
  pooledRoot = null;
  shown = 0;
  flow = 0;
}
