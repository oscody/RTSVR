import { canUnitAttack } from "./combatRules.ts";
import { getBuildingSpec } from "./buildingCatalog.ts";
import { getProductionSpec } from "./craftCatalog.ts";
import { TUTORIAL_DRILLS, type TutorialDrill } from "./tutorialCatalog.ts";

/**
 * Pure decision layer for the tutorial.
 *
 * No IWSDK, no ECS, no Three — so the entire script, including the failure
 * modes that are impossible to reproduce on purpose in a headset, is testable
 * without constructing a world. Mirrors `underAttackAlertRules.ts`.
 *
 * Design: `RTSVR_repos/devlog/plan/2026-08-09-Tutorial-System-Plan.md`.
 */

/** Replacement cost of the only unit that generates income. */
export const MINER_COST = 60;
/** Replacement cost of the builder. */
export const ASTRONAUT_COST = 35;
/** Crystals per completed mining trip (mirrors DEFAULT_RESOURCE_AMOUNT_PER_TRIP). */
export const CRYSTALS_PER_TRIP = 10;

/**
 * Everything the rules need, sampled from the world by TutorialSystem.
 * Plain numbers and booleans so tests can construct one by hand.
 */
export interface TutorialSnapshot {
  selectedUnitCount: number;
  ordersIssued: number;
  crystals: number;
  crystalsMined: number;
  minerCount: number;
  astronautCount: number;
  constructionSiteCount: number;
  turretCount: number;
  enemiesKilled: number;
  liveEnemyCount: number;
  matchStatus: string;
  stepElapsedSeconds: number;
  /**
   * Monotonic. Read the revision rather than a visible flag so a sighting
   * banner that appeared and expired between two samples is still observed.
   */
  alertRevision: number;
}

export type RecoveryUnit = "miner" | "astronaut";

export interface TutorialRecovery {
  unit: RecoveryUnit;
  /** False means "keep mining" — the prompt waits rather than ending the run. */
  affordable: boolean;
}

export interface TutorialProgress {
  /** Index into TUTORIAL_DRILLS; -1 once finished or inactive. */
  drill: number;
  advanced: boolean;
  /** Act 1: the countdown stays frozen. */
  holdsWaves: boolean;
  /** Whether this drill's opponent may be released now. */
  releaseOpponent: boolean;
  recovery: TutorialRecovery | null;
  /** No miner and no way to buy one — the only unrecoverable state. */
  deadEnd: boolean;
}

/** Cost of whatever a drill asks the player to create. 0 for instruction drills. */
export function drillCost(drill: TutorialDrill): number {
  if (!drill.create) return 0;
  const spec =
    drill.create.via === "build"
      ? getBuildingSpec(drill.create.kind)
      : getProductionSpec(drill.create.kind);
  return spec?.cost ?? 0;
}

/** Can the unit a drill teaches actually kill things? Turrets are buildings. */
export function drillUnitCanFight(drill: TutorialDrill): boolean {
  if (!drill.create) return false;
  if (drill.create.via === "build") return drill.create.kind === "turret";
  return canUnitAttack(drill.create.kind);
}

/**
 * The three invariants that cannot be expressed in the type system, checked
 * here so a badly-written drill fails a test rather than soft-locking a player.
 *
 * Returns a list of human-readable problems; empty means the list is sound.
 */
export function validateDrills(
  drills: readonly TutorialDrill[] = TUTORIAL_DRILLS,
): string[] {
  const problems: string[] = [];
  let astronautIndex = -1;

  drills.forEach((drill, index) => {
    if (drill.create?.kind === "astronaut") astronautIndex = index;

    // 1. An opponent needs a unit that can kill it. Pairing the miner with an
    //    alien would hand the player an objective they cannot complete.
    if (drill.opponent && !drillUnitCanFight(drill)) {
      problems.push(
        `drill "${drill.id}" has an opponent but its unit cannot attack`,
      );
    }

    // 2. The counter must be affordable when its enemy is released, or the
    //    no-fail guarantee is a hope rather than a property.
    if (drill.opponent && drill.trigger.kind === "crystalsAtLeast") {
      const cost = drillCost(drill);
      if (drill.trigger.amount < cost) {
        problems.push(
          `drill "${drill.id}" releases at ${drill.trigger.amount} crystals but its unit costs ${cost}`,
        );
      }
    }

    // 3. Racer production and turret construction both need a builder, so the
    //    astronaut drill has to come first. Astronaut production is the one
    //    builder-exempt path, which is what makes a bare start survivable.
    const needsBuilder =
      drill.create !== null &&
      drill.create.kind !== "astronaut" &&
      (drill.create.via === "build" || drill.create.kind === "racer");
    if (needsBuilder && (astronautIndex < 0 || astronautIndex > index)) {
      problems.push(
        `drill "${drill.id}" needs a builder but no astronaut drill precedes it`,
      );
    }
  });

  return problems;
}

/**
 * Income requires a miner — nothing else mines. So the run is unrecoverable
 * only when there is no miner AND no way to buy one. Every other loss recovers
 * given time, which is why an astronaut death waits rather than ending the run.
 */
export function isDeadEnd(snapshot: TutorialSnapshot): boolean {
  return snapshot.minerCount === 0 && snapshot.crystals < MINER_COST;
}

/**
 * What the player has lost that the current drill depends on, if anything.
 * `affordable: false` with a live miner means "wait and keep mining".
 */
export function resolveRecovery(
  drill: TutorialDrill,
  snapshot: TutorialSnapshot,
): TutorialRecovery | null {
  const keep = drill.keepAlive ?? [];
  if (keep.includes("miner") && snapshot.minerCount === 0) {
    return { unit: "miner", affordable: snapshot.crystals >= MINER_COST };
  }
  if (keep.includes("astronaut") && snapshot.astronautCount === 0) {
    return {
      unit: "astronaut",
      affordable: snapshot.crystals >= ASTRONAUT_COST,
    };
  }
  return null;
}

/** Trigger evaluation — what gates this drill's opponent, or its completion. */
function triggerMet(drill: TutorialDrill, snapshot: TutorialSnapshot): boolean {
  switch (drill.trigger.kind) {
    case "immediate":
      return true;
    case "minerTrips":
      return snapshot.crystalsMined >= drill.trigger.count * CRYSTALS_PER_TRIP;
    case "crystalsAtLeast":
      return snapshot.crystals >= drill.trigger.amount;
  }
}

/** Has this drill's release condition been met? */
export function shouldReleaseOpponent(
  drill: TutorialDrill,
  snapshot: TutorialSnapshot,
): boolean {
  return drill.opponent !== null && triggerMet(drill, snapshot);
}

/**
 * Is this drill finished?
 *
 * A combat drill ends when its opponent is dead — counted relative to the
 * drill's own start, so kills banked earlier cannot complete it. An
 * instruction drill (no opponent) ends when its trigger is met, which for the
 * miner means four completed trips.
 */
export function isDrillComplete(
  drill: TutorialDrill,
  snapshot: TutorialSnapshot,
  enemiesKilledAtDrillStart: number,
): boolean {
  if (!drill.opponent) return triggerMet(drill, snapshot);
  return (
    snapshot.enemiesKilled - enemiesKilledAtDrillStart >= drill.opponent.count
  );
}

/**
 * Advance the tutorial one evaluation. Pure: same inputs, same output.
 *
 * `enemiesKilledAtDrillStart` lets a combat drill measure kills relative to its
 * own beginning, so kills banked during an earlier drill do not complete it.
 */
export function advanceTutorial(
  drillIndex: number,
  snapshot: TutorialSnapshot,
  enemiesKilledAtDrillStart: number,
  drills: readonly TutorialDrill[] = TUTORIAL_DRILLS,
): TutorialProgress {
  const inactive: TutorialProgress = {
    drill: -1,
    advanced: false,
    holdsWaves: false,
    releaseOpponent: false,
    recovery: null,
    deadEnd: false,
  };

  // Finished, or never started.
  if (drillIndex < 0 || drillIndex >= drills.length) return inactive;

  // Victory/defeat/restart end the tutorial rather than fighting the match.
  if (snapshot.matchStatus !== "playing") return inactive;

  const drill = drills[drillIndex];

  // A dead end outranks everything: no income and no way to buy income.
  if (isDeadEnd(snapshot)) {
    return {
      drill: drillIndex,
      advanced: false,
      // Hold waves so a stalled player is not also being attacked while the
      // restart offer is up.
      holdsWaves: true,
      releaseOpponent: false,
      recovery: null,
      deadEnd: true,
    };
  }

  // Recovery interrupts: releases pause so a rebuilding player is never
  // simultaneously attacked.
  const recovery = resolveRecovery(drill, snapshot);
  if (recovery) {
    return {
      drill: drillIndex,
      advanced: false,
      holdsWaves: true,
      releaseOpponent: false,
      recovery,
      deadEnd: false,
    };
  }

  const complete = isDrillComplete(drill, snapshot, enemiesKilledAtDrillStart);
  if (complete) {
    const next = drillIndex + 1;
    return {
      drill: next >= drills.length ? -1 : next,
      advanced: true,
      holdsWaves: false,
      releaseOpponent: false,
      recovery: null,
      deadEnd: false,
    };
  }

  return {
    drill: drillIndex,
    advanced: false,
    // Act 1 is any drill with no opponent — nothing to fight yet.
    holdsWaves: drill.opponent === null,
    releaseOpponent: shouldReleaseOpponent(drill, snapshot),
    recovery: null,
    deadEnd: false,
  };
}
