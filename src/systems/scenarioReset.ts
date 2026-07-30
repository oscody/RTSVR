import { RayInteractable, createSystem, type Entity } from "@iwsdk/core";
import { clearAlienAnimations } from "./alienAnimation.js";
import { clearCombatEffects } from "./combatEffects.js";
import { clearCommandCenterAnimations } from "./commandCenterAnimation.js";
import { clearCraftProductionAnimations } from "./craftProductionAnimation.js";
import { clearCraftVisualRise } from "./craftVisualRise.js";
import { resetCraftSerial } from "./craftFactory.js";
import { STARTING_CRYSTALS } from "./economyConstants.js";
import { clearMinerAnimations } from "./minerAnimation.js";
import { clearUnitSelections, updateCommandGridVisibility } from "./selection.js";
import { clearTurretAnimations } from "./turretAnimation.js";
import { clearUnitAnimations } from "./unitAnimation.js";
import {
  createScenarioResetDefaults,
  isScenarioRestartRequested,
} from "./scenarioResetRules.js";
import {
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
import { createInitialScenario } from "./structures.js";
import { INITIAL_WAVE_DELAY_SECONDS } from "./waveRules.js";

const SCENARIO_RESET_DEFAULTS = createScenarioResetDefaults(
  STARTING_CRYSTALS,
  INITIAL_WAVE_DELAY_SECONDS,
);

export class ScenarioResetSystem extends createSystem({
  objects: { required: [ScenarioObject] },
}) {
  update(): void {
    const source = boardState.waveSource;
    if (
      !source ||
      !isScenarioRestartRequested(
        source.getValue(MatchState, "status") ?? "playing",
      )
    ) {
      return;
    }
    this.resetScenario(source);
  }

  private resetScenario(source: Entity): void {
    clearUnitSelections();
    clearCombatEffects();
    clearAlienAnimations();
    clearCommandCenterAnimations();
    clearCraftProductionAnimations();
    clearCraftVisualRise();
    clearMinerAnimations();
    clearTurretAnimations();
    clearUnitAnimations();
    for (const ring of boardState.selectionRingByUnit.values()) ring.dispose();
    boardState.selectionRingByUnit.clear();
    for (const ring of boardState.attackRangeRingByUnit.values()) ring.dispose();
    boardState.attackRangeRingByUnit.clear();
    for (const ring of boardState.rangeRingByTurret.values()) ring.dispose();
    boardState.rangeRingByTurret.clear();

    const staleObjects = Array.from(this.queries.objects.entities);
    for (const entity of staleObjects) {
      if (entity.hasComponent(RayInteractable)) {
        entity.removeComponent(RayInteractable);
      }
      entity.dispose();
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
    createInitialScenario(this.world);
    this.resetTablet();
  }

  private resetSingletons(source: Entity): void {
    const game = boardState.gameState;
    if (game) {
      game.setValue(GameState, "crystals", SCENARIO_RESET_DEFAULTS.crystals);
      game.setValue(
        GameState,
        "revision",
        (game.getValue(GameState, "revision") ?? 0) + 1,
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
    tablet.setValue(TabletState, "buildPlacementActive", false);
    tablet.setValue(TabletState, "spawnBuilding", boardState.commandCenter);
    tablet.setValue(
      TabletState,
      "spawnBuildingIndex",
      boardState.commandCenter?.index ?? -1,
    );
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
