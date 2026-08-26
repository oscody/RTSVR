import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { InitialLoadTracker } from "../src/app/initialLoad.ts";

const read = (path: string): string =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the overlay is authored in HTML, not built from TypeScript", () => {
  const html = read("index.html");
  // The whole point: it must paint before the bundle is parsed. RTSVR preloads
  // 31 critical GLBs and mesh-merges them before a system registers; a
  // TS-created overlay would not exist yet.
  assert.match(html, /id="loading-screen"/);
  assert.match(html, /id="loading-bar-fill"/);
  assert.match(html, /id="loading-title"/);
  const driver = read("src/app/loadingScreen.ts");
  assert.doesNotMatch(driver, /createElement/);
});

test("setupLoadingScreen runs before World.create, not inside its then", () => {
  const index = read("src/index.ts");
  assert.ok(
    index.indexOf("setupLoadingScreen()") < index.indexOf("World.create("),
    "the driver must be attached before the preload it exists to cover",
  );
});

test("the task completes on every path, including failure", () => {
  const index = read("src/index.ts");
  // "The landing page must never wait on a failed download." One 404 must not
  // leave an opaque overlay covering the app forever.
  assert.match(index, /\.finally\(\(\) => \{[\s\S]*initialLoad\.complete\("world"\)/);
  assert.match(index, /\.catch\(/);
  assert.match(index, /showLoadingFailure\(/);
});

test("the indeterminate indicator animates transform only", () => {
  const html = read("index.html");
  const rule = /#loading-bar-fill\.indeterminate \{[^}]*\}/.exec(html)?.[0] ?? "";
  assert.ok(rule, "no indeterminate rule found");
  // A bar animating width or left needs the main thread — the exact thread
  // blocked by asset decode and the first GL upload. It would freeze precisely
  // when it matters.
  assert.match(rule, /animation: loading-sweep/);
  const keyframes = /@keyframes loading-sweep \{[\s\S]*?\n      \}/.exec(html)?.[0] ?? "";
  assert.match(keyframes, /transform: translateX/);
  assert.doesNotMatch(keyframes, /width:/);
  assert.doesNotMatch(keyframes, /left:/);
});

test("reduced motion stops every animation on the overlay", () => {
  const html = read("index.html");
  // Whitespace-tolerant: prettier owns the indentation of this file.
  const start = html.indexOf("@media (prefers-reduced-motion: reduce)");
  const block = start >= 0 ? html.slice(start, start + 400) : "";
  assert.ok(block, "no prefers-reduced-motion block");
  assert.match(block, /animation: none/);
  assert.match(block, /transition: none/);
});

test("the overlay leaves even in a hidden tab", () => {
  const driver = read("src/app/loadingScreen.ts");
  // Transitions do not run in hidden tabs, so transitionend alone strands a
  // player who tabbed away during load.
  assert.match(driver, /transitionend/);
  assert.match(driver, /setTimeout\(\(\) => dismiss\(screen\), 1000\)/);
  // And it waits for a real frame before fading, because World.create resolving
  // is not the same as anything having been drawn.
  assert.match(driver, /requestAnimationFrame\(/);
});

test("a failed boot keeps the overlay up and explains itself", () => {
  const driver = read("src/app/loadingScreen.ts");
  assert.match(driver, /export function showLoadingFailure/);
  // whenDone still fires after the finally, so the fade must be suppressed or
  // the explanation would be wiped off a black scene.
  assert.match(driver, /if \(failed\) return;/);
});

test("progress is monotonic and clamped", () => {
  const tracker = new InitialLoadTracker([
    { id: "a", weight: 1 },
    { id: "b", weight: 3 },
  ]);
  assert.equal(tracker.progress, 0);
  tracker.setProgress("a", 0.5);
  assert.equal(tracker.progress, 0.125); // 1*0.5 of weight 4

  // Backwards is refused: a bar that retreats reads as a bug even on a healthy
  // load.
  tracker.setProgress("a", 0.2);
  assert.equal(tracker.progress, 0.125);

  // Over 1 is clamped.
  tracker.setProgress("b", 5);
  assert.equal(tracker.done, false, "a is still at 0.5");
  tracker.complete("a");
  assert.equal(tracker.progress, 1);
  assert.equal(tracker.done, true);

  // Unknown ids are ignored rather than throwing.
  tracker.setProgress("nope", 1);
  assert.equal(tracker.progress, 1);
});

test("whenDone resolves exactly once, when every task completes", async () => {
  const tracker = new InitialLoadTracker([
    { id: "a", weight: 1 },
    { id: "b", weight: 1 },
  ]);
  let resolved = false;
  void tracker.whenDone.then(() => {
    resolved = true;
  });
  tracker.complete("a");
  await Promise.resolve();
  assert.equal(resolved, false, "must not resolve on a partial load");
  tracker.complete("b");
  await tracker.whenDone;
  assert.equal(resolved, true);
});

test("every reported task is a real signal, never a timer", () => {
  const source = read("src/app/initialLoad.ts");
  // D5: never fake percentages. All four tasks report from something that
  // actually knows how much work is left.
  for (const id of ["assets", "mesh-merge", "world", "scenario"]) {
    assert.match(source, new RegExp(`id: "${id}"`));
  }
  // Match a CALL, not the word: the docblock names setInterval to explain why
  // it is not used, and an over-eager regex flags its own rationale.
  assert.doesNotMatch(source, /setInterval\(/);
  // The donor's raw-fetch helper was deliberately not ported — RTSVR has no
  // large binary fetch to hook. Assert it is not DEFINED here; the docblock
  // mentions it by name to explain the omission.
  assert.doesNotMatch(source, /function fetchArrayBufferWithProgress/);
});

// ── Phase 2: real progress ────────────────────────────────────────────────

test("the AssetManager probe found a real signal, and uses it", () => {
  const source = read("src/app/initialLoad.ts");
  const index = read("src/index.ts");
  // preloadAssets takes no callback, but AssetManager.loadingManager is a
  // three.js LoadingManager declared in the shipped .d.ts, and onProgress fires
  // per item. Nothing in IWSDK assigns it, so taking it clobbers nothing.
  assert.match(source, /export function attachAssetLoadProgress/);
  assert.match(source, /onProgress/);
  assert.match(index, /attachAssetLoadProgress\(\(\) => AssetManager\.loadingManager\)/);
  // Attached before World.create, since the manager appears inside it.
  assert.ok(
    index.indexOf("attachAssetLoadProgress") < index.indexOf("World.create("),
  );
});

test("mesh-merge reports per key, and a missing key still advances", () => {
  const merge = read("src/systems/meshMerge.ts");
  assert.match(merge, /onProgress\?: \(done: number, total: number\) => void/);
  // The increment must precede the `continue`, or one absent asset silently
  // stalls the bar short of 100%.
  const body = /export function optimizeLoadedAssets[\s\S]*?if \(!gltf\?\.scene\) continue;/.exec(merge)?.[0] ?? "";
  assert.ok(body.indexOf("onProgress?.(") < body.indexOf("if (!gltf?.scene) continue;"));
});

test("the scenario reports completion in a finally", () => {
  const structures = read("src/systems/structures.ts");
  // D4's "presentable". A scenario that throws must still release the overlay.
  assert.match(
    structures,
    /\} finally \{[\s\S]{0,400}initialLoad\.complete\("scenario"\)/,
  );
});

test("every task is completed on the boot failure path", () => {
  const index = read("src/index.ts");
  const tail = index.slice(index.indexOf(".finally("));
  for (const id of ["assets", "mesh-merge", "world", "scenario"]) {
    assert.match(
      tail,
      new RegExp(`initialLoad\\.complete\\("${id}"\\)`),
      `${id} must complete even when boot throws, or the overlay never leaves`,
    );
  }
});

test("weights put the bar where the time actually goes", () => {
  const source = read("src/app/initialLoad.ts");
  // 31 critical GLBs dominate; the merge pass is slow but shorter; world and
  // scenario are nominal. A flat weighting would make the bar crawl then leap.
  const weight = (id: string): number =>
    Number(new RegExp(`id: "${id}", weight: (\\d+)`).exec(source)?.[1]);
  assert.ok(weight("assets") > weight("mesh-merge"));
  assert.ok(weight("mesh-merge") > weight("world"));
  assert.equal(weight("world"), weight("scenario"));
});
