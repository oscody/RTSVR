import {
  TUTORIAL_CARD_BACKGROUND,
  TUTORIAL_CARD_DEAD_END_BACKGROUND,
  TUTORIAL_CARD_DIM_BACKGROUND,
  TUTORIAL_CARD_RECOVERY_BACKGROUND,
} from "../src/systems/constants.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  TUTORIAL_DRILLS,
  TUTORIAL_ENABLED,
  type TutorialDrill,
} from "../src/systems/tutorialCatalog.ts";
import { getBuildingSpec } from "../src/systems/buildingCatalog.ts";
import { getProductionSpec } from "../src/systems/craftCatalog.ts";
import { DEFAULT_RESOURCE_AMOUNT_PER_TRIP } from "../src/systems/economyConstants.ts";
import {
  ASTRONAUT_COST,
  advanceGazeProgress,
  gazeFraction,
  gazeRequirement,
  gazeTargetFor,
  CRYSTALS_PER_TRIP,
  MINER_COST,
  advanceTutorial,
  arrowNeedsCommandCenter,
  arrowProblem,
  arrowTargetFor,
  arrowTargetsFor,
  canResolveArrow,
  drillCost,
  drillCrystalGate,
  validateTutorialPricing,
  drillUnitCanFight,
  edgeStep,
  interceptTileFor,
  isDeadEnd,
  hasDrillStarted,
  latchDrillStarted,
  pathsFor,
  allowedCreateKind,
  savingProgressLine,
  cardToneFor,
  recoveryGoal,
  tabHintFor,
  savingTowardFor,
  drillPhase,
  focusTargetFor,
  latchDrillMet,
  nearestCornerTo,
  releaseBudget,
  tutorialHoldsWaveCountdown,
  isDrillComplete,
  resolveRecovery,
  shouldReleaseOpponent,
  tabPulseOn,
  threatTileFor,
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
    lookingAtFocus: false,
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

test("the tutorial is ON by default", () => {
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

test("headset visibility changes pause the tutorial instead of restarting it", () => {
  const tutorial = readFileSync(
    new URL("../src/systems/tutorial.ts", import.meta.url),
    "utf8",
  );
  const scenarioReset = readFileSync(
    new URL("../src/systems/scenarioReset.ts", import.meta.url),
    "utf8",
  );

  // A headset removal may briefly look like exiting and re-entering XR. It
  // must preserve the current drill; only the explicit Restart action replays
  // the tutorial from the command-center drill.
  //
  // This used to ban `visibilityState.subscribe` outright. That was the
  // mechanism, not the rule — there is now exactly one subscription, and it
  // does nothing but claim the level (latched, once per match). Assert the
  // RULE: whatever the subscription does, it must not be able to restart the
  // script or move the player's place in it.
  const subs = tutorial.match(/visibilityState\.subscribe\([\s\S]*?\n      \}\)/g) ?? [];
  assert.equal(subs.length, 1, "one visibility subscription, or the rule below is unchecked");
  for (const body of subs) {
    assert.match(body, /this\.claimTutorialLevel\(\)/);
    for (const forbidden of [
      "drillIndex =",
      "resetTutorial",
      "clearTutorialLeft",
      "markTutorialLeft",
      "goDormant",
    ]) {
      assert.doesNotMatch(
        body,
        new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `the visibility subscription must not ${forbidden} — a headset flicker would replay the tutorial`,
      );
    }
  }
  assert.match(tutorial, /visibilityState\.peek\(\) !== VisibilityState\.Visible/);
  // Dormant either way; the argument decides whether it also holds the waves.
  // See "desktop start must not hold the waves" below for why it is conditional.
  assert.match(
    tutorial,
    /this\.goDormant\(isTutorialEnabled\(\) && matchAwaitingStart\(\)\)/,
  );
  assert.match(scenarioReset, /resetTutorial\(\);/);
});

// ── Drill list invariants (plan tests 16, 17, 17b, 20, 21) ──────────────────

test("the default drill list is valid", () => {
  assert.deepEqual(validateDrills(), []);
});

test("the tutorial opens by naming the base and closes by signing off", () => {
  assert.deepEqual(
    TUTORIAL_DRILLS.map((drill) => drill.id),
    ["orient", "mine", "astronaut", "fighter", "turret", "done"],
  );
  // The first thing a player is ever told is which thing is theirs.
  assert.match(TUTORIAL_DRILLS[0].cards.title, /command center/i);
  assert.equal(TUTORIAL_DRILLS[0].create, null);
  assert.equal(TUTORIAL_DRILLS[0].opponent, null);
});

test("a satisfied trigger cannot skip a card before it can be read", () => {
  const orient = TUTORIAL_DRILLS[0];
  assert.ok(orient.minSeconds && orient.minSeconds > 0, "orient needs a floor");
  // Since the gaze ring, `minSeconds` is spent in ACCUMULATED LOOKING rather
  // than in elapsed time — one knob, drawn as the ring. Facing the base from
  // frame one no longer skips the card; the player has to hold it.
  const looking = snapshot({ lookingAtFocus: true, stepElapsedSeconds: 600 });
  assert.equal(isDrillComplete(orient, { ...looking, gazeProgressSeconds: 0 }, 0), false);
  assert.equal(isDrillComplete(orient, { ...looking, gazeProgressSeconds: 1 }, 0), false);
  assert.equal(
    isDrillComplete(orient, { ...looking, gazeProgressSeconds: orient.minSeconds! }, 0),
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
  // Looking long enough is what completes it — a glance is not enough, which
  // is the distinction the gaze ring exists to make visible.
  assert.equal(
    isDrillComplete(
      orient,
      snapshot({
        lookingAtFocus: true,
        gazeProgressSeconds: orient.minSeconds ?? 0,
        stepElapsedSeconds: 10,
      }),
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
  // Two invariants fire here, not one: a miner cannot attack, AND the fixture
  // now keeps alive the very unit it creates. Assert the one under test rather
  // than the count, so adding an invariant does not break unrelated tests.
  const problems = validateDrills([bad]);
  assert.ok(
    problems.some((problem) => /cannot attack/.test(problem)),
    problems.join("; "),
  );
});

test("a drill released before its unit is affordable is rejected", () => {
  const bad: TutorialDrill = {
    ...drillById("fighter"),
    // Deliberately below the fighter's price, whatever that price is — this is
    // the one place an explicit amount survives, because the test needs a gate
    // that is wrong on purpose.
    trigger: { kind: "crystalsAtLeast", amount: 10 },
  };
  const fighterCost = drillCost(drillById("fighter"));
  const problems = validateDrills([drillById("astronaut"), bad]);
  // Assert the one under test, not the count — same reason as the drill above:
  // adding an invariant must not break a test that is about a different one.
  assert.ok(
    problems.some((problem) =>
      new RegExp(`releases at 10 crystals but its unit costs ${fighterCost}`).test(
        problem,
      ),
    ),
    problems.join("; "),
  );
});

test("a builder-requiring drill before the astronaut drill is rejected", () => {
  // Fighter production and turret construction both need a builder.
  const problems = validateDrills([drillById("turret"), drillById("astronaut")]);
  assert.ok(problems.some((p) => /needs a builder/.test(p)));
});

test("every combat drill's counter is affordable when its enemy is released", () => {
  for (const drill of TUTORIAL_DRILLS) {
    if (!drill.opponent || drill.trigger.kind !== "crystalsAtLeast") continue;
    const gate = drillCrystalGate(drill);
    assert.ok(
      gate >= drillCost(drill),
      `${drill.id}: released at ${gate}, costs ${drillCost(drill)}`,
    );
  }
});

test("no tutorial drill hardcodes a crystal gate", () => {
  // The gate and the price were separate numbers until 2026-09-03 and drifted
  // the moment the catalog was repriced. Omitting `amount` is what keeps them
  // the same number; an explicit one belongs only in a test.
  for (const drill of TUTORIAL_DRILLS) {
    if (drill.trigger.kind !== "crystalsAtLeast") continue;
    assert.equal(
      drill.trigger.amount,
      undefined,
      `drill "${drill.id}" states its own crystal gate; omit it so the gate follows the unit's price`,
    );
  }
});

test("the tutorial's recovery prices resolve against the live catalog", () => {
  // 0 would make `isStalled` read as "a rebuild is always affordable", so the
  // tutorial would never offer recovery and never declare a dead end.
  assert.deepEqual(validateTutorialPricing(), []);
});

test("the tutorial's unit costs are the catalog's, not copies of it", () => {
  assert.equal(MINER_COST, getProductionSpec("miner")?.cost);
  assert.equal(ASTRONAUT_COST, getProductionSpec("astronaut")?.cost);
  assert.equal(CRYSTALS_PER_TRIP, DEFAULT_RESOURCE_AMOUNT_PER_TRIP);
  // Zero would make everything look affordable and every gate open at once.
  assert.ok(MINER_COST > 0 && ASTRONAUT_COST > 0);
});

test("drill costs match the live catalogs", () => {
  assert.equal(drillCost(drillById("astronaut")), ASTRONAUT_COST);
  // Not a tautology: this is what proves `via` routes to the RIGHT catalog —
  // the fighter through production, the turret through buildings.
  assert.equal(drillCost(drillById("fighter")), getProductionSpec("fighter")?.cost);
  assert.equal(drillCost(drillById("turret")), getBuildingSpec("turret")?.cost);
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
  // Since 2a this drill points at BOTH ends of the relationship in both phases,
  // so the assertion is about what is present rather than which single one.
  const asking = arrowTargetsFor(mine, snapshot()).map((t) => t.kind);
  const working = arrowTargetsFor(mine, snapshot({ ordersIssued: 1 })).map(
    (t) => t.kind,
  );
  assert.ok(asking.includes("nearestCrystal"));
  assert.ok(asking.includes("nearestUnit"));
  assert.ok(working.includes("nearestUnit"));
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
  const fighter = drillById("fighter");
  const gate = drillCrystalGate(fighter);
  assert.equal(shouldReleaseOpponent(fighter, snapshot({ crystals: gate - 1 })), false);
  assert.equal(shouldReleaseOpponent(fighter, snapshot({ crystals: gate })), true);
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
  // This drill HAS an opponent, so "started" delegates to the release trigger —
  // the boundary is the gate itself, not the first crystal banked.
  const astronaut = drillById("astronaut");
  const gate = drillCrystalGate(astronaut);
  assert.equal(hasDrillStarted(astronaut, snapshot({ crystals: gate - 1 })), false);
  assert.equal(hasDrillStarted(astronaut, snapshot({ crystals: gate })), true);
});

// ── Completion and progression (plan tests 1, 2) ────────────────────────────

test("a combat drill completes when its opponent dies", () => {
  const astronaut = drillById("astronaut");
  assert.equal(isDrillComplete(astronaut, snapshot({ enemiesKilled: 0 }), 0), false);
  assert.equal(isDrillComplete(astronaut, snapshot({ enemiesKilled: 1 }), 0), true);
});

test("kills banked in an earlier drill do not complete the next one", () => {
  const fighter = drillById("fighter");
  // Two kills already on the board when this drill starts.
  assert.equal(isDrillComplete(fighter, snapshot({ enemiesKilled: 2 }), 2), false);
  assert.equal(isDrillComplete(fighter, snapshot({ enemiesKilled: 3 }), 2), true);
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
  // Checked against the FIGHTER drill, not the astronaut one: a drill cannot
  // depend on the unit it teaches, so astronaut recovery belongs to the first
  // drill that inherits an astronaut rather than creating one.
  const drill = drillById("fighter");
  const poor = snapshot({ astronautCount: 0, crystals: 0, minerCount: 1 });
  assert.deepEqual(resolveRecovery(drill, poor), {
    unit: "astronaut",
    affordable: false,
  });
  // Crucially: not a dead end. Income is still coming.
  assert.equal(isDeadEnd(poor), false);
  const progress = advanceTutorial(indexOf("fighter"), poor, 0);
  assert.equal(progress.deadEnd, false);
  assert.equal(progress.recovery?.unit, "astronaut");
});

test("losing the astronaut with crystals prompts a replacement", () => {
  const recovery = resolveRecovery(
    drillById("fighter"),
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

// ── Phase 3: the pointing layer ─────────────────────────────────────────────

test("edge directions match the spawn geometry in waveCatalog", () => {
  // waveCatalog's edgeCells() puts north at y=0, south at y=last, west at x=0,
  // east at x=last. If that flips, the threat arrow points the wrong way and
  // nothing else breaks — so assert the pairing, not the name.
  assert.deepEqual(edgeStep("north"), { x: 0, y: -1 });
  assert.deepEqual(edgeStep("south"), { x: 0, y: 1 });
  assert.deepEqual(edgeStep("west"), { x: -1, y: 0 });
  assert.deepEqual(edgeStep("east"), { x: 1, y: 0 });
});

test("the threat tile sits between the base and the incoming edge", () => {
  const base = { x: 12, y: 12 };
  assert.deepEqual(threatTileFor(base, "south", 3, 24), { x: 12, y: 15 });
  assert.deepEqual(threatTileFor(base, "north", 3, 24), { x: 12, y: 9 });
  assert.deepEqual(threatTileFor(base, "east", 3, 24), { x: 15, y: 12 });
  assert.deepEqual(threatTileFor(base, "west", 3, 24), { x: 9, y: 12 });
});

test("a threat tile is clamped onto the board, never off it", () => {
  // A base near the rim would otherwise resolve to a tile that does not exist,
  // and the arrow would hang over empty space outside the play area.
  assert.deepEqual(threatTileFor({ x: 22, y: 12 }, "east", 3, 24), {
    x: 23,
    y: 12,
  });
  assert.deepEqual(threatTileFor({ x: 1, y: 1 }, "north", 3, 24), { x: 1, y: 0 });
});

test("the intercept tile lands in front of the unit, not on top of it", () => {
  // Biased toward the threat: a plain midpoint loses the race whenever the
  // alien is closer than the astronaut, which is the case the drill is about.
  const tile = interceptTileFor({ x: 4, y: 4 }, { x: 14, y: 4 }, 24);
  assert.equal(tile.y, 4);
  assert.ok(tile.x > 9, `expected past the midpoint, got ${tile.x}`);
  assert.ok(tile.x < 14, `expected short of the threat, got ${tile.x}`);
});

test("an intercept tile is clamped onto the board", () => {
  const tile = interceptTileFor({ x: 0, y: 0 }, { x: 60, y: 60 }, 24);
  assert.equal(tile.x, 23);
  assert.equal(tile.y, 23);
});

test("the tab pulse is a square wave with an even duty cycle", () => {
  assert.equal(tabPulseOn(0, 0.5), true);
  assert.equal(tabPulseOn(0.4, 0.5), true);
  assert.equal(tabPulseOn(0.6, 0.5), false);
  assert.equal(tabPulseOn(1.1, 0.5), true);
  // A zero period must not divide by zero into a stuck-dark tab.
  assert.equal(tabPulseOn(3, 0), true);
});

test("every drill's declared arrows are targets the system can resolve", () => {
  // The system switches exhaustively on ArrowTarget.kind. A drill naming a kind
  // it does not handle would compile and then silently point at nothing.
  const known = new Set([
    "commandCenter",
    "nearestUnit",
    "nearestCrystal",
    "tile",
    "tabletTab",
    "nearestEnemy",
    "threatTile",
    "interceptTile",
  ]);
  for (const drill of TUTORIAL_DRILLS) {
    // A drill may declare one target or several; normalise before checking.
    for (const started of [false, true]) {
      for (const target of arrowTargetsFor(drill, snapshot(), started)) {
        assert.ok(
          known.has(target.kind),
          `drill "${drill.id}" points at unknown kind "${target.kind}"`,
        );
      }
    }
  }
});

test("a drill that names a tablet tab names one that exists", () => {
  // The pulse writes to `tab-<name>`; a typo would be a silent no-op in uikit.
  const tabs = new Set(["build", "crafts"]);
  for (const drill of TUTORIAL_DRILLS) {
    for (const started of [false, true]) {
      for (const target of arrowTargetsFor(drill, snapshot(), started)) {
        if (target.kind !== "tabletTab") continue;
        assert.ok(
          tabs.has(target.tab),
          `drill "${drill.id}" names tab "${target.tab}"`,
        );
      }
    }
  }
});

test("a released opponent that never appears is reported as such", () => {
  // Distinct from the routine pre-release silence: once the drill has released
  // its opponent, an empty board is a fact worth naming — and after phase 4 it
  // is a defect, so the message must not be a generic shrug.
  const drill = TUTORIAL_DRILLS[indexOf("astronaut")]!;
  const problem = arrowProblem(
    drill,
    snapshot({ crystals: 40, liveEnemyCount: 0 }),
  );
  assert.match(String(problem), /no enemy is on the board/);
});

test("a started drill stays started when live state goes backwards", () => {
  // The miner drill counts "on its way" as started, but `hasOrder` clears the
  // instant the miner arrives and nothing is banked until the first deposit
  // lands. Without the latch the card reverted to "click your mining craft"
  // while the player watched their miner stand on the crystals.
  const drill = TUTORIAL_DRILLS[indexOf("mine")]!;
  const enRoute = snapshot({ ordersIssued: 1, crystalsMined: 0 });
  const arrived = snapshot({ ordersIssued: 0, crystalsMined: 0 });

  assert.equal(hasDrillStarted(drill, enRoute), true);
  // The live read really does go backwards — that is the bug being latched out.
  assert.equal(hasDrillStarted(drill, arrived), false);

  const started = latchDrillStarted(drill, enRoute, false);
  assert.equal(started, true);
  assert.equal(latchDrillStarted(drill, arrived, started), true);
});

test("the latch does not start a drill that has not begun", () => {
  const drill = TUTORIAL_DRILLS[indexOf("mine")]!;
  assert.equal(latchDrillStarted(drill, snapshot(), false), false);
});

test("the arrow follows the phase, not the live read", () => {
  // Checked on the fighter drill, whose three phases genuinely differ — the mine
  // drill points at both ends throughout, so it could not catch a regression.
  const drill = TUTORIAL_DRILLS[indexOf("fighter")]!;
  const idle = snapshot({ crystals: 0 });
  // Intro points at the miner you already have: the step is "you can afford a
  // fighter now". The TAB is highlighted by the derived pulse, not by a cone.
  assert.deepEqual(arrowTargetsFor(drill, idle, "intro")[0], {
    kind: "nearestUnit",
    unit: "miner",
  });
  // The meet beat points at BOTH ends of the red route: what arrived, and what
  // it is walking at. "This is coming, and it is going THERE."
  const meet = arrowTargetsFor(drill, idle, "meet").map((t) => t.kind);
  assert.deepEqual(meet, ["nearestEnemy", "commandCenter"]);
  const doing = arrowTargetsFor(drill, idle, "doing").map((t) => t.kind);
  assert.deepEqual(doing, ["nearestEnemy", "commandCenter"]);
});

// ── Step 3: the meet beat ───────────────────────────────────────────────────

test("a combat drill goes intro -> meet -> doing", () => {
  const drill = TUTORIAL_DRILLS[indexOf("astronaut")]!;
  assert.equal(drillPhase(drill, false, false), "intro");
  // Opponent released, not yet looked at.
  assert.equal(drillPhase(drill, true, false), "meet");
  // Looked at.
  assert.equal(drillPhase(drill, true, true), "doing");
});

test("a drill with no meet beat still runs intro -> doing", () => {
  // Adding the phase must not have changed any existing drill's behaviour.
  for (const id of ["orient", "mine", "done"]) {
    const drill = TUTORIAL_DRILLS[indexOf(id)]!;
    assert.equal(drill.meet, null);
    assert.equal(drillPhase(drill, false, false), "intro");
    // `met` is irrelevant when there is no meet beat.
    assert.equal(drillPhase(drill, true, false), "doing");
  }
});

test("the meet latch closes on accumulated looking", () => {
  const drill = TUTORIAL_DRILLS[indexOf("astronaut")]!;
  const need = drill.meet!.seconds;
  assert.equal(latchDrillMet(drill, 0, false), false);
  assert.equal(latchDrillMet(drill, need - 0.01, false), false);
  assert.equal(latchDrillMet(drill, need, false), true);
  // Latched: looking away afterwards does not re-freeze the world.
  assert.equal(latchDrillMet(drill, 0, true), true);
});

test("every combat drill has a meet beat, and it rings the enemy", () => {
  // The decision was "all three alien types", so this is the invariant rather
  // than three separate assertions that could drift apart.
  for (const drill of TUTORIAL_DRILLS) {
    if (!drill.opponent) continue;
    assert.ok(drill.meet, `drill "${drill.id}" has an opponent but no meet beat`);
    assert.equal(drill.meet!.gaze.kind, "nearestEnemy");
    assert.ok(drill.meet!.seconds > 0);
  }
});

test("the focus follows the phase", () => {
  // During a meet beat the ring is on the alien; afterwards there is no focus,
  // because a ring still burning would say "keep looking" instead of "act".
  const drill = TUTORIAL_DRILLS[indexOf("astronaut")]!;
  assert.equal(focusTargetFor(drill, "meet")?.kind, "nearestEnemy");
  assert.equal(focusTargetFor(drill, "intro"), null);
  assert.equal(focusTargetFor(drill, "doing"), null);
  // The orientation beat's focus comes from its trigger instead.
  const orient = TUTORIAL_DRILLS[indexOf("orient")]!;
  assert.equal(focusTargetFor(orient, "intro")?.kind, "commandCenter");
});

test("every combat drill draws the threat in red", () => {
  for (const drill of TUTORIAL_DRILLS) {
    if (!drill.opponent) continue;
    const meet = pathsFor(drill, "meet");
    assert.ok(
      meet.some((p) => p.style === "hostile"),
      `drill "${drill.id}" should show the threat while the player looks at it`,
    );
    const doing = pathsFor(drill, "doing").map((p) => p.style);
    assert.ok(doing.includes("hostile"), `drill "${drill.id}" lost the threat path`);
  }
});

test("only drills that SEND a unit draw a blue route", () => {
  // A blue trail is a journey. The turret is built where you place it and never
  // travels, so a route from the base to the tile would be drawing a walk that
  // never happens — the cone already says where to put it.
  const sends = new Set(["mine", "astronaut", "fighter"]);
  for (const drill of TUTORIAL_DRILLS) {
    const blue = (["intro", "meet", "doing"] as const).some((phase) =>
      pathsFor(drill, phase).some((p) => p.style === "friendly"),
    );
    assert.equal(
      blue,
      sends.has(drill.id),
      `drill "${drill.id}" blue route: expected ${sends.has(drill.id)}`,
    );
  }
});

// ── Phase 4: the wave gate, wave 0, and the bare start ──────────────────────

test("nothing is released before the first combat drill", () => {
  assert.equal(releaseBudget(indexOf("orient"), false), 0);
  assert.equal(releaseBudget(indexOf("mine"), false), 0);
  // Even if a non-combat drill somehow reported a release, it has no opponent
  // to contribute, so the budget stays shut.
  assert.equal(releaseBudget(indexOf("mine"), true), 0);
});

test("a drill's own opponent is released only once its trigger fires", () => {
  const astronaut = indexOf("astronaut");
  assert.equal(releaseBudget(astronaut, false), 0);
  assert.equal(releaseBudget(astronaut, true), 1);
});

test("the budget accumulates, so an earlier alien still walking is not recalled", () => {
  // Reaching the fighter drill means the astronaut's alien was already released.
  // Dropping back to 1 here would make the wave system consider it un-released
  // and hold the drake behind an alien that is already dead.
  assert.equal(releaseBudget(indexOf("fighter"), false), 1);
  assert.equal(releaseBudget(indexOf("fighter"), true), 2);
  assert.equal(releaseBudget(indexOf("turret"), true), 3);
});

test("a finished tutorial releases everything and stops holding", () => {
  const total = TUTORIAL_DRILLS.reduce(
    (sum, drill) => sum + (drill.opponent?.count ?? 0),
    0,
  );
  assert.equal(releaseBudget(-1, false), total);
  assert.equal(tutorialHoldsWaveCountdown(-1), false);
});

test("the countdown holds through Act 1 and lifts when an alien is owed", () => {
  // Act 1: nothing earned, nothing released, countdown frozen.
  assert.equal(tutorialHoldsWaveCountdown(indexOf("orient"), 0), true);
  assert.equal(tutorialHoldsWaveCountdown(indexOf("mine"), 0), true);
  // The moment the budget opens the hold MUST lift: the wave system only
  // releases from an active wave, and only the countdown produces activation.
  // Holding here is a deadlock, not extra safety — the live run proved it.
  assert.equal(tutorialHoldsWaveCountdown(indexOf("astronaut"), 1), false);
  // And a finished tutorial never holds.
  assert.equal(tutorialHoldsWaveCountdown(-1, 3), false);
});

test("the hold and the budget cannot disagree", () => {
  // The deadlock in one assertion: any drill with something owed must not hold.
  for (let drill = 0; drill < TUTORIAL_DRILLS.length; drill += 1) {
    const budget = releaseBudget(drill, true);
    if (budget <= 0) continue;
    assert.equal(
      tutorialHoldsWaveCountdown(drill, budget),
      false,
      `drill ${drill} owes ${budget} aliens but would freeze the countdown`,
    );
  }
});

test("the wave-0 roster has exactly one opponent per combat drill", () => {
  // The roster is derived from this list; if a drill gains an opponent the wave
  // must gain an alien, or the player is told to fight something absent.
  const opponents = TUTORIAL_DRILLS.filter((drill) => drill.opponent);
  assert.equal(opponents.length, 3);
  assert.deepEqual(
    opponents.map((drill) => drill.opponent!.enemy),
    ["alien", "alienDrake", "strongAlienMech"],
  );
  assert.equal(releaseBudget(-1, false), opponents.length);
});

test("the first alien spawns in the mine's corner", () => {
  // The mine nearest the base is (8, 11) on the 24-grid, so the corner is the
  // north-west one — on the miner's side of the board, ~13.6 tiles away, about
  // 24 seconds of walking at ALIEN_MOVE_SPEED.
  assert.deepEqual(nearestCornerTo({ x: 8, y: 11 }, 24), { x: 0, y: 0 });
  assert.deepEqual(nearestCornerTo({ x: 19, y: 17 }, 24), { x: 23, y: 23 });
  assert.deepEqual(nearestCornerTo({ x: 18, y: 6 }, 24), { x: 23, y: 0 });
});

test("the spawn corner is always a real tile on the board", () => {
  for (const tile of [{ x: 0, y: 0 }, { x: 23, y: 23 }, { x: 12, y: 12 }]) {
    const corner = nearestCornerTo(tile, 24);
    assert.ok(corner.x === 0 || corner.x === 23);
    assert.ok(corner.y === 0 || corner.y === 23);
  }
});

test("a drill never demands the unit it is about to teach", () => {
  // The bare start means the player has none of it yet, so requiring one alive
  // turns the drill's opening card into a recovery prompt for a unit they never
  // owned. This is the invariant, not just the fix to the one drill that had it.
  const broken = TUTORIAL_DRILLS.map((drill) =>
    drill.id === "fighter"
      ? { ...drill, keepAlive: ["miner", "fighter"] as readonly string[] }
      : drill,
  );
  const problems = validateDrills(broken);
  assert.ok(
    problems.some((problem) => problem.includes("the unit it teaches")),
    `expected the invariant to bite, got: ${problems.join("; ")}`,
  );
  assert.deepEqual(validateDrills(), []);
});

test("the astronaut drill does not open as a recovery prompt", () => {
  // The live failure: bare start, no astronaut, drill 3 greeted the player with
  // "Rebuild your astronaut" instead of teaching them to make their first.
  const drill = TUTORIAL_DRILLS[indexOf("astronaut")]!;
  assert.equal(
    resolveRecovery(drill, snapshot({ minerCount: 1, astronautCount: 0 })),
    null,
  );
});

test("every drill that needs a builder can recover one", () => {
  // The other half of invariant 3. A drill must not keep alive what it teaches,
  // but a drill that DEPENDS on an earlier unit must keep that one alive — or
  // the recovery prompt exists in the rules and fires for nothing.
  for (const drill of TUTORIAL_DRILLS) {
    const needsBuilder =
      drill.create !== null &&
      drill.create.kind !== "astronaut" &&
      (drill.create.via === "build" || drill.create.kind === "fighter");
    if (!needsBuilder) continue;
    assert.ok(
      (drill.keepAlive ?? []).includes("astronaut"),
      `drill "${drill.id}" needs a builder but would not prompt to replace one`,
    );
  }
});

// ── Future features: the gaze ring ──────────────────────────────────────────

test("gaze progress fills while looking and drains while not", () => {
  // Draining is the point. A ring that merely pauses tells the player nothing
  // about why it stopped; one that retreats says "come back".
  let progress = advanceGazeProgress(0, true, 1, 4, 1.6);
  assert.equal(progress, 1);
  progress = advanceGazeProgress(progress, true, 1, 4, 1.6);
  assert.equal(progress, 2);
  progress = advanceGazeProgress(progress, false, 1, 4, 1.6);
  assert.ok(progress < 2, "looking away must cost progress");
  assert.equal(progress, 2 - 1.6);
});

test("gaze progress is clamped at both ends", () => {
  // Never negative — a long look away must not bank a debt the player then has
  // to pay back before the ring moves at all.
  assert.equal(advanceGazeProgress(0, false, 10, 4, 1.6), 0);
  // And never past the requirement, so the ring cannot overfill.
  assert.equal(advanceGazeProgress(3.9, true, 10, 4, 1.6), 4);
});

test("a lookedAt drill completes on accumulated looking, not on a glance", () => {
  const drill = TUTORIAL_DRILLS[indexOf("orient")]!;
  const required = gazeRequirement(drill);
  assert.ok(required > 0, "the orientation beat must require real looking");

  // Looking right now, but no accumulated progress: NOT complete. This is the
  // bug the ring fixes — a glance used to satisfy the gate.
  const glance = snapshot({
    lookingAtFocus: true,
    gazeProgressSeconds: 0,
    stepElapsedSeconds: 999,
  });
  assert.equal(isDrillComplete(drill, glance, 0), false);

  // Progress banked: complete.
  const held = snapshot({
    lookingAtFocus: true,
    gazeProgressSeconds: required,
    stepElapsedSeconds: 999,
  });
  assert.equal(isDrillComplete(drill, held, 0), true);
});

test("time alone never completes the orientation beat", () => {
  // Ten minutes of standing still, looking the wrong way.
  const drill = TUTORIAL_DRILLS[indexOf("orient")]!;
  const away = snapshot({
    lookingAtFocus: false,
    gazeProgressSeconds: 0,
    stepElapsedSeconds: 600,
  });
  assert.equal(isDrillComplete(drill, away, 0), false);
});

test("the ring fraction maps progress onto 0..1", () => {
  assert.equal(gazeFraction(0, 4), 0);
  assert.equal(gazeFraction(2, 4), 0.5);
  assert.equal(gazeFraction(4, 4), 1);
  assert.equal(gazeFraction(9, 4), 1);
  // A zero requirement must read as full, not divide by zero into NaN.
  assert.equal(gazeFraction(0, 0), 1);
});

test("the focus effect is aimed by data, not by code", () => {
  // The whole point of the refactor: a gaze beat names an ArrowTarget, and the
  // dim, the light and the ring all follow it. Pointing the effect at an alien
  // instead of the base must be a catalog edit, not a code change.
  const orient = TUTORIAL_DRILLS[indexOf("orient")]!;
  const target = gazeTargetFor(orient);
  assert.ok(target, "the orientation beat must declare what to look at");
  assert.equal(target!.kind, "commandCenter");

  // Any target the arrow can resolve is a legal focus subject.
  for (const kind of ["nearestEnemy", "nearestUnit", "tile"] as const) {
    const drill: TutorialDrill = {
      ...orient,
      trigger: {
        kind: "lookedAt",
        target:
          kind === "nearestUnit"
            ? { kind, unit: "miner" }
            : kind === "tile"
              ? { kind, x: 3, y: 4 }
              : { kind },
      },
    };
    assert.equal(gazeTargetFor(drill)?.kind, kind);
  }
});

test("drills that are not gaze beats declare no focus", () => {
  // Otherwise every drill would dim the world.
  for (const id of ["mine", "astronaut", "fighter", "turret", "done"]) {
    assert.equal(
      gazeTargetFor(TUTORIAL_DRILLS[indexOf(id)]!),
      null,
      `drill "${id}" should not hold the world dimmed`,
    );
  }
});

// ── Future features 2a: more than one cone ──────────────────────────────────

test("the mine drill points at BOTH the miner and the crystals", () => {
  // The instruction is a relationship — that craft goes to those crystals — and
  // one cone can only name one end of it.
  const drill = TUTORIAL_DRILLS[indexOf("mine")]!;
  const intro = arrowTargetsFor(drill, snapshot(), false);
  const doing = arrowTargetsFor(drill, snapshot(), true);
  for (const [phase, targets] of [["intro", intro], ["doing", doing]] as const) {
    const kinds = targets.map((t) => t.kind);
    assert.ok(kinds.includes("nearestUnit"), `${phase} should point at the miner`);
    assert.ok(kinds.includes("nearestCrystal"), `${phase} should point at the crystals`);
  }
});

test("a single declared target still yields exactly one arrow", () => {
  // The array form must not force every drill to become a list.
  const drill = TUTORIAL_DRILLS[indexOf("orient")]!;
  assert.equal(arrowTargetsFor(drill, snapshot(), false).length, 1);
  assert.equal(arrowTargetFor(drill, snapshot(), false)?.kind, "commandCenter");
});

test("a drill with no arrows yields none, and allocates nothing new", () => {
  const drill = TUTORIAL_DRILLS[indexOf("done")]!;
  const a = arrowTargetsFor(drill, snapshot(), false);
  const b = arrowTargetsFor(drill, snapshot(), true);
  assert.equal(a.length, 0);
  // Same shared empty array both times — this runs at 4 Hz for the whole
  // sign-off beat, and a fresh [] each call is garbage for nothing.
  assert.equal(a, b);
});

test("no drill declares more arrows than the pool can show", () => {
  // Extra targets would be silently dropped, which is worse than a loud failure.
  const capacity = 3; // TUTORIAL_ARROW_POOL
  for (const drill of TUTORIAL_DRILLS) {
    for (const started of [false, true]) {
      const count = arrowTargetsFor(drill, snapshot(), started).length;
      assert.ok(
        count <= capacity,
        `drill "${drill.id}" declares ${count} arrows but the pool holds ${capacity}`,
      );
    }
  }
});

// ── The Living Path is data-driven too ──────────────────────────────────────

test("a drill's path is declared, not coded", () => {
  // Same principle as the focus effect: both ends are ordinary ArrowTargets, so
  // adding a route to a drill is a catalog edit.
  const mine = TUTORIAL_DRILLS[indexOf("mine")]!;
  // Before acting: an INSTRUCTION, "send it there".
  assert.equal(pathsFor(mine, "intro")[0]?.to.kind, "nearestCrystal");
  // Once working: a FORECAST that follows the mining cycle out and back.
  assert.equal(pathsFor(mine, "doing")[0]?.to.kind, "unitDestination");

  // The combat drills draw both sides at once: the threat in red, the answer
  // in blue. That pairing is the whole point of the colour language.
  const astronaut = pathsFor(TUTORIAL_DRILLS[indexOf("astronaut")]!, "doing");
  assert.equal(astronaut.length, 2);
  assert.deepEqual(
    astronaut.map((p) => p.style).sort(),
    ["friendly", "hostile"],
  );
  // Red shows what the alien is walking at; blue ends ON the alien, because
  // that is the click the game actually wants — an attack order is issued by
  // clicking the enemy itself (interaction.ts).
  const red = astronaut.find((p) => p.style === "hostile")!;
  const blue = astronaut.find((p) => p.style === "friendly")!;
  assert.equal(red.to.kind, "nearestUnit");
  assert.equal(blue.to.kind, "nearestEnemy");
});

test("instruction beats declare no path", () => {
  // Nothing is travelling during orientation or the sign-off.
  for (const id of ["orient", "done"]) {
    for (const phase of ["intro", "meet", "doing"] as const) {
      assert.equal(pathsFor(TUTORIAL_DRILLS[indexOf(id)]!, phase).length, 0);
    }
  }
});

test("every path endpoint is a target the system can resolve", () => {
  // The resolver switches exhaustively on kind; a path naming an unhandled kind
  // would compile and then silently draw nothing.
  const known = new Set([
    "commandCenter",
    "nearestUnit",
    "nearestCrystal",
    "tile",
    "tabletTab",
    "nearestEnemy",
    "threatTile",
    "interceptTile",
    "unitDestination",
  ]);
  for (const drill of TUTORIAL_DRILLS) {
    for (const phase of ["intro", "meet", "doing"] as const) {
    for (const path of pathsFor(drill, phase)) {
    for (const end of [path.from, path.to]) {
      assert.ok(
        known.has(end.kind),
        `drill "${drill.id}" path names unknown kind "${end.kind}"`,
      );
    }
    }
    }
  }
});

test("the second cone marks where the alien is going", () => {
  // Cone 1 on the thing that arrived, cone 2 on what it is walking at — the two
  // ends of the red route.
  for (const drill of TUTORIAL_DRILLS) {
    if (!drill.opponent) continue;
    const meet = arrowTargetsFor(drill, snapshot(), "meet");
    assert.equal(meet[0]?.kind, "nearestEnemy", `drill "${drill.id}"`);
    const red = pathsFor(drill, "meet").find((p) => p.style === "hostile");
    assert.deepEqual(meet[1], red!.to, `drill "${drill.id}" cone 2 vs red route end`);
  }
});

test("a blue route ends where the player has to click", () => {
  // An attack order is issued by clicking the ENEMY (interaction.ts orders the
  // unit onto the enemy's own tile). A route ending anywhere else would point
  // at a square where clicking achieves nothing.
  for (const id of ["astronaut", "fighter"]) {
    const drill = TUTORIAL_DRILLS[indexOf(id)]!;
    const paths = pathsFor(drill, "doing");
    const blue = paths.find((p) => p.style === "friendly")!;
    assert.equal(blue.to.kind, "nearestEnemy", `drill "${id}"`);
    // And it starts at the unit being taught, so it cannot draw before the
    // player has made one.
    assert.equal(blue.from.kind, "nearestUnit");
  }
});

// ── The saving-toward progress line ─────────────────────────────────────────

test("the mining drill looks ahead to what you are saving for", () => {
  // The mining drill creates nothing, so without looking ahead the card can
  // never answer "why am I hoarding crystals?".
  const goal = savingTowardFor(indexOf("mine"));
  assert.ok(goal);
  assert.equal(goal!.kind, "astronaut");
  assert.equal(goal!.cost, ASTRONAUT_COST);
});

test("a drill that creates something points at its own unit", () => {
  assert.equal(savingTowardFor(indexOf("astronaut"))?.kind, "astronaut");
  assert.equal(savingTowardFor(indexOf("fighter"))?.kind, "fighter");
  assert.equal(savingTowardFor(indexOf("turret"))?.kind, "turret");
});

test("the sign-off has nothing left to save for", () => {
  assert.equal(savingTowardFor(indexOf("done")), null);
  assert.equal(savingTowardFor(-1), null);
});

test("the progress line counts crystals, and says when you can afford it", () => {
  const goal = savingTowardFor(indexOf("mine"))!;
  assert.equal(goal.cost, ASTRONAUT_COST);
  assert.match(
    savingProgressLine(goal, 0),
    new RegExp(`0 / ${ASTRONAUT_COST} crystals toward an `),
  );
  assert.match(
    savingProgressLine(goal, ASTRONAUT_COST - 1),
    new RegExp(`^${ASTRONAUT_COST - 1} / ${ASTRONAUT_COST} crystals`),
  );
  // Affordable: the line stops nagging and starts inviting.
  assert.match(savingProgressLine(goal, ASTRONAUT_COST), /you can build an /);
  assert.match(savingProgressLine(goal, 99), /you can build an /);
  // No goal, no line — never a stray "0 / 0".
  assert.equal(savingProgressLine(null, 10), "");
});

// ── Tablet lock and tab hint ────────────────────────────────────────────────

test("the tab pulses only once the unit is affordable", () => {
  // A highlight over a tab with nothing affordable behind it teaches the player
  // to ignore highlights.
  const astronaut = TUTORIAL_DRILLS[indexOf("astronaut")]!;
  assert.equal(tabHintFor(astronaut, 0), null);
  assert.equal(tabHintFor(astronaut, ASTRONAUT_COST - 1), null);
  assert.equal(tabHintFor(astronaut, ASTRONAUT_COST), "build");
});

test("every drill that creates something pulses the right tab", () => {
  // The ask was "same for astronaut and turret as for fighter" — derived from
  // where the card actually lives, so all three are identical by construction
  // rather than by three separate catalog entries agreeing.
  //
  // The astronaut is the reason this is not `create.via`: it is *produced*, but
  // its card is on the BUILD tab beside the turret, because it comes from the
  // command center rather than a hangar.
  const expected: Record<string, "build" | "crafts"> = {
    astronaut: "build",
    fighter: "crafts",
    turret: "build",
  };
  for (const [id, tab] of Object.entries(expected)) {
    const drill = TUTORIAL_DRILLS[indexOf(id)]!;
    assert.equal(tabHintFor(drill, 9999), tab, `drill "${id}"`);
  }
});

test("instruction drills pulse no tab", () => {
  for (const id of ["orient", "mine", "done"]) {
    assert.equal(tabHintFor(TUTORIAL_DRILLS[indexOf(id)]!, 9999), null);
  }
});

test("the tablet lock names the drill's own unit", () => {
  assert.equal(allowedCreateKind(TUTORIAL_DRILLS[indexOf("astronaut")]!, null), "astronaut");
  assert.equal(allowedCreateKind(TUTORIAL_DRILLS[indexOf("turret")]!, null), "turret");
  // Nothing to create, nothing to lock.
  assert.equal(allowedCreateKind(TUTORIAL_DRILLS[indexOf("mine")]!, null), null);
  assert.equal(allowedCreateKind(undefined, null), null);
});

test("recovery outranks the drill, or the player is stranded", () => {
  // Locking the tablet to an astronaut while the miner is dead and there is no
  // income is a soft-lock with no exit but restart.
  const drill = TUTORIAL_DRILLS[indexOf("fighter")]!;
  assert.equal(
    allowedCreateKind(drill, { unit: "miner", affordable: true }),
    "miner",
  );
  assert.equal(
    allowedCreateKind(drill, { unit: "astronaut", affordable: true }),
    "astronaut",
  );
});

// ── Phase 5: recovery and dead-end presentation ─────────────────────────────

test("the card tone distinguishes a lesson from a loss", () => {
  // The whole point of 5a: three states that must not look alike.
  assert.equal(cardToneFor({ recovery: null, deadEnd: false }), "normal");
  assert.equal(
    cardToneFor({ recovery: { unit: "miner", affordable: true }, deadEnd: false }),
    "recovery",
  );
  // A dead end outranks a recovery, the same way it does in `advanceTutorial` —
  // if both were somehow set, "you cannot continue" is the true one.
  assert.equal(
    cardToneFor({ recovery: { unit: "miner", affordable: true }, deadEnd: true }),
    "deadEnd",
  );
});

test("a recovery prompt is priced", () => {
  // "Make another miner" with no number leaves the player unable to tell
  // whether they are 5 crystals away or 50.
  const miner = recoveryGoal({ unit: "miner", affordable: false })!;
  assert.equal(miner.kind, "miner");
  assert.equal(miner.cost, MINER_COST);
  // A display label, not the internal kind — this is read aloud on the card.
  assert.ok(miner.label.length > 0);
  const astronaut = recoveryGoal({ unit: "astronaut", affordable: true })!;
  assert.equal(astronaut.kind, "astronaut");
  assert.equal(astronaut.cost, ASTRONAUT_COST);
  assert.equal(recoveryGoal(null), null);
});

test("the recovery prompt renders through the same progress line", () => {
  const goal = recoveryGoal({ unit: "miner", affordable: false });
  assert.match(savingProgressLine(goal, 20), new RegExp(`20 / ${MINER_COST}`));
  assert.match(savingProgressLine(goal, MINER_COST), /banked/);
});

test("the tab pulse follows the recovery, not the drill", () => {
  // The lock already switches to the lost unit; the pulse must agree, or the
  // player gets a locked tab with no highlight telling them to go there.
  const drill = TUTORIAL_DRILLS[indexOf("turret")]!;   // a BUILD-tab drill
  const miner = { unit: "miner", affordable: true };   // a CRAFTS-tab unit
  assert.equal(tabHintFor(drill, 9999, miner), "crafts");
  // Unaffordable: no pulse, because the click behind it would fail.
  assert.equal(tabHintFor(drill, 9999, { unit: "miner", affordable: false }), null);
  // No recovery: unchanged behaviour.
  assert.equal(tabHintFor(drill, 9999, null), "build");
});

// ── Visual lifecycle: Finish/Skip detach, Restart reuses ────────────────────

test("tutorial visuals are pooled under a non-entity group so detach sticks", () => {
  const pool = readFileSync(
    new URL("../src/systems/tutorialVisualPool.ts", import.meta.url),
    "utf8",
  );

  // The whole design rests on this: TransformSystem re-parents every Transform
  // entity every frame, so a detached ENTITY is put straight back next frame.
  // Only the anchor may be an entity; the group and its meshes must not be.
  assert.match(pool, /createTransformEntity/);
  assert.match(pool, /removeFromParent/);
  assert.match(pool, /TransformSystem/);

  for (const module of [
    "tutorialArrow",
    "tutorialRing",
    "tutorialPath",
    "tutorialTurnCue",
    "tutorialSpotlight",
  ]) {
    const source = readFileSync(
      new URL(`../src/systems/${module}.ts`, import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      source,
      /createTransformEntity/,
      `${module} must pool under the visual pool's anchor, not create entities ` +
        `per mesh — an entity cannot stay detached`,
    );
    assert.match(
      source,
      /attachTutorialVisualPool/,
      `${module} must re-attach through the pool so Restart reuses its objects`,
    );
  }
});

test("every tutorial visual layer can be detached", () => {
  const tutorial = readFileSync(
    new URL("../src/systems/tutorial.ts", import.meta.url),
    "utf8",
  );

  // Finish or Skip must take the whole layer out of the scene, not hide it.
  for (const detach of [
    "detachTutorialVisualPool\\(cardPool\\)",
    "detachTutorialArrows\\(\\)",
    "detachTutorialRing\\(\\)",
    "detachTutorialPaths\\(\\)",
    "detachTutorialTurnCue\\(\\)",
    "detachTutorialSpotlight\\(\\)",
  ]) {
    assert.match(tutorial, new RegExp(detach));
  }
});

test("the turn cue and spotlight are lazy, not built in init", () => {
  for (const module of ["tutorialTurnCue", "tutorialSpotlight"]) {
    const source = readFileSync(
      new URL(`../src/systems/${module}.ts`, import.meta.url),
      "utf8",
    );
    // These two used to be created unconditionally in TutorialSystem.init(),
    // so a player who never enabled the tutorial still paid for them.
    assert.match(
      source,
      /function ensure(Cue|Spotlight)\(\): boolean/,
      `${module} must build on first use`,
    );
  }
});

test("a finished tutorial stops doing per-frame work", () => {
  const tutorial = readFileSync(
    new URL("../src/systems/tutorial.ts", import.meta.url),
    "utf8",
  );
  // Without this the card, arrow, ring and path checks ran every frame for
  // the rest of the match after the script was over.
  assert.match(tutorial, /if \(drillIndex < 0\) return;/);
});

test("re-enabling the tutorial mid-match requires a Restart", () => {
  const gate = readFileSync(
    new URL("../src/systems/tutorialWaveGate.ts", import.meta.url),
    "utf8",
  );
  const tutorial = readFileSync(
    new URL("../src/systems/tutorial.ts", import.meta.url),
    "utf8",
  );
  const tablet = readFileSync(
    new URL("../src/systems/tablet.ts", import.meta.url),
    "utf8",
  );

  // The flag lives in the wave-gate leaf because the tablet has to read it and
  // the tablet may never import the tutorial system (tablet.ts:135-136).
  assert.match(gate, /export function tutorialRequiresRestart/);
  assert.match(gate, /export function markTutorialLeft/);
  assert.match(gate, /export function clearTutorialLeft/);
  assert.doesNotMatch(
    tablet,
    /from "\.\/tutorial\.js"/,
    "the tablet must not import the tutorial system — that is the cycle rule",
  );

  // Finish and Skip both latch it; only Restart clears it.
  assert.match(tutorial, /markTutorialLeft\(\);/);
  assert.match(tutorial, /clearTutorialLeft\(\);/);
  assert.match(tutorial, /if \(tutorialRequiresRestart\(\)\) \{/);
  assert.match(tablet, /Restart to begin Tutorial/);
});

// ── Finding B: card vs tablet ──────────────────────────────────────────────

test("the tutorial card is near-opaque so the tablet cannot bleed through", () => {
  // At 0.90 the Quest capture showed profiler rows and the Build tab rendering
  // straight through the closing card. The material carries no `opacity`, so
  // these canvas alphas are the only source of translucency.
  const alphaOf = (fill: string): number =>
    Number(/rgba\([^)]*,\s*([0-9.]+)\)/.exec(fill)?.[1]);
  for (const [name, fill] of [
    ["TUTORIAL_CARD_BACKGROUND", TUTORIAL_CARD_BACKGROUND],
    ["TUTORIAL_CARD_RECOVERY_BACKGROUND", TUTORIAL_CARD_RECOVERY_BACKGROUND],
    ["TUTORIAL_CARD_DEAD_END_BACKGROUND", TUTORIAL_CARD_DEAD_END_BACKGROUND],
    ["TUTORIAL_CARD_DIM_BACKGROUND", TUTORIAL_CARD_DIM_BACKGROUND],
  ] as const) {
    const alpha = alphaOf(fill);
    assert.ok(
      Number.isFinite(alpha),
      `${name} is not an rgba() string: ${fill}`,
    );
    assert.ok(
      alpha >= 0.97,
      `${name} alpha is ${alpha}; below 0.97 the tablet reads through the card`,
    );
  }
});

test("the card steps clear of the tablet when placed", () => {
  const tutorial = readFileSync(
    new URL("../src/systems/tutorial.ts", import.meta.url),
    "utf8",
  );
  // Must run inside placeCard, before the anchor is converted to board space —
  // afterwards the offset would be applied in the wrong coordinate system.
  assert.match(
    tutorial,
    /this\.stepClearOfTablet\(\);[\s\S]{0,120}rootObject\.worldToLocal\(tmpAnchor\)/,
    "stepClearOfTablet must run before worldToLocal",
  );
  // Zero allocation: it reuses the module-level temporaries like every other
  // per-placement helper here.
  const body = /private stepClearOfTablet\(\): void \{[\s\S]*?\n  \}/.exec(
    tutorial,
  )?.[0];
  assert.ok(body, "stepClearOfTablet not found");
  assert.doesNotMatch(body!, /new Vector3\(/);
});

test("the tablet clearance is derived from the two widths, not typed", () => {
  const constants = readFileSync(
    new URL("../src/systems/constants.ts", import.meta.url),
    "utf8",
  );
  // Resizing the card or the tablet must move the clearance with it.
  assert.match(
    constants,
    /TUTORIAL_CARD_TABLET_CLEARANCE =\s*\n?\s*TUTORIAL_CARD_WIDTH \/ 2 \+ TABLET_FRAME_SIZE\[0\] \/ 2/,
  );
});

// ── Desktop start: the tutorial must not hold what it cannot run ───────────

test("a desktop start releases the tutorial's wave hold", () => {
  const tutorial = readFileSync(
    new URL("../src/systems/tutorial.ts", import.meta.url),
    "utf8",
  );

  // The rule: VR start respects the ON/OFF setting; a desktop start never runs
  // the tutorial and never lets it hold the waves.
  //
  // The deadlock this closes, measured 2026-08-26 with the tutorial enabled and
  // the match started flat: wave 0 pinned at `timer: 2`
  // (TUTORIAL_WAVE_ACTIVATION_LEAD_SECONDS) indefinitely, three aliens prepared
  // and never released, TutorialState inactive. The tutorial is VR-only, so it
  // held a countdown it could never release.
  assert.match(
    tutorial,
    /this\.goDormant\(isTutorialEnabled\(\) && matchAwaitingStart\(\)\)/,
    "the 2D-preview hold must be conditional on the match not having started",
  );
  assert.match(
    tutorial,
    /import \{ matchAwaitingStart \} from "\.\/matchStart\.js";/,
  );
});

test("matchStart has no import back into the tutorial", () => {
  // tutorial.ts -> matchStart.ts is a new edge. matchStart must stay a leaf or
  // it becomes the middle of a cycle, the same rule tutorialWaveGate.ts follows.
  const start = readFileSync(
    new URL("../src/systems/matchStart.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(start, /from "\.\/tutorial/);
  assert.doesNotMatch(start, /from "\.\/tablet/);
});

// ── Which level a run starts on, added 2026-08-27 ─────────────────────────

const systemSrc = (path: string): string =>
  readFileSync(new URL(`../src/systems/${path}`, import.meta.url), "utf8");
const systemCode = (path: string): string =>
  systemSrc(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

test("a desktop start never claims the tutorial's wave", () => {
  // Measured (`console-logs/..._Desktop_Vr.log`): a desktop run played `Lvl 0`
  // — the teaching wave, three aliens on a bare board — while the tutorial
  // retired on the first frame with `reason=not-immersive`. The player fought
  // the teaching wave with no teaching.
  const code = systemCode("tutorial.ts");

  // It must not be claimed UNCONDITIONALLY at init, where desktop-vs-VR is not
  // yet known — but it may be claimed from init's visibility subscription,
  // which only fires once the app is actually immersive. The distinction is the
  // whole fix, so assert the guard rather than the absence.
  const init = /\n  init\(\): void \{[\s\S]*?\n  \}\n/.exec(code)?.[0] ?? "";
  assert.ok(init, "init() not found");
  const bare = init.replace(
    /this\.world\.visibilityState\.subscribe\([\s\S]*?\n      \}\),/,
    "",
  );
  assert.doesNotMatch(
    bare,
    /claimTutorialLevel/,
    "init() must not claim the level outside the immersive subscription",
  );
  // And that subscription must be gated on Visible, not on any XR state.
  assert.match(init, /if \(state !== VisibilityState\.Visible\) return;/);

  // It must be claimed inside update(), AFTER the immersive guard — that guard
  // is what makes "the tutorial will actually run" true.
  const update = /\n  update\(delta: number\): void \{[\s\S]*?\n  \}\n/.exec(code)?.[0] ?? "";
  assert.ok(update, "update() not found");
  const guard = update.indexOf("visibilityState.peek() !== VisibilityState.Visible");
  const claim = update.indexOf("this.claimTutorialLevel()");
  assert.ok(guard >= 0, "the immersive guard is gone");
  assert.ok(claim >= 0, "update() never claims the level");
  assert.ok(claim > guard, "the claim must sit BEHIND the immersive guard");
});

test("leaving the tutorial does not advance the match to wave 1", () => {
  // The other half of the owner's rule: desktop starts at 1, but a VR run that
  // exits the tutorial stays where it is. Claiming is latched to once per
  // match, so a wave-0 clear mid-script cannot pull the match back either.
  const code = systemCode("tutorial.ts");
  assert.match(code, /let levelClaimed = false;/);
  assert.match(code, /if \(levelClaimed\) return;/);
  assert.match(code, /levelClaimed = true;/);
  // Cleared only by a restart, which is the one deliberate re-arm path.
  const reset = /export function resetTutorial\(\): void \{[\s\S]*?\n\}/.exec(code)?.[0] ?? "";
  assert.ok(reset, "resetTutorial not found");
  assert.match(reset, /levelClaimed = false;/);
  // And nothing in the tutorial ever pushes the wave forward.
  assert.doesNotMatch(code, /setValue\(WaveSource, "waveNumber", 1\)/);
});

test("restart has ONE owner for the wave-0 decision", () => {
  const code = systemCode("scenarioReset.ts");
  // It used to branch on `isTutorialEnabled()` — the setting, not whether the
  // tutorial can run — so a desktop restart went back to wave 0. Two owners of
  // one decision, and the one without the immersive check won.
  assert.doesNotMatch(code, /TUTORIAL_WAVE_NUMBER/);
  assert.match(code, /"waveNumber",\s*SCENARIO_RESET_DEFAULTS\.waveNumber,/);
  // resetTutorial() must still run, since clearing the latch is what lets the
  // tutorial re-claim wave 0 on the next update when it really is going to run.
  assert.match(code, /resetTutorial\(\)/);
});

test("only the tutorial reads the tutorial setting", () => {
  // The whole class of bug behind both fixes: `isTutorialEnabled()` is the
  // SETTING, which defaults on, and says nothing about whether the tutorial can
  // actually run. Two other files branched on it and both got desktop wrong —
  // the wave (structures/scenarioReset gave wave 0) and the board (a bare start
  // with no astronaut, for a tutorial that never arrived).
  for (const file of ["structures.ts", "scenarioReset.ts"]) {
    assert.doesNotMatch(
      systemCode(file),
      /isTutorialEnabled/,
      `${file} must not branch on the tutorial setting`,
    );
  }
  // And the cycle that used to make this impossible is gone.
  assert.doesNotMatch(systemCode("structures.ts"), /from "\.\/tutorial\.js"/);
});

test("the board is always built bare; the tutorial gives back what it withheld", () => {
  // Bare is the safe default because the correction is ADDITIVE. Building the
  // astronaut and removing it later would mean reproducing demolition.ts's
  // seven-step teardown, and missing one step is a leak.
  const structures = systemCode("structures.ts");
  assert.match(structures, /createInitialScenario\(this\.world, \{ bareStart: true \}\)/);
  assert.match(systemCode("scenarioReset.ts"), /createInitialScenario\(this\.world, \{ bareStart: true \}\)/);

  // The additive path must reuse the same loop, not re-implement placement.
  assert.match(
    structures,
    /export function createTutorialOmittedStructures\(world: World\): void \{\s*createInitialScenario\(world, \{ only: TUTORIAL_OMITTED_STRUCTURES \}\);/,
  );

  // Restored exactly when the script never ran — and NOT when it did, or a run
  // that reached the astronaut drill would be handed a free one on the way out.
  const tutorial = systemCode("tutorial.ts");
  assert.match(tutorial, /if \(!levelClaimed\) createTutorialOmittedStructures\(this\.world\);/);
  // It sits inside the once-per-match retirement block, not on the every-frame
  // dormant path — goDormant runs ~90x/s and this creates entities.
  const dormant = /private goDormant[\s\S]*?\n  \}/.exec(tutorial)?.[0] ?? "";
  const guardAt = dormant.indexOf("if (!wasRetired) {");
  const restoreAt = dormant.indexOf("createTutorialOmittedStructures");
  assert.ok(guardAt >= 0 && restoreAt > guardAt, "the restore must be behind the once-only guard");
});

test("entering XR mid-match never drags the match back to the tutorial wave", () => {
  // Measured (`console-logs/..._Desktop_Vr_v2.log`): a desktop run sat at
  // `Lvl 1 active | Enemies 11 alive`; `[Action] xr enter` landed at line 1702;
  // twelve lines later it read `Lvl 0 active | Enemies 14 alive`. The match was
  // dragged back to the teaching wave and wave 0's three aliens spawned on top
  // of the eleven already fighting.
  //
  // Cause: `claimTutorialLevel` relied on `tutorialRequiresRestart()` being
  // checked by `update()`, its only caller at the time. The visibility
  // subscription became a second caller and did not carry the precondition.
  const code = systemCode("tutorial.ts");
  const claim = /private claimTutorialLevel\(\): void \{[\s\S]*?\n  \}/.exec(code)?.[0] ?? "";
  assert.ok(claim, "claimTutorialLevel not found");

  // Self-guarding: the check must be IN the function, not only in a caller.
  assert.match(claim, /if \(tutorialRequiresRestart\(\)\) return;/);

  // ...and it must come before anything is written to the wave source, or the
  // guard would run after the damage.
  const guardAt = claim.indexOf("tutorialRequiresRestart()");
  const writeAt = claim.indexOf('setValue(WaveSource, "waveNumber"');
  assert.ok(writeAt > guardAt, "the retirement guard must precede the wave write");

  // The latch must not be consumed by a refused claim either — a run that
  // legitimately claims later must still be able to.
  const latchAt = claim.indexOf("levelClaimed = true;");
  assert.ok(latchAt > guardAt, "a refused claim must not burn the latch");
});
