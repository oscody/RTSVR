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
  TUTORIAL_PATH_HOSTILE_COLOR,
  TUTORIAL_PATH_MIN_LENGTH,
  TUTORIAL_PATH_OPACITY,
  TUTORIAL_PATH_POOL,
  TUTORIAL_PATH_SIZE,
  TUTORIAL_PATH_SPACING,
  TUTORIAL_PATH_SPEED,
  TUTORIAL_PATH_Y_OFFSET,
} from "./constants.ts";
import { gridToWorld } from "./board.js";
import { makeNonInteractive } from "./sharedGeometry.js";
import { boardState } from "./state.js";
import {
  attachTutorialVisualPool,
  createTutorialVisualPool,
  detachTutorialVisualPool,
} from "./tutorialVisualPool.js";
import type { PathStyle } from "./tutorialCatalog.ts";

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

/**
 * One pool per side.
 *
 * They must be separate: the astronaut beat draws a red route and a blue route
 * at the same time, and a single shared pool cannot show four of each — whoever
 * drew first would starve the other.
 */
interface PathPool {
  chevrons: Mesh[];
  material: MeshBasicMaterial | null;
  /** How many are currently up, so hiding only touches what changed. */
  shown: number;
}

const pools: Record<PathStyle, PathPool> = {
  friendly: { chevrons: [], material: null, shown: 0 },
  hostile: { chevrons: [], material: null, shown: 0 },
};
let pathGeometry: BufferGeometry | null = null;
/**
 * Anchor + detachable container. Both chevron pools are plain children of
 * `pool.group` rather than entities — see `tutorialVisualPool.ts`.
 */
const visualPool = createTutorialVisualPool("TutorialPaths");
let pathWorld: World | null = null;
/** Flow offset, in world units along the route. Shared, so both sides pulse together. */
let flow = 0;

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
  // Builds once, then RE-ATTACHES after a detach so a Restart reuses the same
  // 32 chevrons rather than allocating a second set.
  if (!attachTutorialVisualPool(visualPool, pathWorld)) return false;
  if (pools.friendly.chevrons.length > 0) return true;

  pathGeometry = makeChevronGeometry();
  for (const style of ["friendly", "hostile"] as PathStyle[]) {
    const pool = pools[style];
    pool.chevrons.length = 0;
    pool.material = new MeshBasicMaterial({
      color:
        style === "hostile"
          ? TUTORIAL_PATH_HOSTILE_COLOR
          : TUTORIAL_PATH_COLOR,
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
      const mesh = new Mesh(pathGeometry, pool.material);
      makeNonInteractive(mesh);
      mesh.name = `TutorialPath_${style}_${index}`;
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = TUTORIAL_CUE_RENDER_ORDER;
      mesh.userData.drawCat = "tutorial";
      // Plain child of the visual pool, not an entity: TransformSystem
      // re-parents entities every frame and would undo the detach.
      visualPool.group.add(mesh);
      pool.chevrons.push(mesh);
    }
    pool.shown = 0;
  }
  return true;
}

/** Remove both chevron pools from the live scene, keeping GPU resources. */
export function detachTutorialPaths(): void {
  detachTutorialVisualPool(visualPool);
}

/** Advance the shared flow. Call once per frame, before drawing anything. */
export function tickTutorialPaths(delta: number): void {
  flow = (flow + Math.max(0, delta) * TUTORIAL_PATH_SPEED) % TUTORIAL_PATH_SPACING;
}

/**
 * Draw a straight path from `fromWorld` to `toWorld` in the given style.
 *
 * Correct for FRIENDLY units, whose movement really is a straight line at their
 * order tile. Aliens run a pathfinder and need `showTutorialRoute` instead.
 */
export function showTutorialPath(
  style: PathStyle,
  fromWorld: Vector3,
  toWorld: Vector3,
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
    hideTutorialPath(style);
    return;
  }
  tmpDir.divideScalar(length);
  const yaw = Math.atan2(tmpDir.x, tmpDir.z);

  const pool = pools[style];
  let used = 0;
  for (let index = 0; index < pool.chevrons.length; index += 1) {
    const distance = flow + index * TUTORIAL_PATH_SPACING;
    if (distance >= length) break;
    place(
      pool.chevrons[index],
      tmpFrom.x + tmpDir.x * distance,
      tmpFrom.z + tmpDir.z * distance,
      yaw,
    );
    used += 1;
  }
  hideFrom(pool, used);
}

/**
 * Draw a path along a TILE ROUTE — the alien case.
 *
 * Aliens run a real pathfinder and walk around obstacles, so a straight line
 * would be a drawing of a route they will not take. This walks the polyline and
 * places chevrons at constant arc-length along it, so spacing looks the same on
 * a straight leg and around a corner.
 *
 * `tiles` is expected to start at the alien's current cursor, which is what
 * makes the trail vanish behind it without any extra work.
 */
export function showTutorialRoute(
  style: PathStyle,
  fromWorld: Vector3,
  tiles: readonly { x: number; y: number }[],
  tileCount: number,
): void {
  if (!ensurePath() || tileCount <= 0) return;
  const rootObject = boardState.boardRoot?.object3D;
  if (!rootObject) return;

  const pool = pools[style];
  tmpFrom.copy(fromWorld);
  rootObject.worldToLocal(tmpFrom);

  // Walk the polyline, dropping a chevron every TUTORIAL_PATH_SPACING of ARC
  // length. Measuring along the arc rather than per segment is what keeps the
  // spacing even through corners.
  let carried = flow;
  let used = 0;
  let prevX = tmpFrom.x;
  let prevZ = tmpFrom.z;
  for (let index = 0; index < tileCount && used < pool.chevrons.length; index += 1) {
    const [tileX, tileZ] = gridToWorld(tiles[index].x, tiles[index].y);
    let dx = tileX - prevX;
    let dz = tileZ - prevZ;
    const segment = Math.hypot(dx, dz);
    if (segment > 1e-5) {
      dx /= segment;
      dz /= segment;
      const yaw = Math.atan2(dx, dz);
      while (carried < segment && used < pool.chevrons.length) {
        place(pool.chevrons[used], prevX + dx * carried, prevZ + dz * carried, yaw);
        used += 1;
        carried += TUTORIAL_PATH_SPACING;
      }
      carried -= segment;
    }
    prevX = tileX;
    prevZ = tileZ;
  }
  hideFrom(pool, used);
}

function place(mesh: Mesh, x: number, z: number, yaw: number): void {
  mesh.position.set(x, TUTORIAL_PATH_Y_OFFSET, z);
  mesh.rotation.y = yaw;
  mesh.visible = true;
}

function hideFrom(pool: PathPool, used: number): void {
  for (let index = used; index < pool.shown; index += 1) {
    pool.chevrons[index].visible = false;
  }
  pool.shown = used;
}

/** Park one side. Cheap enough to call unconditionally every frame. */
export function hideTutorialPath(style: PathStyle): void {
  hideFrom(pools[style], 0);
}

/** Park both sides. */
export function hideAllTutorialPaths(): void {
  hideTutorialPath("friendly");
  hideTutorialPath("hostile");
}

/** Scenario reset: park and rewind the flow. */
export function clearTutorialPath(): void {
  hideAllTutorialPaths();
  flow = 0;
}

/** Genuine teardown only. */
export function disposeTutorialPath(): void {
  detachTutorialVisualPool(visualPool);
  for (const style of ["friendly", "hostile"] as PathStyle[]) {
    const pool = pools[style];
    for (const mesh of pool.chevrons) mesh.removeFromParent();
    pool.material?.dispose();
    pool.chevrons.length = 0;
    pool.material = null;
    pool.shown = 0;
  }
  pathGeometry?.dispose();
  pathGeometry = null;
  visualPool.anchor = null;
  visualPool.builtFor = null;
  flow = 0;
}
