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
  assert.doesNotMatch(html, /id="explore-button"/);
  assert.match(html, /id="xr-note"[^>]*hidden/);
  // D7: the slot stays, the badge does not ship yet.
  assert.match(html, /id="landing-footer"/);
  assert.doesNotMatch(html, /id="landing-version"/);
  // #landing is display:none until .visible is applied.
  const rule = /#landing \{[^}]*\}/.exec(html)?.[0] ?? "";
  assert.match(rule, /display: none/);
});

test("the analytics tag ships, with the right property and non-blocking", () => {
  // Analytics fails silently in both directions: a dropped tag collects
  // nothing and says nothing, and a wrong measurement ID reports into someone
  // else's property. Neither surfaces until you go looking at a dashboard
  // weeks later, so it is pinned here.
  const html = read("index.html");
  assert.match(html, /googletagmanager\.com\/gtag\/js\?id=G-GS0ZJB7BBH/);
  assert.match(html, /gtag\('config', 'G-GS0ZJB7BBH'\)/);

  // One property only. Two config calls means double-counted sessions.
  const ids = html.match(/G-[A-Z0-9]+/g) ?? [];
  assert.equal(new Set(ids).size, 1, `more than one measurement ID: ${ids}`);

  // `async`, or the loader blocks first paint on a third-party host — this is
  // a game whose first impression is a loading screen.
  const loader = /<script[^>]*googletagmanager[^>]*>/.exec(html)?.[0] ?? "";
  assert.match(loader, /\basync\b/);

  // In <head>, before the app module, so a session is recorded even if the
  // player closes the tab during the asset preload.
  assert.ok(
    html.indexOf("googletagmanager") < html.indexOf("src=\"/src/index.ts\""),
    "the tag must load ahead of the app entry point",
  );
});

test("analytics stays silent while testing", () => {
  // HTML comments survive `code()`, and the rationale beside the guard names
  // every host the guard excludes. Strip them here, or an assertion about the
  // code ends up reading the prose that explains it.
  const html = read("index.html").replace(/<!--[\s\S]*?-->/g, "");

  // gtag's own opt-out flag rather than a conditionally-injected tag: the
  // markup exercised on a dev build is the markup that ships, minus the
  // beacon. A tag that only exists in production can only be verified there.
  assert.match(html, /window\["ga-disable-G-GS0ZJB7BBH"\] = !enabled;/);

  // `config` sends a page_view the moment it runs, and the flag is read at
  // send time - so the guard has to be set before the loader, not merely
  // before the first custom event.
  assert.ok(
    html.indexOf("ga-disable") < html.indexOf("googletagmanager"),
    "the guard must run before the tag loads, or the first page_view escapes",
  );

  // Two conditions, because each one alone leaks in a case the other covers.
  //
  // `%MODE%` is substituted by Vite at transform time, so any dev server reads
  // "development" regardless of the URL that reached it. That is the only half
  // that catches the headset, which loads the dev server over the LAN at an
  // address no localhost check would recognise. Verified in both directions:
  // `vite build` writes "production", the dev server serves "development".
  assert.match(html, /"%MODE%" === "production"/);

  // The host half catches the reverse: a production bundle - MODE already
  // "production" - served to this machine through `npm run preview`.
  // Substrings, not regexes: the thing being asserted about is itself a set of
  // regex literals, and matching a pattern against a pattern gets the
  // backslashes wrong in a way that still passes for the wrong reason.
  for (const host of [
    'host === "localhost"',
    'host === "::1"',
    'host === "0.0.0.0"',
    'host.endsWith(".local")',
    "/^127\\./.test(host)",
    "/^10\\./.test(host)",
    "/^192\\.168\\./.test(host)",
    "/^172\\.(1[6-9]|2[0-9]|3[01])\\./.test(host)",
  ]) {
    assert.ok(html.includes(host), `the guard no longer excludes ${host}`);
  }

  // An escape hatch both ways, or confirming the tag works means deploying to
  // find out, and browsing the live site means polluting it.
  assert.match(html, /asked === "on" \|\| asked === "off"/);
  assert.match(html, /override === "on"/);
});

test("the landing sits below the loading overlay", () => {
  const html = read("index.html");
  const z = (sel: string): number =>
    Number(new RegExp(`${sel} \\{[^}]*z-index: (\\d+)`).exec(html)?.[1]);
  // Otherwise the buttons show through the splash during load.
  assert.ok(z("#landing") < z("#loading-screen"));
});

test("the landing page is VR-only — there is no flat route in", () => {
  // This REVERSES what this file used to assert. The old test read "desktop
  // always gets a way to start", because RTSVR plays flat and a VR-only
  // landing page turns a working flat build into an apparent dead end. That
  // reasoning was sound and is now overridden on request (2026-09-05).
  //
  // The consequence is deliberate: a machine with no headset can load the page
  // and cannot begin. Pinned here so nobody restores the button by accident
  // while thinking they are fixing a bug — and so that anyone who wants it back
  // has to delete this test and read why it exists.
  const html = read("index.html");
  const landing = read("src/app/landing.ts");
  assert.doesNotMatch(html, /explore-button/, "markup, styles and all");
  assert.doesNotMatch(landing, /exploreButton/);
  assert.doesNotMatch(
    code("src/app/landing.ts"),
    /startMatch\(/,
    "no landing handler may release the gate; the visibility change does it",
  );
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

test("nothing anywhere still starts a match as landing-explore", () => {
  // The label survived in comments describing the frame-order bug it exposed,
  // which is fine — that history is still true. What must not survive is a
  // live call, in any file.
  for (const path of ["src/app/landing.ts", "src/systems/matchStart.ts"]) {
    assert.doesNotMatch(
      code(path),
      /startMatch\("landing-explore"\)/,
      `${path} still releases the gate on the removed flat route`,
    );
  }
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
