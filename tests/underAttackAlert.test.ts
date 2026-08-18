import assert from "node:assert/strict";
import test from "node:test";

import {
  ALERT_GLOBAL_GAP_SECONDS,
  ALERT_PRIORITY,
  ALERT_TARGET_COOLDOWN_SECONDS,
  ALERT_VISIBLE_SECONDS,
  ALERT_SPOTTED_PRIORITY,
  alertCategoryFor,
  alertDisplayName,
  alertMessage,
  alertPriority,
  shouldRaiseAlert,
  shouldRaiseSpottedAlert,
  spottedDetail,
  spottedMessage,
  type AlertRequest,
  type AlertRuntime,
  type SpottedRequest,
  type SpottedRuntime,
} from "../src/systems/underAttackAlertRules.ts";

function request(overrides: Partial<AlertRequest> = {}): AlertRequest {
  return {
    targetIndex: 1,
    category: "unit",
    displayKind: "astronaut",
    fatal: false,
    matchStatus: "playing",
    ...overrides,
  };
}

function runtime(overrides: Partial<AlertRuntime> = {}): AlertRuntime {
  return {
    activePriority: 0,
    activeUntil: 0,
    lastAlertAt: Number.NEGATIVE_INFINITY,
    lastTargetAlertAt: Number.NEGATIVE_INFINITY,
    ...overrides,
  };
}

test("the command center outranks buildings, which outrank units", () => {
  assert.ok(ALERT_PRIORITY["command-center"] > ALERT_PRIORITY.building);
  assert.ok(ALERT_PRIORITY.building > ALERT_PRIORITY.unit);
  assert.equal(alertPriority("unit"), 1);
  assert.equal(alertCategoryFor(true, true), "command-center");
  assert.equal(alertCategoryFor(true, false), "building");
  assert.equal(alertCategoryFor(false, false), "unit");
});

test("a first non-fatal hit on a surviving friendly raises an alert", () => {
  assert.equal(shouldRaiseAlert(request(), runtime(), 0), true);
});

test("a fatal hit raises nothing - destruction messaging is more accurate", () => {
  assert.equal(shouldRaiseAlert(request({ fatal: true }), runtime(), 0), false);
  assert.equal(
    shouldRaiseAlert(
      request({ fatal: true, category: "command-center" }),
      runtime(),
      0,
    ),
    false,
  );
});

test("alerts are suppressed outside an actively playing match", () => {
  for (const matchStatus of ["countdown", "victory", "defeat", "restarting"]) {
    assert.equal(
      shouldRaiseAlert(request({ matchStatus }), runtime(), 0),
      false,
      matchStatus,
    );
  }
});

test("the same target cannot re-alert for the cooldown window", () => {
  const state = runtime({ lastTargetAlertAt: 0 });
  assert.equal(
    shouldRaiseAlert(request(), state, ALERT_TARGET_COOLDOWN_SECONDS - 0.01),
    false,
  );
  assert.equal(
    shouldRaiseAlert(request(), state, ALERT_TARGET_COOLDOWN_SECONDS),
    true,
  );
});

test("the per-target cooldown outlasts a sustained assault on the command center", () => {
  // The alarm's own hold window is what keeps a long attack audible; the alert
  // itself must not retrigger on every damage tick.
  const state = runtime({ lastTargetAlertAt: 0, activePriority: 0, activeUntil: 0 });
  assert.equal(
    shouldRaiseAlert(request({ category: "command-center" }), state, 1),
    false,
  );
});

test("an equal-priority alert does not replace one that is still visible", () => {
  const state = runtime({
    activePriority: ALERT_PRIORITY.unit,
    activeUntil: ALERT_VISIBLE_SECONDS,
    lastAlertAt: 0,
  });
  assert.equal(shouldRaiseAlert(request({ targetIndex: 2 }), state, 1), false);
});

test("a lower-priority alert does not replace one that is still visible", () => {
  const state = runtime({
    activePriority: ALERT_PRIORITY.building,
    activeUntil: ALERT_VISIBLE_SECONDS,
    lastAlertAt: 0,
  });
  assert.equal(shouldRaiseAlert(request({ targetIndex: 2 }), state, 1), false);
});

test("a command-center alert replaces a visible unit alert immediately", () => {
  const state = runtime({
    activePriority: ALERT_PRIORITY.unit,
    activeUntil: ALERT_VISIBLE_SECONDS,
    lastAlertAt: 0,
  });
  assert.equal(
    shouldRaiseAlert(
      request({ targetIndex: 2, category: "command-center", displayKind: "command-center" }),
      state,
      1,
    ),
    true,
  );
});

test("ordinary alerts wait out the global gap, the command center does not", () => {
  const state = runtime({ lastAlertAt: 0, activeUntil: 0 });
  const inGap = ALERT_GLOBAL_GAP_SECONDS - 0.01;
  assert.equal(shouldRaiseAlert(request({ targetIndex: 2 }), state, inGap), false);
  assert.equal(
    shouldRaiseAlert(
      request({ targetIndex: 2, category: "command-center" }),
      state,
      inGap,
    ),
    true,
  );
  assert.equal(
    shouldRaiseAlert(request({ targetIndex: 2 }), state, ALERT_GLOBAL_GAP_SECONDS),
    true,
  );
});

test("an expired alert stops blocking replacements", () => {
  const state = runtime({
    activePriority: ALERT_PRIORITY.building,
    activeUntil: ALERT_VISIBLE_SECONDS,
    lastAlertAt: 0,
  });
  assert.equal(
    shouldRaiseAlert(
      request({ targetIndex: 2 }),
      state,
      ALERT_VISIBLE_SECONDS + ALERT_GLOBAL_GAP_SECONDS,
    ),
    true,
  );
});

test("messages use player-facing names, never kinds or entity indexes", () => {
  assert.equal(
    alertMessage("command-center", "command-center"),
    "Command center under attack",
  );
  assert.equal(alertMessage("building", "turret"), "Turret under attack");
  assert.equal(alertMessage("building", "hangar"), "Hangar under attack");
  assert.equal(alertMessage("unit", "astronaut"), "Astronaut under attack");
  assert.equal(alertMessage("unit", "miner"), "Mining Craft under attack");
  assert.equal(alertMessage("unit", "racer"), "Racing Craft under attack");
});

const SPOTTED_GAP = 8;
const SPOTTED_COOLDOWN = 20;

function spotted(overrides: Partial<SpottedRequest> = {}): SpottedRequest {
  return {
    targetIndex: 1,
    category: "unit",
    displayKind: "miner",
    matchStatus: "playing",
    ...overrides,
  };
}

function spottedState(overrides: Partial<SpottedRuntime> = {}): SpottedRuntime {
  return {
    activeUntil: 0,
    lastSpottedAt: Number.NEGATIVE_INFINITY,
    lastTargetSpottedAt: Number.NEGATIVE_INFINITY,
    ...overrides,
  };
}

const raiseSpotted = (
  request: SpottedRequest,
  state: SpottedRuntime,
  now: number,
): boolean =>
  shouldRaiseSpottedAlert(request, state, now, SPOTTED_GAP, SPOTTED_COOLDOWN);

test("a sighting ranks below every damage alert", () => {
  assert.ok(ALERT_SPOTTED_PRIORITY < ALERT_PRIORITY.unit);
});

test("a first sighting raises a caution alert", () => {
  assert.equal(raiseSpotted(spotted(), spottedState(), 0), true);
});

test("a sighting never interrupts a visible alert of any kind", () => {
  const state = spottedState({ activeUntil: ALERT_VISIBLE_SECONDS });
  assert.equal(raiseSpotted(spotted(), state, 1), false);
  assert.equal(raiseSpotted(spotted(), state, ALERT_VISIBLE_SECONDS), true);
});

test("sightings are spaced far wider apart than damage alerts", () => {
  assert.ok(SPOTTED_GAP > ALERT_GLOBAL_GAP_SECONDS);
  assert.ok(SPOTTED_COOLDOWN > ALERT_TARGET_COOLDOWN_SECONDS);
  const state = spottedState({ lastSpottedAt: 0 });
  assert.equal(raiseSpotted(spotted({ targetIndex: 2 }), state, SPOTTED_GAP - 0.01), false);
  assert.equal(raiseSpotted(spotted({ targetIndex: 2 }), state, SPOTTED_GAP), true);
});

test("the same unit cannot re-raise a sighting for its own cooldown", () => {
  const state = spottedState({ lastTargetSpottedAt: 0 });
  assert.equal(raiseSpotted(spotted(), state, SPOTTED_COOLDOWN - 0.01), false);
  assert.equal(raiseSpotted(spotted(), state, SPOTTED_COOLDOWN), true);
});

test("sightings are suppressed outside an actively playing match", () => {
  for (const matchStatus of ["countdown", "victory", "defeat", "restarting"]) {
    assert.equal(
      raiseSpotted(spotted({ matchStatus }), spottedState(), 0),
      false,
      matchStatus,
    );
  }
});

test("the caution message names the spotted unit", () => {
  assert.equal(spottedMessage(), "Unit detected");
  assert.equal(
    spottedDetail("unit", "miner"),
    "Aliens have spotted your Mining Craft.",
  );
  assert.equal(
    spottedDetail("command-center", "command-center"),
    "Aliens have spotted your Command center.",
  );
});

test("an unknown kind still produces a readable name", () => {
  assert.equal(alertDisplayName("unit", "rover"), "Rover");
  assert.equal(alertDisplayName("unit", ""), "Unit");
  assert.equal(alertDisplayName("building", ""), "Building");
});
