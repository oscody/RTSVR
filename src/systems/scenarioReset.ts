import { createSystem, type Entity } from "@iwsdk/core";
import { clearAlienAnimations } from "./alienAnimation.js";
import { ActionKind, logAction } from "./actionLog.js";
import { clearCombatEffects } from "./combatEffects.js";
import { clearCommandCenterHud } from "./commandCenterHud.js";
import { clearCommandCenterAnimations } from "./commandCenterAnimation.js";
import { clearCraftVisualRise } from "./craftVisualRise.js";
import { resetCraftSerial } from "./craftFactory.js";
import { STARTING_CRYSTALS } from "./economyConstants.js";
import { clearMeteors } from "./meteorSystem.js";
import { clearSfx } from "./sfx.js";
import { clearMinerAnimations } from "./minerAnimation.js";
import { beginHeapCycle } from "./frameProfiler.js";
import { resetWaveTransitionLog } from "./waveTransitionLog.js";
import {
  beginResourceCycle,
  emitResourceSnapshot,
} from "./resourceCycle.js";
import {
  clearGpuWarmupQueue,
  gpuWarmupActive,
  setGpuWarmupPaused,
} from "./gpuWarmup.js";
import { clearUnitSelections, updateCommandGridVisibility } from "./selection.js";
import { clearTurretAnimations } from "./turretAnimation.js";
import { resetTutorial } from "./tutorial.js";
import { clearSpotlightSubject } from "./tutorialSpotlight.js";
import { resetUnderAttackAlert } from "./underAttackAlert.js";
import { clearUnderAttackVfx } from "./underAttackVfx.js";
import { clearUnitAnimations } from "./unitAnimation.js";
import {
  createScenarioResetDefaults,
  isScenarioRestartRequested,
} from "./scenarioResetRules.js";
import { cancelConstructionSite } from "./construction.js";
import {
  ConstructionSite,
  DebugSettings,
  GameState,
  GameStats,
  MatchResultPanel,
  MatchState,
  ScenarioObject,
  SelectionState,
  TabletState,
  WaveSource,
  boardState,
  resetBoardTerrain,
} from "./state.js";
import { clearDimmableScenario } from "./board.js";
import { createInitialScenario } from "./structures.js";
import { INITIAL_WAVE_DELAY_SECONDS } from "./waveRules.js";
import { releaseEntity } from "./entityTeardown.js";
import { clearHandoffs } from "./traceContracts.js";
import { clearPhase2Trace } from "./phase2Trace.js";
import { resetTracedLifecycles, traceDecision, traceStateChange } from "./trace.js";
import { Reason, State } from "./traceIds.js";

const SCENARIO_RESET_DEFAULTS = createScenarioResetDefaults(
  STARTING_CRYSTALS,
  INITIAL_WAVE_DELAY_SECONDS,
);

/**
 * How long a reset will wait for an in-flight `compileAsync` before giving up.
 *
 * 60 frames is ~0.7s at 90Hz. Quest Browser does not expose
 * `KHR_parallel_shader_compile`, so Three.js does its compile setup
 * synchronously and the promise normally settles within a frame or two — this
 * is a safety margin, not an expected wait.
 */
const RESET_WARMUP_WAIT_FRAMES = 60;

export class ScenarioResetSystem extends createSystem({
  objects: { required: [ScenarioObject] },
  // Construction sites are disposed by name, not incidentally. They used to be
  // owned by a builder and vanish with it; a place-first site can be unclaimed,
  // so nothing else guarantees it — and an orphan site would keep its reserved
  // footprint blocked for the whole next match.
  sites: { required: [ConstructionSite] },
}) {
  private loggedRestart = false;
  /** Frames spent waiting for an in-flight `compileAsync` to settle. */
  private warmupWaitFrames = 0;

  update(): void {
    const source = boardState.waveSource;
    if (
      !source ||
      !isScenarioRestartRequested(
        source.getValue(MatchState, "status") ?? "playing",
      )
    ) {
      // Re-arm here, NOT after the reset below. `update()` runs every frame and
      // the status stays "restarting" until `resetScenario` clears it; clearing
      // the latch in the same call left it re-armed for the very next frame, so
      // a reset that ever took two frames would still have logged twice — the
      // exact repeat the latch exists to stop. It only looked correct because
      // `resetScenario` finishes in one frame and this early return then fires.
      // Re-arming on the way out ties the latch to the restart being OVER.
      this.loggedRestart = false;
      this.warmupWaitFrames = 0;
      // Only ever released here, so a reset that bailed out early cannot leave
      // warm-up switched off for the rest of the session.
      setGpuWarmupPaused(false);
      return;
    }
    if (!this.loggedRestart) {
      this.loggedRestart = true;
      logAction(ActionKind.Restart, "scenario reset requested");
    }

    // Disposing the scene while Three.js is still polling a `compileAsync`
    // throws inside its own timer — see `setGpuWarmupPaused`. Pausing first
    // works because `ScenarioResetSystem` is registered BEFORE
    // `GpuWarmupSystem` (index.ts), so no new target can start this frame.
    setGpuWarmupPaused(true);
    // Drop queued targets before anything is disposed. They point at objects
    // this reset is about to destroy, so leaving them queued both retains those
    // objects past their owner's death and hands a post-rebuild frame a target
    // whose resources are gone. The in-flight one cannot be cancelled — Three's
    // readiness timer is not ours to un-schedule — so it is waited out below.
    const dropped = clearGpuWarmupQueue("scenario-reset");
    if (dropped > 0) {
      logAction(ActionKind.Restart, `dropped ${dropped} queued GPU warm-up target(s)`);
    }
    if (gpuWarmupActive()) {
      this.warmupWaitFrames += 1;
      if (this.warmupWaitFrames <= RESET_WARMUP_WAIT_FRAMES) {
        // Status stays `restarting`, so this simply retries next frame.
        return;
      }
      // Bounded on purpose. A compile that never settles is exactly what the
      // crash above causes, and a restart the player cannot perform is worse
      // than the error it was avoiding — so give up waiting and say so.
      logAction(
        ActionKind.Restart,
        `proceeding with GPU warm-up still active after ${RESET_WARMUP_WAIT_FRAMES} frames`,
      );
    }
    this.warmupWaitFrames = 0;
    // `finally`, not a plain call after: a reset that throws must still hand
    // warm-up back. Leaving it paused would disable first-use compilation for
    // the rest of the session on top of whatever the original failure was.
    // A new cycle starts here so the next cycle's minimum is measured against a
    // freshly rebuilt scenario, not against whatever the previous one settled
    // at. Without a boundary the minimum is session-wide and cannot climb.
    beginHeapCycle();
    // Emits `pre-reset` and opens the new cycle. Before the teardown, so the
    // line describes what the OLD cycle grew to.
    beginResourceCycle();
    // A restart replays the ladder, so wave 1 of the new run must be timed from
    // the rebuild rather than from the previous run's last transition.
    resetWaveTransitionLog();
    try {
      this.resetScenario(source);
    } finally {
      setGpuWarmupPaused(false);
    }
  }

  private resetScenario(source: Entity): void {
    const staleObjectCount = this.queries.objects.entities.size;
    const staleSiteCount = this.queries.sites.entities.size;
    // Restart deliberately ends old correlations rather than letting a deposit
    // or build order from the discarded match fail in the fresh one.
    clearHandoffs();
    clearPhase2Trace();
    resetTracedLifecycles();
    traceDecision(Reason.Restarted, staleObjectCount, State.SceneEntities);
    traceStateChange(
      State.SceneEntities,
      staleObjectCount + staleSiteCount,
      0,
      Reason.Restarted,
    );
    clearUnitSelections();
    clearCombatEffects();
    clearSfx();
    clearMeteors();
    clearAlienAnimations();
    clearCommandCenterAnimations();
    clearCraftVisualRise();
    clearMinerAnimations();
    clearTurretAnimations();
    clearUnitAnimations();
    // Board back to its base position, rim back to Martian brown, banner
    // hidden, alarm silenced, and every cooldown dropped — a stale entry keyed
    // on a now-recycled entity index would suppress the next match's alerts.
    clearCommandCenterHud();
    // Restart replays the tutorial from drill 1 while it is enabled.
    resetTutorial();
    clearUnderAttackVfx();
    // The base is about to be rebuilt; drop references into the old model.
    clearSpotlightSubject();
    clearDimmableScenario();
    resetUnderAttackAlert();
    for (const ring of boardState.selectionRingByUnit.values()) releaseEntity(ring);
    boardState.selectionRingByUnit.clear();
    for (const ring of boardState.attackRangeRingByUnit.values()) releaseEntity(ring);
    boardState.attackRangeRingByUnit.clear();
    for (const ring of boardState.rangeRingByTurret.values()) releaseEntity(ring);
    boardState.rangeRingByTurret.clear();
    for (const ring of boardState.rangeRingByEnemy.values()) releaseEntity(ring);
    boardState.rangeRingByEnemy.clear();
    boardState.selectedEnemy = null;

    const staleSites = Array.from(this.queries.sites.entities);
    for (const site of staleSites) {
      // No refund on restart — the whole economy is being reset anyway, and a
      // refund here would credit crystals into the fresh starting balance.
      cancelConstructionSite(site, false);
    }
    boardState.buildersBySite.clear();
    boardState.liveSites.length = 0;
    boardState.selectedSite = null;
    // Build-queue numbering restarts at 1 with the match.
    boardState.nextQueueOrder = 1;

    const staleObjects = Array.from(this.queries.objects.entities);
    for (const entity of staleObjects) {
      releaseEntity(entity);
    }

    boardState.commandCenter = null;
    boardState.resourceByKey.clear();
    boardState.cargoVisualByUnit.clear();
    boardState.pathByUnit.clear();
    boardState.selectedUnits.clear();
    boardState.selectedUnit = null;
    boardState.selectedTurret = null;
    boardState.selectedTile = null;
    boardState.hoveredTile = null;
    boardState.pointerTile = null;
    resetCraftSerial();

    resetBoardTerrain();
    this.hideBoardMarkers();
    this.resetSingletons(source);
    // The one moment `scenario` and `temporary` are SUPPOSED to be zero:
    // everything the old cycle owned is released, and nothing has been rebuilt
    // yet. A leak seen here belongs to teardown; a leak seen only at
    // `post-settled` belongs to the rebuild. Emitting after the rebuild would
    // merge the two and make neither diagnosable.
    emitResourceSnapshot("post-teardown");
    // Always bare, for the same reason as the boot build: `resetTutorial()`
    // above cleared the claim latch, so TutorialSystem re-decides on its next
    // update and puts the astronaut back itself if it is not going to run.
    createInitialScenario(this.world, { bareStart: true });
    this.resetTablet();
  }

  private resetSingletons(source: Entity): void {
    const game = boardState.gameState;
    if (game) {
      const previousCrystals = game.getValue(GameState, "crystals") ?? 0;
      const revision = (game.getValue(GameState, "revision") ?? 0) + 1;
      game.setValue(GameState, "crystals", SCENARIO_RESET_DEFAULTS.crystals);
      game.setValue(GameState, "revision", revision);
      traceStateChange(
        State.Crystals,
        previousCrystals,
        SCENARIO_RESET_DEFAULTS.crystals,
        Reason.Restarted,
        revision,
      );
    }
    const stats = boardState.gameStats;
    if (stats) {
      stats.setValue(
        GameStats,
        "crystalsMined",
        SCENARIO_RESET_DEFAULTS.crystalsMined,
      );
      stats.setValue(
        GameStats,
        "enemiesKilled",
        SCENARIO_RESET_DEFAULTS.enemiesKilled,
      );
      stats.setValue(
        GameStats,
        "revision",
        (stats.getValue(GameStats, "revision") ?? 0) + 1,
      );
    }
    const selection = boardState.selection;
    if (selection) {
      selection.setValue(SelectionState, "unitIndex", -1);
      selection.setValue(SelectionState, "unitKind", "none");
      selection.setValue(SelectionState, "selectedCount", 0);
      selection.setValue(
        SelectionState,
        "revision",
        (selection.getValue(SelectionState, "revision") ?? 0) + 1,
      );
    }
    // Always wave 1. **TutorialSystem is the sole owner of the wave-0
    // decision** — `resetTutorial()` above cleared its latch, so if the
    // tutorial is actually going to run it re-claims wave 0 on its next update,
    // and if it is not, the match correctly stays on wave 1.
    //
    // This used to branch on `isTutorialEnabled()`, which is the *setting*, not
    // whether the tutorial can run. On desktop the setting is on and the
    // tutorial never runs, so a restart put the player back on wave 0 with no
    // tutorial — visible in `console-logs/..._Desktop_Vr.log`, where the run
    // after the restart is `Lvl 0` again. Two owners of one decision, and the
    // one without the immersive check won.
    //
    // The one-frame window at wave 1 before the tutorial re-claims is inert:
    // the status is `restarting`, so WaveSystem is gated out entirely.
    source.setValue(
      WaveSource,
      "waveNumber",
      SCENARIO_RESET_DEFAULTS.waveNumber,
    );
    source.setValue(
      WaveSource,
      "timer",
      boardState.debugSettings?.getValue(
        DebugSettings,
        "initialWaveDelaySeconds",
      ) ?? SCENARIO_RESET_DEFAULTS.waveTimer,
    );
    source.setValue(WaveSource, "stage", SCENARIO_RESET_DEFAULTS.waveStage);
    source.setValue(
      WaveSource,
      "spawnedWaveNumber",
      SCENARIO_RESET_DEFAULTS.spawnedWaveNumber,
    );
    source.setValue(WaveSource, "releaseTimer", SCENARIO_RESET_DEFAULTS.releaseTimer);
    source.setValue(
      WaveSource,
      "releasedAlienCount",
      SCENARIO_RESET_DEFAULTS.releasedAlienCount,
    );
    source.setValue(
      WaveSource,
      "revision",
      (source.getValue(WaveSource, "revision") ?? 0) + 1,
    );
    source.setValue(MatchState, "status", SCENARIO_RESET_DEFAULTS.matchStatus);
    source.setValue(
      MatchState,
      "commandCenterAlive",
      SCENARIO_RESET_DEFAULTS.commandCenterAlive,
    );
    source.setValue(
      MatchState,
      "revision",
      (source.getValue(MatchState, "revision") ?? 0) + 1,
    );
  }

  private resetTablet(): void {
    const tablet = boardState.tablet;
    if (!tablet) return;
    tablet.setValue(TabletState, "view", "overview");
    tablet.setValue(TabletState, "astronaut", null);
    tablet.setValue(TabletState, "astronautIndex", -1);
    tablet.setValue(TabletState, "selectedBuildingKind", "none");
    tablet.setValue(TabletState, "selectedSite", null);
    tablet.setValue(TabletState, "selectedSiteIndex", -1);
    tablet.setValue(TabletState, "buildPlacementActive", false);
    tablet.setValue(TabletState, "spawnBuilding", boardState.commandCenter);
    tablet.setValue(
      TabletState,
      "spawnBuildingIndex",
      boardState.commandCenter?.index ?? -1,
    );
    tablet.setValue(TabletState, "focusBuilding", null);
    tablet.setValue(TabletState, "focusBuildingIndex", -1);
    tablet.setValue(TabletState, "selectedCraftKind", "none");
    tablet.setValue(TabletState, "selectedCraftCost", 0);
    tablet.setValue(TabletState, "craftPage", 0);
    tablet.setValue(TabletState, "craftPlacementActive", false);
    tablet.setValue(TabletState, "unitFilter", "all");
    tablet.setValue(TabletState, "unitPage", 0);
    tablet.setValue(TabletState, "status", "Scenario restarted");
    tablet.setValue(TabletState, "statusKind", "success");
    tablet.setValue(
      TabletState,
      "revision",
      (tablet.getValue(TabletState, "revision") ?? 0) + 1,
    );
    updateCommandGridVisibility();
    const panel = boardState.matchResultPanel;
    if (panel?.object3D) panel.object3D.visible = false;
    panel?.setValue(MatchResultPanel, "visible", false);
  }

  private hideBoardMarkers(): void {
    for (const marker of [
      boardState.hoverMarker,
      boardState.selectionMarker,
      boardState.orderMarker,
      boardState.buildMarker,
    ]) {
      if (marker?.object3D) marker.object3D.visible = false;
    }
  }
}
