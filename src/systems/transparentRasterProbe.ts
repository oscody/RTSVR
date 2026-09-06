import { Mesh, MeshBasicMaterial, PlaneGeometry, type Object3D, type World } from "@iwsdk/core";
import { TRANSPARENT_PASS_TRACE_ENABLED } from "./traceFlags.js";
import { tracked } from "./resourceLifetime.js";

/**
 * Does the transparent pass actually RASTERISE on a blink frame?
 *
 * ## The gap this closes
 *
 * The investigation has proved two things and left a hole between them:
 *
 * | level | instrument | verdict |
 * | --- | --- | --- |
 * | the draw is issued by JS | `transparentPassProbe.ts` | **fine** — `calls === listSum * views`, 60k frames, both multiview arms |
 * | the fragments are rasterised | *nothing* | **unknown** |
 * | the pixels reach the display | the recordings | **broken** — overlays vanish for a frame |
 *
 * `renderer.info.render.calls` counts draws *submitted*, so the first row can
 * never speak for the second. This probe fills the middle row, and it is the
 * measurement that decides where the bug actually lives:
 *
 * - **No samples on a blink frame** → the GPU never rasterised the transparent
 *   draws. The defect is in multiview rasterisation, and it is a driver bug with
 *   a precise description worth reporting upstream.
 * - **Samples pass on a blink frame** → the pass rendered and was lost after,
 *   in the multiview texture-array resolve or the compositor. Different bug,
 *   different owner, and the app-side mitigation (moving overlays to the opaque
 *   pass) is the only lever either way.
 *
 * ## How
 *
 * A WebGL2 occlusion query wrapped around one transparent draw. `ANY_SAMPLES_PASSED`
 * answers exactly "did any fragment of this object survive rasterisation", which
 * is the question, and Three.js uses no occlusion queries of its own
 * (`grep ANY_SAMPLES_PASSED node_modules/three` → 0), so the target is free.
 *
 * The subject is a dedicated quad rather than a real overlay, because the answer
 * is only meaningful if the object is *guaranteed* to produce samples when
 * things are working. It is parented to the camera, `depthTest: false`,
 * `frustumCulled = false` and sits 30 cm ahead on the view axis, so it is always
 * on screen, never occluded and never culled. `opacity: 0.02` makes it invisible
 * to the player while still rasterising — the GPU has no idea the pixels are not
 * worth drawing.
 *
 * `transparent: true` is the whole point: it puts the quad in the pass under
 * test. If the pass survives, so does the quad.
 *
 * ## Cost
 *
 * Queries are asynchronous by construction — begin, end, and read the result
 * some frames later — so nothing here stalls the pipeline the way a
 * `readPixels` probe would, and stalling is disqualifying when the bug is
 * suspected of being timing-related in the first place. One extra draw of a
 * 3 mm quad, and a pool of eight queries polled once per frame.
 */

/** Metres. Small enough to be invisible, large enough to cover a pixel. */
const PROBE_SIZE = 0.003;

/** Metres along -Z from the camera. Well inside the near plane. */
const PROBE_DISTANCE = 0.3;

/** Outstanding queries. Results land a frame or two after the draw. */
const QUERY_POOL = 8;

/** Minimum seconds between reports, so a bad stretch cannot flood the log. */
const REPORT_COOLDOWN_SECONDS = 2;

interface GL2 extends WebGL2RenderingContext {}

interface Slot {
  query: WebGLQuery;
  frame: number;
  pending: boolean;
}

let installed = false;
let gl: GL2 | null = null;
let probe: Mesh | null = null;
let slots: Slot[] = [];
let writeIndex = 0;
let queryActive = false;
let drawsThisFrame = 0;
let frame = 0;
let rasterised = 0;
let missed = 0;
let lastReportSeconds = -Infinity;

/**
 * Call once from `index.ts` after `World.create()`. Installs nothing and
 * allocates nothing when the flag is off, or on a context without WebGL2
 * queries.
 */
export function installTransparentRasterProbe(world: World): void {
  if (!TRANSPARENT_PASS_TRACE_ENABLED || installed) return;
  const targets = world as unknown as {
    renderer?: { getContext?: () => unknown };
    camera?: Object3D;
  };
  const context = targets.renderer?.getContext?.();
  const camera = targets.camera;
  // `createQuery` is WebGL2-only, and its absence is a reason to do nothing at
  // all rather than to half-install.
  if (!context || !camera || typeof (context as GL2).createQuery !== "function") {
    return;
  }
  gl = context as GL2;

  // Session-scoped and singular: one geometry and one material for the life of
  // the page, created only when the flag is on. Registered like every other GPU
  // resource in the project so the allocation census stays complete — a
  // diagnostic that quietly leaks into the counters corrupts the very readings
  // the rest of the instrument exists to produce.
  const mesh = new Mesh(
    tracked(
      new PlaneGeometry(PROBE_SIZE, PROBE_SIZE),
      "geometry",
      "session",
      "transparent-raster-probe",
    ),
    tracked(new MeshBasicMaterial({
      color: 0xffffff,
      // The property under test. Anything else here is incidental.
      transparent: true,
      opacity: 0.02,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    }), "material", "session", "transparent-raster-probe"),
  );
  mesh.name = "TransparentRasterProbe";
  mesh.position.set(0, 0, -PROBE_DISTANCE);
  mesh.frustumCulled = false;
  // Last in the transparent pass, so a partial loss of the pass is more likely
  // to include it than to stop just short of it.
  mesh.renderOrder = 9999;
  mesh.raycast = () => {};

  slots = [];
  for (let i = 0; i < QUERY_POOL; i += 1) {
    const query = gl.createQuery();
    if (!query) break;
    slots.push({ query, frame: 0, pending: false });
  }
  if (slots.length === 0) {
    gl = null;
    return;
  }

  mesh.onBeforeRender = () => {
    drawsThisFrame += 1;
    // One query per frame: `beginQuery` on an already-active target is an
    // error, and with two eye viewports this callback fires once per view.
    if (drawsThisFrame > 1 || queryActive || !gl) return;
    const slot = slots[writeIndex];
    if (slot.pending) return; // pool exhausted; skip this frame rather than stall
    gl.beginQuery(gl.ANY_SAMPLES_PASSED, slot.query);
    queryActive = true;
  };
  mesh.onAfterRender = () => {
    if (!queryActive || !gl) return;
    gl.endQuery(gl.ANY_SAMPLES_PASSED);
    queryActive = false;
    const slot = slots[writeIndex];
    slot.frame = frame;
    slot.pending = true;
    writeIndex = (writeIndex + 1) % slots.length;
  };

  camera.add(mesh);
  probe = mesh;
  installed = true;
  console.log(
    `[RasterWitness] installed | probe ${mesh.name} transparent depthTest:false | ` +
      `queries ${slots.length}`,
  );
}

/**
 * Drain finished queries. Called once per frame from the transparent-pass
 * witness's own `scene.onAfterRender` hook, so the two instruments agree on
 * what a frame is and report the same frame numbers.
 */
export function pollTransparentRasterProbe(frameNumber: number): void {
  if (!installed || !gl) return;
  frame = frameNumber;
  drawsThisFrame = 0;
  for (const slot of slots) {
    if (!slot.pending) continue;
    if (!gl.getQueryParameter(slot.query, gl.QUERY_RESULT_AVAILABLE)) continue;
    const anySamples = gl.getQueryParameter(slot.query, gl.QUERY_RESULT) as boolean;
    slot.pending = false;
    if (anySamples) {
      rasterised += 1;
      continue;
    }
    missed += 1;
    // A `depthTest: false` quad locked to the camera cannot fail to produce
    // samples for any reason this app controls. Zero here means the GPU did not
    // rasterise a draw that JavaScript definitely issued.
    const seconds = performance.now() / 1000;
    if (seconds - lastReportSeconds < REPORT_COOLDOWN_SECONDS) continue;
    lastReportSeconds = seconds;
    console.log(
      `[RasterWitness] NO-SAMPLES frame ${slot.frame} t+${seconds.toFixed(3)}s | ` +
        `the transparent draw was issued but did not rasterise | ` +
        `rasterised ${rasterised} missed ${missed}`,
    );
  }
}

/**
 * Reported on every `[Profile]` line, for the same reason the pass witness
 * reports its sample count: a probe that has stopped looking and a probe that
 * has found nothing produce identical silence. `rasterised` must climb.
 */
export function getTransparentRasterSummary(): string {
  if (!installed) return "";
  return `RasterWitness rasterised ${rasterised} missed ${missed} probe ${probe ? "on" : "off"}`;
}
