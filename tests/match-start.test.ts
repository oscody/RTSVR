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

test("the economy is held too, not just the waves", () => {
  // A miner working through the landing page would grow the treasury in
  // proportion to how long the player read it.
  assert.match(source("mining.ts"), /if \(matchAwaitingStart\(\)\) return;/);
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
