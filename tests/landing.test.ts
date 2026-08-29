import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string): string =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/**
 * Source with comments stripped.
 *
 * Use this for "must NOT contain X" assertions. Three times now a
 * `doesNotMatch` has flagged a docblock that names the thing precisely to
 * explain why it is not used — the rationale tripping the rule it documents.
 * Assert against code, not vocabulary.
 */
const code = (path: string): string =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

test("the landing markup is authored in HTML, hidden by default", () => {
  const html = read("index.html");
  assert.match(html, /id="landing"/);
  assert.match(html, /id="enter-vr-button"[^>]*hidden/);
  assert.match(html, /id="explore-button"/);
  assert.match(html, /id="xr-note"[^>]*hidden/);
  // D7: the slot stays, the badge does not ship yet.
  assert.match(html, /id="landing-footer"/);
  assert.doesNotMatch(html, /id="landing-version"/);
  // #landing is display:none until .visible is applied.
  const rule = /#landing \{[^}]*\}/.exec(html)?.[0] ?? "";
  assert.match(rule, /display: none/);
});

test("the landing sits below the loading overlay", () => {
  const html = read("index.html");
  const z = (sel: string): number =>
    Number(new RegExp(`${sel} \\{[^}]*z-index: (\\d+)`).exec(html)?.[1]);
  // Otherwise the buttons show through the splash during load.
  assert.ok(z("#landing") < z("#loading-screen"));
});

test("desktop always gets a way to start", () => {
  const html = read("index.html");
  const landing = read("src/app/landing.ts");
  // RTSVR plays flat. A VR-only landing page turns a working flat build into an
  // apparent dead end, and a machine with no headset could not begin at all.
  assert.doesNotMatch(html, /id="explore-button"[^>]*hidden/);
  assert.match(landing, /exploreButton\?\.addEventListener\("click"/);
  assert.match(landing, /startMatch\("landing-explore"\)/);
});

test("capability detection does not use world.xrEnabled", () => {
  const landing = read("src/app/landing.ts");
  // `world.xrEnabled` is what the connect-island donor uses, but IWSDK 0.4.2
  // does not declare it — only the internal renderer.xr.enabled. Using it would
  // be undefined at runtime and silently hide the VR button forever.
  assert.doesNotMatch(code("src/app/landing.ts"), /world\.xrEnabled/);
  assert.match(landing, /isSessionSupported\("immersive-vr"\)/);
  // And it must decide on the rejection path too, or both buttons stay hidden.
  assert.match(landing, /\.finally\(/);
});

test("ENTER VR must NOT start the match itself", () => {
  const landing = code("src/app/landing.ts");
  const enter = /enterButton\?\.addEventListener[\s\S]*?\}\);/.exec(landing)?.[0] ?? "";
  assert.ok(enter, "ENTER VR handler not found");

  // The bug this encodes. `launchXR` is async, so calling `startMatch()` here
  // leaves the app `playing` AND non-immersive for the frames until the session
  // opens — the exact signature of a desktop start. TutorialSystem reads that
  // and retires the tutorial before the headset is in the session. Measured in
  // devlog/console-logs/2026-08-26-Landging-page.log: XR opened at t+10.8s and
  // wave 0 went active at t+11.8s with no tutorial.
  assert.doesNotMatch(
    enter,
    /startMatch\(\)/,
    "the gate is released by attachMatchStart on the visibility change, so that "
      + "every entry route starts the match at the same moment",
  );
  assert.match(enter, /launchXR\(world\)/);
});

test("the desktop button is what releases the gate on the flat path", () => {
  const landing = code("src/app/landing.ts");
  const explore = /exploreButton\?\.addEventListener[\s\S]*?\}\);/.exec(landing)?.[0] ?? "";
  // Labelled, so the action timeline records which of the three entry routes
  // released the gate.
  assert.match(explore, /startMatch\("landing-explore"\)/);
});

test("every XR entry route starts the match at the same moment", () => {
  // The invariant behind the fix: one release point for anything immersive, so
  // the browser pill, this button and a headset-native entry cannot diverge.
  const start = code("src/systems/matchStart.ts");
  assert.match(start, /visibilityState\.subscribe/);
  // startMatch now takes a `via` label so the timeline records which of the
  // three entry routes released the gate.
  assert.match(start, /startMatch\("xr-session"\)/);
});

test("the chrome hides once the match begins", () => {
  const landing = read("src/app/landing.ts");
  // The condition the plan did not list. Without it the buttons sit over a
  // running game and START can be pressed on a match already in progress.
  assert.match(
    landing,
    /const show = loaded && !immersive && matchAwaitingStart\(\);/,
  );
});

test("setupLanding runs after the systems that create the wave source", () => {
  const index = read("src/index.ts");
  // matchAwaitingStart() reads the WaveSource singleton, which BoardSystem and
  // friends create during registration.
  assert.ok(index.indexOf("registerSystem(BoardSystem)") < index.indexOf("setupLanding(world)"));
});
