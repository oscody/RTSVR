/**
 * The contract registry: what is supposed to reach whom, by when, and what it
 * means when it does not.
 *
 * ## The registry is data, and the timings are measured, not assumed
 *
 * Every `timing` below was taken from the Phase 0 audit's execution-order
 * derivation, not from what the code looks like it ought to do. Two of them are
 * `next-frame` precisely because the reader runs EARLIER in `world.update` than
 * the writer — the tablet reads the crystal balance at registration index 16
 * and `MiningSystem` writes it at index 32 — and writing those down as
 * `same-frame` would have manufactured a failure out of correct code.
 *
 * **No system is reordered to satisfy a contract.** Where the architecture is
 * one frame late, the contract says one frame late.
 *
 * ## Two shapes of check
 *
 * - **Immediate** — the condition is decidable at the moment it is checked
 *   (`activeAliens <= cap`). {@link checkContract} records a pass or a fail.
 * - **Handoff** — a value is published and one or more consumers are expected
 *   to act on it within a deadline. {@link expectHandoff} opens it,
 *   {@link observeHandoff} closes it, {@link sweepHandoffs} fails the ones that
 *   never closed. A consumer that *deliberately filters* still closes its half:
 *   documented filtering is correct behaviour, and reporting it as a lost
 *   handoff would make the whole instrument cry wolf.
 */

import {
  Contract,
  ContractTiming,
  type ContractTimingId,
  Reason,
  contractName,
} from "./traceIds.js";
import { traceContract } from "./trace.js";
import { isTraceRecording, traceFrame } from "./traceRecorder.js";
import { SYSTEM_INTERACTION_TRACE_ENABLED } from "./traceFlags.js";

/** One row of the registry. Documentation and behaviour in the same object. */
export interface ContractSpec {
  readonly id: number;
  /** The state or event the contract is about. */
  readonly state: string;
  readonly writer: string;
  readonly readers: readonly string[];
  readonly timing: ContractTimingId;
  /** Frames the reader may lag by before this is a failure. */
  readonly maxDelayFrames: number;
  readonly failure: string;
  readonly message: string;
  /** Whether a failure preserves a flight-recorder snapshot. */
  readonly snapshot: boolean;
}

/**
 * Consumer bits for a handoff. A handoff closes when every REQUIRED bit is set.
 */
export const Consumer = {
  AlertState: 1,
  Vfx: 2,
  Banner: 4,
  Audio: 8,
  TabletRead: 16,
  PlacementRead: 32,
  Construction: 64,
  Production: 128,
} as const;

export const CONTRACT_REGISTRY: readonly ContractSpec[] = [
  {
    id: Contract.TutorialGateBeforeWavePrep,
    state: "tutorial wave gate (governing / holdsCountdown / releaseBudget / spawnAnchor)",
    writer: "TutorialSystem.init + TutorialSystem.update (4 Hz sample)",
    readers: ["WaveSystem.update", "waveCatalog.resolveWaveSpawns"],
    // TutorialSystem is registration index 27, WaveSystem is 19 — the writer
    // runs AFTER the reader. The only read that cannot be a frame late is the
    // spawn anchor for the first prepared alien, and that one is published from
    // init(), before any system's first update. See tutorial.ts:314-319.
    timing: ContractTiming.Initialization,
    maxDelayFrames: 0,
    failure: "wave 0 prepared before any gate was published",
    message: "WaveSystem prepared the tutorial wave with no tutorial gate in place",
    snapshot: true,
  },
  {
    id: Contract.AlienCreatedBeforeWaiting,
    state: "alien lifecycle Created -> Waiting",
    writer: "WaveSystem.createPreparedAlien",
    readers: ["WaveSystem.waitingReadyAliens"],
    timing: ContractTiming.SameFrame,
    maxDelayFrames: 0,
    failure: "an alien entered Waiting without having been Created",
    message: "alien lifecycle out of order",
    snapshot: true,
  },
  {
    id: Contract.AlienWaitingBeforeActive,
    state: "alien lifecycle Waiting -> Active",
    writer: "WaveSystem.releaseReserveAliens",
    readers: ["CombatSystem", "MovementSystem"],
    timing: ContractTiming.SameFrame,
    maxDelayFrames: 0,
    failure: "an alien became Active without having been Waiting",
    message: "alien activated from an unexpected stage",
    snapshot: true,
  },
  {
    id: Contract.NoActivationInInvalidStage,
    state: "WaveSource.stage at the moment of release",
    writer: "WaveSystem.update",
    readers: ["WaveSystem.updateWaveRelease"],
    timing: ContractTiming.SameFrame,
    maxDelayFrames: 0,
    failure: "aliens released while the wave stage was not 'active'",
    message: "release attempted outside the active stage",
    snapshot: true,
  },
  {
    id: Contract.ActiveNeverAboveCap,
    state: "active living aliens vs DebugSettings.waveMaxActiveAliens",
    writer: "WaveSystem.releaseReserveAliens",
    readers: ["WaveSystem.activeLivingAlienCount"],
    // Checked at the exact transition into Active, not once per frame — a cap
    // violation that lasted less than a frame would otherwise be invisible.
    timing: ContractTiming.SameFrame,
    maxDelayFrames: 0,
    failure: "activeAliens > configuredCap",
    message: "active alien cap exceeded at the transition into Active",
    snapshot: true,
  },
  {
    id: Contract.DamageReachesAlertConsumers,
    state: "one enemy hit on a friendly",
    writer: "CombatSystem.applyAttack -> notifyFriendlyDamage",
    readers: [
      "UnderAttackAlertState",
      "underAttackVfx.punchThreatBadge",
      "underAttackBanner",
      "underAttackAudio",
    ],
    // The fan-out is four direct calls inside raiseAlert(), all synchronous
    // inside CombatSystem's own update. Nothing is polled and nothing waits.
    timing: ContractTiming.SameFrame,
    maxDelayFrames: 0,
    failure: "an accepted alert did not reach every cue",
    message: "accepted alert lost a consumer",
    snapshot: true,
  },
  {
    id: Contract.MiningDepositReachesEconomy,
    state: "GameState.crystals after a deposit",
    writer: "MiningSystem.update (registration index 32)",
    readers: [
      "TabletSystem.update (index 16)",
      "InteractionSystem placement validation (index 17)",
    ],
    // Both readers run BEFORE the writer in the same world.update, so the new
    // balance is first visible to them on the following frame. Real, tiny, and
    // recorded honestly rather than rounded to same-frame.
    timing: ContractTiming.NextFrame,
    maxDelayFrames: 2,
    failure: "the tablet never read the new balance",
    message: "crystal deposit did not reach the economy readers",
    snapshot: true,
  },
  {
    id: Contract.TabletOrderReachesBuilder,
    state: "a placed ConstructionSite / CraftProductionSite",
    writer: "InteractionSystem.placeConstructionSite / placeCraft (index 17)",
    readers: ["ConstructionSystem (index 34)", "CraftProductionSystem (index 35)"],
    timing: ContractTiming.SameFrame,
    maxDelayFrames: 1,
    failure: "a placed site was never picked up by its owning system",
    message: "build order did not reach its system",
    snapshot: true,
  },
  {
    id: Contract.ResetClearsAliens,
    state: "alien entities after a scenario reset",
    writer: "ScenarioResetSystem.resetScenario",
    readers: ["WaveSystem", "CombatSystem"],
    timing: ContractTiming.NextFrame,
    maxDelayFrames: 1,
    failure: "aliens survived the reset",
    message: "scenario reset left aliens on the board",
    snapshot: true,
  },
  {
    id: Contract.ResetClearsSelection,
    state: "selection, targets, damage and alert state after a reset",
    writer: "ScenarioResetSystem.resetScenario",
    readers: ["InteractionSystem", "TabletSystem", "UnderAttackAlertSystem"],
    timing: ContractTiming.NextFrame,
    maxDelayFrames: 1,
    failure: "a stale selection, target or alert survived the reset",
    message: "scenario reset left stale selection or alert state",
    snapshot: true,
  },
  {
    id: Contract.ResetClearsConstruction,
    state: "construction and production sites after a reset",
    writer: "ScenarioResetSystem.resetScenario",
    readers: ["ConstructionSystem", "CraftProductionSystem"],
    timing: ContractTiming.NextFrame,
    maxDelayFrames: 1,
    failure: "a site or a builder assignment survived the reset",
    message: "scenario reset left construction work behind",
    snapshot: true,
  },
  {
    id: Contract.ResetRepublishesStartingState,
    state: "wave, match, economy and tutorial singletons after a reset",
    writer: "ScenarioResetSystem.resetSingletons",
    readers: ["WaveSystem", "TabletSystem", "TutorialSystem"],
    timing: ContractTiming.SameFrame,
    maxDelayFrames: 0,
    failure: "gameplay resumed before required starting state existed",
    message: "scenario reset did not republish starting state",
    snapshot: true,
  },
  {
    id: Contract.ClickReachesTerminalResult,
    state: "one observable trigger press or UIKit click",
    writer: "InputSystem (Pressed tag) / UIKit click handler",
    readers: ["InteractionSystem", "TabletSystem"],
    // The raycast and UIKit dispatch stages in the middle are NOT observable
    // (Phase 0 §7). A deadline is the only honest way to notice a click that
    // vanished inside them.
    timing: ContractTiming.Eventual,
    maxDelayFrames: 45,
    failure: "no terminal result within the deadline",
    message: "interaction never reached a terminal result",
    snapshot: true,
  },
  {
    id: Contract.WaitingAlienDetached,
    state: "a reserve alien's Object3D parent and visibility",
    writer: "WaveSystem.createPreparedAlien",
    readers: ["the renderer", "TransformSystem"],
    timing: ContractTiming.SameFrame,
    maxDelayFrames: 0,
    failure: "a waiting alien is attached to the board root or visible",
    message: "waiting alien is not detached",
    snapshot: true,
  },
];

const SPEC_BY_ID = new Map<number, ContractSpec>(
  CONTRACT_REGISTRY.map((spec) => [spec.id, spec] as const),
);

export function contractSpec(id: number): ContractSpec | undefined {
  return SPEC_BY_ID.get(id);
}

/**
 * Check an immediately-decidable contract.
 *
 * `observed` and `limit` are stored on the event so a dump shows the numbers,
 * not just the verdict.
 */
export function checkContract(
  id: number,
  passed: boolean,
  observed: number,
  limit: number,
  failureReason: number = Reason.ContractTimingMissed,
): void {
  if (!isTraceRecording()) return;
  const spec = SPEC_BY_ID.get(id);
  traceContract(
    id,
    passed,
    observed,
    limit,
    passed ? Reason.None : failureReason,
    passed ? "" : `${contractName(id)}: ${spec?.message ?? "contract failed"}`,
  );
}

// ---------------------------------------------------------------------------
// Handoffs
// ---------------------------------------------------------------------------

/**
 * Open handoffs, in fixed-size parallel arrays.
 *
 * 64 concurrent handoffs is far more than the game can generate: the busiest
 * case is one per damage tick per victim, and every one of those closes inside
 * the same synchronous call. The slot table exists for the ones that genuinely
 * span frames — a deposit, a placed site, a click.
 */
const PENDING_SLOTS = 64;
const pendingContract = new Int32Array(PENDING_SLOTS);
const pendingCorr = new Uint32Array(PENDING_SLOTS);
const pendingFrame = new Int32Array(PENDING_SLOTS);
const pendingDeadline = new Int32Array(PENDING_SLOTS);
const pendingRequired = new Uint8Array(PENDING_SLOTS);
const pendingSeen = new Uint8Array(PENDING_SLOTS);
const pendingActive = new Uint8Array(PENDING_SLOTS);
/** Handoffs evicted because every slot was busy. Reported, never silent. */
let evictedHandoffs = 0;

/** Announce that `corr` has been published and is expected to be consumed. */
export function expectHandoff(
  contract: number,
  corr: number,
  requiredConsumers: number,
): void {
  if (!SYSTEM_INTERACTION_TRACE_ENABLED || !isTraceRecording()) return;
  const spec = SPEC_BY_ID.get(contract);
  let slot = -1;
  for (let index = 0; index < PENDING_SLOTS; index += 1) {
    if (pendingActive[index] === 0) {
      slot = index;
      break;
    }
  }
  if (slot < 0) {
    // Evict the oldest rather than drop the newest: a stuck handoff that never
    // closes is exactly the thing that fills this table, and keeping it would
    // block every real one behind it.
    let oldest = 0;
    for (let index = 1; index < PENDING_SLOTS; index += 1) {
      if (pendingFrame[index] < pendingFrame[oldest]) oldest = index;
    }
    slot = oldest;
    evictedHandoffs += 1;
  }
  pendingContract[slot] = contract;
  pendingCorr[slot] = corr;
  pendingFrame[slot] = traceFrame();
  pendingDeadline[slot] = spec?.maxDelayFrames ?? 1;
  pendingRequired[slot] = requiredConsumers;
  pendingSeen[slot] = 0;
  pendingActive[slot] = 1;
}

/**
 * A consumer acted on `corr`.
 *
 * `filtered` records that the consumer *deliberately* declined — a documented
 * alert filter, a cue that does not apply to this category. The handoff still
 * closes, because the contract is "the event reached every consumer", not
 * "every consumer did something visible".
 */
export function observeHandoff(
  contract: number,
  corr: number,
  consumer: number,
  filtered = false,
  filterReason: number = Reason.None,
): void {
  if (!SYSTEM_INTERACTION_TRACE_ENABLED || !isTraceRecording()) return;
  for (let slot = 0; slot < PENDING_SLOTS; slot += 1) {
    if (pendingActive[slot] === 0) continue;
    if (pendingContract[slot] !== contract || pendingCorr[slot] !== corr) continue;
    pendingSeen[slot] |= consumer;
    if ((pendingSeen[slot] & pendingRequired[slot]) === pendingRequired[slot]) {
      pendingActive[slot] = 0;
      traceContract(
        contract,
        true,
        pendingSeen[slot],
        pendingRequired[slot],
        filtered ? filterReason : Reason.None,
      );
    }
    return;
  }
}

/**
 * Fail every handoff past its deadline. Called once per frame.
 *
 * The deadline is in frames rather than milliseconds on purpose: the thing
 * being measured is "did the next system see it", and on a hitching frame a
 * millisecond deadline would fail correct code for being slow.
 */
export function sweepHandoffs(): void {
  if (!SYSTEM_INTERACTION_TRACE_ENABLED || !isTraceRecording()) return;
  const now = traceFrame();
  for (let slot = 0; slot < PENDING_SLOTS; slot += 1) {
    if (pendingActive[slot] === 0) continue;
    if (now - pendingFrame[slot] <= pendingDeadline[slot]) continue;
    const contract = pendingContract[slot];
    const spec = SPEC_BY_ID.get(contract);
    pendingActive[slot] = 0;
    traceContract(
      contract,
      false,
      pendingSeen[slot],
      pendingRequired[slot],
      Reason.ContractTimingMissed,
      `${contractName(contract)}: ${spec?.message ?? "handoff lost"} ` +
        `(corr#${pendingCorr[slot]}, published frame ${pendingFrame[slot]}, ` +
        `deadline ${pendingDeadline[slot]} frames, ` +
        `saw ${pendingSeen[slot]} of ${pendingRequired[slot]})`,
    );
  }
}

/** Drop every open handoff. Called by scenario reset. */
export function clearHandoffs(): void {
  pendingActive.fill(0);
}

/** How many handoffs were evicted for lack of a slot. Reported in the dump. */
export function evictedHandoffCount(): number {
  return evictedHandoffs;
}

/** Open handoffs right now. Test-facing. */
export function openHandoffCount(): number {
  let count = 0;
  for (let slot = 0; slot < PENDING_SLOTS; slot += 1) count += pendingActive[slot];
  return count;
}
