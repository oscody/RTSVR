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
  arrowNeedsCommandCenter,
  arrowProblem,
  arrowTargetFor,
  canResolveArrow,
  drillCost,
  drillUnitCanFight,
  isDeadEnd,
  hasDrillStarted,
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
    lookingAtCommandCenter: false,
    commandCenterAlive: true,
    ...overrides,
  };
}

/** Index of a drill by id. Tests must never hardcode positions — inserting a
 *  drill (as `orient` was) would silently retarget them. */
const indexOf = (id: string): number => {
  const i = TUTORIAL_DRILLS.findIndex((entry) => entry.id === id);
  assert.ok(i >= 0, `no drill "${id}"`);
  return i;
};

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

test("the tutorial opens by naming the base and closes by signing off", () => {
  assert.deepEqual(
    TUTORIAL_DRILLS.map((drill) => drill.id),
    ["orient", "mine", "astronaut", "racer", "turret", "done"],
  );
  // The first thing a player is ever told is which thing is theirs.
  assert.match(TUTORIAL_DRILLS[0].cards.title, /command center/i);
  assert.equal(TUTORIAL_DRILLS[0].create, null);
  assert.equal(TUTORIAL_DRILLS[0].opponent, null);
});

test("a satisfied trigger cannot skip a card before it can be read", () => {
  const orient = TUTORIAL_DRILLS[0];
  assert.ok(orient.minSeconds && orient.minSeconds > 0, "orient needs a floor");
  // Already looking at the base — the trigger is satisfied from frame one.
  const looking = snapshot({ lookingAtCommandCenter: true });
  // …but it must still be on screen long enough to read.
  assert.equal(isDrillComplete(orient, { ...looking, stepElapsedSeconds: 0 }, 0), false);
  assert.equal(isDrillComplete(orient, { ...looking, stepElapsedSeconds: 1 }, 0), false);
  assert.equal(
    isDrillComplete(orient, { ...looking, stepElapsedSeconds: orient.minSeconds! }, 0),
    true,
  );
});

test("the floor is a minimum, not a timer - it never completes on its own", () => {
  const orient = TUTORIAL_DRILLS[0];
  // Ten minutes elapsed, still not looking: still incomplete.
  assert.equal(
    isDrillComplete(orient, snapshot({ stepElapsedSeconds: 600 }), 0),
    false,
  );
});

test("the orientation beat waits until the player looks at their base", () => {
  const orient = TUTORIAL_DRILLS[0];
  // Event, not a timer: no amount of elapsed time completes it on its own.
  assert.equal(
    isDrillComplete(orient, snapshot({ stepElapsedSeconds: 600 }), 0),
    false,
  );
  // Looking AND read: both are required.
  assert.equal(
    isDrillComplete(
      orient,
      snapshot({ lookingAtCommandCenter: true, stepElapsedSeconds: 10 }),
      0,
    ),
    true,
  );
});

test("the sign-off does not spawn anything", () => {
  const done = TUTORIAL_DRILLS[TUTORIAL_DRILLS.length - 1];
  assert.equal(done.opponent, null);
  assert.equal(done.create, null);
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

// ── Arrow targets (plan tests 19, 19b) ──────────────────────────────────────

test("every drill declares an arrow for both card phases", () => {
  for (const drill of TUTORIAL_DRILLS) {
    assert.ok("intro" in drill.arrows, `${drill.id} missing arrows.intro`);
    assert.ok("doing" in drill.arrows, `${drill.id} missing arrows.doing`);
  }
});

test("the arrow follows the card from intro to doing", () => {
  const mine = drillById("mine");
  // Asking: point at the crystals.
  assert.deepEqual(arrowTargetFor(mine, snapshot()), { kind: "nearestCrystal" });
  // Working: point at the miner doing the work.
  assert.deepEqual(arrowTargetFor(mine, snapshot({ ordersIssued: 1 })), {
    kind: "nearestUnit",
    unit: "miner",
  });
});

test("orientation points at the base, which is the whole lesson", () => {
  assert.deepEqual(arrowTargetFor(TUTORIAL_DRILLS[0], snapshot()), {
    kind: "commandCenter",
  });
});

test("only base-derived targets are flagged as needing the command center", () => {
  assert.equal(arrowNeedsCommandCenter({ kind: "commandCenter" }), true);
  assert.equal(arrowNeedsCommandCenter({ kind: "threatTile" }), true);
  assert.equal(arrowNeedsCommandCenter({ kind: "nearestCrystal" }), false);
  assert.equal(arrowNeedsCommandCenter({ kind: "nearestEnemy" }), false);
  assert.equal(arrowNeedsCommandCenter({ kind: "interceptTile" }), false);
});

test("a base-derived arrow is hidden once the base is gone, never redirected", () => {
  const dead = snapshot({ commandCenterAlive: false });
  assert.equal(canResolveArrow({ kind: "commandCenter" }, dead), false);
  assert.equal(canResolveArrow({ kind: "threatTile" }, dead), false);
  // Targets that do not depend on the base are unaffected.
  assert.equal(canResolveArrow({ kind: "nearestCrystal" }, dead), true);
});

test("enemy-derived arrows are hidden when there is no enemy", () => {
  assert.equal(
    canResolveArrow({ kind: "nearestEnemy" }, snapshot({ liveEnemyCount: 0 })),
    false,
  );
  assert.equal(
    canResolveArrow({ kind: "nearestEnemy" }, snapshot({ liveEnemyCount: 1 })),
    true,
  );
  assert.equal(
    canResolveArrow({ kind: "interceptTile" }, snapshot({ liveEnemyCount: 0 })),
    false,
  );
});

test("a null target draws nothing", () => {
  assert.equal(canResolveArrow(null, snapshot()), false);
});

// ── What gets logged, and what deliberately does not ────────────────────────

test("waiting for an enemy that has not been released is not reported", () => {
  // The astronaut drill's intro points at nearestEnemy while the alien is still
  // gated on crystals. That happens on every run — warning about it would train
  // whoever reads the console to ignore the message.
  const astronaut = drillById("astronaut");
  assert.equal(arrowProblem(astronaut, snapshot({ crystals: 0, liveEnemyCount: 0 })), null);
});

test("a base-derived arrow with no base is reported, and says why", () => {
  const problem = arrowProblem(
    TUTORIAL_DRILLS[0],
    snapshot({ commandCenterAlive: false }),
  );
  assert.ok(problem, "expected a reported problem");
  assert.match(problem, /orient/);
  assert.match(problem, /command center is gone/);
});

test("a drill that deliberately has no arrow reports nothing", () => {
  const done = TUTORIAL_DRILLS[TUTORIAL_DRILLS.length - 1];
  assert.equal(done.arrows.intro, null);
  assert.equal(arrowProblem(done, snapshot()), null);
});

test("a resolvable arrow reports nothing", () => {
  assert.equal(arrowProblem(drillById("mine"), snapshot()), null);
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
  const mine = indexOf("mine");
  const progress = advanceTutorial(mine, snapshot({ crystalsMined: 0 }), 0);
  assert.equal(progress.drill, mine);
  assert.equal(progress.advanced, false);
  assert.equal(progress.releaseOpponent, false);
  assert.equal(progress.holdsWaves, true);
});

// ── Card feedback: intro -> doing ───────────────────────────────────────────

test("ordering the miner changes the card, even though it does not complete the drill", () => {
  const mine = drillById("mine");
  // Nothing done yet: the card still asks for the click.
  assert.equal(hasDrillStarted(mine, snapshot()), false);
  // Miner en route — the click is acknowledged before any crystal lands.
  assert.equal(hasDrillStarted(mine, snapshot({ ordersIssued: 1 })), true);
  // …and the drill is still NOT complete, which is the point.
  assert.equal(isDrillComplete(mine, snapshot({ ordersIssued: 1 }), 0), false);
});

test("a partial haul keeps the card on doing", () => {
  const mine = drillById("mine");
  assert.equal(hasDrillStarted(mine, snapshot({ crystalsMined: 10 })), true);
  assert.equal(isDrillComplete(mine, snapshot({ crystalsMined: 10 }), 0), false);
});

test("a combat drill starts when its opponent is released", () => {
  const astronaut = drillById("astronaut");
  assert.equal(hasDrillStarted(astronaut, snapshot({ crystals: 34 })), false);
  assert.equal(hasDrillStarted(astronaut, snapshot({ crystals: 35 })), true);
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
  // The last drill is the sign-off: a dwell beat, not a fight.
  const progress = advanceTutorial(
    last,
    snapshot({ stepElapsedSeconds: 30 }),
    0,
  );
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

test("losing the command center is a dead end regardless of everything else", () => {
  // Rich, mining happily, plenty of units — and still over.
  assert.equal(
    isDeadEnd(snapshot({ commandCenterAlive: false, minerCount: 3, crystals: 999 })),
    true,
  );
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
  const progress = advanceTutorial(indexOf("astronaut"), poor, 0);
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
    indexOf("astronaut"),
    snapshot({ minerCount: 0, crystals: MINER_COST }),
    0,
  );
  assert.equal(progress.releaseOpponent, false);
  assert.equal(progress.holdsWaves, true);
});

test("a dead end reports once and holds waves", () => {
  const progress = advanceTutorial(
    indexOf("astronaut"),
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
  // Instruction drills have no opponent: nothing to fight yet, so waves stay held.
  assert.equal(advanceTutorial(indexOf("orient"), snapshot(), 0).holdsWaves, true);
  assert.equal(advanceTutorial(indexOf("mine"), snapshot(), 0).holdsWaves, true);
  // The first combat drill releases them.
  assert.equal(
    advanceTutorial(indexOf("astronaut"), snapshot({ astronautCount: 1 }), 0)
      .holdsWaves,
    false,
  );
});
