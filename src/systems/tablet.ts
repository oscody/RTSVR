import {
  BoxGeometry,
  Entity,
  Group,
  Mesh,
  MeshStandardMaterial,
  OneHandGrabbable,
  PanelDocument,
  PanelUI,
  RayInteractable,
  UIKit,
  UIKitDocument,
  createSystem,
} from "@iwsdk/core";
import { BUILDING_CATALOG, getBuildingSpec } from "./buildingCatalog.js";
import { CRAFT_CATALOG, getCraftSpec } from "./craftCatalog.js";
import { validateCraftPurchase } from "./craftRules.js";
import { validateBuildOrder } from "./constructionRules.js";
import {
  currentBuildingMaxHealth,
  currentEnemyMaxHealth,
  currentUnitMaxHealth,
} from "./debugStatOverrides.js";
import { DEBUG_SETTINGS_CATALOG } from "./debugSettingsCatalog.js";
import { updateHealthBar } from "./healthBar.js";
import {
  TABLET_CARD_BORDER,
  TABLET_COMMAND_CENTER_X_OFFSET,
  TABLET_EMPTY_UNIT_BACKGROUND,
  TABLET_EMPTY_UNIT_BORDER,
  TABLET_FRAME_COLOR,
  TABLET_FRAME_METALNESS,
  TABLET_FRAME_ROUGHNESS,
  TABLET_FRAME_SIZE,
  TABLET_FRAME_Z_OFFSET,
  TABLET_HANDLE_COLOR,
  TABLET_HANDLE_METALNESS,
  TABLET_HANDLE_ROUGHNESS,
  TABLET_HANDLE_SIZE,
  TABLET_HANDLE_X_OFFSET,
  TABLET_LOCKED_UNIT_BACKGROUND,
  TABLET_LOCKED_UNIT_BORDER,
  TABLET_PANEL_MAX_HEIGHT,
  TABLET_PANEL_MAX_WIDTH,
  TABLET_ROTATION,
  TABLET_SCREEN_Z_OFFSET,
  TABLET_SELECTED_BUILD_BORDER,
  TABLET_SELECTED_CRAFT_BORDER,
  TABLET_SELECTED_UNIT_BACKGROUND,
  TABLET_STATUS_ERROR_COLOR,
  TABLET_STATUS_INFO_COLOR,
  TABLET_STATUS_SUCCESS_COLOR,
  TABLET_TAB_ACTIVE_BACKGROUND,
  TABLET_TAB_ACTIVE_BORDER,
  TABLET_TAB_INACTIVE_BACKGROUND,
  TABLET_TAB_INACTIVE_BORDER,
  TABLET_UNIT_BACKGROUND,
  TABLET_Y_OFFSET,
} from "./constants.ts";
import {
  clearUnitSelections,
  getSingleSelectedUnit,
  refreshTurretRangeRingGeometry,
  refreshUnitAttackRangeRingGeometry,
  toggleUnitSelection,
} from "./selection.js";
import {
  countRosterKinds,
  paginateRoster,
  type RosterEntry,
} from "./selectionRules.js";
import {
  Building,
  ConstructionState,
  DebugSettings,
  Enemy,
  GameState,
  GameStats,
  Health,
  MatchState,
  RuntimePerformance,
  SelectionState,
  TabletState,
  Unit,
  UnitSelection,
  WaveSource,
  boardState,
  type DebugSettingKey,
} from "./state.js";

type UiElement = UIKit.Text & {
  setProperties(properties: Record<string, unknown>): void;
};

function element(document: UIKitDocument, id: string): UiElement | null {
  return document.getElementById(id) as UiElement | null;
}

interface LiveRosterEntry extends RosterEntry {
  entity: Entity;
}

export class TabletSystem extends createSystem({
  tablets: { required: [TabletState, PanelUI, PanelDocument] },
  buildings: { required: [Building, Health] },
  units: { required: [Unit, UnitSelection, Health] },
  enemies: { required: [Enemy, Health] },
}) {
  private document: UIKitDocument | null = null;
  private tabletEntity: Entity | null = null;
  private lastAstronauts = Number.NaN;
  private lastBuildingCount = Number.NaN;
  private lastCountdown = Number.NaN;
  private lastCrafts = Number.NaN;
  private lastCrystals = Number.NaN;
  private lastDebugRevision = Number.NaN;
  private lastEnemyCount = Number.NaN;
  private lastKills = Number.NaN;
  private lastMined = Number.NaN;
  private lastPerformanceRevision = Number.NaN;
  private lastSelectionRevision = Number.NaN;
  private lastTabletRevision = Number.NaN;
  private lastWaveNumber = Number.NaN;
  private lastWaveStage = "";

  init(): void {
    this.createTablet();
    this.cleanupFuncs.push(
      this.queries.tablets.subscribe("qualify", (entity) => {
        this.tabletEntity = entity;
        this.document = PanelDocument.data.document[entity.index] as UIKitDocument;
        this.bind(this.document, entity);
        this.invalidateSnapshot();
      }),
    );
  }

  update(): void {
    const tablet = this.tabletEntity;
    const document = this.document;
    if (!tablet || !document) return;

    const waveSource = boardState.waveSource;
    const waveStage = waveSource?.getValue(WaveSource, "stage") ?? "countdown";
    const waveNumber = waveSource?.getValue(WaveSource, "waveNumber") ?? 1;
    const countingDown = waveStage === "countdown";
    if (waveNumber !== this.lastWaveNumber) {
      this.lastWaveNumber = waveNumber;
      this.setText("current-level", `${waveNumber}`);
      this.setText("wave-banner-label", `Wave ${waveNumber} incoming in`);
    }
    if (waveStage !== this.lastWaveStage) {
      this.lastWaveStage = waveStage;
      element(document, "wave-banner")?.setProperties({
        display: countingDown ? "flex" : "none",
      });
    }
    if (countingDown) {
      const waveTimer = waveSource?.getValue(WaveSource, "timer") ?? 0;
      const countdown = Math.max(0, Math.ceil(waveTimer));
      if (countdown !== this.lastCountdown) {
        this.lastCountdown = countdown;
        this.setText("wave-countdown", `${countdown}`);
      }
    }

    const game = boardState.gameState;
    const stats = boardState.gameStats;
    const performance = boardState.runtimePerformance;
    const crystals = game?.getValue(GameState, "crystals") ?? 0;
    const mined = stats?.getValue(GameStats, "crystalsMined") ?? 0;
    let astronauts = 0;
    let crafts = 0;
    for (const unit of this.queries.units.entities) {
      if (unit.getValue(Unit, "kind") === "astronaut") astronauts += 1;
      else crafts += 1;
    }
    const tabletRevision = tablet.getValue(TabletState, "revision") ?? 0;
    const buildingCount = this.queries.buildings.entities.size;
    const enemyCount = this.queries.enemies.entities.size;
    const kills = stats?.getValue(GameStats, "enemiesKilled") ?? 0;
    const selectionRevision =
      boardState.selection?.getValue(SelectionState, "revision") ?? 0;
    const debugRevision =
      boardState.debugSettings?.getValue(DebugSettings, "revision") ?? 0;
    const performanceRevision =
      performance?.getValue(RuntimePerformance, "revision") ?? 0;
    if (
      tabletRevision === this.lastTabletRevision &&
      crystals === this.lastCrystals &&
      mined === this.lastMined &&
      buildingCount === this.lastBuildingCount &&
      astronauts === this.lastAstronauts &&
      crafts === this.lastCrafts &&
      enemyCount === this.lastEnemyCount &&
      kills === this.lastKills &&
      selectionRevision === this.lastSelectionRevision &&
      debugRevision === this.lastDebugRevision &&
      performanceRevision === this.lastPerformanceRevision
    ) {
      return;
    }
    this.lastTabletRevision = tabletRevision;
    this.lastCrystals = crystals;
    this.lastMined = mined;
    this.lastBuildingCount = buildingCount;
    this.lastAstronauts = astronauts;
    this.lastCrafts = crafts;
    this.lastEnemyCount = enemyCount;
    this.lastKills = kills;
    this.lastSelectionRevision = selectionRevision;
    this.lastDebugRevision = debugRevision;
    this.lastPerformanceRevision = performanceRevision;

    this.setText("crystal-balance", `${crystals}`);
    this.setText("overview-crystals", `${crystals}`);
    this.setText("overview-mined", `${mined}`);
    this.setText("overview-buildings", `${buildingCount}`);
    this.setText("overview-crafts", `${crafts}`);
    this.setText("overview-units", `${crafts + astronauts}`);
    this.setText("overview-astronauts", `${astronauts}`);
    this.setText("overview-enemies", `${enemyCount}`);
    this.setText("overview-kills", `${kills}`);
    this.setText(
      "settings-performance",
      performanceRevision > 0
        ? `FPS ${Math.round(performance?.getValue(RuntimePerformance, "fps") ?? 0)} | Avg ${(performance?.getValue(RuntimePerformance, "averageFrameMs") ?? 0).toFixed(1)} ms | Worst ${(performance?.getValue(RuntimePerformance, "worstFrameMs") ?? 0).toFixed(1)} ms | Moving ${performance?.getValue(RuntimePerformance, "movingEntities") ?? 0}`
        : "FPS -- | Avg -- ms | Worst -- ms | Moving 0",
    );
    this.setText("tablet-status", tablet.getValue(TabletState, "status") ?? "");
    element(document, "tablet-status")?.setProperties({
      color:
        tablet.getValue(TabletState, "statusKind") === "error"
          ? TABLET_STATUS_ERROR_COLOR
          : tablet.getValue(TabletState, "statusKind") === "success"
            ? TABLET_STATUS_SUCCESS_COLOR
            : TABLET_STATUS_INFO_COLOR,
    });
    const astronautIndex = tablet.getValue(TabletState, "astronautIndex") ?? -1;
    this.setText(
      "builder-label",
      astronautIndex >= 0 ? `Astronaut #${astronautIndex}` : "Select an astronaut",
    );
    this.applyView(tablet.getValue(TabletState, "view") ?? "overview");
    this.applySelectedCard(
      tablet.getValue(TabletState, "selectedBuildingKind") ?? "none",
    );
    const building = getBuildingSpec(
      tablet.getValue(TabletState, "selectedBuildingKind") ?? "none",
    );
    const placingBuilding =
      tablet.getValue(TabletState, "buildPlacementActive") ?? false;
    this.setText(
      "build-action-label",
      building
        ? placingBuilding
          ? `Choose tile for ${building.label}`
          : `Produce ${building.label} - ${building.cost}`
        : "Choose a building",
    );
    const source = tablet.getValue(TabletState, "spawnBuilding") as Entity | null;
    const sourceKind = source?.getValue(Building, "kind") ?? null;
    this.setText(
      "craft-source-label",
      sourceKind
        ? `Production: ${this.buildingLabel(sourceKind)}`
        : "Select a production building",
    );
    const craftKind = tablet.getValue(TabletState, "selectedCraftKind") ?? "none";
    const craft = getCraftSpec(craftKind);
    const placingCraft =
      tablet.getValue(TabletState, "craftPlacementActive") ?? false;
    this.setText(
      "craft-action-label",
      craft
        ? placingCraft
          ? `Choose tile for ${craft.label}`
          : `Produce ${craft.label} - ${craft.cost}`
        : "Choose a craft",
    );
    this.applyCraftPage(tablet, craftKind);
    this.applyUnitPage(tablet);
    this.applySettingsView();
  }

  private invalidateSnapshot(): void {
    this.lastAstronauts = Number.NaN;
    this.lastBuildingCount = Number.NaN;
    this.lastCountdown = Number.NaN;
    this.lastCrafts = Number.NaN;
    this.lastCrystals = Number.NaN;
    this.lastDebugRevision = Number.NaN;
    this.lastEnemyCount = Number.NaN;
    this.lastKills = Number.NaN;
    this.lastMined = Number.NaN;
    this.lastPerformanceRevision = Number.NaN;
    this.lastSelectionRevision = Number.NaN;
    this.lastTabletRevision = Number.NaN;
    this.lastWaveNumber = Number.NaN;
    this.lastWaveStage = "";
  }

  private createTablet(): void {
    const root = boardState.boardRoot;
    if (!root) throw new Error("TabletSystem requires BoardSystem first");
    const frame = new Group();
    frame.name = "RTSVRTablet";
    const backing = new Mesh(
      new BoxGeometry(...TABLET_FRAME_SIZE),
      new MeshStandardMaterial({
        color: TABLET_FRAME_COLOR,
        roughness: TABLET_FRAME_ROUGHNESS,
        metalness: TABLET_FRAME_METALNESS,
      }),
    );
    backing.name = "RTSVRTabletFrame";
    backing.position.z = TABLET_FRAME_Z_OFFSET;
    // The backing covers the whole panel. Keep it visual-only so it cannot
    // intercept pointer rays before UIKit's buttons receive them.
    backing.raycast = () => {};
    frame.add(backing);
    const handle = new Mesh(
      new BoxGeometry(...TABLET_HANDLE_SIZE),
      new MeshStandardMaterial({
        color: TABLET_HANDLE_COLOR,
        roughness: TABLET_HANDLE_ROUGHNESS,
        metalness: TABLET_HANDLE_METALNESS,
      }),
    );
    handle.name = "RTSVRTabletGrabHandle";
    handle.position.set(TABLET_HANDLE_X_OFFSET, 0, 0);
    frame.add(handle);

    const shell = this.world
      .createTransformEntity(frame, { parent: root })
      .addComponent(OneHandGrabbable, { rotate: true, translate: true });
    shell.object3D!.name = "RTSVRTabletShell";

    const tablet = this.world
      .createTransformEntity(undefined, { parent: shell })
      .addComponent(PanelUI, {
        config: "./ui/rts-tablet.json",
        maxWidth: TABLET_PANEL_MAX_WIDTH,
        maxHeight: TABLET_PANEL_MAX_HEIGHT,
      })
      .addComponent(RayInteractable)
      .addComponent(TabletState);
    if (boardState.commandCenter) {
      tablet.setValue(TabletState, "spawnBuilding", boardState.commandCenter);
      tablet.setValue(
        TabletState,
        "spawnBuildingIndex",
        boardState.commandCenter.index,
      );
    }
    tablet.object3D!.name = "RTSVRTabletScreen";
    tablet.object3D!.position.z = TABLET_SCREEN_Z_OFFSET;
    const commandCenter = boardState.commandCenter?.object3D;
    shell.object3D!.position.set(
      (commandCenter?.position.x ?? 0) + TABLET_COMMAND_CENTER_X_OFFSET,
      TABLET_Y_OFFSET,
      commandCenter?.position.z ?? 0,
    );
    shell.object3D!.rotation.set(...TABLET_ROTATION);
    boardState.tablet = tablet;
  }

  private bind(document: UIKitDocument, tablet: Entity): void {
    const on = (id: string, handler: () => void) => {
      document.getElementById(id)?.addEventListener("click", handler);
    };
    on("tab-overview", () => this.setView(tablet, "overview", "Economy overview"));
    on("tab-build", () => this.setView(tablet, "build", "Choose a building"));
    on("tab-crafts", () => this.openCrafts(tablet));
    on("tab-units", () => this.openUnits(tablet));
    on("tab-settings", () => this.setView(tablet, "settings", "Playtesting settings"));
    on("exit-vr", () => {
      this.world.exitXR();
    });
    on("restart-game", () => {
      const source = boardState.waveSource;
      if (!source) return;
      source.setValue(MatchState, "status", "restarting");
    });

    for (const spec of DEBUG_SETTINGS_CATALOG) {
      on(`setting-${spec.key}-minus`, () => this.adjustSetting(tablet, spec.key, -1));
      on(`setting-${spec.key}-plus`, () => this.adjustSetting(tablet, spec.key, 1));
    }

    for (const spec of BUILDING_CATALOG) {
      on(`build-${spec.kind}`, () => {
        if (spec.locked) {
          this.touch(tablet, `${spec.label} is locked`, "error");
          return;
        }
        tablet.setValue(TabletState, "view", "build");
        tablet.setValue(TabletState, "buildPlacementActive", false);
        tablet.setValue(TabletState, "craftPlacementActive", false);
        this.hidePlacementMarker();
        tablet.setValue(TabletState, "selectedBuildingKind", spec.kind);
        this.touch(tablet, `${spec.label}: ${spec.cost} crystals`);
      });
    }
    for (let slot = 0; slot < 4; slot += 1) {
      on(`craft-card-${slot}`, () => {
        const page = tablet.getValue(TabletState, "craftPage") ?? 0;
        const spec = CRAFT_CATALOG[page * 4 + slot];
        if (!spec) return;
        if (spec.locked) {
          this.touch(tablet, `${spec.label} is locked`, "error");
          return;
        }
        tablet.setValue(TabletState, "view", "crafts");
        tablet.setValue(TabletState, "selectedCraftKind", spec.kind);
        tablet.setValue(TabletState, "selectedCraftCost", spec.cost);
        tablet.setValue(TabletState, "buildPlacementActive", false);
        tablet.setValue(TabletState, "craftPlacementActive", false);
        this.hidePlacementMarker();
        this.touch(tablet, `${spec.label}: ${spec.cost} crystals`);
      });
    }
    on("craft-prev", () => this.changeCraftPage(tablet, -1));
    on("craft-next", () => this.changeCraftPage(tablet, 1));
    for (let slot = 0; slot < 4; slot += 1) {
      on(`unit-card-${slot}`, () => this.toggleRosterSlot(tablet, slot));
    }
    on("unit-prev", () => this.changeUnitPage(tablet, -1));
    on("unit-next", () => this.changeUnitPage(tablet, 1));
    on("unit-clear", () => {
      clearUnitSelections();
      tablet.setValue(TabletState, "astronaut", null);
      tablet.setValue(TabletState, "astronautIndex", -1);
      this.touch(tablet, "Unit selection cleared");
    });
    on("build-produce", () => this.produceSelectedBuilding(tablet));
    on("craft-produce", () => this.produceSelectedCraft(tablet));
  }

  private changeCraftPage(tablet: Entity, direction: number): void {
    const pageCount = Math.max(1, Math.ceil(CRAFT_CATALOG.length / 4));
    const current = tablet.getValue(TabletState, "craftPage") ?? 0;
    const next = Math.max(0, Math.min(pageCount - 1, current + direction));
    if (next === current) return;
    tablet.setValue(TabletState, "craftPage", next);
    tablet.setValue(TabletState, "craftPlacementActive", false);
    this.hidePlacementMarker();
    this.touch(tablet, `Craft catalog page ${next + 1} of ${pageCount}`);
  }

  private openCrafts(tablet: Entity): void {
    if (!(tablet.getValue(TabletState, "spawnBuilding") as Entity | null)) {
      const commandCenter = boardState.commandCenter;
      if (commandCenter) {
        tablet.setValue(TabletState, "spawnBuilding", commandCenter);
        tablet.setValue(TabletState, "spawnBuildingIndex", commandCenter.index);
      }
    }
    this.setView(tablet, "crafts", "Choose a craft to produce");
  }

  private openUnits(tablet: Entity): void {
    tablet.setValue(TabletState, "unitFilter", "all");
    tablet.setValue(TabletState, "unitPage", 0);
    this.setView(tablet, "units", "All live units");
  }

  private setView(tablet: Entity, view: string, status: string): void {
    tablet.setValue(TabletState, "view", view);
    tablet.setValue(TabletState, "buildPlacementActive", false);
    tablet.setValue(TabletState, "craftPlacementActive", false);
    this.hidePlacementMarker();
    this.touch(tablet, status);
  }

  private touch(tablet: Entity, status: string, statusKind = "info"): void {
    tablet.setValue(TabletState, "status", status);
    tablet.setValue(TabletState, "statusKind", statusKind);
    tablet.setValue(
      TabletState,
      "revision",
      (tablet.getValue(TabletState, "revision") ?? 0) + 1,
    );
  }

  private applyView(view: string): void {
    element(this.document!, "overview-view")?.setProperties({
      display: view === "overview" ? "flex" : "none",
    });
    element(this.document!, "build-view")?.setProperties({
      display: view === "build" ? "flex" : "none",
    });
    element(this.document!, "crafts-view")?.setProperties({
      display: view === "crafts" ? "flex" : "none",
    });
    element(this.document!, "units-view")?.setProperties({
      display: view === "units" ? "flex" : "none",
    });
    element(this.document!, "settings-view")?.setProperties({
      display: view === "settings" ? "flex" : "none",
    });
    const tabs = [
      ["tab-overview", "overview"],
      ["tab-build", "build"],
      ["tab-crafts", "crafts"],
      ["tab-units", "units"],
      ["tab-settings", "settings"],
    ];
    for (const [id, tabView] of tabs) {
      element(this.document!, id)?.setProperties({
        backgroundColor:
          view === tabView
            ? TABLET_TAB_ACTIVE_BACKGROUND
            : TABLET_TAB_INACTIVE_BACKGROUND,
        borderColor:
          view === tabView
            ? TABLET_TAB_ACTIVE_BORDER
            : TABLET_TAB_INACTIVE_BORDER,
        borderWidth: view === tabView ? 2 : 1,
      });
    }
  }

  private applySelectedCard(kind: string): void {
    for (const spec of BUILDING_CATALOG.filter((item) => !item.locked)) {
      element(this.document!, `build-${spec.kind}`)?.setProperties({
        borderColor:
          spec.kind === kind ? TABLET_SELECTED_BUILD_BORDER : TABLET_CARD_BORDER,
        borderWidth: spec.kind === kind ? 3 : 1,
      });
    }
  }

  private applyCraftPage(tablet: Entity, selectedKind: string): void {
    const pageCount = Math.max(1, Math.ceil(CRAFT_CATALOG.length / 4));
    const page = Math.max(
      0,
      Math.min(pageCount - 1, tablet.getValue(TabletState, "craftPage") ?? 0),
    );
    for (let slot = 0; slot < 4; slot += 1) {
      const spec = CRAFT_CATALOG[page * 4 + slot];
      element(this.document!, `craft-card-${slot}`)?.setProperties({
        display: spec ? "flex" : "none",
        borderColor:
          spec?.kind === selectedKind
            ? TABLET_SELECTED_CRAFT_BORDER
            : TABLET_CARD_BORDER,
        borderWidth: spec?.kind === selectedKind ? 3 : 1,
      });
      if (!spec) continue;
      element(this.document!, `craft-image-${slot}`)?.setProperties({
        src: spec.image,
      });
      this.setText(`craft-name-${slot}`, spec.label);
      this.setText(`craft-cost-${slot}`, `${spec.cost} crystals`);
    }
    this.setText("craft-page-label", `Page ${page + 1} / ${pageCount}`);
    element(this.document!, "craft-prev")?.setProperties({
      opacity: page > 0 ? 1 : 0.35,
    });
    element(this.document!, "craft-next")?.setProperties({
      opacity: page < pageCount - 1 ? 1 : 0.35,
    });
  }

  private adjustSetting(
    tablet: Entity,
    key: DebugSettingKey,
    direction: number,
  ): void {
    const spec = DEBUG_SETTINGS_CATALOG.find((item) => item.key === key);
    const settings = boardState.debugSettings;
    if (!spec || !settings) return;
    const current = (settings.getValue(DebugSettings, spec.key) as number) ?? spec.min;
    const raw = current + spec.step * direction;
    const rounded = Math.round(raw / spec.step) * spec.step;
    const next = Math.min(spec.max, Math.max(spec.min, rounded));
    settings.setValue(DebugSettings, spec.key, next);
    settings.setValue(
      DebugSettings,
      "revision",
      (settings.getValue(DebugSettings, "revision") ?? 0) + 1,
    );
    if (spec.key === "turretRange") refreshTurretRangeRingGeometry();
    if (
      spec.key === "astronautAttackRange" ||
      spec.key === "craftRacerAttackRange"
    ) {
      refreshUnitAttackRangeRingGeometry();
    }
    this.applyHealthSetting(spec.key, current, next);
    this.touch(
      tablet,
      `${spec.label}: ${this.formatSettingValue(next, spec.decimals)}`,
    );
  }

  private applyHealthSetting(
    key: DebugSettingKey,
    previousValue: number,
    nextValue: number,
  ): void {
    if (key === "buildingHealthScale") {
      for (const building of this.queries.buildings.entities) {
        this.setEntityMaxHealth(
          building,
          currentBuildingMaxHealth(building.getValue(Building, "kind") ?? ""),
        );
      }
      return;
    }
    if (key === "alienHealthScale") {
      const ratio = nextValue / Math.max(0.01, previousValue);
      for (const enemy of this.queries.enemies.entities) {
        const previousMax =
          enemy.getValue(Health, "max") ??
          currentEnemyMaxHealth(enemy.getValue(Enemy, "kind") ?? "alien");
        this.setEntityMaxHealth(
          enemy,
          Math.round(previousMax * ratio),
        );
      }
      return;
    }
    if (
      key !== "astronautHealth" &&
      key !== "craftRacerHealth" &&
      key !== "craftMinerHealth"
    ) {
      return;
    }
    for (const unit of this.queries.units.entities) {
      const kind = unit.getValue(Unit, "kind") ?? "";
      if (
        (key === "astronautHealth" && kind !== "astronaut") ||
        (key === "craftRacerHealth" && kind !== "racer") ||
        (key === "craftMinerHealth" && kind !== "miner")
      ) {
        continue;
      }
      this.setEntityMaxHealth(unit, currentUnitMaxHealth(kind));
    }
  }

  private setEntityMaxHealth(entity: Entity, nextMax: number): void {
    const previousMax = Math.max(1, entity.getValue(Health, "max") ?? nextMax);
    const previousCurrent = Math.max(
      0,
      entity.getValue(Health, "current") ?? previousMax,
    );
    const max = Math.max(1, Math.round(nextMax));
    const current = Math.min(
      max,
      Math.max(0, previousCurrent + max - previousMax),
    );
    entity.setValue(Health, "max", max);
    entity.setValue(Health, "current", current);
    updateHealthBar(entity);
  }

  private applySettingsView(): void {
    const settings = boardState.debugSettings;
    if (!settings) return;
    for (const spec of DEBUG_SETTINGS_CATALOG) {
      const value = (settings.getValue(DebugSettings, spec.key) as number) ?? spec.min;
      this.setText(
        `setting-${spec.key}-value`,
        this.formatSettingValue(value, spec.decimals),
      );
    }
  }

  private formatSettingValue(value: number, decimals: number): string {
    return value.toFixed(decimals);
  }

  private applyUnitPage(tablet: Entity): void {
    const roster = this.liveRoster();
    const filter = tablet.getValue(TabletState, "unitFilter") ?? "all";
    const page = paginateRoster(
      roster,
      filter,
      tablet.getValue(TabletState, "unitPage") ?? 0,
    );
    const totals = countRosterKinds(roster);
    const selectedCount =
      boardState.selection?.getValue(SelectionState, "selectedCount") ?? 0;
    this.setText(
      "unit-filter-label",
      filter === "all"
        ? `All units (${page.total})`
        : `${this.buildingLabel(filter)} (${page.total})`,
    );
    this.setText(
      "unit-selected-label",
      `${selectedCount} selected`,
    );

    for (let slot = 0; slot < 4; slot += 1) {
      const entry = page.entries[slot];
      const card = element(this.document!, `unit-card-${slot}`);
      const image = element(this.document!, `unit-image-${slot}`);
      if (entry) {
        const selected =
          entry.entity.getValue(UnitSelection, "selected") ?? false;
        card?.setProperties({
          backgroundColor: selected
            ? TABLET_SELECTED_UNIT_BACKGROUND
            : TABLET_UNIT_BACKGROUND,
          borderColor: selected
            ? TABLET_SELECTED_CRAFT_BORDER
            : TABLET_CARD_BORDER,
          borderWidth: selected ? 3 : 1,
          cursor: "pointer",
        });
        image?.setProperties({
          display: "flex",
          src: this.unitImage(entry.entity, entry.kind),
        });
        this.setText(`unit-name-${slot}`, this.unitLabel(entry.kind));
        this.setText(
          `unit-meta-${slot}`,
          `#${entry.index} - ${totals.get(entry.kind) ?? 1} total`,
        );
        continue;
      }

      const locked = slot === 3;
      card?.setProperties({
        backgroundColor: locked
          ? TABLET_LOCKED_UNIT_BACKGROUND
          : TABLET_EMPTY_UNIT_BACKGROUND,
        borderColor: locked ? TABLET_LOCKED_UNIT_BORDER : TABLET_EMPTY_UNIT_BORDER,
        borderWidth: 1,
        cursor: "default",
      });
      image?.setProperties({ display: "none" });
      this.setText(`unit-name-${slot}`, locked ? "Locked" : "Empty");
      this.setText(
        `unit-meta-${slot}`,
        locked ? "Future reinforcement" : "No live unit in this slot",
      );
    }

    this.setText(
      "unit-page-label",
      `Page ${page.page + 1} / ${page.pageCount}`,
    );
    element(this.document!, "unit-prev")?.setProperties({
      opacity: page.page > 0 ? 1 : 0.35,
    });
    element(this.document!, "unit-next")?.setProperties({
      opacity: page.page < page.pageCount - 1 ? 1 : 0.35,
    });
  }

  private liveRoster(): LiveRosterEntry[] {
    return Array.from(this.queries.units.entities, (entity) => ({
      entity,
      index: entity.index,
      kind: entity.getValue(Unit, "kind") ?? "unknown",
      category:
        entity.getValue(UnitSelection, "category") ?? "command-center",
    }));
  }

  private toggleRosterSlot(tablet: Entity, slot: number): void {
    const page = paginateRoster(
      this.liveRoster(),
      tablet.getValue(TabletState, "unitFilter") ?? "all",
      tablet.getValue(TabletState, "unitPage") ?? 0,
    );
    const entry = page.entries[slot];
    if (!entry) return;
    const selected = toggleUnitSelection(this.world, entry.entity);
    const single = getSingleSelectedUnit();
    const astronaut =
      single?.getValue(Unit, "kind") === "astronaut" ? single : null;
    tablet.setValue(TabletState, "astronaut", astronaut);
    tablet.setValue(TabletState, "astronautIndex", astronaut?.index ?? -1);
    this.touch(
      tablet,
      `${selected ? "Selected" : "Deselected"} ${this.unitLabel(entry.kind)} #${entry.index}`,
    );
  }

  private changeUnitPage(tablet: Entity, direction: number): void {
    const current = tablet.getValue(TabletState, "unitPage") ?? 0;
    const page = paginateRoster(
      this.liveRoster(),
      tablet.getValue(TabletState, "unitFilter") ?? "all",
      current,
    );
    const next = Math.max(0, Math.min(page.pageCount - 1, current + direction));
    if (next === current) return;
    tablet.setValue(TabletState, "unitPage", next);
    this.touch(tablet, `Unit roster page ${next + 1} of ${page.pageCount}`);
  }

  private produceSelectedCraft(tablet: Entity): void {
    const source = tablet.getValue(TabletState, "spawnBuilding") as Entity | null;
    const game = boardState.gameState;
    const spec = getCraftSpec(
      tablet.getValue(TabletState, "selectedCraftKind") ?? "none",
    );
    const validation = validateCraftPurchase({
      spec,
      crystals: game?.getValue(GameState, "crystals") ?? 0,
      buildingKind: source?.getValue(Building, "kind") ?? null,
      // Tile availability is validated when the player clicks the board.
      tileAvailable: true,
    });
    if (!validation.ok || !spec || !game) {
      this.touch(
        tablet,
        validation.ok ? "Craft production is unavailable" : validation.error,
        "error",
      );
      return;
    }

    tablet.setValue(TabletState, "craftPlacementActive", true);
    tablet.setValue(TabletState, "buildPlacementActive", false);
    tablet.setValue(TabletState, "astronaut", null);
    tablet.setValue(TabletState, "astronautIndex", -1);
    clearUnitSelections();
    this.touch(tablet, `Choose an open tile for ${spec.label}`);
  }

  private produceSelectedBuilding(tablet: Entity): void {
    const astronaut = tablet.getValue(TabletState, "astronaut") as Entity | null;
    if (!astronaut) {
      this.touch(tablet, "Select an astronaut to build", "error");
      return;
    }
    const spec = getBuildingSpec(
      tablet.getValue(TabletState, "selectedBuildingKind") ?? "none",
    );
    const validation = validateBuildOrder({
      spec,
      crystals: boardState.gameState?.getValue(GameState, "crystals") ?? 0,
      builderIdle:
        astronaut.hasComponent(ConstructionState) &&
        astronaut.getValue(ConstructionState, "stage") === "idle",
      // Footprint and path are validated against the tile the player clicks.
      footprintValid: true,
      pathFound: true,
    });
    if (!validation.ok || !spec) {
      this.touch(
        tablet,
        validation.ok ? "Building production is unavailable" : validation.error,
        "error",
      );
      return;
    }

    tablet.setValue(TabletState, "buildPlacementActive", true);
    tablet.setValue(TabletState, "craftPlacementActive", false);
    this.touch(tablet, `Choose a build tile for ${spec.label}`);
  }

  private hidePlacementMarker(): void {
    if (boardState.buildMarker?.object3D) {
      boardState.buildMarker.object3D.visible = false;
    }
  }

  private buildingLabel(kind: string): string {
    if (kind === "command-center") return "Command Center";
    if (kind === "factory") return "Aircraft Factory";
    if (kind === "hangar") return "Hangar";
    if (kind === "turret") return "Turret";
    return kind;
  }

  private unitLabel(kind: string): string {
    if (kind === "astronaut") return "Astronaut";
    return getCraftSpec(kind)?.label ?? kind;
  }

  private unitImage(unit: Entity, kind: string): string {
    if (kind === "astronaut") {
      return unit.object3D?.name.includes("B")
        ? "/images/astronautB.png"
        : "/images/astronautA.png";
    }
    return getCraftSpec(kind)?.image ?? "/images/rover.png";
  }

  private setText(id: string, text: string): void {
    element(this.document!, id)?.setProperties({ text });
  }
}
