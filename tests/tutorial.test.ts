import assert from "node:assert/strict";
import test from "node:test";

import {
  TUTORIAL_DRILLS,
  TUTORIAL_ENABLED,
  type TutorialDrill,
} from "../src/systems/tutorialCatalog.ts";
import {
  ASTRONAUT_COST,
  CRYSTALS_PER_TRIP,
  MINER_COST,
  advanceTutorial,
  drillCost,
  drillUnitCanFight,
  isDeadEnd,
  isDrillComplete,
  resolveRecovery,
  shouldReleaseOpponent,
  validateDrills,
  type TutorialSnapshot,
} from "../src/systems/tutorialRules.ts";
import { DEBUG_SETTINGS_CATALOG } from "../src/systems/debugSettingsCatalog.ts";

function snapshot(overrides: Partial<TutorialSnapshot> = {}): TutorialSnapshot {
  return {
    selectedUnitCount: 0,
    ordersIssued: 0,
    crystals: 0,
    crystalsMined: 0,
    minerCount: 1,
    astronautCount: 0,
    constructionSiteCount: 0,
    turretCount: 0,
    enemiesKilled: 0,
    liveEnemyCount: 0,
    matchStatus: "playing",
    stepElapsedSeconds: 0,
    alertRevision: 0,
    ...overrides,
  };
}

const drillById = (id: string): TutorialDrill => {
  const drill = TUTORIAL_DRILLS.find((entry) => entry.id === id);
  assert.ok(drill, `no drill "${id}"`);
  return drill;
};

// ── The flag ────────────────────────────────────────────────────────────────

test("the tutorial is on by default", () => {
  // TUTORIAL_ENABLED seeds DebugSettings.tutorialEnabled, which is what the
  // runtime reads — so this is the default, not the live value.
  assert.equal(TUTORIAL_ENABLED, true);
});

test("the settings tab exposes a tutorial toggle", () => {
  const spec = DEBUG_SETTINGS_CATALOG.find(
    (entry) => entry.key === "tutorialEnabled",
  );
  assert.ok(spec, "no tutorialEnabled row in the debug settings catalog");
  // 0/1 with step 1 so it reuses the numeric +/- rows as an on/off switch.
  assert.equal(spec.min, 0);
  assert.equal(spec.max, 1);
  assert.equal(spec.step, 1);
  assert.equal(spec.decimals, 0);
});

// ── Drill list invariants (plan tests 16, 17, 17b, 20, 21) ──────────────────

test("the default drill list is valid", () => {
  assert.deepEqual(validateDrills(), []);
});

test("the default order is miner then astronaut then racer then turret", () => {
  assert.deepEqual(
    TUTORIAL_DRILLS.map((drill) => drill.id),
    ["mine", "astronaut", "racer", "turret"],
  );
});

test("the miner drill has no opponent - it cannot fight", () => {
  const mine = drillById("mine");
  assert.equal(mine.opponent, null);
  assert.equal(drillUnitCanFight(mine), false);
});

test("a miner drill given an opponent is rejected, not shipped", () => {
  const bad: TutorialDrill = {
    ...drillById("mine"),
    create: { via: "produce", kind: "miner" },
    opponent: { enemy: "alien", count: 1, spawn: "south" },
  };
  const problems = validateDrills([bad]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /cannot attack/);
});

test("a drill released before its unit is affordable is rejected", () => {
  const bad: TutorialDrill = {
    ...drillById("racer"),
    trigger: { kind: "crystalsAtLeast", amount: 10 }, // racer costs 80
  };
  const problems = validateDrills([drillById("astronaut"), bad]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /releases at 10 crystals but its unit costs 80/);
});

test("a builder-requiring drill before the astronaut drill is rejected", () => {
  // Racer production and turret construction both need a builder.
  const problems = validateDrills([drillById("turret"), drillById("astronaut")]);
  assert.ok(problems.some((p) => /needs a builder/.test(p)));
});

test("every combat drill's counter is affordable when its enemy is released", () => {
  for (const drill of TUTORIAL_DRILLS) {
    if (!drill.opponent || drill.trigger.kind !== "crystalsAtLeast") continue;
    assert.ok(
      drill.trigger.amount >= drillCost(drill),
      `${drill.id}: released at ${drill.trigger.amount}, costs ${drillCost(drill)}`,
    );
  }
});

test("drill costs match the live catalogs", () => {
  assert.equal(drillCost(drillById("astronaut")), ASTRONAUT_COST);
  assert.equal(drillCost(drillById("racer")), 80);
  assert.equal(drillCost(drillById("turret")), 30);
  assert.equal(drillCost(drillById("mine")), 0);
});

// ── Release gating (plan tests 13, 21, 32) ──────────────────────────────────

test("four mining trips releases the first alien", () => {
  const mine = drillById("mine");
  const astronaut = drillById("astronaut");
  // Three trips is not enough.
  assert.equal(
    isDrillComplete(mine, snapshot({ crystalsMined: 3 * CRYSTALS_PER_TRIP }), 0),
    false,
  );
  assert.equal(
    isDrillComplete(mine, snapshot({ crystalsMined: 4 * CRYSTALS_PER_TRIP }), 0),
    true,
  );
  // 40 mined leaves 40 in hand, which covers the 35 astronaut.
  assert.equal(
    shouldReleaseOpponent(astronaut, snapshot({ crystals: 40 })),
    true,
  );
});

test("no enemy is released before its counter is affordable", () => {
  const racer = drillById("racer");
  assert.equal(shouldReleaseOpponent(racer, snapshot({ crystals: 79 })), false);
  assert.equal(shouldReleaseOpponent(racer, snapshot({ crystals: 80 })), true);
});

test("a player who never mines is never attacked", () => {
  // Drill 1 waits indefinitely; nothing is released, so nothing can kill them.
  const progress = advanceTutorial(0, snapshot({ crystalsMined: 0 }), 0);
  assert.equal(progress.drill, 0);
  assert.equal(progress.advanced, false);
  assert.equal(progress.releaseOpponent, false);
  assert.equal(progress.holdsWaves, true);
});

// ── Completion and progression (plan tests 1, 2) ────────────────────────────

test("a combat drill completes when its opponent dies", () => {
  const astronaut = drillById("astronaut");
  assert.equal(isDrillComplete(astronaut, snapshot({ enemiesKilled: 0 }), 0), false);
  assert.equal(isDrillComplete(astronaut, snapshot({ enemiesKilled: 1 }), 0), true);
});

test("kills banked in an earlier drill do not complete the next one", () => {
  const racer = drillById("racer");
  // Two kills already on the board when this drill starts.
  assert.equal(isDrillComplete(racer, snapshot({ enemiesKilled: 2 }), 2), false);
  assert.equal(isDrillComplete(racer, snapshot({ enemiesKilled: 3 }), 2), true);
});

test("completing the last drill ends the tutorial", () => {
  const last = TUTORIAL_DRILLS.length - 1;
  const progress = advanceTutorial(last, snapshot({ enemiesKilled: 1 }), 0);
  assert.equal(progress.advanced, true);
  assert.equal(progress.drill, -1);
});

test("the tutorial is inactive outside a playing match", () => {
  for (const matchStatus of ["victory", "defeat", "restarting", "countdown"]) {
    const progress = advanceTutorial(0, snapshot({ matchStatus }), 0);
    assert.equal(progress.drill, -1, matchStatus);
    assert.equal(progress.holdsWaves, false, matchStatus);
  }
});

// ── Recovery and the one dead end (plan tests 27-31) ────────────────────────

test("the only dead end is no miner and no way to buy one", () => {
  assert.equal(isDeadEnd(snapshot({ minerCount: 0, crystals: 0 })), true);
  assert.equal(
    isDeadEnd(snapshot({ minerCount: 0, crystals: MINER_COST - 1 })),
    true,
  );
  assert.equal(isDeadEnd(snapshot({ minerCount: 0, crystals: MINER_COST })), false);
  // A live miner is never a dead end, however poor the player is.
  assert.equal(isDeadEnd(snapshot({ minerCount: 1, crystals: 0 })), false);
});

test("losing the miner with crystals prompts a replacement", () => {
  const recovery = resolveRecovery(
    drillById("astronaut"),
    snapshot({ minerCount: 0, crystals: MINER_COST }),
  );
  assert.deepEqual(recovery, { unit: "miner", affordable: true });
});

test("losing the astronaut with a live miner waits, it does not end the run", () => {
  const drill = drillById("astronaut");
  const poor = snapshot({ astronautCount: 0, crystals: 0, minerCount: 1 });
  assert.deepEqual(resolveRecovery(drill, poor), {
    unit: "astronaut",
    affordable: false,
  });
  // Crucially: not a dead end. Income is still coming.
  assert.equal(isDeadEnd(poor), false);
  const progress = advanceTutorial(1, poor, 0);
  assert.equal(progress.deadEnd, false);
  assert.equal(progress.recovery?.unit, "astronaut");
});

test("losing the astronaut with crystals prompts a replacement", () => {
  const recovery = resolveRecovery(
    drillById("astronaut"),
    snapshot({ astronautCount: 0, crystals: ASTRONAUT_COST }),
  );
  assert.deepEqual(recovery, { unit: "astronaut", affordable: true });
});

test("recovery pauses enemy releases so a rebuilding player is not attacked", () => {
  const progress = advanceTutorial(
    1,
    snapshot({ minerCount: 0, crystals: MINER_COST }),
    0,
  );
  assert.equal(progress.releaseOpponent, false);
  assert.equal(progress.holdsWaves, true);
});

test("a dead end reports once and holds waves", () => {
  const progress = advanceTutorial(
    1,
    snapshot({ minerCount: 0, crystals: 0 }),
    0,
  );
  assert.equal(progress.deadEnd, true);
  assert.equal(progress.holdsWaves, true);
  assert.equal(progress.releaseOpponent, false);
  // Dead end outranks recovery — no point prompting for a miner they cannot buy.
  assert.equal(progress.recovery, null);
});

// ── Act 1 holds waves (plan acceptance 6) ───────────────────────────────────

test("act 1 holds waves, act 2 does not", () => {
  // Drill 0 has no opponent: nothing to fight yet.
  assert.equal(advanceTutorial(0, snapshot(), 0).holdsWaves, true);
  // Drill 1 has an opponent: waves are live.
  assert.equal(advanceTutorial(1, snapshot({ astronautCount: 1 }), 0).holdsWaves, false);
});
