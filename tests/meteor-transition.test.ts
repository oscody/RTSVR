import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  departPose,
  easeInCubic,
  easeOutCubic,
  materializePose,
  transitionProgress,
} from "../src/systems/transitionRules.ts";

const ROOT = new URL("../", import.meta.url);
const source = (path: string): string => readFileSync(new URL(path, ROOT), "utf8");

// ── Progress maths ─────────────────────────────────────────────────────────

test("progress runs 0 to 1 as the countdown drains", () => {
  assert.equal(transitionProgress(1, 1), 0, "nothing elapsed yet");
  assert.equal(transitionProgress(0.5, 1), 0.5);
  assert.equal(transitionProgress(0, 1), 1, "exactly finished");
});

test("a frame long enough to overshoot cannot push progress past 1", () => {
  // A hitch — and this codebase has measured 300 ms ones — drives the timer
  // negative. Unclamped that scales a rock past its real size on the last
  // frame of its entrance, which is a visible pop at the exact moment the
  // transition exists to remove.
  assert.equal(transitionProgress(-5, 0.32), 1);
  assert.equal(transitionProgress(-0.001, 0.32), 1);
});

test("progress never goes negative if the timer is somehow above the duration", () => {
  assert.equal(transitionProgress(2, 1), 0);
});

test("a zero or negative duration reads as already finished", () => {
  // Division by zero would give NaN, and NaN propagates into a transform where
  // it silently removes the object from the scene rather than erroring.
  assert.equal(transitionProgress(0, 0), 1);
  assert.equal(transitionProgress(1, 0), 1);
  assert.equal(transitionProgress(1, -1), 1);
});

// ── Easing shape ───────────────────────────────────────────────────────────

test("both easings are pinned at their endpoints", () => {
  for (const ease of [easeOutCubic, easeInCubic]) {
    assert.equal(ease(0), 0);
    assert.equal(ease(1), 1);
    // Out-of-range input is clamped rather than extrapolated.
    assert.equal(ease(-1), 0);
    assert.equal(ease(2), 1);
  }
});

test("arrivals decelerate and departures accelerate — opposite shapes", () => {
  // This is what makes the two read as different events rather than one
  // animation played backwards.
  assert.ok(easeOutCubic(0.5) > 0.5, "an arrival is more than half done at halfway");
  assert.ok(easeInCubic(0.5) < 0.5, "a departure is less than half done at halfway");
});

test("both easings are monotonic — a rock never reverses mid-transition", () => {
  for (const ease of [easeOutCubic, easeInCubic]) {
    let previous = -1;
    for (let i = 0; i <= 20; i += 1) {
      const value = ease(i / 20);
      assert.ok(value >= previous, `${ease.name} went backwards at t=${i / 20}`);
      previous = value;
    }
  }
});

// ── Poses ──────────────────────────────────────────────────────────────────

test("a materialising rock starts small and low, ending at full size in place", () => {
  const start = materializePose(0, 0.05, 4.5, 0.216);
  assert.equal(start.scale, 0.05);
  assert.ok(Math.abs(start.y - (4.5 - 0.216)) < 1e-9, "starts below the hover height");

  const end = materializePose(1, 0.05, 4.5, 0.216);
  assert.equal(end.scale, 1, "ends at exactly full size");
  assert.equal(end.y, 4.5, "and exactly at the hover height");
});

test("a departing rock shrinks and sinks from wherever it is", () => {
  // `fromY` is sampled at departure, not assumed to be ground level — a match
  // ending mid-fall must not teleport the rock down before it leaves.
  const midAir = departPose(0, 3.2, 0.081);
  assert.equal(midAir.scale, 1);
  assert.equal(midAir.y, 3.2, "leaves from where it actually is");

  const gone = departPose(1, 3.2, 0.081);
  assert.ok(gone.scale > 0, "scale must never reach zero — a degenerate matrix");
  assert.ok(gone.scale < 0.02, "but it must be effectively invisible");
  assert.ok(Math.abs(gone.y - (3.2 - 0.081)) < 1e-9, "and it has sunk");
});

test("no pose can produce NaN, whatever it is handed", () => {
  // A NaN in a transform removes the object from the scene with no error at
  // all, which is the worst possible failure mode for a visual bug.
  for (const t of [-1, 0, 0.5, 1, 2]) {
    const m = materializePose(t, 0.05, 4.5, 0.2);
    const d = departPose(t, 3, 0.1);
    for (const v of [m.scale, m.y, d.scale, d.y]) {
      assert.ok(Number.isFinite(v), `non-finite value at t=${t}`);
    }
  }
});

// ── System wiring ──────────────────────────────────────────────────────────

const meteor = () => source("src/systems/meteorSystem.ts");

test("the shower has both transition phases", () => {
  const src = meteor();
  assert.match(src, /"materializing"/);
  assert.match(src, /"departing"/);
});

test("a batch enters through materializing, never at full size", () => {
  const src = meteor();
  const start = src.slice(src.indexOf("function startCycle"));
  const body = start.slice(0, start.indexOf("\n}"));
  assert.match(body, /materializePose\(/, "the entry pose must be computed, not assumed");
  assert.match(body, /phase = tiles\.length > 0 \? "materializing" : "idle"/);
  assert.ok(
    !/holder\.position\.set\(worldX, METEOR_FLOAT_HEIGHT, worldZ\)/.test(body),
    "entering at the full hover height is the pop this phase removes",
  );
});

test("resting hands off to a departure instead of cutting to invisible", () => {
  const src = meteor();
  const resting = src.slice(src.indexOf('case "resting":'));
  const body = resting.slice(0, resting.indexOf("break;"));
  assert.match(body, /beginDeparture\(\)/);
  assert.ok(
    !body.includes("holder.visible = false"),
    "the one-frame cut is what this phase replaces",
  );
});

test("a match ending departs gracefully; the tutorial still stops immediately", () => {
  // Two different exits for two different reasons. The tutorial one must stay
  // immediate — the shower is a competing motion cue aimed at nothing while
  // someone is being taught.
  const src = meteor();
  const tutorial = src.indexOf("if (waveNumber === TUTORIAL_WAVE_NUMBER)");
  const ended = src.indexOf('if (status !== "playing")');
  assert.ok(tutorial > 0 && ended > 0, "both exits must exist separately");

  const tutorialBlock = src.slice(tutorial, ended);
  assert.match(tutorialBlock, /clearMeteors\(\)/, "tutorial suppression stays immediate");

  const endedBlock = src.slice(ended, ended + 500);
  assert.match(endedBlock, /beginDeparture\(\)/, "a finished match departs gracefully");
  // …and keeps advancing, or the batch freezes half-shrunk behind the result panel.
  assert.match(endedBlock, /this\.updateDeparting\(/);
});

test("a hard clear restores the transform the transitions animate", () => {
  // Restart during a materialise or departure leaves the holder at a
  // fractional scale. Without this the next cycle's rock enters wrong-sized.
  const src = meteor();
  const clear = src.slice(src.indexOf("export function clearMeteors"));
  const body = clear.slice(0, clear.indexOf("\n}"));
  assert.match(body, /holder\.scale\.setScalar\(1\)/);
});

test("a completed departure parks the slot and restores its scale", () => {
  const src = meteor();
  const depart = src.slice(src.indexOf("private updateDeparting"));
  const body = depart.slice(0, depart.indexOf("\n  }"));
  assert.match(body, /slot\.used = false/);
  assert.match(body, /holder\.visible = false/);
  assert.match(body, /holder\.scale\.setScalar\(1\)/, "or the next cycle inherits a shrunk slot");
});

test("the transitions never touch a shared GLTF material", () => {
  // The meteor models come from AssetManager and their materials are shared
  // across every clone. Fading one fades them all, and mutating them recreates
  // the shader churn already fixed elsewhere.
  const src = meteor();
  for (const fn of ["private updateMaterializing", "private updateDeparting"]) {
    const start = src.indexOf(fn);
    assert.ok(start > 0, `${fn} not found`);
    const body = src.slice(start, src.indexOf("\n  }", start));
    assert.ok(!/\.material\b/.test(body), `${fn} must animate transform only`);
    assert.ok(!/opacity/.test(body), `${fn} must not fade a shared material`);
  }
});
