import {
  Entity,
  Hovered,
  Mesh,
  MeshBasicMaterial,
  Pressed,
  createSystem,
} from "@iwsdk/core";
import { GRID_SIZE, gridToWorld, worldToGrid } from "./board.js";
import { stampBuildingFootprint } from "./buildingFactory.js";
import { getBuildingSpec, type BuildingSpec } from "./buildingCatalog.js";
import {
  attachBuilderToSite,
  createConstructionSite,
  releaseBuilder,
  siteAnchor,
} from "./construction.js";
import {
  ASTRONAUT_PRODUCTION_SPEC,
  getProductionSpec,
} from "./craftCatalog.js";
import { createCraftProductionSite } from "./craftProduction.js";
import {
  CRAFT_PRODUCTION_BUILDINGS,
  validateCraftPurchase,
} from "./craftRules.js";
import {
  BLOCKED_MARKER_COLOR,
  ORDER_MARKER_COLOR,
  VALID_PLACEMENT_MARKER_COLOR,
} from "./constants.ts";
import {
  footprintApproaches,
  footprintCells,
  validateBuildOrder,
} from "./constructionRules.js";
import {
  findApproachTile,
  findGridPath,
  type GridPosition,
} from "./navigation.js";
import {
  clearUnitSelections,
  getSelectedUnits,
  toggleEnemyRangeRing,
  getSingleSelectedUnit,
  toggleTurretRangeRing,
  toggleUnitSelection,
  updateCommandGridVisibility,
} from "./selection.js";
import { matchAcceptsCommands } from "./matchStart.js";
import {
} from "./selection.js";
import { assignGroupDestinations } from "./selectionRules.js";
import {
  BoardSurface,
  Building,
  CombatCapability,
  CombatState,
  ConstructionSite,
  ConstructionState,
  CraftProductionSite,
  Enemy,
  GameState,
  MinerState,
  ResourceNode,
  TabletState,
  Unit,
  boardState,
  getTerrainAt,
  gridKey,
  setTerrainAt,
} from "./state.js";
import { Consumer } from "./traceContracts.js";
import { trackPlacedSite } from "./phase2Trace.js";
import {
  beginWorldInteraction,
  finishInteraction,
  noteInteractionStage,
} from "./traceInteraction.js";
import {
  newCorrelationId,
  traceDecision,
  traceEntityCreated,
  traceWrite,
} from "./trace.js";
import {
  Contract,
  EntityKind,
  InteractionStage,
  Lifecycle,
  Reason,
  State,
  Terminal,
} from "./traceIds.js";

function markerToLocal(markerEntity: Entity | null, x: number, z: number): void {
  const marker = markerEntity?.object3D;
  if (!marker) return;
  marker.position.set(x, marker.position.y, z);
  marker.visible = true;
}

function hideMarker(markerEntity: Entity | null): void {
  const marker = markerEntity?.object3D;
  if (marker) marker.visible = false;
}

function moveMarker(
  markerEntity: Entity | null,
  tile: { x: number; y: number } | null,
): void {
  if (!tile) {
    hideMarker(markerEntity);
    return;
  }
  const [worldX, worldZ] = gridToWorld(tile.x, tile.y);
  markerToLocal(markerEntity, worldX, worldZ);
}

function setOrderMarker(tileX: number, tileY: number, color: number): void {
  const marker = boardState.orderMarker?.object3D as Mesh | undefined;
  if (!marker) return;
  (marker.material as MeshBasicMaterial).color.setHex(color);
  const [worldX, worldZ] = gridToWorld(tileX, tileY);
  marker.position.set(worldX, marker.position.y, worldZ);
  marker.visible = true;
}

export class InteractionSystem extends createSystem({
  hoveredBoard: { required: [BoardSurface, Hovered] },
  pressedBoard: { required: [BoardSurface, Pressed] },
  pressedUnits: { required: [Unit, Pressed] },
  pressedEnemies: { required: [Enemy, Pressed] },
  pressedBuildings: { required: [Building, Pressed] },
  pressedSites: { required: [ConstructionSite, Pressed] },
  pressedCraftSites: { required: [CraftProductionSite, Pressed] },
  units: { required: [Unit] },
  enemies: { required: [Enemy] },
  sites: { required: [ConstructionSite] },
}) {
  init(): void {
    this.cleanupFuncs.push(
      this.queries.hoveredBoard.subscribe("qualify", () => {
        this.syncHoveredBoardTile();
      }),
      this.queries.hoveredBoard.subscribe("disqualify", () => {
        boardState.hoveredTile = null;
        moveMarker(boardState.hoverMarker, null);
        hideMarker(boardState.buildMarker);
      }),
      // Board and roster clicks share the same toggle semantics so a unit can
      // be added to or removed from a group from either surface.
      this.queries.pressedUnits.subscribe("qualify", (entity) => {
        this.observeWorldPress(entity, () => {
        if (this.isCraftPlacementActive()) {
          this.rejectCraftPlacementTarget(entity);
          return;
        }
        if (this.isBuildPlacementModeActive()) {
          this.rejectBuildPlacementTarget(entity);
          return;
        }
        toggleUnitSelection(this.world, entity);
        boardState.selectedTile = null;
        hideMarker(boardState.selectionMarker);
        const single = getSingleSelectedUnit();
        const astronaut =
          single?.getValue(Unit, "kind") === "astronaut" ? single : null;
        if (boardState.tablet?.getValue(TabletState, "view") === "units") {
          boardState.tablet.setValue(TabletState, "astronaut", astronaut);
          boardState.tablet.setValue(
            TabletState,
            "astronautIndex",
            astronaut?.index ?? -1,
          );
          this.setTabletStatus(`${getSelectedUnits().length} units selected`);
        } else {
          this.publishBuilder(astronaut);
        }
        });
      }),
      // Click an enemy with a unit selected: approach the open tile on the
      // mover-facing side. The red marker stays on the unavailable target.
      this.queries.pressedEnemies.subscribe("qualify", (entity) => {
        this.observeWorldPress(entity, () => {
        if (this.isCraftPlacementActive()) {
          this.rejectCraftPlacementTarget(entity);
          return;
        }
        if (this.isBuildPlacementModeActive()) {
          this.rejectBuildPlacementTarget(entity);
          return;
        }
        const units = getSelectedUnits();
        const enemyObject = entity.object3D;
        if (!enemyObject) return;
        // Nothing of yours selected, so this click cannot be an attack order:
        // treat it as inspection and show the alien's threat radius instead.
        if (units.length === 0) {
          const shown = toggleEnemyRangeRing(this.world, entity);
          const kind = entity.getValue(Enemy, "kind") ?? "alien";
          this.setTabletStatus(
            shown ? `${kind} attack range shown` : "Attack range hidden",
            "info",
          );
          return;
        }
        const attackers = units.filter((unit) =>
          unit.hasComponent(CombatCapability),
        );
        for (const unit of units) {
          if (!unit.hasComponent(CombatCapability)) {
            this.setCombatTarget(unit, null);
          }
        }
        if (attackers.length === 0) {
          this.setTabletStatus("Selected units cannot attack", "error");
          return;
        }
        const [ex, ey] = worldToGrid(enemyObject.position.x, enemyObject.position.z);
        const assigned = this.issueGroupOrder(attackers, ex, ey, entity);
        this.setTabletStatus(
          `${assigned} combat unit${assigned === 1 ? "" : "s"} attacking`,
          assigned > 0 ? "info" : "error",
        );
        setOrderMarker(ex, ey, BLOCKED_MARKER_COLOR);
        if (assigned > 0) this.clearCommandSelection();
        });
      }),
      // Buildings are production sources. Selecting one opens Crafts and
      // records which building is authorizing the next craft purchase.
      this.queries.pressedBuildings.subscribe("qualify", (entity) => {
        this.observeWorldPress(entity, () => {
        if (this.isCraftPlacementActive()) {
          this.rejectCraftPlacementTarget(entity);
          return;
        }
        if (this.isBuildPlacementModeActive()) {
          this.rejectBuildPlacementTarget(entity);
          return;
        }
        const tablet = boardState.tablet;
        if (!tablet) return;
        const kind = entity.getValue(Building, "kind") ?? "building";
        if (kind === "turret") {
          toggleTurretRangeRing(this.world, entity);
        }
        // Always record what was clicked; only a building that can actually
        // produce becomes the production source. Clicking a turret used to
        // overwrite `spawnBuilding` with something that can never produce, and
        // nothing set it back — every craft after that failed validation with
        // "That building cannot produce crafts".
        const canProduce = CRAFT_PRODUCTION_BUILDINGS.has(kind);
        tablet.setValue(TabletState, "focusBuilding", entity);
        tablet.setValue(TabletState, "focusBuildingIndex", entity.index);
        if (tablet.getValue(TabletState, "view") === "units") {
          if (canProduce) {
            tablet.setValue(TabletState, "spawnBuilding", entity);
            tablet.setValue(TabletState, "spawnBuildingIndex", entity.index);
          }
          // Do NOT narrow the roster to this building's kind. That used to be
          // harmless because buildings were absent from the roster, so the
          // filter produced nothing visible. Now that turrets are listed, it
          // hid every unit behind a turrets-only view. Clicking a turret on the
          // board is simply selecting it, exactly like clicking its card.
          this.setTabletStatus(
            `${this.buildingLabel(kind)} #${entity.index} selected`,
          );
          return;
        }
        clearUnitSelections();
        hideMarker(boardState.selectionMarker);
        hideMarker(boardState.buildMarker);
        tablet.setValue(TabletState, "astronaut", null);
        tablet.setValue(TabletState, "astronautIndex", -1);
        if (canProduce) {
          tablet.setValue(TabletState, "spawnBuilding", entity);
          tablet.setValue(TabletState, "spawnBuildingIndex", entity.index);
        }
        tablet.setValue(TabletState, "buildPlacementActive", false);
        tablet.setValue(TabletState, "craftPlacementActive", false);
        tablet.setValue(TabletState, "view", "crafts");
        updateCommandGridVisibility();
        this.setTabletStatus(
          canProduce
            ? "Choose a craft to produce"
            : `${this.buildingLabel(kind)} selected - it cannot produce crafts`,
        );
        });
      }),
      // Click a construction site. With astronauts selected they take the job
      // (manual assignment); with nothing selected the site itself becomes the
      // selection, which is what the tablet's Cancel action acts on.
      this.queries.pressedSites.subscribe("qualify", (site) => {
        this.observeWorldPress(site, () => {
        if (this.isCraftPlacementActive()) {
          this.rejectCraftPlacementTarget(site);
          return;
        }
        if (this.isBuildPlacementModeActive()) {
          this.rejectBuildPlacementTarget(site);
          return;
        }
        const astronauts = getSelectedUnits().filter(
          (unit) => unit.getValue(Unit, "kind") === "astronaut",
        );
        if (astronauts.length > 0) {
          this.assignBuildersToSite(astronauts, site);
          return;
        }
        this.selectConstructionSite(site);
        });
      }),
      // An in-flight craft is the same idea: select it to be able to cancel it.
      this.queries.pressedCraftSites.subscribe("qualify", (site) => {
        this.observeWorldPress(site, () => {
        if (this.isCraftPlacementActive()) {
          this.rejectCraftPlacementTarget(site);
          return;
        }
        if (this.isBuildPlacementModeActive()) {
          this.rejectBuildPlacementTarget(site);
          return;
        }
        const astronauts = getSelectedUnits().filter(
          (unit) => unit.getValue(Unit, "kind") === "astronaut",
        );
        if (
          astronauts.length > 0 &&
          (site.getValue(CraftProductionSite, "requiresBuilder") ?? false)
        ) {
          this.assignBuildersToSite(astronauts, site);
          return;
        }
        this.selectCraftProductionSite(site);
        });
      }),
      // Click a tile: open -> move there. Terrain features and occupied tiles
      // are unavailable destinations, so approach from the nearest open tile.
      this.queries.pressedBoard.subscribe("qualify", (entity) => {
        this.observeWorldPress(entity, (corr) => {
        const pointerTile = boardState.pointerTile;
        if (!pointerTile) return;
        const { x: tx, y: ty } = pointerTile;
        if (this.isCraftPlacementActive()) {
          this.placeCraft(tx, ty, corr);
          return;
        }
        // Place-first: a build order no longer needs a selected astronaut. The
        // site drops on the board here and the ConstructionSystem sends
        // whoever is free.
        if (this.isBuildPlacementActive()) {
          this.placeConstructionSite(tx, ty, corr);
          return;
        }
        const units = getSelectedUnits();
        const unit = boardState.selectedUnit;
        if (unit && units.length > 0) {
          const resource = boardState.resourceByKey.get(gridKey(tx, ty));
          if (
            resource &&
            (resource.getValue(ResourceNode, "remaining") ?? 0) > 0 &&
            units.length === 1 &&
            unit.getValue(Unit, "kind") === "miner"
          ) {
            const resourceDestination = this.nearestOpenAdjacent(tx, ty, unit);
            const baseDestination = this.nearestCommandCenterApproach(unit);
            if (resourceDestination && baseDestination) {
              this.startMining(
                unit,
                resource,
                tx,
                ty,
                resourceDestination,
                baseDestination,
              );
              this.clearCommandSelection();
            }
            setOrderMarker(tx, ty, BLOCKED_MARKER_COLOR);
            return;
          }

          const blocked = getTerrainAt(tx, ty) !== "open";
          const selectedSet = new Set(units);
          const occupied = this.isOccupiedExcept(tx, ty, selectedSet);
          const assigned = this.issueGroupOrder(units, tx, ty);
          setOrderMarker(
            tx,
            ty,
            blocked || occupied ? BLOCKED_MARKER_COLOR : ORDER_MARKER_COLOR,
          );
          if (assigned > 0) this.clearCommandSelection();
          return;
        }
        boardState.selectedTile = { x: tx, y: ty };
        moveMarker(boardState.selectionMarker, boardState.selectedTile);
        });
      }),
    );
  }

  update(): void {
    if (this.queries.hoveredBoard.entities.size > 0) {
      this.syncHoveredBoardTile();
    }
  }

  /**
   * Correlate a supported `Pressed` boundary with its application-visible
   * result. The internal InputSystem ray test already happened before this
   * callback and is deliberately not inspected or polled here.
   */
  private observeWorldPress(target: Entity, action: (corr: number) => void): void {
    // Every gameplay press in this system funnels through here, so this is the
    // one place that has to refuse them once the match is decided. Without it
    // units keep taking orders and sites keep being cancelled over a finished
    // match — the result panel is up and the board is still playable behind it.
    //
    // The tablet is untouched: its handlers live in TabletSystem, so Restart
    // still works. That is the whole reason this gate is here and not on the
    // system's update.
    if (!matchAcceptsCommands()) return;
    const corr = beginWorldInteraction(target.index);
    const tablet = boardState.tablet;
    const beforeRevision = tablet?.getValue(TabletState, "revision") ?? -1;
    noteInteractionStage(corr, InteractionStage.GameplayValidation, target.index);
    try {
      action(corr);
    } catch (error) {
      finishInteraction(corr, Terminal.ActionFailure, Reason.SystemError);
      throw error;
    }
    const afterRevision = tablet?.getValue(TabletState, "revision") ?? -1;
    if (afterRevision !== beforeRevision) {
      noteInteractionStage(corr, InteractionStage.StateChange, afterRevision);
      noteInteractionStage(corr, InteractionStage.VisualResponse, afterRevision);
    }
    const rejected =
      afterRevision !== beforeRevision &&
      tablet?.getValue(TabletState, "statusKind") === "error";
    finishInteraction(
      corr,
      rejected ? Terminal.RejectedWithReason : Terminal.Success,
      Reason.None,
    );
  }

  private syncHoveredBoardTile(): void {
    const tile = boardState.pointerTile;
    if (!tile) {
      boardState.hoveredTile = null;
      moveMarker(boardState.hoverMarker, null);
      hideMarker(boardState.buildMarker);
      return;
    }
    if (
      boardState.hoveredTile?.x === tile.x &&
      boardState.hoveredTile.y === tile.y
    ) {
      return;
    }
    boardState.hoveredTile = { x: tile.x, y: tile.y };
    this.updateHoverMarker(tile.x, tile.y);
  }

  private issueOrder(unit: Entity, x: number, y: number): void {
    unit.setValue(Unit, "orderX", x);
    unit.setValue(Unit, "orderY", y);
    unit.setValue(Unit, "hasOrder", true);
  }

  private issueGroupOrder(
    units: readonly Entity[],
    targetX: number,
    targetY: number,
    combatTarget: Entity | null = null,
  ): number {
    const eligible = units.filter(
      (unit) => unit.object3D && this.prepareManualOrder(unit),
    );
    const moving = new Set(eligible);
    for (const unit of eligible) this.setCombatTarget(unit, null);
    const assignments = assignGroupDestinations({
      members: eligible.map((unit) => {
        const [x, y] = worldToGrid(
          unit.object3D!.position.x,
          unit.object3D!.position.z,
        );
        return { unit, x, y };
      }),
      target: { x: targetX, y: targetY },
      gridSize: GRID_SIZE,
      canStandAt: (x, y) =>
        getTerrainAt(x, y) === "open" &&
        !this.isOccupiedExcept(x, y, moving),
    });
    for (const assignment of assignments) {
      this.issueOrder(assignment.unit, assignment.x, assignment.y);
      this.setCombatTarget(assignment.unit, combatTarget);
    }
    return assignments.length;
  }

  private setCombatTarget(unit: Entity, target: Entity | null): void {
    if (!unit.hasComponent(CombatState)) return;
    unit.setValue(CombatState, "target", target);
    unit.setValue(CombatState, "targetMode", target ? "manual" : "none");
    unit.setValue(CombatState, "stage", target ? "approaching" : "idle");
    unit.setValue(CombatState, "timer", 0);
  }

  private startMining(
    miner: Entity,
    resource: Entity,
    targetX: number,
    targetY: number,
    resourceDestination: [number, number],
    baseDestination: [number, number],
  ): void {
    this.setCombatTarget(miner, null);
    miner.setValue(MinerState, "target", resource);
    miner.setValue(MinerState, "targetX", targetX);
    miner.setValue(MinerState, "targetY", targetY);
    miner.setValue(MinerState, "approachX", resourceDestination[0]);
    miner.setValue(MinerState, "approachY", resourceDestination[1]);
    miner.setValue(MinerState, "depositX", baseDestination[0]);
    miner.setValue(MinerState, "depositY", baseDestination[1]);
    miner.setValue(MinerState, "timer", 0);

    if ((miner.getValue(MinerState, "cargo") ?? 0) > 0) {
      miner.setValue(MinerState, "stage", "toBase");
      if (!(miner.getValue(Unit, "hasOrder") ?? false)) {
        this.issueOrder(miner, baseDestination[0], baseDestination[1]);
      }
      return;
    }

    miner.setValue(MinerState, "stage", "toResource");
    this.issueOrder(miner, resourceDestination[0], resourceDestination[1]);
  }

  private prepareManualOrder(unit: Entity): boolean {
    // A move order now pulls a builder off its job instead of being refused.
    // The site survives and waits for someone else, so this is a reassignment
    // rather than a lost build — and it is the only way to rescue a builder
    // sent to a site that has become unreachable.
    if (
      unit.hasComponent(ConstructionState) &&
      unit.getValue(ConstructionState, "stage") !== "idle"
    ) {
      releaseBuilder(unit);
    }
    if (!unit.hasComponent(MinerState)) return true;
    if ((unit.getValue(MinerState, "cargo") ?? 0) > 0) return false;
    unit.setValue(MinerState, "stage", "idle");
    unit.setValue(MinerState, "timer", 0);
    unit.setValue(MinerState, "target", null);
    return true;
  }

  private nearestCommandCenterApproach(unit: Entity): [number, number] | null {
    const commandCenter = boardState.commandCenter?.object3D;
    if (!commandCenter) return null;
    const [x, y] = worldToGrid(commandCenter.position.x, commandCenter.position.z);
    return this.nearestOpenAdjacent(x, y, unit);
  }

  private isOccupied(tx: number, ty: number, exclude: Entity | null): boolean {
    for (const other of this.queries.units.entities) {
      if (exclude && other === exclude) continue;
      const o = other.object3D;
      if (!o) continue;
      const [ox, oy] = worldToGrid(o.position.x, o.position.z);
      if (ox === tx && oy === ty) return true;
    }
    for (const enemy of this.queries.enemies.entities) {
      const object = enemy.object3D;
      if (!object) continue;
      const [ex, ey] = worldToGrid(object.position.x, object.position.z);
      if (ex === tx && ey === ty) return true;
    }
    return false;
  }

  private isOccupiedExcept(
    tx: number,
    ty: number,
    excluded: ReadonlySet<Entity>,
  ): boolean {
    for (const unit of this.queries.units.entities) {
      if (excluded.has(unit) || !unit.object3D) continue;
      const [x, y] = worldToGrid(
        unit.object3D.position.x,
        unit.object3D.position.z,
      );
      if (x === tx && y === ty) return true;
    }
    for (const enemy of this.queries.enemies.entities) {
      if (!enemy.object3D) continue;
      const [x, y] = worldToGrid(
        enemy.object3D.position.x,
        enemy.object3D.position.z,
      );
      if (x === tx && y === ty) return true;
    }
    return false;
  }

  private nearestOpenAdjacent(
    tx: number,
    ty: number,
    unit: Entity,
  ): [number, number] | null {
    const from = unit.object3D;
    if (!from) return null;
    const [fromX, fromY] = worldToGrid(from.position.x, from.position.z);
    const result = findApproachTile({
      target: { x: tx, y: ty },
      from: { x: fromX, y: fromY },
      gridSize: GRID_SIZE,
      canStandAt: (x, y) => {
        return (
          getTerrainAt(x, y) === "open" &&
          !this.isOccupied(x, y, unit)
        );
      },
    });
    return result ? [result.x, result.y] : null;
  }

  private publishBuilder(astronaut: Entity | null): void {
    const tablet = boardState.tablet;
    if (!tablet) return;
    tablet.setValue(TabletState, "astronaut", astronaut);
    tablet.setValue(TabletState, "astronautIndex", astronaut?.index ?? -1);
    tablet.setValue(TabletState, "buildPlacementActive", false);
    hideMarker(boardState.buildMarker);
    if (astronaut) {
      tablet.setValue(TabletState, "view", "build");
      this.setTabletStatus("Choose a building type");
    } else {
      this.setTabletStatus("Select an astronaut to build");
    }
  }

  // No astronaut in this test any more — that is the place-first change.
  private isBuildPlacementActive(): boolean {
    const tablet = boardState.tablet;
    return Boolean(
      tablet &&
        tablet.getValue(TabletState, "view") === "build" &&
        tablet.getValue(TabletState, "buildPlacementActive") &&
        tablet.getValue(TabletState, "selectedBuildingKind") !== "none",
    );
  }

  private isBuildPlacementModeActive(): boolean {
    const tablet = boardState.tablet;
    return Boolean(
      tablet &&
        tablet.getValue(TabletState, "view") === "build" &&
        tablet.getValue(TabletState, "buildPlacementActive"),
    );
  }

  private isCraftPlacementActive(): boolean {
    const tablet = boardState.tablet;
    return Boolean(
      tablet &&
        (tablet.getValue(TabletState, "view") === "crafts" ||
          tablet.getValue(TabletState, "view") === "build") &&
        tablet.getValue(TabletState, "craftPlacementActive") &&
        tablet.getValue(TabletState, "selectedCraftKind") !== "none",
    );
  }

  private placeCraft(tx: number, ty: number, corr = 0): void {
    const tablet = boardState.tablet;
    const gameState = boardState.gameState;
    const root = boardState.boardRoot;
    if (!tablet || !gameState || !root) return;
    const spec = getProductionSpec(
      tablet.getValue(TabletState, "selectedCraftKind") ?? "none",
    );
    const validation = validateCraftPurchase({
      spec,
      crystals: gameState.getValue(GameState, "crystals") ?? 0,
      tileAvailable: this.isCraftTileAvailable(tx, ty),
    });
    if (!validation.ok || !spec) {
      this.setTabletStatus(
        validation.ok ? "Craft placement is unavailable" : validation.error,
        "error",
      );
      setOrderMarker(tx, ty, BLOCKED_MARKER_COLOR);
      return;
    }

    const actionCorr = corr || newCorrelationId();
    const previousCrystals = gameState.getValue(GameState, "crystals") ?? 0;
    const revision = (gameState.getValue(GameState, "revision") ?? 0) + 1;
    gameState.setValue(GameState, "crystals", validation.remainingCrystals);
    gameState.setValue(GameState, "revision", revision);
    traceWrite(
      State.Crystals,
      previousCrystals,
      validation.remainingCrystals,
      revision,
      actionCorr,
    );
    setTerrainAt(tx, ty, "blocked");
    // Astronaut production is the one thing that still builds itself. Every
    // other craft is a real job an astronaut has to come and do.
    const requiresBuilder = spec.kind !== ASTRONAUT_PRODUCTION_SPEC.kind;
    const site = createCraftProductionSite(
      this.world,
      root,
      spec,
      tx,
      ty,
      "none",
      requiresBuilder,
    );
    traceEntityCreated(site.index, EntityKind.CraftProductionSite, Lifecycle.Created, Reason.Placed);
    traceDecision(Reason.Placed, site.index, State.SelectedCraftKind, actionCorr);
    trackPlacedSite(
      site.index,
      Contract.TabletOrderReachesBuilder,
      actionCorr,
      Consumer.Production,
    );
    tablet.setValue(TabletState, "craftPlacementActive", false);
    hideMarker(boardState.buildMarker);
    setOrderMarker(tx, ty, VALID_PLACEMENT_MARKER_COLOR);

    const astronauts = requiresBuilder
      ? getSelectedUnits().filter(
          (unit) => unit.getValue(Unit, "kind") === "astronaut",
        )
      : [];
    const assigned =
      astronauts.length > 0 ? this.assignBuildersToSite(astronauts, site) : 0;
    if (assigned === 0) {
      this.setTabletStatus(
        requiresBuilder
          ? `${spec.label} placed. Waiting for an astronaut`
          : `${spec.label} production started (${spec.duration}s)`,
        "success",
      );
    }
    this.clearCommandSelection();
  }

  private isCraftTileAvailable(tx: number, ty: number): boolean {
    return (
      getTerrainAt(tx, ty) === "open" && !this.isOccupied(tx, ty, null)
    );
  }

  private rejectCraftPlacementTarget(entity: Entity): void {
    const object = entity.object3D;
    if (!object) return;
    const [x, y] = worldToGrid(object.position.x, object.position.z);
    setOrderMarker(x, y, BLOCKED_MARKER_COLOR);
    this.setTabletStatus("That tile is blocked. Choose an open tile", "error");
  }

  private rejectBuildPlacementTarget(entity: Entity): void {
    const object = entity.object3D;
    if (!object) return;
    const [x, y] = worldToGrid(object.position.x, object.position.z);
    setOrderMarker(x, y, BLOCKED_MARKER_COLOR);
    this.setTabletStatus(
      "That footprint is blocked. Choose an open tile",
      "error",
    );
  }

  // Place-first construction. The order becomes a board object immediately:
  // the footprint is reserved and the cost is taken NOW (so you cannot queue
  // what you cannot afford — which is why cancelling refunds in full), and the
  // site waits, unclaimed, until an astronaut is free.
  private placeConstructionSite(tx: number, ty: number, corr = 0): void {
    const tablet = boardState.tablet;
    const gameState = boardState.gameState;
    const root = boardState.boardRoot;
    if (!tablet || !gameState || !root) return;
    const kind = tablet.getValue(TabletState, "selectedBuildingKind") ?? "none";
    const spec = getBuildingSpec(kind);
    const cells = spec ? footprintCells(tx, ty, spec.widthTiles) : [];
    const validation = validateBuildOrder({
      spec,
      crystals: gameState.getValue(GameState, "crystals") ?? 0,
      footprintValid: this.isFootprintAvailable(cells),
      // No builder is required to place, so there is no path to check here.
      // Reachability is the assigner's problem, and an unreachable site can be
      // cancelled for a full refund.
      pathFound: true,
    });
    if (!validation.ok || !spec) {
      this.setTabletStatus(
        validation.ok ? "Invalid build order" : validation.error,
        "error",
      );
      setOrderMarker(tx, ty, BLOCKED_MARKER_COLOR);
      return;
    }

    const actionCorr = corr || newCorrelationId();
    const previousCrystals = gameState.getValue(GameState, "crystals") ?? 0;
    const revision = (gameState.getValue(GameState, "revision") ?? 0) + 1;
    gameState.setValue(GameState, "crystals", validation.remainingCrystals);
    gameState.setValue(GameState, "revision", revision);
    traceWrite(
      State.Crystals,
      previousCrystals,
      validation.remainingCrystals,
      revision,
      actionCorr,
    );
    // The footprint blocks at PLACEMENT, not at build start. Without this two
    // orders could be placed overlapping and the second would corrupt the first.
    stampBuildingFootprint(tx, ty, spec.widthTiles);
    const site = createConstructionSite(this.world, root, spec, tx, ty);
    traceEntityCreated(site.index, EntityKind.ConstructionSite, Lifecycle.Created, Reason.Placed);
    traceDecision(Reason.Placed, site.index, State.SelectedBuildingKind, actionCorr);
    trackPlacedSite(
      site.index,
      Contract.TabletOrderReachesBuilder,
      actionCorr,
      Consumer.Construction,
    );
    tablet.setValue(TabletState, "buildPlacementActive", false);
    hideMarker(boardState.buildMarker);

    // If astronauts happen to be selected, treat that as an explicit "you three
    // build it" and skip the wait. Otherwise it queues for the assigner.
    const astronauts = getSelectedUnits().filter(
      (unit) => unit.getValue(Unit, "kind") === "astronaut",
    );
    const assigned =
      astronauts.length > 0 ? this.assignBuildersToSite(astronauts, site) : 0;
    if (assigned === 0) {
      this.setTabletStatus(`${spec.label} placed. Waiting for an astronaut`);
    }
    setOrderMarker(tx, ty, ORDER_MARKER_COLOR);
    this.clearCommandSelection();
  }

  private assignBuildersToSite(
    astronauts: readonly Entity[],
    site: Entity,
  ): number {
    const anchor = siteAnchor(site);
    if (!anchor) return 0;
    const { x: anchorX, y: anchorY, widthTiles: width } = anchor;
    const cells = footprintCells(anchorX, anchorY, width);
    let assigned = 0;
    for (const astronaut of astronauts) {
      const path = this.findSitePath(astronaut, anchorX, anchorY, width, cells);
      if (!path) continue;
      this.setCombatTarget(astronaut, null);
      attachBuilderToSite(astronaut, site, path);
      assigned += 1;
    }
    const label = this.siteLabel(site);
    if (assigned === 0) {
      this.setTabletStatus(`No path to the ${label} site`, "error");
    } else {
      this.setTabletStatus(
        `${assigned} astronaut${assigned === 1 ? "" : "s"} building ${label}`,
      );
    }
    return assigned;
  }

  private selectConstructionSite(site: Entity): void {
    const tablet = boardState.tablet;
    if (!tablet) return;
    clearUnitSelections();
    boardState.selectedSite = site;
    tablet.setValue(TabletState, "selectedSite", site);
    tablet.setValue(TabletState, "selectedSiteIndex", site.index);
    tablet.setValue(TabletState, "view", "build");
    tablet.setValue(TabletState, "buildPlacementActive", false);
    tablet.setValue(TabletState, "craftPlacementActive", false);
    hideMarker(boardState.buildMarker);
    updateCommandGridVisibility();
    const spec = getBuildingSpec(site.getValue(ConstructionSite, "kind") ?? "");
    this.setTabletStatus(
      `${spec?.label ?? "Site"} selected. Cancel refunds ${
        site.getValue(ConstructionSite, "cost") ?? 0
      } crystals`,
    );
  }

  private siteLabel(site: Entity): string {
    if (site.hasComponent(ConstructionSite)) {
      return (
        getBuildingSpec(site.getValue(ConstructionSite, "kind") ?? "")?.label ??
        "Building"
      );
    }
    return (
      getProductionSpec(site.getValue(CraftProductionSite, "kind") ?? "")
        ?.label ?? "Craft"
    );
  }

  private selectCraftProductionSite(site: Entity): void {
    const tablet = boardState.tablet;
    if (!tablet) return;
    clearUnitSelections();
    boardState.selectedSite = site;
    tablet.setValue(TabletState, "selectedSite", site);
    tablet.setValue(TabletState, "selectedSiteIndex", site.index);
    tablet.setValue(TabletState, "view", "build");
    tablet.setValue(TabletState, "buildPlacementActive", false);
    tablet.setValue(TabletState, "craftPlacementActive", false);
    hideMarker(boardState.buildMarker);
    updateCommandGridVisibility();
    const spec = getProductionSpec(
      site.getValue(CraftProductionSite, "kind") ?? "",
    );
    this.setTabletStatus(
      `${spec?.label ?? "Craft"} in production. Cancel refunds ${
        spec?.cost ?? 0
      } crystals`,
    );
  }

  private clearCommandSelection(): void {
    clearUnitSelections();
    boardState.selectedTile = null;
    hideMarker(boardState.selectionMarker);
    hideMarker(boardState.buildMarker);
    const tablet = boardState.tablet;
    if (!tablet) return;
    tablet.setValue(TabletState, "astronaut", null);
    tablet.setValue(TabletState, "astronautIndex", -1);
    tablet.setValue(TabletState, "buildPlacementActive", false);
    tablet.setValue(TabletState, "craftPlacementActive", false);
    boardState.selectedSite = null;
    tablet.setValue(TabletState, "selectedSite", null);
    tablet.setValue(TabletState, "selectedSiteIndex", -1);
    updateCommandGridVisibility();
  }

  private updateHoverMarker(tx: number, ty: number): void {
    if (this.isCraftPlacementActive()) {
      this.updateCraftPlacementHover(tx, ty);
      return;
    }
    if (!this.isBuildPlacementActive()) {
      hideMarker(boardState.buildMarker);
      moveMarker(boardState.hoverMarker, { x: tx, y: ty });
      return;
    }
    hideMarker(boardState.hoverMarker);
    const tablet = boardState.tablet!;
    const spec = getBuildingSpec(
      tablet.getValue(TabletState, "selectedBuildingKind") ?? "none",
    );
    const marker = boardState.buildMarker?.object3D as Mesh | undefined;
    if (!spec || !marker) return;
    const cells = footprintCells(tx, ty, spec.widthTiles);
    const validation = validateBuildOrder({
      spec,
      crystals: boardState.gameState?.getValue(GameState, "crystals") ?? 0,
      footprintValid: this.isFootprintAvailable(cells),
      pathFound: true,
    });
    const first = cells[0];
    const last = cells[cells.length - 1];
    const [x0, z0] = gridToWorld(first.x, first.y);
    const [x1, z1] = gridToWorld(last.x, last.y);
    marker.position.set((x0 + x1) / 2, marker.position.y, (z0 + z1) / 2);
    marker.scale.set(spec.widthTiles, spec.widthTiles, 1);
    (marker.material as MeshBasicMaterial).color.setHex(
      validation.ok ? VALID_PLACEMENT_MARKER_COLOR : BLOCKED_MARKER_COLOR,
    );
    marker.visible = true;
  }

  private updateCraftPlacementHover(tx: number, ty: number): void {
    hideMarker(boardState.hoverMarker);
    const marker = boardState.buildMarker?.object3D as Mesh | undefined;
    const tablet = boardState.tablet;
    if (!marker || !tablet) return;
    const validation = validateCraftPurchase({
      spec: getProductionSpec(
        tablet.getValue(TabletState, "selectedCraftKind") ?? "none",
      ),
      crystals: boardState.gameState?.getValue(GameState, "crystals") ?? 0,
      tileAvailable: this.isCraftTileAvailable(tx, ty),
    });
    const [worldX, worldZ] = gridToWorld(tx, ty);
    marker.position.set(worldX, marker.position.y, worldZ);
    marker.scale.set(1, 1, 1);
    (marker.material as MeshBasicMaterial).color.setHex(
      validation.ok ? VALID_PLACEMENT_MARKER_COLOR : BLOCKED_MARKER_COLOR,
    );
    marker.visible = true;
  }

  // Terrain alone used to be the whole test, which is how two build orders
  // could land on the same tile. A placed site reserves its cells (stamped
  // "blocked"), and this also checks live sites directly so the rule holds even
  // if terrain is restored out from under one.
  private isFootprintAvailable(cells: readonly GridPosition[]): boolean {
    return (
      cells.length > 0 &&
      cells.every(({ x, y }) => {
        return (
          getTerrainAt(x, y) === "open" &&
          !this.isOccupied(x, y, null) &&
          !this.isReservedBySite(x, y)
        );
      })
    );
  }

  private isReservedBySite(tx: number, ty: number): boolean {
    for (const site of this.queries.sites.entities) {
      const anchorX = site.getValue(ConstructionSite, "x") ?? -1;
      const anchorY = site.getValue(ConstructionSite, "y") ?? -1;
      const width = site.getValue(ConstructionSite, "widthTiles") ?? 1;
      const half = Math.floor((width - 1) / 2);
      const startX = anchorX - half;
      const startY = anchorY - half;
      if (
        tx >= startX &&
        tx < startX + width &&
        ty >= startY &&
        ty < startY + width
      ) {
        return true;
      }
    }
    return false;
  }

  private findSitePath(
    astronaut: Entity,
    tx: number,
    ty: number,
    widthTiles: number,
    cells: readonly GridPosition[],
  ): GridPosition[] | null {
    const holder = astronaut.object3D;
    if (!holder) return null;
    const [fromX, fromY] = worldToGrid(holder.position.x, holder.position.z);
    const footprintKeys = new Set(cells.map(({ x, y }) => gridKey(x, y)));
    const canStandAt = (x: number, y: number) => {
      return (
        !footprintKeys.has(gridKey(x, y)) &&
        getTerrainAt(x, y) === "open" &&
        !this.isOccupied(x, y, astronaut)
      );
    };
    const goals = footprintApproaches(tx, ty, widthTiles, GRID_SIZE).filter(
      ({ x, y }) => canStandAt(x, y),
    );
    if (goals.length === 0) return null;
    return findGridPath({
      start: { x: fromX, y: fromY },
      goals,
      gridSize: GRID_SIZE,
      canStandAt,
    });
  }

  private setTabletStatus(status: string, statusKind = "info"): void {
    const tablet = boardState.tablet;
    if (!tablet) return;
    tablet.setValue(TabletState, "status", status);
    tablet.setValue(TabletState, "statusKind", statusKind);
    tablet.setValue(
      TabletState,
      "revision",
      (tablet.getValue(TabletState, "revision") ?? 0) + 1,
    );
  }

  private buildingLabel(kind: string): string {
    if (kind === "command-center") return "Command Center";
    if (kind === "factory") return "Aircraft Factory";
    if (kind === "hangar") return "Hangar";
    if (kind === "turret") return "Turret";
    return kind;
  }
}
