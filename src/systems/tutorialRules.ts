import { canUnitAttack } from "./combatRules.ts";
import { getBuildingSpec } from "./buildingCatalog.ts";
import { getProductionSpec } from "./craftCatalog.ts";
import {
  TUTORIAL_DRILLS,
  type ArrowTarget,
  type TutorialDrill,
} from "./tutorialCatalog.ts";

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
   * Is the current drill's gaze subject within the player's view cone?
   *
   * Deliberately not named for the command center: the focus effect works for
   * any subject the tutorial can point at, and a snapshot field named after one
   * of them would have to be renamed the first time it was used for another.
   */
  lookingAtFocus: boolean;
  /**
   * Seconds of accumulated LOOKING, not of elapsed time — it fills while the
   * player is on target and drains when they are not. This is what the gaze
   * ring draws, and what a `lookedAt` trigger is measured against.
   */
  gazeProgressSeconds: number;
  /** False once the base is gone. Its own dead end — see isDeadEnd. */
  commandCenterAlive: boolean;
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

    // 3. A drill cannot require the unit it teaches to already be alive. With
    //    a bare start the player has none, so the drill would open with a
    //    recovery prompt for something they never owned. Found the moment the
    //    bare start landed in phase 4.
    if (drill.create && (drill.keepAlive ?? []).includes(drill.create.kind)) {
      problems.push(
        `drill "${drill.id}" keeps alive "${drill.create.kind}", which is the unit it teaches`,
      );
    }

    // 4. Racer production and turret construction both need a builder, so the
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
 * The two unrecoverable states.
 *
 * 1. **No income, no way to buy income.** Only miners mine, so with no miner and
 *    fewer crystals than one costs, nothing can ever be built again. Every other
 *    unit loss recovers given time — which is why an astronaut death waits
 *    rather than ending the run.
 * 2. **No command center.** It is the loss condition; there is nothing to
 *    defend and nothing to produce from.
 *
 * The second is belt-and-braces: as of 2026-08-19 losing the base sets
 * `MatchState.status` to defeat, which takes the tutorial inactive before this
 * is reached. It is kept because the tutorial samples at 4 Hz and should never
 * be caught instructing a player to defend a base that no longer exists.
 */
export function isDeadEnd(snapshot: TutorialSnapshot): boolean {
  if (!snapshot.commandCenterAlive) return true;
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

/**
 * How long a `lookedAt` drill needs the player to actually look.
 *
 * The same number as `minSeconds`, deliberately: the floor exists so a card is
 * readable, and for a gaze beat "long enough to read" and "long enough to have
 * found it" are the same requirement. One knob, one ring, one meaning.
 */
export function gazeRequirement(drill: TutorialDrill): number {
  return Math.max(0, drill.minSeconds ?? 0);
}

/**
 * What this drill wants the player to look at, or null if it is not a gaze beat.
 *
 * The whole reusability of the focus effect rests here: it returns an
 * `ArrowTarget`, which the system already knows how to resolve to a position and
 * an object — so pointing the dim, the light and the ring at an alien instead of
 * the base is a data change, not a code change.
 */
export function gazeTargetFor(drill: TutorialDrill): ArrowTarget | null {
  return drill.trigger.kind === "lookedAt" ? drill.trigger.target : null;
}

/**
 * Advance the gaze clock: fill while looking, drain while not.
 *
 * Draining is the point. A ring that merely pauses tells the player nothing
 * about why it stopped; one that visibly retreats says "come back". Pure, with
 * the previous value passed in, so the caller owns the storage.
 */
export function advanceGazeProgress(
  current: number,
  looking: boolean,
  delta: number,
  required: number,
  drainRate: number,
): number {
  const step = Math.max(0, delta);
  const next = looking ? current + step : current - step * drainRate;
  return Math.max(0, Math.min(required, next));
}

/** 0..1 for the ring, given the drill's requirement. */
export function gazeFraction(progress: number, required: number): number {
  if (required <= 0) return 1;
  return Math.max(0, Math.min(1, progress / required));
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
    case "lookedAt":
      // Accumulated looking, not "is looking right now". The gaze ring makes
      // this legible: a glance no longer completes the beat, and looking away
      // visibly costs progress rather than silently pausing it.
      return snapshot.gazeProgressSeconds >= gazeRequirement(drill);
    case "dwellSeconds":
      return snapshot.stepElapsedSeconds >= drill.trigger.seconds;
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
 * Has the player visibly begun this drill? Drives the card from `intro` to
 * `doing`, so a click that does not complete a step still produces feedback.
 *
 * The miner drill is why this exists: it completes at four trips, so ordering
 * the miner to a crystal patch changes nothing the player can see. Without
 * this, the first thing a new player ever does is met with silence.
 */
export function hasDrillStarted(
  drill: TutorialDrill,
  snapshot: TutorialSnapshot,
): boolean {
  // A combat drill has "started" once its opponent is on the board.
  if (drill.opponent) return triggerMet(drill, snapshot);
  switch (drill.trigger.kind) {
    case "immediate":
      return true;
    case "minerTrips":
      // Either the miner is on its way, or something has already been banked.
      return snapshot.ordersIssued > 0 || snapshot.crystalsMined > 0;
    case "crystalsAtLeast":
      return snapshot.crystals > 0;
    case "lookedAt":
    case "dwellSeconds":
      // Instruction beats have nothing to "start" — they read the same
      // throughout, so the card never switches to `doing`.
      return true;
  }
}

/**
 * Has this drill started, given that it may already have?
 *
 * `hasDrillStarted` reads live state, and live state can go backwards: the miner
 * drill counts "on its way" as started, but `hasOrder` clears the instant the
 * miner arrives, and nothing is banked until the first deposit lands seconds
 * later. In that window the card reverted from *"It mines and carries it back on
 * its own"* to *"Click your mining craft, then click the nearest crystals"* —
 * un-acknowledging the player while they watched their miner do the thing.
 *
 * So started is a **latch**: once true for a drill it stays true, and only a new
 * drill clears it. Pure, with the previous value passed in, so the caller owns
 * the storage and this stays testable.
 */
export function latchDrillStarted(
  drill: TutorialDrill,
  snapshot: TutorialSnapshot,
  wasStarted: boolean,
): boolean {
  return wasStarted || hasDrillStarted(drill, snapshot);
}

/**
 * How many of wave 0's aliens the tutorial permits to be on the board.
 *
 * Every opponent from a **completed** drill counts — those aliens were already
 * released and may still be walking — plus the current drill's own, once its
 * trigger has fired. The wave system then releases up to this many and no more.
 *
 * Derived from the drill list rather than tracked separately, so adding a drill
 * with an opponent widens the budget automatically. A hand-maintained counter
 * would drift the moment someone reordered the script.
 *
 * `drillIndex < 0` means the tutorial has finished: everything is permitted,
 * which is what hands the board back to the normal ladder.
 */
export function releaseBudget(
  drillIndex: number,
  releaseCurrent: boolean,
  drills: readonly TutorialDrill[] = TUTORIAL_DRILLS,
): number {
  const total = drills.reduce(
    (sum, drill) => sum + (drill.opponent?.count ?? 0),
    0,
  );
  if (drillIndex < 0) return total;

  let budget = 0;
  for (let index = 0; index < drills.length && index < drillIndex; index += 1) {
    budget += drills[index].opponent?.count ?? 0;
  }
  if (releaseCurrent) {
    budget += drills[drillIndex]?.opponent?.count ?? 0;
  }
  return budget;
}

/**
 * Does the tutorial still need to freeze the wave countdown?
 *
 * **Only while nothing is owed yet** — i.e. while the budget is 0. That is Act
 * 1: the player is mining, and no alien has been earned.
 *
 * It must lift the moment the budget opens, because the wave system only
 * releases aliens once the wave has ACTIVATED, and activation is what the
 * countdown produces. Holding the countdown through Act 2 as well looks like it
 * would be the safer, stricter choice; it is actually a deadlock — the budget
 * opens and nothing is ever released, because the wave is still counting down.
 * That is exactly what shipped and what the in-app run caught.
 *
 * Pacing does not go back to the clock: once active, the wave releases only up
 * to the budget, which is still driven entirely by the drills.
 */
export function tutorialHoldsWaveCountdown(
  drillIndex: number,
  budget: number,
): boolean {
  return drillIndex >= 0 && budget <= 0;
}

/** A board coordinate. Duplicated rather than imported to keep this file pure. */
export interface TutorialTile {
  x: number;
  y: number;
}

/**
 * Which way an edge lies from the middle of the board.
 *
 * Mirrors `edgeCells()` in `waveCatalog.ts`: north is y=0, south is y=last,
 * west is x=0, east is x=last. If that ever changes, the threat arrow points
 * the wrong way while everything else keeps working — which is why the test
 * asserts the pairing rather than trusting the name.
 */
export function edgeStep(edge: string): TutorialTile {
  switch (edge) {
    case "north":
      return { x: 0, y: -1 };
    case "south":
      return { x: 0, y: 1 };
    case "west":
      return { x: -1, y: 0 };
    default:
      return { x: 1, y: 0 };
  }
}

function clampTile(value: number, gridSize: number): number {
  return Math.max(0, Math.min(gridSize - 1, Math.round(value)));
}

/**
 * The tile the tutorial points at when it says "build on the side they come
 * from": the base, stepped `steps` tiles toward the incoming edge.
 *
 * Clamped to the board, so a base already near the edge yields a tile on the
 * board rather than off it. Being clamped short is harmless — the arrow is
 * advisory and the direction still reads.
 */
export function threatTileFor(
  base: TutorialTile,
  edge: string,
  steps: number,
  gridSize: number,
): TutorialTile {
  const step = edgeStep(edge);
  return {
    x: clampTile(base.x + step.x * steps, gridSize),
    y: clampTile(base.y + step.y * steps, gridSize),
  };
}

/**
 * Where to stand to get between a threatened unit and what is coming for it:
 * the midpoint, biased toward the threat so the defender arrives in front of
 * the unit rather than on top of it.
 *
 * A plain midpoint puts the astronaut halfway, which loses the race whenever
 * the alien is closer than the astronaut — the exact case the drill is about.
 */
export function interceptTileFor(
  unit: TutorialTile,
  threat: TutorialTile,
  gridSize: number,
  bias = 0.65,
): TutorialTile {
  return {
    x: clampTile(unit.x + (threat.x - unit.x) * bias, gridSize),
    y: clampTile(unit.y + (threat.y - unit.y) * bias, gridSize),
  };
}

/**
 * The board corner nearest a tile — where the tutorial's first alien lands.
 *
 * This is the "spawn it in the corner of where the mine is, furthest away from
 * it" rule, resolved: a corner *of the mine's own side of the board* is on the
 * miner's side, so the alien walks toward the mining area and the drill's lesson
 * ("it is heading for your mining craft") is reliable — while a corner is about
 * as far from the mine as that side of the board goes, which is what buys the
 * player time to react.
 *
 * With the mine at (8, 11) on a 24-grid this is (0, 0): ~13.6 tiles, or about
 * **24 seconds** of walking at `ALIEN_MOVE_SPEED`. Ties break toward the lower
 * corner, which only matters for a mine exactly on a centre line.
 */
export function nearestCornerTo(
  tile: TutorialTile,
  gridSize: number,
): TutorialTile {
  const last = Math.max(0, gridSize - 1);
  const corners: TutorialTile[] = [
    { x: 0, y: 0 },
    { x: last, y: 0 },
    { x: 0, y: last },
    { x: last, y: last },
  ];
  let best = corners[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const corner of corners) {
    const dx = corner.x - tile.x;
    const dy = corner.y - tile.y;
    const distance = dx * dx + dy * dy;
    if (distance >= bestDistance) continue;
    bestDistance = distance;
    best = corner;
  }
  return best;
}

/**
 * Is the hinted tablet tab lit this instant?
 *
 * A square wave, not a fade — see TUTORIAL_TAB_PULSE_SECONDS. Pure so the
 * duty cycle is testable without a tablet.
 */
export function tabPulseOn(elapsedSeconds: number, period: number): boolean {
  if (period <= 0) return true;
  return Math.floor(elapsedSeconds / period) % 2 === 0;
}

/**
 * Which arrow this drill wants right now — the same intro/doing split the card
 * uses, so the words and the pointing never disagree.
 */
export function arrowTargetFor(
  drill: TutorialDrill,
  snapshot: TutorialSnapshot,
  /** The caller's latched value — see latchDrillStarted. Omit to read live. */
  started = hasDrillStarted(drill, snapshot),
): ArrowTarget | null {
  return arrowTargetsFor(drill, snapshot, started)[0] ?? null;
}

/** Shared empty result, so the common no-arrow case allocates nothing. */
const NO_ARROWS: readonly ArrowTarget[] = [];

/**
 * Every target this drill wants pointed at right now.
 *
 * A drill may name one target, several, or none — "send this craft to those
 * crystals" needs two cones, because one cone can only name one end of a
 * relationship. `arrowTargetFor` above is the single-target view, kept for the
 * tab hint and the problem report, and defined in terms of this.
 */
export function arrowTargetsFor(
  drill: TutorialDrill,
  snapshot: TutorialSnapshot,
  started = hasDrillStarted(drill, snapshot),
): readonly ArrowTarget[] {
  const declared = started ? drill.arrows.doing : drill.arrows.intro;
  if (!declared) return NO_ARROWS;
  return Array.isArray(declared) ? declared : [declared as ArrowTarget];
}

/**
 * Does resolving this target require a living command center?
 *
 * Both of these derive from the base, and the base can be destroyed — at which
 * point `boardState.commandCenter` is null. The system must render **no arrow**
 * rather than resolving to the world origin, which is board centre and would
 * point confidently at where the base used to be.
 */
export function arrowNeedsCommandCenter(target: ArrowTarget): boolean {
  return target.kind === "commandCenter" || target.kind === "threatTile";
}

/**
 * Can this target be pointed at right now? False means draw nothing.
 *
 * An arrow aimed at nothing is worse than no arrow: the card still has words,
 * but a confident pointer at the wrong place actively misleads.
 */
export function canResolveArrow(
  target: ArrowTarget | null,
  snapshot: TutorialSnapshot,
): boolean {
  if (!target) return false;
  if (arrowNeedsCommandCenter(target) && !snapshot.commandCenterAlive) {
    return false;
  }
  if (target.kind === "nearestEnemy" && snapshot.liveEnemyCount === 0) {
    return false;
  }
  if (target.kind === "interceptTile" && snapshot.liveEnemyCount === 0) {
    return false;
  }
  return true;
}

/**
 * Why the arrow cannot be drawn — a short reason for the log — or null when
 * there is nothing worth reporting.
 *
 * Deliberately quiet about the one routine case: a combat drill's intro points
 * at `nearestEnemy` *before* its opponent has been released, which happens on
 * every single run. Warning about that would train whoever reads the console to
 * ignore the message, and the one time it mattered they would.
 *
 * What is left is genuinely worth seeing: a base-derived arrow with no base, or
 * a target that should have resolved and did not — which usually means the
 * drill declares the wrong target for what is on the board.
 */
export function arrowProblem(
  drill: TutorialDrill,
  snapshot: TutorialSnapshot,
  started = hasDrillStarted(drill, snapshot),
): string | null {
  const target = arrowTargetFor(drill, snapshot, started);
  // No arrow declared is a choice, not a failure.
  if (!target) return null;
  if (canResolveArrow(target, snapshot)) return null;

  const awaitingRelease =
    (target.kind === "nearestEnemy" || target.kind === "interceptTile") &&
    !shouldReleaseOpponent(drill, snapshot);
  if (awaitingRelease) return null;

  if (arrowNeedsCommandCenter(target) && !snapshot.commandCenterAlive) {
    return `drill "${drill.id}" points at ${target.kind}, but the command center is gone`;
  }
  // Released, but nothing arrived. Until the wave gate exists (phase 4) this is
  // routine — "release" only unblocks a spawn that nothing is yet performing —
  // so the message names the actual condition rather than shrugging. Kept as a
  // warning on purpose: once phase 4 lands, a released opponent that never
  // appears is a real defect, and this is the line that would report it.
  if (target.kind === "nearestEnemy" || target.kind === "interceptTile") {
    return `drill "${drill.id}" points at ${target.kind}, but no enemy is on the board`;
  }
  return `drill "${drill.id}" points at ${target.kind}, which cannot be resolved`;
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
  // A card nobody had time to read taught nothing, however satisfied its
  // trigger is. This is a floor on display time, not a timer that completes.
  if (snapshot.stepElapsedSeconds < (drill.minSeconds ?? 0)) return false;
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
