import type { Object3D, Scene, World } from "@iwsdk/core";
import {
  TRANSPARENT_PASS_COOLDOWN_SECONDS,
  TRANSPARENT_PASS_DUMP_CONTEXT,
  TRANSPARENT_PASS_PREFIX,
  TRANSPARENT_PASS_RING_FRAMES,
  TRANSPARENT_PASS_TRACE_ENABLED,
} from "./traceFlags.js";

/**
 * Witness for the one-frame overlay blink. See
 * `TRANSPARENT_PASS_TRACE_ENABLED` in `traceFlags.ts` for what it is for and
 * which four outcomes it distinguishes; this file is only the mechanism.
 *
 * ## Where it hooks, and why there
 *
 * Three.js calls `scene.onAfterRender( renderer, scene, camera )` as the last
 * thing in `WebGLRenderer.render()` (`three.module.js:17224`), after every draw
 * for the frame has been issued. That is the only moment where all three
 * questions have answers at once, so it is the only place this can sample.
 *
 * `renderer.renderLists` is a public property (`three.module.js:16016`), and
 * `renderLists.get( scene, 0 )` returns the very list the frame was drawn from —
 * `{ opaque, transmissive, transparent }`, each a plain array. Depth 0 is the
 * top-level render; nested renders push deeper, and this app performs none.
 *
 * The "did it draw" half uses `object.onAfterRender`, which the renderer fires
 * per drawn object (`three.module.js:17576`). One callback on one mesh is the
 * cheapest possible truth: it cannot fire unless the draw call was issued.
 *
 * ## Reading the counter in XR
 *
 * `render()` runs once per frame but `renderScene()` runs once per view, so on
 * a headset the per-object callback fires **twice** per frame (once per eye)
 * and once per frame on the desktop mirror. The witness therefore records the
 * raw count and asks only whether it is zero, never whether it equals one.
 */

interface ProbeRenderList {
  opaque: unknown[];
  transmissive: unknown[];
  transparent: Array<{ object?: Object3D }>;
}

interface ProbeRenderer {
  renderLists?: { get: (scene: unknown, depth: number) => ProbeRenderList };
  info?: { render?: { calls?: number } };
}

interface ProbeTargets {
  renderer?: ProbeRenderer;
  scene?: Scene;
}

/** The canary: always present, always visible, never frustum-culled. */
const CANARY_NAME = "CommandCenterHud";

/**
 * The opaque control, and the reason there are two witnesses.
 *
 * The whole claim is "the transparent pass went missing while the opaque pass
 * did not". A transparent canary alone cannot say that — if it is not drawn,
 * nothing distinguishes "the transparent pass was lost" from "the frame was not
 * drawn at all". The starfield answers the second half: it is opaque
 * (`PointsMaterial` with no `transparent`), `frustumCulled = false`, and
 * persistent, so it is drawn on every frame that renders anything.
 */
const CONTROL_NAME = "Starfield";

/**
 * Frames the expected per-frame draw count must hold before a shortfall counts
 * as an anomaly. At ~90 Hz this is a little over a second — long enough for XR
 * to settle on its view count, short enough to be armed almost immediately.
 */
const EXPECTED_DRAWS_WARMUP = 120;

let installed = false;
let targets: ProbeTargets | null = null;
let canary: Object3D | null = null;
let canaryDraws = 0;
let priorCanaryAfterRender: Object3D["onAfterRender"] | null = null;
let control: Object3D | null = null;
let controlDraws = 0;
let priorControlAfterRender: Object3D["onAfterRender"] | null = null;
/**
 * How many times the canary is drawn on a healthy frame.
 *
 * **Not assumed to be 1.** `render()` runs once per frame but `renderScene()`
 * runs once per view, so the per-object callback fires twice on a headset
 * rendering two eye viewports and once under `OVR_multiview2` or on the desktop
 * mirror. Testing `draws > 0` — which is what the first version did — would
 * therefore miss a transparent pass lost in ONE eye, which is exactly the shape
 * a single-eye screen recording shows. So the healthy count is learned, and any
 * shortfall against it is the anomaly.
 */
let expectedCanaryDraws = 0;
let framesAtExpected = 0;

/**
 * Draw calls a frame issues **beyond** its three render lists — the background,
 * and any shadow or transmission pass. Learned, never predicted.
 *
 * This is the whole-pass check, and it exists because the canary is a sample of
 * one: it proves `CommandCenterHud` was drawn, not that every transparent item
 * was, so a blink that spared the HUD and took the grid would pass unnoticed.
 * Draw calls cannot be spared that way — losing the transparent pass costs
 * `transparent.length` calls whatever it was that vanished.
 *
 * Predicting the absolute figure is hopeless (`defaultLighting: true` is the
 * SDK's, and what it enables is not this app's to know), but the *difference*
 * between calls and list length is stable when nothing is wrong. So the
 * difference is learned by repetition and a shortfall against it is the signal.
 */
let stableOverhead = -1;
let overheadCandidate = -1;
let overheadRun = 0;
let framesSinceOverheadSet = 0;
/** Consecutive frames a candidate overhead must hold before it is adopted. */
const OVERHEAD_ADOPT_RUN = 30;
let frame = 0;
let lastDumpSeconds = -Infinity;
let anomalies = 0;
/** Frame counter at the previous summary, so the line can report a rate. */
let lastSummaryFrame = 0;
let lastTransparent = 0;
let lastOpaque = 0;

// Preallocated ring. Parallel typed arrays rather than an array of objects,
// because this is written every frame and must never allocate.
const RING = TRANSPARENT_PASS_RING_FRAMES;
let ringFrame: Int32Array | null = null;
let ringTransparent: Int32Array | null = null;
let ringOpaque: Int32Array | null = null;
let ringCalls: Int32Array | null = null;
/** Bitfield: 1 = canary visible, 2 = canary in list. */
let ringFlags: Uint8Array | null = null;
let ringCanaryDraws: Uint8Array | null = null;
let ringControlDraws: Uint8Array | null = null;
let ringMs: Float64Array | null = null;
let ringWrite = 0;

const FLAG_VISIBLE = 1;
const FLAG_IN_LIST = 2;

/**
 * Visible for real — the object's own flag AND every ancestor's, which is the
 * distinction the older `[GridVisual]` probe had to walk for by hand. Cheap:
 * the canary sits three levels under the scene.
 */
function effectivelyVisible(object: Object3D): boolean {
  let node: Object3D | null = object;
  while (node) {
    if (!node.visible) return false;
    node = node.parent;
  }
  return true;
}

/**
 * Binds the canary the first frame it exists; the HUD is built after install,
 * and `ScenarioResetSystem` can rebuild it, so this re-binds on a new object.
 *
 * Returns true when it bound something THIS frame, which the caller must treat
 * as "no verdict". Binding happens inside `scene.onAfterRender`, i.e. after the
 * frame's draws have already been issued, so the draw counter cannot have been
 * incremented for a frame the wrapper was not installed for. Without this the
 * probe reports a guaranteed `IN-LIST-NOT-DRAWN` on its own bind frame — which
 * is exactly what the first on-device run produced at frame 2, and it was the
 * probe's own footprint rather than a blink.
 */
function bindCanary(scene: Scene): boolean {
  const found = scene.getObjectByName(CANARY_NAME) ?? null;
  if (!found || found === canary) return false;
  canary = found;
  // A rebound canary has a fresh draw history; the old expectation is stale.
  expectedCanaryDraws = 0;
  framesAtExpected = 0;
  priorCanaryAfterRender = found.onAfterRender;
  found.onAfterRender = function (this: Object3D, ...args) {
    canaryDraws += 1;
    priorCanaryAfterRender?.apply(this, args);
  } as Object3D["onAfterRender"];
  return true;
}

/** Same contract as {@link bindCanary}, for the opaque control. */
function bindControl(scene: Scene): boolean {
  const found = scene.getObjectByName(CONTROL_NAME) ?? null;
  if (!found || found === control) return false;
  control = found;
  priorControlAfterRender = found.onAfterRender;
  found.onAfterRender = function (this: Object3D, ...args) {
    controlDraws += 1;
    priorControlAfterRender?.apply(this, args);
  } as Object3D["onAfterRender"];
  return true;
}

function record(
  transparentLen: number,
  opaqueLen: number,
  calls: number,
  flags: number,
  draws: number,
  ctrlDraws: number,
  ms: number,
): void {
  if (!ringFrame) return;
  const i = ringWrite;
  ringFrame[i] = frame;
  ringTransparent![i] = transparentLen;
  ringOpaque![i] = opaqueLen;
  ringCalls![i] = calls;
  ringFlags![i] = flags;
  ringCanaryDraws![i] = Math.min(255, draws);
  ringControlDraws![i] = Math.min(255, ctrlDraws);
  ringMs![i] = ms;
  ringWrite = (i + 1) % RING;
}

/** Oldest-to-newest window ending at the most recent write. */
function dumpWindow(): void {
  if (!ringFrame) return;
  const span = Math.min(RING, TRANSPARENT_PASS_DUMP_CONTEXT * 2 + 1);
  for (let back = span - 1; back >= 0; back -= 1) {
    const i = (ringWrite - 1 - back + RING * 2) % RING;
    if (ringFrame[i] === 0 && ringCalls![i] === 0) continue;
    const f = ringFlags![i];
    console.log(
      `${TRANSPARENT_PASS_PREFIX}   frame ${ringFrame[i]} ` +
        `t+${(ringMs![i] / 1000).toFixed(3)}s ` +
        `transparent ${ringTransparent![i]} opaque ${ringOpaque![i]} ` +
        `calls ${ringCalls![i]} ` +
        `canary vis=${(f & FLAG_VISIBLE) !== 0 ? 1 : 0} ` +
        `list=${(f & FLAG_IN_LIST) !== 0 ? 1 : 0} ` +
        `draws=${ringCanaryDraws![i]}/${expectedCanaryDraws} ` +
        `opaqueDraws=${ringControlDraws![i]}`,
    );
  }
}

/**
 * Call once from `index.ts` after `World.create` resolves. Installs nothing and
 * allocates nothing when the flag is off.
 */
export function installTransparentPassProbe(world: World): void {
  if (!TRANSPARENT_PASS_TRACE_ENABLED || installed) return;
  const candidate = world as unknown as ProbeTargets;
  const scene = candidate.scene;
  const renderer = candidate.renderer;
  if (!scene || !renderer?.renderLists) return;

  targets = candidate;
  installed = true;
  ringFrame = new Int32Array(RING);
  ringTransparent = new Int32Array(RING);
  ringOpaque = new Int32Array(RING);
  ringCalls = new Int32Array(RING);
  ringFlags = new Uint8Array(RING);
  ringCanaryDraws = new Uint8Array(RING);
  ringControlDraws = new Uint8Array(RING);
  ringMs = new Float64Array(RING);

  const prior = scene.onAfterRender;
  scene.onAfterRender = function (this: Scene, ...args) {
    try {
      sample();
    } catch {
      // A diagnostic must never be able to break the render loop.
    }
    prior?.apply(this, args);
  } as Scene["onAfterRender"];

  console.log(
    `${TRANSPARENT_PASS_PREFIX} installed | canary ${CANARY_NAME} | ` +
      `control ${CONTROL_NAME} | ring ${RING} frames`,
  );
}

function sample(): void {
  const scene = targets?.scene;
  const renderer = targets?.renderer;
  if (!scene || !renderer?.renderLists) return;

  frame += 1;
  const justBound = !canary || !canary.parent ? bindCanary(scene) : false;
  if (!control || !control.parent) bindControl(scene);

  const list = renderer.renderLists.get(scene, 0);
  const transparentLen = list.transparent.length;
  const opaqueLen = list.opaque.length;
  const calls = renderer.info?.render?.calls ?? 0;
  const listSum = opaqueLen + list.transmissive.length + transparentLen;
  lastTransparent = transparentLen;
  lastOpaque = opaqueLen;

  // Learn the overhead by repetition. A value only becomes the reference after
  // holding for OVERHEAD_ADOPT_RUN consecutive frames, so the frame a blink
  // lands on cannot itself redefine "normal" and hide the next one.
  const overhead = calls - listSum;
  if (overhead === stableOverhead) {
    framesSinceOverheadSet += 1;
    overheadCandidate = -1;
    overheadRun = 0;
  } else if (overhead === overheadCandidate) {
    overheadRun += 1;
    if (overheadRun >= OVERHEAD_ADOPT_RUN) {
      stableOverhead = overheadCandidate;
      framesSinceOverheadSet = 0;
      overheadCandidate = -1;
      overheadRun = 0;
    }
  } else {
    overheadCandidate = overhead;
    overheadRun = 1;
  }

  let flags = 0;
  if (canary) {
    if (effectivelyVisible(canary)) flags |= FLAG_VISIBLE;
    // Linear scan of tens of entries. No allocation, no sort, no Set.
    for (let i = 0; i < transparentLen; i += 1) {
      if (list.transparent[i]?.object === canary) {
        flags |= FLAG_IN_LIST;
        break;
      }
    }
  }
  const draws = canaryDraws;
  const ctrlDraws = controlDraws;
  canaryDraws = 0;
  controlDraws = 0;

  const now = performance.now();
  record(transparentLen, opaqueLen, calls, flags, draws, ctrlDraws, now);

  // Learn the healthy draw count rather than assuming it. It only ratchets up,
  // and only a run of frames holding it arms the comparison — a shortfall is
  // meaningless until there is a settled figure to fall short of.
  const eligible =
    canary !== null && !justBound && (flags & FLAG_VISIBLE) !== 0 &&
    (flags & FLAG_IN_LIST) !== 0;
  if (eligible && draws > expectedCanaryDraws) {
    expectedCanaryDraws = draws;
    framesAtExpected = 0;
  } else if (eligible && draws === expectedCanaryDraws) {
    framesAtExpected += 1;
  }

  // The whole-pass check, independent of the canary. Tolerance is half the
  // transparent list (min 4): a lost pass costs all of it, while a couple of
  // calls either way is ordinary jitter — a material turned invisible inside a
  // list, or the background toggling.
  const callsArmed =
    stableOverhead >= 0 && framesSinceOverheadSet >= EXPECTED_DRAWS_WARMUP;
  const deficit = listSum + stableOverhead - calls;
  const callsShort =
    callsArmed && transparentLen > 0 &&
    deficit >= Math.max(4, transparentLen >> 1);

  // A canary that SHOULD have been drawn and was not is interesting; a hidden
  // canary is the game's business and the older probe's beat, and the bind
  // frame has no draw counter to read. `callsShort` needs none of that, so it
  // reports on its own regardless.
  const canaryUsable =
    canary !== null && !justBound && (flags & FLAG_VISIBLE) !== 0;
  const armed = framesAtExpected >= EXPECTED_DRAWS_WARMUP;
  const canaryFailed =
    canaryUsable &&
    ((flags & FLAG_IN_LIST) === 0 || (armed && draws < expectedCanaryDraws));
  if (!canaryFailed && !callsShort) return;

  anomalies += 1;
  const seconds = now / 1000;
  if (seconds - lastDumpSeconds < TRANSPARENT_PASS_COOLDOWN_SECONDS) return;
  lastDumpSeconds = seconds;

  // The control is what turns "not drawn" into "the TRANSPARENT pass was lost".
  // A frame where neither was drawn is a frame that did not render at all, and
  // that is a different bug with a different fix.
  const verdict = !canaryFailed
    ? "PASS-CALLS-SHORT (the canary drew, but the frame is missing draw calls)"
    : (flags & FLAG_IN_LIST) === 0
      ? "NOT-IN-LIST (projectObject dropped it: material or frustum state)"
      : draws === 0 && ctrlDraws === 0
        ? "NOTHING-DREW (the whole frame rendered nothing — not a pass problem)"
        : draws === 0
          ? "IN-LIST-NOT-DRAWN (the transparent pass did not execute)"
          : "PARTIAL-DRAW (the transparent pass was lost in some views, not all)";
  console.log(
    `${TRANSPARENT_PASS_PREFIX} ANOMALY #${anomalies} frame ${frame} ` +
      `t+${seconds.toFixed(3)}s | ${verdict} | ` +
      `transparent ${transparentLen} opaque ${opaqueLen} calls ${calls} ` +
      `expected ${listSum + stableOverhead} deficit ${deficit} | ` +
      `canaryDraws ${draws}/${expectedCanaryDraws} opaqueDraws ${ctrlDraws}`,
  );
  dumpWindow();
}

/**
 * The counter-evidence line, printed on every `[Profile]` sample.
 *
 * **This exists because a silent probe and a clean probe look identical.** The
 * first on-device run logged one anomaly at frame 2 and then nothing for the
 * remaining 58,842 frames, and nothing in the output could distinguish "sampled
 * every frame, found nothing" from "the hook stopped firing at frame 3". Since
 * the whole value of this instrument is being able to say "the renderer drew
 * every overlay it was asked to", a claim it cannot support without proof that
 * it was still looking, the sample rate is part of the evidence.
 *
 * `sampled` is frames since the previous summary — roughly the profiler's
 * interval times the frame rate, and **zero means the hook is dead**, not that
 * the frame was clean. `anomalies` counts every anomaly, including the ones the
 * dump cooldown suppressed.
 */
export function getTransparentPassSummary(): string {
  if (!TRANSPARENT_PASS_TRACE_ENABLED || !installed) return "";
  const sampled = frame - lastSummaryFrame;
  lastSummaryFrame = frame;
  const bound = canary ? (control ? "yes" : "no-control") : "NO";
  const armed = framesAtExpected >= EXPECTED_DRAWS_WARMUP ? "armed" : "warming";
  const callsArmed =
    stableOverhead >= 0 && framesSinceOverheadSet >= EXPECTED_DRAWS_WARMUP
      ? `armed +${stableOverhead}`
      : "warming";
  return (
    `PassWitness sampled ${sampled} frames ${frame} anomalies ${anomalies} ` +
    `canary ${bound} ${armed} draws/frame ${expectedCanaryDraws} | ` +
    `calls ${callsArmed} | ` +
    `last transparent ${lastTransparent} opaque ${lastOpaque}`
  );
}
