import { Entity, RayInteractable, createSystem } from "@iwsdk/core";
import { GRID_SIZE, gridToWorld, worldToGrid } from "./board.js";
import {
  ALIEN_PATHFINDS_PER_FRAME,
  UNIT_APPROACH_OFFSETS,
  WAVE_PREP_PER_FRAME,
  TUTORIAL_WAVE_ACTIVATION_LEAD_SECONDS,
} from "./constants.ts";
import { warmObjectForRender } from "./gpuWarmup.js";
import { ReusableGridPathfinder } from "./navigation.js";
import { isTutorialFrozen } from "./tutorialFreeze.js";
import {
  isTutorialGoverningWaves,
  tutorialHoldsCountdown,
  tutorialReleaseAllowance,
  tutorialWaveGateRevision,
} from "./tutorialWaveGate.js";
import {
  traceDecision,
  traceEntityCreated,
  traceEntityDestroyed,
  traceEntityRequested,
  traceEntityTransition,
  traceError,
  traceRead,
  traceSkipped,
  traceStateChange,
} from "./trace.js";
import { checkContract } from "./traceContracts.js";
import {
  Contract,
  EntityKind,
  Lifecycle,
  Reason,
  State,
  entityKindId,
  waveStageId,
} from "./traceIds.js";
import { setTraceWaveContext } from "./traceRecorder.js";
import { setShaderPhaseWaveStage } from "./traceShader.js";

/**
 * "No wave" — for the preparation sentinels and the spawned-wave marker.
 *
 * Must not collide with any real `waveNumber`, which since the tutorial
 * includes 0. Anything negative works; -1 reads as "none".
 */
const NO_WAVE = -1;
import { createEnemyEntity } from "./structures.js";
import {
  Building,
  CombatState,
  DebugSettings,
  Enemy,
  Health,
  MatchState,
  Unit,
  WaveSource,
  WaveUnit,
  boardState,
  getTerrainAt,
} from "./state.js";
import {
  ALIEN_MOVE_SPEED,
  ALIEN_REPATH_DELAY,
  INITIAL_WAVE_DELAY_SECONDS,
  advanceAlienMovement,
  advanceWaveRelease,
  advanceWaveClock,
  enemyFacingYaw,
  isAdjacentToFootprint,
  type MatchStatus,
  type WaveReleaseState,
  type WaveClockState,
  type WaveStage,
} from "./waveRules.js";
import {
  getWaveSpec,
  resolveWavePacing,
  resolveWaveSpawns,
  TUTORIAL_WAVE_NUMBER,
  type ResolvedWaveSpawn,
} from "./waveCatalog.js";
import { clearThreat } from "./underAttackVfx.js";
import { detachAlienAnimation } from "./alienAnimation.js";
import { disposeEnemyRangeRing } from "./selection.js";
import { releaseEntity } from "./entityTeardown.js";
import { playSfx } from "./sfx.js";

interface AlienRoute {
  steps: Int16Array;
  length: number;
  cursor: number;
  targetIndex: number;
}

function compareEntityIndex(left: Entity, right: Entity): number {
  return left.index - right.index;
}

/**
 * The remaining tiles of an alien's route, from where it has got to.
 *
 * Exported so the tutorial can draw the red path along the route the alien will
 * ACTUALLY take. A straight line would be a drawing of a route it will not walk,
 * which is worse than no path — and unlike friendly units, aliens really do
 * path around obstacles.
 *
 * Reads from `cursor`, so "the path disappears behind the unit" is free. Fills
 * a caller-owned array to keep this allocation-free on a per-frame path, and
 * returns how many entries are valid.
 *
 * **Re-read it every frame.** Routes are re-derived on `ALIEN_REPATH_DELAY`; a
 * cached copy keeps pointing along the old route, which is invisible until
 * something blocks the way and then points confidently through a wall.
 */
export function alienRouteTiles(
  alienIndex: number,
  out: { x: number; y: number }[],
): number {
  const route = routeRegistry?.get(alienIndex);
  if (!route) return 0;
  let count = 0;
  for (let step = route.cursor; step < route.length && count < out.length; step += 1) {
    const cell = route.steps[step];
    out[count].x = cell % GRID_SIZE;
    out[count].y = Math.floor(cell / GRID_SIZE);
    count += 1;
  }
  return count;
}

/** Set by WaveSystem.init so the accessor above can see the live routes. */
let routeRegistry: Map<number, AlienRoute> | null = null;

export class WaveSystem extends createSystem({
  sources: { required: [WaveSource, MatchState] },
  aliens: { required: [Enemy, WaveUnit, CombatState, Health] },
  units: { required: [Unit, Health] },
  buildings: { required: [Building, Health] },
}) {
  private readonly clock: WaveClockState = {
    waveNumber: 1,
    timer: INITIAL_WAVE_DELAY_SECONDS,
    stage: "countdown",
  };
  private readonly waitingReadyBuffer: Entity[] = [];
  private readonly routeByAlien = new Map<number, AlienRoute>();
  private readonly navigationOccupancy = new Uint8Array(GRID_SIZE * GRID_SIZE);
  private readonly targetByGoalCell = new Int32Array(GRID_SIZE * GRID_SIZE);
  private readonly pathfinder = new ReusableGridPathfinder(GRID_SIZE);
  private navigationStartIndex = -1;
  private readonly canNavigateForPath = (x: number, y: number): boolean =>
    this.canNavigateAt(x, y, this.navigationStartIndex);
  // -1, not 0. These are "no wave" sentinels, and wave 0 is the tutorial's real
  // level — with 0 as the sentinel, `preparationFailedWaveNumber === 0` made
  // prepareWaveIncrementally return before it ever started, and
  // `preparedWaveNumber === 0` made spawnWaveIfNeeded take the already-prepared
  // branch with an empty list. Wave 0 spawned nothing, cleared instantly, and
  // the match silently advanced to wave 1, deleting the whole tutorial level.
  /**
   * Aliens BUILT for the wave being prepared but not yet handed to a live wave.
   *
   * Preparation creates real entities — `WaveUnit.stage = "waiting"`, detached
   * from the render tree but fully present in the ECS — a few per frame across
   * the countdown. If preparation is abandoned before activation, those
   * entities have no owner: nothing releases them, nothing disposes them, and
   * `completeVictoryIfWaveCleared` counts **every** enemy with health
   * regardless of stage, so the current wave can never clear. A wedged match.
   *
   * Abandonment is not exotic. `prepareWaveIncrementally` resets whenever
   * `WaveSource.revision` bumps mid-countdown (`wave.ts:449`) or the wave
   * number changes under it (`wave.ts:454`) — both ordinary events.
   *
   * Ownership is explicit: {@link adoptPreparedAliens} disowns the list on the
   * one path where the aliens become the live wave, and
   * {@link resetWavePreparation} disposes whatever is left. That direction is
   * deliberate — forgetting to disown destroys a wave loudly, forgetting to
   * dispose leaks silently, and loud is the failure worth having.
   */
  private preparedAliens: Entity[] = [];

  private preparedWaveNumber = NO_WAVE;
  private pendingSpawns: ResolvedWaveSpawn[] = [];
  private spawnCursor = 0;
  private prepMs = 0;
  private slowestBuildMs = 0;
  private slowestBuildAsset = "";
  private slowestBuildName = "";
  private prepSourceRevision = -1;
  private preparationFailedWaveNumber = NO_WAVE;
  /** Last traced gate values, so an unchanged read is not re-recorded. */
  private tracedHeld = false;
  private tracedGoverning = false;
  /** Last traced release reason, same anti-spam rule. */
  private tracedReleaseReason = -1;
  /** Last expected early-return reason; keep ring status, not duplicate events. */
  private tracedSkipReason = -1;
  /** Highest simultaneous active count this wave, for the release record. */
  private highestActiveObserved = 0;

  init(): void {
    routeRegistry = this.routeByAlien;
    this.cleanupFuncs.push(
      this.queries.aliens.subscribe(
        "qualify",
        (alien) => {
          this.routeByAlien.set(alien.index, {
            steps: new Int16Array(GRID_SIZE * GRID_SIZE),
            length: 0,
            cursor: 0,
            targetIndex: -1,
          });
        },
        true,
      ),
      this.queries.aliens.subscribe("disqualify", (alien) => {
        this.routeByAlien.delete(alien.index);
      }),
    );
  }

  update(delta: number): void {
    const source = this.queries.sources.entities.values().next().value as
      | Entity
      | undefined;
    if (!source) {
      this.traceExpectedSkip(Reason.NoSource);
      return;
    }

    this.clock.waveNumber = source.getValue(WaveSource, "waveNumber") ?? 1;
    this.clock.timer = source.getValue(WaveSource, "timer") ?? 0;
    this.clock.stage = (source.getValue(WaveSource, "stage") ??
      "countdown") as WaveStage;
    const matchStatus = (source.getValue(MatchState, "status") ??
      "playing") as MatchStatus;
    // Published once per frame so every event recorded anywhere in the app
    // carries the wave it belongs to, without any caller passing it along.
    const stageId = waveStageId(this.clock.stage);
    setTraceWaveContext(this.clock.waveNumber, stageId);
    setShaderPhaseWaveStage(stageId);
    // ---- Tutorial hold. The ONLY intrusion into the wave clock. ------------
    // With the tutorial off, `tutorialHoldsCountdown()` is false and the two
    // lines below are byte-for-byte today's behaviour.
    //
    // The timer parks at a short lead rather than freezing wherever it was, so
    // that when the tutorial lets go, Act 2 starts within a couple of seconds
    // instead of waiting out a fresh 30-second countdown. Setting it (rather
    // than clamping) is idempotent and can never reach 0 while held, which
    // would activate the wave on the next tick.
    const held = matchStatus === "playing" && tutorialHoldsCountdown();
    // The contract read, recorded when it CHANGES rather than every frame: at
    // 90 Hz a per-frame record of an unchanging boolean would be ~5,400 events
    // a minute of pure noise, and would evict the events a hitch needs.
    const governing = isTutorialGoverningWaves();
    if (held !== this.tracedHeld || governing !== this.tracedGoverning) {
      this.tracedHeld = held;
      this.tracedGoverning = governing;
      traceRead(State.TutorialGoverning, governing ? 1 : 0);
      traceRead(State.TutorialHoldsCountdown, held ? 1 : 0);
    }
    // Pin the countdown to the tutorial's short lead ONLY while the match is
    // actually running.
    //
    // The pin exists so a drill that releases the wave gate gets its alien
    // promptly instead of waiting a full wave delay. It was unconditional, and
    // that quietly undid the start gate one line below: `advanceWaveClock`
    // deliberately HOLDS during `awaiting-start` so "a player who waited five
    // minutes on the landing page still gets the full wave-1 grace period" —
    // but this line had already overwritten the seeded delay with 2 and the
    // write at the bottom of the block persisted it.
    //
    // The tutorial holds the waves on the landing page even on desktop, where
    // it will never run, so every desktop start reached wave 1 after ~2s
    // instead of the configured 5. Measured
    // (`console-logs/..._Desktop_Vr_v3.log`): EXPLORE at t+14.6s, `Lvl 1
    // active` at t+17.6s, against `INITIAL_WAVE_DELAY_SECONDS = 5`. The
    // wave 1 -> 2 countdown in the same run was a correct 5.1s, which is what
    // isolated this to the pre-start window.
    //
    // Pin the countdown to the tutorial's short lead, on the TUTORIAL'S OWN
    // WAVE only.
    //
    // The lead exists so a drill that releases the gate gets its alien promptly
    // instead of waiting a full wave delay. It used to be `if (held)` with no
    // scope, and that shortened ordinary waves through a one-frame window.
    //
    // `held` already requires a playing match (see its definition above), so
    // the landing page was never the problem — the problem is the FIRST FRAME
    // AFTER a desktop start. `startMatch("landing-explore")` sets `playing`
    // between frames; `WaveSystem` is registered at `index.ts:258` and
    // `TutorialSystem` at `:267`, so this runs before the tutorial has had its
    // update to retire and call `clearTutorialWaveGate()`. For that one frame
    // the gate is stale, `held` is true, and the pin wrote 2 over the seeded 5
    // — which the block below then persisted.
    //
    // Measured (`console-logs/..._Desktop_Vr_v3.log`): EXPLORE at t+14.6s,
    // `Lvl 1 active` at t+17.6s against `INITIAL_WAVE_DELAY_SECONDS = 5`. After
    // the scope was added (`..._v4.log`): EXPLORE t+6.5s -> active t+12.5s, and
    // three post-restart countdowns at 5.0s, 5.0s, 5.1s.
    //
    // Scoping to wave 0 is also the honest statement of intent, and it holds
    // regardless of registration order — which is the point. A finished
    // tutorial releases the gate entirely and never governs a numbered wave, so
    // this cannot take the lead away from the tutorial itself; verified in v4,
    // where wave 0 still activated ~2s after the tutorial was switched off.
    if (held && this.clock.waveNumber === TUTORIAL_WAVE_NUMBER) {
      this.clock.timer = TUTORIAL_WAVE_ACTIVATION_LEAD_SECONDS;
    }
    const activated = advanceWaveClock(
      this.clock,
      held ? 0 : delta,
      matchStatus,
    );
    source.setValue(WaveSource, "timer", this.clock.timer);
    source.setValue(WaveSource, "stage", this.clock.stage);
    if (this.clock.stage === "countdown" && matchStatus === "playing") {
      this.prepareWaveIncrementally(source);
    }
    if (this.clock.stage === "active" && matchStatus === "playing") {
      this.spawnWaveIfNeeded(source);
      this.updateWaveRelease(source, delta);
    }
    if (activated) {
      // The countdown -> active edge, which `advanceWaveClock` returns true for
      // exactly once per wave. One-shot: the wave arriving is the event, so a
      // looping siren would still be wailing through the fight it announced.
      playSfx("waveSiren");
      source.setValue(
        WaveSource,
        "revision",
        (source.getValue(WaveSource, "revision") ?? 0) + 1,
      );
    }

    if (this.clock.stage !== "active" || matchStatus !== "playing") {
      if (matchStatus !== "playing") this.stopAliens();
      // A normal, expected early return — the wave is counting down or the
      // match is over. Recorded as a skip with its reason so the trace shows
      // the system reasoning, never as a failure.
      this.traceExpectedSkip(
        matchStatus !== "playing" ? Reason.MatchNotPlaying : Reason.WaveNotActive,
      );
      return;
    }

    this.tracedSkipReason = -1;

    this.rebuildNavigationOccupancy();
    let pathfindsRemaining = ALIEN_PATHFINDS_PER_FRAME;
    for (const alien of this.queries.aliens.entities) {
      if ((alien.getValue(Health, "current") ?? 0) <= 0) continue;
      if (alien.getValue(WaveUnit, "stage") === "waiting") continue;
      if (alien.getValue(WaveUnit, "hasWaypoint") ?? false) {
        // Tutorial freeze: hold position rather than merely slowing. One of
        // three reads that must agree — see tutorialFreeze.ts.
        if (!isTutorialFrozen()) this.advanceAlien(alien, delta);
        continue;
      }

      const currentTarget = alien.getValue(CombatState, "target") as Entity | null;
      if (this.isAliveTarget(currentTarget) && this.isInContact(alien, currentTarget)) {
        this.invalidateRoute(alien);
        alien.setValue(WaveUnit, "stage", "attacking");
        alien.setValue(CombatState, "stage", "attacking");
        continue;
      }
      if (this.resumeCachedRoute(alien, currentTarget)) continue;

      const repathTimer = Math.max(
        0,
        (alien.getValue(WaveUnit, "repathTimer") ?? 0) - Math.max(0, delta),
      );
      alien.setValue(WaveUnit, "repathTimer", repathTimer);
      if (repathTimer > 0) continue;
      if (pathfindsRemaining <= 0) continue;
      pathfindsRemaining -= 1;

      const target = this.findNearestTargetPath(alien);
      if (!target) {
        this.clearAlienTarget(alien, "released");
        alien.setValue(WaveUnit, "repathTimer", ALIEN_REPATH_DELAY);
        continue;
      }
      alien.setValue(CombatState, "target", target);
      alien.setValue(CombatState, "timer", 0);
      if (!this.resumeCachedRoute(alien, target)) {
        this.invalidateRoute(alien);
        alien.setValue(WaveUnit, "stage", "attacking");
        alien.setValue(CombatState, "stage", "attacking");
      }
    }
  }

  /**
   * Build one alien, absorbing a failure rather than aborting the wave.
   *
   * One bad spawn — a missing asset, a tile that stopped being placeable
   * between preparation and activation — used to take every alien after it with
   * it, because the loop had no guard. The wave arrives short instead.
   */
  private buildAlienSafely(spawn: ResolvedWaveSpawn): void {
    try {
      this.createPreparedAlien(spawn);
    } catch (error) {
      traceError(
        Reason.PreparationFailed,
        this.clock.waveNumber,
        `wave ${this.clock.waveNumber}: one alien failed to build; the rest of the wave continues`,
      );
      console.warn(
        `[WaveBuild] wave ${this.clock.waveNumber}: alien build failed; continuing`,
        error,
      );
    }
  }

  private spawnWaveIfNeeded(source: Entity): void {
    if (
      (source.getValue(WaveSource, "spawnedWaveNumber") ?? NO_WAVE) ===
      this.clock.waveNumber
    ) {
      return;
    }
    const spec = getWaveSpec(this.clock.waveNumber);
    if (!spec) {
      traceDecision(Reason.NoWaveSpec, this.clock.waveNumber);
      source.setValue(WaveSource, "spawnedWaveNumber", this.clock.waveNumber);
      return;
    }
    this.highestActiveObserved = 0;
    this.tracedReleaseReason = -1;

    let spawns: ResolvedWaveSpawn[];
    let buildMs: number;
    let activationFinishMs: number;
    // Activation must not throw.
    //
    // Countdown preparation already degrades safely — it catches, records
    // `preparationFailedWaveNumber` and returns so activation can retry. The
    // retry itself did not, and neither did alien creation on either path: an
    // exception here escapes `WaveSystem.update` and takes the whole frame with
    // it, mid-wave, leaving `spawnedWaveNumber` unset so the next frame tries
    // again and throws again. A wave that cannot be placed would wedge the
    // match rather than arriving short.
    //
    // The contract now is: **build whatever can be built, mark the wave spawned
    // either way.** A short wave is recoverable; a wedged frame loop is not.
    if (this.preparedWaveNumber === this.clock.waveNumber) {
      spawns = this.pendingSpawns;
      const finishStart = performance.now();
      while (this.spawnCursor < spawns.length) {
        this.buildAlienSafely(spawns[this.spawnCursor]);
        this.spawnCursor += 1;
      }
      activationFinishMs = performance.now() - finishStart;
      buildMs = this.prepMs + activationFinishMs;
    } else {
      const buildStart = performance.now();
      try {
        spawns = resolveWaveSpawns(spec, {
          canSpawnAt: (x, y) => this.canSpawnAlienAt(x, y),
        });
      } catch (error) {
        // The retry after a failed preparation is the likeliest place to land
        // here, and it is exactly where the old code threw.
        spawns = [];
        traceError(
          Reason.PreparationFailed,
          this.clock.waveNumber,
          `wave ${this.clock.waveNumber} activation could not resolve spawns; releasing an empty wave`,
        );
        console.warn(
          `[WaveBuild] wave ${this.clock.waveNumber}: activation failed to resolve spawns; the wave will be empty`,
          error,
        );
      }
      for (const spawn of spawns) this.buildAlienSafely(spawn);
      activationFinishMs = performance.now() - buildStart;
      buildMs = activationFinishMs;
    }
    const perAlien = buildMs / Math.max(1, spawns.length);
    const slowestBuild = this.slowestBuildAsset
      ? `; slowest ${this.slowestBuildName} (${this.slowestBuildAsset}) ${this.slowestBuildMs.toFixed(2)}ms`
      : "";
    console.log(
      `[WaveBuild] wave ${this.clock.waveNumber}: ${spawns.length} aliens built in ${buildMs.toFixed(2)}ms total across preparation frames (${activationFinishMs.toFixed(2)}ms activation finish, ${perAlien.toFixed(2)}ms/alien${slowestBuild})`,
    );
    traceStateChange(
      State.RequiredAlienTotal,
      0,
      spawns.length,
      Reason.Accepted,
    );
    // These aliens ARE the wave now — WaveSystem hands them to the release
    // logic below. Disown before the reset, or the reset would dispose the wave
    // it just spawned. Both branches above (prepared, and the resolve-now
    // fallback) converge here, so this covers each of them.
    this.adoptPreparedAliens();
    this.resetWavePreparation();
    source.setValue(WaveSource, "spawnedWaveNumber", this.clock.waveNumber);
    source.setValue(WaveSource, "releaseTimer", 0);
    source.setValue(WaveSource, "releasedAlienCount", 0);

    // Seed the Settings tab's live pacing override with this wave's own
    // catalog-scaled default, so difficulty escalation still applies unless
    // the player has since changed it for testing.
    const debugSettings = boardState.debugSettings;
    if (debugSettings) {
      const pacing = resolveWavePacing(spec);
      debugSettings.setValue(
        DebugSettings,
        "waveMaxActiveAliens",
        pacing.maxActiveAliens,
      );
      debugSettings.setValue(
        DebugSettings,
        "waveReleaseIntervalSeconds",
        pacing.releaseIntervalSeconds,
      );
    }
  }

  private prepareWaveIncrementally(source: Entity): void {
    const waveNumber = this.clock.waveNumber;
    const sourceRevision = source.getValue(WaveSource, "revision") ?? 0;
    if (
      (this.preparedWaveNumber === waveNumber ||
        this.preparationFailedWaveNumber === waveNumber) &&
      this.prepSourceRevision !== sourceRevision
    ) {
      this.resetWavePreparation();
    }
    if (this.preparationFailedWaveNumber === waveNumber) return;

    if (this.preparedWaveNumber !== waveNumber) {
      this.resetWavePreparation();
      this.prepSourceRevision = sourceRevision;
      const spec = getWaveSpec(waveNumber);
      if (!spec) return;
      // WaveSystem runs before TutorialSystem, so tutorial-wave preparation is
      // valid only when init/reset has already published a gate.
      const gateRevision = tutorialWaveGateRevision();
      checkContract(
        Contract.TutorialGateBeforeWavePrep,
        waveNumber !== TUTORIAL_WAVE_NUMBER || gateRevision > 0,
        gateRevision,
        1,
      );
      const resolveStart = performance.now();
      try {
        this.pendingSpawns = resolveWaveSpawns(spec, {
          canSpawnAt: (x, y) => this.canSpawnAlienAt(x, y),
        });
      } catch (error) {
        this.preparationFailedWaveNumber = waveNumber;
        // An unexpected failure, not a normal skip: preserves a snapshot so the
        // frames leading up to it survive.
        traceError(
          Reason.PreparationFailed,
          waveNumber,
          `wave ${waveNumber} countdown preparation threw; activation will retry`,
        );
        console.warn(
          `[WaveBuild] wave ${waveNumber}: countdown preparation failed; activation will retry`,
          error,
        );
        return;
      }
      this.prepMs += performance.now() - resolveStart;
      this.preparedWaveNumber = waveNumber;
      // The Requested step of the alien lifecycle: the spec exists, the
      // entities do not yet. Recorded once per wave, not once per frame.
      for (let index = 0; index < this.pendingSpawns.length; index += 1) {
        traceEntityRequested(
          index,
          entityKindId(this.pendingSpawns[index].enemy),
          Reason.Queued,
        );
      }
      traceStateChange(
        State.PreparationLimit,
        0,
        WAVE_PREP_PER_FRAME,
        Reason.Accepted,
      );
    }

    const end = Math.min(
      this.pendingSpawns.length,
      this.spawnCursor + WAVE_PREP_PER_FRAME,
    );
    while (this.spawnCursor < end) {
      const prepStart = performance.now();
      // Guarded like the two activation paths, and this is the one that matters
      // most: countdown preparation builds the bulk of every wave, a few aliens
      // per frame, so it is the likeliest place for a bad spawn to surface.
      // `createPreparedAlien` throws outright when the board root is missing.
      // Unguarded, that escaped `WaveSystem.update` and took the frame with it.
      this.buildAlienSafely(this.pendingSpawns[this.spawnCursor]);
      this.prepMs += performance.now() - prepStart;
      this.spawnCursor += 1;
    }
  }

  private createPreparedAlien(spawn: ResolvedWaveSpawn): void {
    const root = boardState.boardRoot;
    if (!root) throw new Error("Wave spawning requires BoardSystem first");
    const buildStart = performance.now();
    const alien = createEnemyEntity(this.world, root, {
      asset: spawn.asset,
      kind: spawn.enemy,
      name: spawn.name,
      widthTiles: spawn.widthTiles,
      x: spawn.x,
      y: spawn.y,
      yawDeg: spawn.yawDeg,
      healthMultiplier: spawn.healthMultiplier,
    });
    this.preparedAliens.push(alien);
    const kindId = entityKindId(spawn.enemy);
    traceEntityCreated(alien.index, kindId, Lifecycle.Created);
    alien.setValue(WaveUnit, "stage", "waiting");
    // Created -> Waiting, in that order and in this call, which is the whole of
    // `Contract.AlienCreatedBeforeWaiting`. The transition validates itself
    // against the stage the trace already recorded, so a system cannot claim a
    // transition it did not make.
    traceEntityTransition(alien.index, kindId, Lifecycle.Waiting, Reason.Queued);
    alien.setValue(WaveUnit, "releaseDelay", spawn.releaseDelaySeconds);
    alien.setValue(WaveUnit, "speedMultiplier", spawn.speedMultiplier);
    // `visible = false` keeps a reserve out of the render pass, but
    // Object3D.updateMatrixWorld recurses into invisible subtrees regardless
    // (three.core.js), so ~79 nodes per waiting alien still cost a matrix
    // recompose every frame. Detaching removes that cost entirely. `position`
    // is local and survives removeFromParent, so isOccupied() still reserves
    // the spawn tile, and scenarioReset disposes by ECS query rather than by
    // scene traversal — neither depends on the holder being attached.
    alien.object3D?.removeFromParent();
    // Compile its shaders now, while it is still detached and nothing is waiting.
    // The detach above is what keeps preparation cheap; it is also what defers
    // every program compile to the frame the whole reserve is released on. This
    // pays that cost here instead, a few aliens per frame across the countdown —
    // and it lands inside the PAlien/PDrake/PMech measurement, so its price is
    // visible in the profiler rather than hidden.
    warmObjectForRender(alien.object3D, `alien:${spawn.asset}`);
    // A reserve that is still attached, or still visible, is the failure this
    // detach exists to prevent — it costs a matrix recompose for ~79 nodes every
    // frame and can be drawn. Checked here, at the only moment it is decidable.
    checkContract(
      Contract.WaitingAlienDetached,
      alien.object3D?.parent == null && alien.object3D?.visible === false,
      alien.index,
      0,
      alien.object3D?.parent != null
        ? Reason.WaitingAlienAttached
        : Reason.WaitingAlienVisible,
    );
    const buildMs = performance.now() - buildStart;
    if (buildMs > this.slowestBuildMs) {
      this.slowestBuildMs = buildMs;
      this.slowestBuildAsset = spawn.asset;
      this.slowestBuildName = spawn.name;
    }
  }

  /**
   * Give up ownership of the prepared aliens without disposing them.
   *
   * Called only from activation, where they become the live wave.
   */
  private adoptPreparedAliens(): void {
    this.preparedAliens.length = 0;
  }

  /**
   * Dispose aliens built for a wave that was abandoned before activation.
   *
   * Mirrors `CombatSystem.destroyTarget`'s enemy teardown, minus the kill
   * accounting — nothing killed these, so `enemiesKilled` must not move and no
   * wave-clear check should see them as a death.
   *
   * `releaseEntity`, never `entity.dispose()`: GLTF geometry and materials are
   * shared `AssetManager` resources and dispose() traverse-frees the whole
   * subtree, taking the shared asset with it.
   */
  private disposePreparedAliens(): void {
    for (const alien of this.preparedAliens) {
      // Entity indexes are pooled and reused, so anything keyed on this index
      // would re-point at whatever entity is created next.
      clearThreat(alien);
      if (alien.hasComponent(RayInteractable)) {
        alien.removeComponent(RayInteractable);
      }
      const kindId = entityKindId(alien.getValue(Enemy, "kind") ?? "alien");
      traceEntityTransition(
        alien.index,
        kindId,
        Lifecycle.Destroyed,
        Reason.Cancelled,
      );
      traceEntityDestroyed(alien.index, kindId, Reason.Cancelled);
      detachAlienAnimation(alien);
      disposeEnemyRangeRing(alien);
      releaseEntity(alien);
    }
    this.preparedAliens.length = 0;
  }

  private resetWavePreparation(): void {
    // Anything still owned here belongs to a wave that never activated.
    this.disposePreparedAliens();
    this.preparedWaveNumber = NO_WAVE;
    this.pendingSpawns = [];
    this.spawnCursor = 0;
    this.prepMs = 0;
    this.slowestBuildMs = 0;
    this.slowestBuildAsset = "";
    this.slowestBuildName = "";
    this.prepSourceRevision = -1;
    this.preparationFailedWaveNumber = NO_WAVE;
  }

  private updateWaveRelease(source: Entity, delta: number): void {
    const spec = getWaveSpec(this.clock.waveNumber);
    if (!spec) return;
    this.tickWaitingReleaseDelays(delta);
    const waitingReady = this.waitingReadyAliens(
      source.getValue(WaveSource, "releasedAlienCount") ?? 0,
    );
    const state: WaveReleaseState = {
      releaseTimer: source.getValue(WaveSource, "releaseTimer") ?? 0,
      releasedAlienCount: source.getValue(WaveSource, "releasedAlienCount") ?? 0,
    };
    const debugSettings = boardState.debugSettings;
    const pacing = debugSettings
      ? {
          maxActiveAliens:
            debugSettings.getValue(DebugSettings, "waveMaxActiveAliens") ?? 3,
          releaseIntervalSeconds:
            debugSettings.getValue(
              DebugSettings,
              "waveReleaseIntervalSeconds",
            ) ?? 8,
        }
      : resolveWavePacing(spec);
    const activeLiving = this.activeLivingAlienCount();
    if (activeLiving > this.highestActiveObserved) {
      this.highestActiveObserved = activeLiving;
    }
    const releaseCount = advanceWaveRelease(
      state,
      { activeLiving, waitingReady: waitingReady.length },
      pacing,
      delta,
    );
    this.traceReleaseDecision(
      activeLiving,
      waitingReady.length,
      pacing.maxActiveAliens,
      releaseCount,
      state.releasedAlienCount,
    );
    if (releaseCount > 0) {
      this.releaseReserveAliens(waitingReady, releaseCount, pacing.maxActiveAliens);
    }
    source.setValue(WaveSource, "releaseTimer", state.releaseTimer);
    source.setValue(WaveSource, "releasedAlienCount", state.releasedAlienCount);
  }

  /**
   * The release reasoning, recorded when it CHANGES.
   *
   * `updateWaveRelease` runs every frame of an active wave. Emitting the full
   * eight-field bundle each time would be ~720 events a second of a decision
   * that has not moved — enough on its own to evict the events a hitch needs
   * from the flight recorder. So the bundle goes in when the answer changes or
   * when aliens actually enter, and the steady state is silence.
   *
   * A cap that is full is a NORMAL decision. It records its reasoning and its
   * contract PASS, and preserves nothing.
   */
  private traceReleaseDecision(
    activeLiving: number,
    waitingReady: number,
    cap: number,
    releaseCount: number,
    releasedSoFar: number,
  ): void {
    const reason =
      releaseCount > 0
        ? Reason.Released
        : waitingReady <= 0
          ? tutorialReleaseAllowance(releasedSoFar) <= 0
            ? Reason.TutorialBudgetSpent
            : Reason.NoReserveReady
          : Reason.ActiveCapReached;
    if (reason === this.tracedReleaseReason && releaseCount === 0) return;
    this.tracedReleaseReason = reason;
    traceRead(State.ActiveAliens, activeLiving);
    traceRead(State.AlienCap, cap);
    traceRead(State.WaitingReady, waitingReady);
    traceRead(State.HighWaterActive, this.highestActiveObserved);
    traceDecision(reason, releaseCount, State.RequestedRelease);
    // The cap contract, recorded on the same tick as the decision that respects
    // it — so a reader sees "3 active, cap 3, released 0, PASS" rather than
    // having to infer that nothing went wrong from the absence of a record.
    checkContract(Contract.ActiveNeverAboveCap, activeLiving <= cap, activeLiving, cap, Reason.CapViolated);
  }

  /**
   * Mark every skipped execution in the compact execution ring, but only put a
   * reason in the flight recorder when the WaveSystem's state actually changes.
   */
  private traceExpectedSkip(reason: number): void {
    const changed = reason !== this.tracedSkipReason;
    this.tracedSkipReason = reason;
    traceSkipped(reason, changed);
  }

  private tickWaitingReleaseDelays(delta: number): void {
    for (const alien of this.queries.aliens.entities) {
      if (alien.getValue(WaveUnit, "stage") !== "waiting") continue;
      alien.setValue(
        WaveUnit,
        "releaseDelay",
        Math.max(
          0,
          (alien.getValue(WaveUnit, "releaseDelay") ?? 0) - Math.max(0, delta),
        ),
      );
    }
  }

  /**
   * The reserve aliens that may be released right now.
   *
   * This is the second and last tutorial intrusion: an allowance capping how
   * many of the reserve are *offered*. `advanceWaveRelease` releases nothing
   * when the list is empty, so a spent budget stalls the wave without any
   * change to the release rules themselves. With the tutorial off the allowance
   * is Infinity and the cap is a no-op.
   */
  private waitingReadyAliens(alreadyReleased: number): Entity[] {
    const allowance = tutorialReleaseAllowance(alreadyReleased);
    this.waitingReadyBuffer.length = 0;
    if (allowance <= 0) return this.waitingReadyBuffer;
    if (Number.isFinite(allowance)) {
      traceRead(State.TutorialReleaseBudget, allowance);
    }
    for (const alien of this.queries.aliens.entities) {
      if ((alien.getValue(Health, "current") ?? 0) <= 0) continue;
      if (alien.getValue(WaveUnit, "stage") !== "waiting") continue;
      if ((alien.getValue(WaveUnit, "releaseDelay") ?? 0) > 0) continue;
      this.waitingReadyBuffer.push(alien);
    }
    // Sort BEFORE truncating. Entity order is spawn order, which is drill
    // order — alien, then drake, then mech. Capping the raw query order would
    // hand the tutorial whichever alien the ECS happened to iterate first, and
    // the turret drill could find itself facing the mech's opponent early.
    this.waitingReadyBuffer.sort(compareEntityIndex);
    if (this.waitingReadyBuffer.length > allowance) {
      this.waitingReadyBuffer.length = allowance;
    }
    return this.waitingReadyBuffer;
  }

  private activeLivingAlienCount(): number {
    let count = 0;
    for (const alien of this.queries.aliens.entities) {
      if ((alien.getValue(Health, "current") ?? 0) <= 0) continue;
      if (alien.getValue(WaveUnit, "stage") === "waiting") continue;
      count += 1;
    }
    return count;
  }

  private releaseReserveAliens(
    waitingReady: readonly Entity[],
    count: number,
    cap: number,
  ): void {
    const releaseCount = Math.min(waitingReady.length, Math.max(0, count));
    // The stage must be `active` at the moment of release. Checked here rather
    // than trusted from the caller, because this is the last place the two can
    // still disagree.
    checkContract(
      Contract.NoActivationInInvalidStage,
      this.clock.stage === "active",
      waveStageId(this.clock.stage),
      waveStageId("active"),
      Reason.ActivationInInvalidStage,
    );
    let active = this.activeLivingAlienCount();
    const boardRoot = boardState.boardRoot?.object3D;
    for (let index = 0; index < releaseCount; index += 1) {
      const alien = waitingReady[index];
      if (alien.object3D) {
        // Re-attach: reserves are detached from the board root while waiting.
        if (boardRoot && alien.object3D.parent !== boardRoot) {
          boardRoot.add(alien.object3D);
        }
        alien.object3D.visible = true;
      }
      if (!alien.hasComponent(RayInteractable)) {
        alien.addComponent(RayInteractable);
      }
      this.clearAlienTarget(alien, "released");
      alien.setValue(WaveUnit, "releaseDelay", 0);
      alien.setValue(WaveUnit, "repathTimer", 0);
      // Waiting -> Active, and the cap checked at the EXACT transition. A
      // violation that lasted less than a frame would be invisible to a
      // once-per-frame check, which is the whole reason it is done here and
      // incrementally rather than from the census.
      active += 1;
      traceEntityTransition(
        alien.index,
        entityKindId(alien.getValue(Enemy, "kind") ?? "alien"),
        Lifecycle.Active,
        Reason.Released,
      );
      if (active > this.highestActiveObserved) {
        this.highestActiveObserved = active;
      }
      checkContract(
        Contract.ActiveNeverAboveCap,
        active <= cap,
        active,
        cap,
        Reason.CapViolated,
      );
    }
    traceStateChange(State.ActualRelease, count, releaseCount, Reason.Released);
  }

  private advanceAlien(alien: Entity, delta: number): void {
    const object = alien.object3D;
    if (!object) return;
    const [targetX, targetZ] = gridToWorld(
      alien.getValue(WaveUnit, "nextX") ?? 0,
      alien.getValue(WaveUnit, "nextY") ?? 0,
    );
    const baseSpeed =
      boardState.debugSettings?.getValue(DebugSettings, "alienMoveSpeed") ??
      ALIEN_MOVE_SPEED;
    const movement = advanceAlienMovement(
      { x: object.position.x, z: object.position.z },
      { x: targetX, z: targetZ },
      baseSpeed * (alien.getValue(WaveUnit, "speedMultiplier") ?? 1),
      delta,
    );
    const dx = targetX - object.position.x;
    const dz = targetZ - object.position.z;
    object.position.x = movement.x;
    object.position.z = movement.z;
    if (dx !== 0 || dz !== 0) {
      object.rotation.y = enemyFacingYaw(
        alien.getValue(Enemy, "kind") ?? "alien",
        dx,
        dz,
      );
    }
    if (!movement.arrived) return;
    alien.setValue(WaveUnit, "hasWaypoint", false);
    alien.setValue(WaveUnit, "nextX", -1);
    alien.setValue(WaveUnit, "nextY", -1);
    alien.setValue(WaveUnit, "repathTimer", 0);
  }

  private findNearestTargetPath(alien: Entity): Entity | null {
    const object = alien.object3D;
    const route = this.routeByAlien.get(alien.index);
    if (!object || !route) return null;
    const [startX, startY] = worldToGrid(object.position.x, object.position.z);
    const startIndex = startY * GRID_SIZE + startX;
    this.targetByGoalCell.fill(-1);
    for (const unit of this.queries.units.entities) {
      this.markTargetApproaches(unit, startIndex);
    }
    for (const building of this.queries.buildings.entities) {
      this.markTargetApproaches(building, startIndex);
    }
    this.navigationStartIndex = startIndex;
    if (
      !this.pathfinder.findPathToAny(
        startX,
        startY,
        this.targetByGoalCell,
        this.canNavigateForPath,
      )
    ) {
      this.invalidateRoute(alien);
      return null;
    }

    const target = this.findAliveTargetByIndex(this.pathfinder.goalValue);
    if (!target) {
      this.invalidateRoute(alien);
      return null;
    }
    route.length = this.pathfinder.pathLength;
    route.cursor = 0;
    route.targetIndex = target.index;
    for (let index = 0; index < route.length; index += 1) {
      route.steps[index] = this.pathfinder.path[index];
    }
    return target;
  }

  private markTargetApproaches(target: Entity, startIndex: number): void {
    if (!this.isAliveTarget(target)) return;
    if (target.hasComponent(Building)) {
      const anchorX = target.getValue(Building, "x") ?? -1;
      const anchorY = target.getValue(Building, "y") ?? -1;
      const width = target.getValue(Building, "widthTiles") ?? 1;
      const minX = anchorX - Math.floor((width - 1) / 2);
      const minY = anchorY - Math.floor((width - 1) / 2);
      const maxX = minX + width - 1;
      const maxY = minY + width - 1;
      for (let x = minX; x <= maxX; x += 1) {
        this.markTargetGoal(x, minY - 1, target.index, startIndex);
        this.markTargetGoal(x, maxY + 1, target.index, startIndex);
      }
      for (let y = minY; y <= maxY; y += 1) {
        this.markTargetGoal(minX - 1, y, target.index, startIndex);
        this.markTargetGoal(maxX + 1, y, target.index, startIndex);
      }
      return;
    }

    const object = target.object3D;
    if (!object) return;
    const [x, y] = worldToGrid(object.position.x, object.position.z);
    for (const [dx, dy] of UNIT_APPROACH_OFFSETS) {
      this.markTargetGoal(x + dx, y + dy, target.index, startIndex);
    }
  }

  private markTargetGoal(
    x: number,
    y: number,
    targetIndex: number,
    startIndex: number,
  ): void {
    if (
      x < 0 ||
      y < 0 ||
      x >= GRID_SIZE ||
      y >= GRID_SIZE ||
      !this.canNavigateAt(x, y, startIndex)
    ) {
      return;
    }
    const cellIndex = y * GRID_SIZE + x;
    if (this.targetByGoalCell[cellIndex] < 0) {
      this.targetByGoalCell[cellIndex] = targetIndex;
    }
  }

  private resumeCachedRoute(alien: Entity, target: Entity | null): boolean {
    const route = this.routeByAlien.get(alien.index);
    if (
      !route ||
      !this.isAliveTarget(target) ||
      route.targetIndex !== target.index ||
      route.cursor >= route.length
    ) {
      if (route && route.targetIndex >= 0) this.invalidateRoute(alien);
      return false;
    }

    const cellIndex = route.steps[route.cursor];
    const x = cellIndex % GRID_SIZE;
    const y = Math.floor(cellIndex / GRID_SIZE);
    if (!this.canNavigateAt(x, y, -1)) {
      this.invalidateRoute(alien);
      return false;
    }
    route.cursor += 1;
    this.reserveNavigationCell(cellIndex);
    alien.setValue(WaveUnit, "nextX", x);
    alien.setValue(WaveUnit, "nextY", y);
    alien.setValue(WaveUnit, "hasWaypoint", true);
    alien.setValue(WaveUnit, "stage", "marching");
    alien.setValue(CombatState, "stage", "approaching");
    return true;
  }

  private invalidateRoute(alien: Entity): void {
    const route = this.routeByAlien.get(alien.index);
    if (!route) return;
    route.length = 0;
    route.cursor = 0;
    route.targetIndex = -1;
  }

  private findAliveTargetByIndex(entityIndex: number): Entity | null {
    for (const unit of this.queries.units.entities) {
      if (unit.index === entityIndex && this.isAliveTarget(unit)) return unit;
    }
    for (const building of this.queries.buildings.entities) {
      if (building.index === entityIndex && this.isAliveTarget(building)) {
        return building;
      }
    }
    return null;
  }

  private rebuildNavigationOccupancy(): void {
    this.navigationOccupancy.fill(0);
    for (const unit of this.queries.units.entities) {
      const object = unit.object3D;
      if (!object || (unit.getValue(Health, "current") ?? 0) <= 0) continue;
      const [x, y] = worldToGrid(object.position.x, object.position.z);
      this.reserveNavigationPosition(x, y);
    }
    for (const alien of this.queries.aliens.entities) {
      if ((alien.getValue(Health, "current") ?? 0) <= 0) continue;
      const object = alien.object3D;
      if (object) {
        const [x, y] = worldToGrid(object.position.x, object.position.z);
        this.reserveNavigationPosition(x, y);
      }
      if (alien.getValue(WaveUnit, "hasWaypoint") ?? false) {
        this.reserveNavigationPosition(
          alien.getValue(WaveUnit, "nextX") ?? -1,
          alien.getValue(WaveUnit, "nextY") ?? -1,
        );
      }
    }
  }

  private reserveNavigationPosition(x: number, y: number): void {
    if (x < 0 || y < 0 || x >= GRID_SIZE || y >= GRID_SIZE) return;
    this.reserveNavigationCell(y * GRID_SIZE + x);
  }

  private reserveNavigationCell(cellIndex: number): void {
    if (this.navigationOccupancy[cellIndex] < 0xff) {
      this.navigationOccupancy[cellIndex] += 1;
    }
  }

  private canNavigateAt(x: number, y: number, ownStartIndex: number): boolean {
    if (getTerrainAt(x, y) !== "open") return false;
    const cellIndex = y * GRID_SIZE + x;
    const occupants = this.navigationOccupancy[cellIndex];
    return occupants === 0 || (cellIndex === ownStartIndex && occupants === 1);
  }

  private canSpawnAlienAt(x: number, y: number): boolean {
    return getTerrainAt(x, y) === "open" && !this.isOccupied(x, y);
  }

  private isOccupied(x: number, y: number, exclude?: Entity): boolean {
    for (const unit of this.queries.units.entities) {
      const object = unit.object3D;
      if (!object || (unit.getValue(Health, "current") ?? 0) <= 0) continue;
      const [unitX, unitY] = worldToGrid(object.position.x, object.position.z);
      if (unitX === x && unitY === y) return true;
    }
    for (const alien of this.queries.aliens.entities) {
      if (
        (exclude && alien === exclude) ||
        (alien.getValue(Health, "current") ?? 0) <= 0
      ) {
        continue;
      }
      const object = alien.object3D;
      if (object) {
        const [alienX, alienY] = worldToGrid(object.position.x, object.position.z);
        if (alienX === x && alienY === y) return true;
      }
      if (
        (alien.getValue(WaveUnit, "hasWaypoint") ?? false) &&
        alien.getValue(WaveUnit, "nextX") === x &&
        alien.getValue(WaveUnit, "nextY") === y
      ) {
        return true;
      }
    }
    return false;
  }

  private isInContact(alien: Entity, target: Entity): boolean {
    const object = alien.object3D;
    const targetObject = target.object3D;
    if (!object || !targetObject) return false;
    const [x, y] = worldToGrid(object.position.x, object.position.z);
    if (target.hasComponent(Building)) {
      return isAdjacentToFootprint(
        { x, y },
        {
          x: target.getValue(Building, "x") ?? -1,
          y: target.getValue(Building, "y") ?? -1,
        },
        target.getValue(Building, "widthTiles") ?? 1,
      );
    }
    const [targetX, targetY] = worldToGrid(
      targetObject.position.x,
      targetObject.position.z,
    );
    return Math.abs(x - targetX) + Math.abs(y - targetY) === 1;
  }

  private isAliveTarget(target: Entity | null): target is Entity {
    return Boolean(
      target?.object3D &&
        target.hasComponent(Health) &&
        (target.hasComponent(Unit) || target.hasComponent(Building)) &&
        (target.getValue(Health, "current") ?? 0) > 0,
    );
  }

  private clearAlienTarget(alien: Entity, stage: string): void {
    this.invalidateRoute(alien);
    alien.setValue(CombatState, "target", null);
    alien.setValue(CombatState, "stage", "idle");
    alien.setValue(CombatState, "timer", 0);
    alien.setValue(WaveUnit, "stage", stage);
    alien.setValue(WaveUnit, "hasWaypoint", false);
    alien.setValue(WaveUnit, "nextX", -1);
    alien.setValue(WaveUnit, "nextY", -1);
  }

  private stopAliens(): void {
    for (const alien of this.queries.aliens.entities) {
      this.clearAlienTarget(alien, "stopped");
      alien.setValue(WaveUnit, "repathTimer", 0);
    }
  }
}
