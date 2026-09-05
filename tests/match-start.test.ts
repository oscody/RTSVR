import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { advanceWaveClock } from "../src/systems/waveRules.ts";
import { matchStatusId } from "../src/systems/traceIds.ts";

const source = (path: string): string =>
  readFileSync(new URL(`../src/systems/${path}`, import.meta.url), "utf8");

test("the match boots held, not playing", () => {
  // The defect this closes: an unattended tab was found at
  // `status: "defeat", commandCenterAlive: false` with nobody in the headset.
  assert.match(
    source("state.ts"),
    /status: \{ type: Types\.String, default: "awaiting-start" \}/,
  );
});

test("awaiting-start HOLDS the wave clock instead of zeroing it", () => {
  // Every other non-playing status clears the clock. awaiting-start must not:
  // a player who waited on the landing page still gets the full wave-1 grace
  // period rather than an immediate spawn.
  const held = { stage: "countdown" as const, timer: 30 };
  assert.equal(advanceWaveClock(held, 5, "awaiting-start"), false);
  assert.equal(held.timer, 30, "timer must not tick while held");
  assert.equal(held.stage, "countdown", "stage must not be stopped while held");

  // Contrast: a terminal status still clears it.
  const over = { stage: "countdown" as const, timer: 30 };
  advanceWaveClock(over, 5, "defeat");
  assert.equal(over.timer, 0);
  assert.equal(over.stage, "stopped");

  // And playing still counts down normally.
  const live = { stage: "countdown" as const, timer: 30 };
  advanceWaveClock(live, 5, "playing");
  assert.equal(live.timer, 25);
});

test("awaiting-start cannot resolve to victory or defeat", () => {
  const rules = source("waveRules.ts");
  // All three resolvers short-circuit on `current !== "playing"`, so the held
  // match cannot be lost before it begins.
  for (const fn of [
    "resolveMatchAfterCommandCenterLoss",
    "resolveMatchAfterFriendlyElimination",
    "resolveWaveClearOutcome",
  ]) {
    assert.match(rules, new RegExp(`export function ${fn}`));
  }
  assert.equal((rules.match(/current !== "playing"/g) ?? []).length >= 3, true);
});

test("the status has a trace id, so captures can decode it", () => {
  assert.equal(matchStatusId("awaiting-start"), 5);
  assert.equal(matchStatusId("playing"), 1);
  assert.notEqual(matchStatusId("awaiting-start"), matchStatusId("playing"));
});

test("every entry route releases the gate", () => {
  const start = source("matchStart.ts");
  // The browser's own Enter XR pill never touches our markup, so a
  // button-only release would strand a headset-native entry.
  assert.match(start, /export function startMatch/);
  assert.match(start, /export function attachMatchStart/);
  assert.match(start, /visibilityState\.subscribe/);
  // Idempotent: several triggers can fire for one entry, and a restart that is
  // already playing must not be knocked back to the gate.
  assert.match(start, /if \(status !== "awaiting-start"\) return false;/);
  assert.match(source("../index.ts"), /attachMatchStart\(world\)/);
});

test("the economy is held at BOTH ends of the match", () => {
  // Before the start: a miner working through the landing page grows the
  // treasury in proportion to how long the player read it.
  // After it: crystals arriving during a defeat screen change a total the
  // player is still looking at.
  assert.match(source("mining.ts"), /if \(!matchAcceptsCommands\("mining"\)\) return;/);
});

test("a restart begins playing immediately", () => {
  // Restart is an explicit player action, so it must not drop back to the gate.
  assert.match(source("scenarioResetRules.ts"), /matchStatus: "playing"/);
});

test("the gate is wired after the systems that create the wave source", () => {
  const index = source("../index.ts");
  // `visibilityState.subscribe` fires IMMEDIATELY with the current value
  // (@preact/signals-core: subscribe wraps effect, which runs its body at once).
  // `xr.offer: "always"` means a session can already be open when this .then()
  // runs — a headset already on accepts the offered session during
  // World.create. Subscribing before BoardSystem registers would fire while
  // boardState.waveSource is null, startMatch() would return false, and since
  // visibility never changes again the gate would never release.
  assert.ok(
    index.indexOf("registerSystem(BoardSystem)") <
      index.indexOf("attachMatchStart(world)"),
    "attachMatchStart must run after the wave source exists",
  );
});

test("matchAwaitingStart fails SAFE when the board does not exist", () => {
  const start = source("matchStart.ts");
  // false would retire the tutorial, hide the landing page and let mining run —
  // three different bad outcomes from one wrong default.
  assert.match(start, /if \(!source\) return true;/);
});

// ── Blocked-work reporting, added 2026-08-27 ──────────────────────────────

const stripped = (path: string): string =>
  source(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

test("all four silent gates now name themselves", () => {
  // 2026-08-27: a session ended in victory and the board went quiet, but with
  // no miners, nothing in production, nothing under construction and no wave 7,
  // the quiet was over-determined — with every gate REMOVED that board would
  // have looked identical. Four of the five gates were bare `return`s no log
  // could see, so the ✅ rested on one manual check.
  const gates: Array<[string, string]> = [
    ["mining.ts", "mining"],
    ["construction.ts", "construction"],
    ["craftProduction.ts", "craft-production"],
    ["interaction.ts", "world-press"],
  ];
  for (const [file, name] of gates) {
    assert.match(
      stripped(file),
      new RegExp(`matchAcceptsCommands\\("${name}"\\)`),
      `${file} must name its gate so a refusal is observable`,
    );
    // An unnamed call in these four is the regression: it compiles, it works,
    // and it goes back to being invisible.
    assert.doesNotMatch(
      stripped(file),
      /matchAcceptsCommands\(\)/,
      `${file} has an unnamed gate — it would refuse silently`,
    );
  }
});

test("a refusal reports on the edge, not once per frame", () => {
  const gate = stripped("matchStart.ts");
  // Three of the four callers ask EVERY FRAME. Logging unconditionally would be
  // ~360 lines a second — the "mechanism, not decision" flood the action log
  // exists to prevent. Suppression belongs here, in the function that knows
  // "the match is over" is a STATE, not in logAction which cannot tell a state
  // from an action.
  assert.match(gate, /const blockedBy = new Map<string, string>\(\);/);
  assert.match(gate, /if \(blockedBy\.get\(system\) !== now\)/);
  // And the re-arm: returning to "playing" clears the record rather than
  // latching, so a restart reports its next block afresh.
  assert.match(gate, /blockedBy\.set\(system, now\)/);
});

test("only a DECIDED match is reported as blocking", () => {
  const gate = stripped("matchStart.ts");
  // awaiting-start and restarting also block, but both already have their own
  // narrative line, and reporting them would add four lines at every boot and
  // four at every restart for nothing new.
  assert.match(gate, /MATCH_OVER: ReadonlySet<string> = new Set\(\["victory", "defeat"\]\)/);
  assert.match(gate, /MATCH_OVER\.has\(status\)/);
  assert.doesNotMatch(gate, /MATCH_OVER[\s\S]{0,80}"awaiting-start"/);
  assert.doesNotMatch(gate, /MATCH_OVER[\s\S]{0,80}"restarting"/);
});

test("ENTER VR records intent WITHOUT releasing the gate", () => {
  const landing = stripped("../app/landing.ts");
  const handler =
    /enterButton\?\.addEventListener\("click", \(\) => \{[\s\S]*?\}\);/.exec(landing)?.[0] ?? "";
  assert.ok(handler, "enter button handler not found");
  // The 08-26 bug: startMatch() before the async launchXR left the app
  // `playing` AND non-immersive — the desktop-start signature — so the tutorial
  // retired before the headset was in the session. It must never come back.
  assert.doesNotMatch(handler, /startMatch/);
  assert.match(handler, /launchXR\(world\)/);
  // ...but removing it also made this button indistinguishable from the
  // browser's own pill: both report via=xr-session. The intent line is what
  // tells them apart without touching the gate.
  assert.match(handler, /logAction\(ActionKind\.Xr, "launch requested via=landing-button"\)/);
  // There used to be a second landing route — EXPLORE IN BROWSER — and it was
  // the one that legitimately released the gate. It was removed 2026-09-05, so
  // no landing handler releases it at all now; `attachMatchStart` does, on the
  // visibility change.
  assert.doesNotMatch(landing, /startMatch\("landing-explore"\)/);
});

test("the pre-start guard lives in `held`, where it is defined", () => {
  // Recorded because I got this wrong and wrote a redundant condition into the
  // pin below, plus a comment explaining a mechanism that does not exist.
  // `held` ALREADY requires a playing match, so the landing page could never
  // have triggered the pin and no extra status check was buying anything.
  //
  // Pinning the definition here is what makes the pin's single condition safe:
  // if this ever drops the status test, the pin becomes reachable before the
  // player starts and this test is the thing that notices.
  assert.match(
    stripped("wave.ts"),
    /const held = matchStatus === "playing" && tutorialHoldsCountdown\(\);/,
    "`held` must keep implying a playing match — the pin relies on it",
  );
});

test("the wave-1 delay has ONE source, and the settings knob feeds it", () => {
  // Boot, restart and every wave advance must agree, or "wave 1 is 5s" is only
  // true on whichever path you happened to test.
  assert.match(source("waveRules.ts"), /export const INITIAL_WAVE_DELAY_SECONDS = 5;/);
  assert.match(source("state.ts"), /timer: \{ type: Types\.Float32, default: INITIAL_WAVE_DELAY_SECONDS \}/);
  assert.match(source("scenarioReset.ts"), /createScenarioResetDefaults\(\s*STARTING_CRYSTALS,\s*INITIAL_WAVE_DELAY_SECONDS,/);
  // ...and the live knob overrides all of them, so playtesting a longer grace
  // period does not need a rebuild.
  assert.match(source("combat.ts"), /"initialWaveDelaySeconds",\s*\) \?\? INITIAL_WAVE_DELAY_SECONDS/);
});

test("a stale wave gate cannot shorten an ordinary wave", () => {
  // The `matchStatus === "playing"` guard alone was NOT enough, and the reason
  // is frame ordering. WaveSystem is registered at index.ts:258 and
  // TutorialSystem at :267, so on the first frame after a desktop start the
  // gate is stale: `startMatch("landing-explore")` already set `playing`
  // between frames, and the tutorial has not yet had its update to retire and
  // clear the gate — so `held` is still true. One frame is enough to write 2
  // and persist it.
  const wave = stripped("wave.ts");
  const pin = /if \([\s\S]{0,160}?TUTORIAL_WAVE_ACTIVATION_LEAD_SECONDS;/.exec(wave)?.[0] ?? "";
  assert.ok(pin, "the tutorial lead pin was not found");
  assert.match(
    pin,
    /held && this\.clock\.waveNumber === TUTORIAL_WAVE_NUMBER/,
    "the pin must be scoped to the tutorial's own wave, so it cannot depend on system registration order",
  );
  // And the bug shape must not come back.
  assert.doesNotMatch(
    stripped("wave.ts"),
    /if \(held\) this\.clock\.timer = TUTORIAL_WAVE_ACTIVATION_LEAD_SECONDS;/,
  );

  // The ordering this defends against is real; if it ever changes, the comment
  // above is wrong but the fix still holds.
  const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.ok(
    index.indexOf("registerSystem(WaveSystem)") <
      index.indexOf("registerSystem(TutorialSystem)"),
    "WaveSystem is expected to run before TutorialSystem",
  );
});
