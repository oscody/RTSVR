import { BoxGeometry, type Object3D } from "@iwsdk/core";
import { trackResource } from "./resourceLifetime.js";

/**
 * Mark decoration as never hit-testable.
 *
 * Pointer raycasting runs for both hands every frame against every visible mesh
 * under a `RayInteractable`, and `Input` was measured on Quest 2026-08-09 as a
 * *sustained* ~3.5-4.5 ms — the only cost paid on every single frame. Most of
 * what is on screen is scenery nobody can click: health bars, range rings,
 * bolts, meteors, progress fills, board dressing.
 *
 * The examples treat this as a per-mesh decision made at creation
 * (`vr_examples/brushspace` opts out in 10 of its 11 mesh-creating systems);
 * RTSVR historically left everything hit-testable. Call this on anything
 * decorative. Rendering is unaffected — raycast is not draw.
 */
export function makeNonInteractive<T extends Object3D>(object: T): T {
  object.raycast = () => {};
  return object;
}

/**
 * One unit cube reused by every interaction proxy. Proxies differ only in
 * footprint and height, so they scale this instead of allocating a fresh
 * BoxGeometry per unit — one geometry for the whole game rather than one per
 * alien, craft, and building.
 */
export const UNIT_BOX_GEOMETRY = new BoxGeometry(1, 1, 1);
// The single cube behind every interaction proxy in the game. Exactly 1 for
// the whole session — a count above that means something stopped sharing it,
// which is a draw-call regression as much as a memory one.
trackResource(UNIT_BOX_GEOMETRY, {
  kind: "geometry",
  scope: "session",
  label: "unit-box-proxy",
});
