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
import { createConstructionSite } from "./construction.js";
import { getCraftSpec } from "./craftCatalog.js";
import { createCraftProductionSite } from "./craftProduction.js";
import { validateCraftPurchase } from "./craftRules.js";
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
  getSingleSelectedUnit,
  toggleTurretRangeRing,
  toggleUnitSelection,
} from "./selection.js";
import { assignGroupDestinations } from "./selectionRules.js";
import {
  BoardTile,
  Building,
  CombatCapability,
  CombatState,
  ConstructionState,
  Enemy,
  GameState,
  MinerState,
  ResourceNode,
  TabletState,
  Unit,
  boardState,
  gridKey,
} from "./state.js";

const ORDER_COLOR = 0xffbd59; // valid destination
const BLOCKED_COLOR = 0xff5050; // clicked a blocked/occupied tile

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

function moveMarker(markerEntity: Entity | null, tile: Entity | null): void {
  if (!tile) {
    hideMarker(markerEntity);
    return;
  }
  const [worldX, worldZ] = gridToWorld(
    tile.getValue(BoardTile, "x") ?? 0,
    tile.getValue(BoardTile, "y") ?? 0,
  );
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
  hoveredTiles: { required: [BoardTile, Hovered] },
  pressedTiles: { required: [BoardTile, Pressed] },
  pressedUnits: { required: [Unit, Pressed] },
  pressedEnemies: { required: [Enemy, Pressed] },
  pressedBuildings: { required: [Building, Pressed] },
  units: { required: [Unit] },
  enemies: { required: [Enemy] },
}) {
  init(): void {
    this.cleanupFuncs.push(
      this.queries.hoveredTiles.subscribe("qualify", (entity) => {
        boardState.hoveredTile = entity;
        this.updateHoverMarker(entity);
      }),
      this.queries.hoveredTiles.subscribe("disqualify", (entity) => {
        if (boardState.hoveredTile === entity) {
          boardState.hoveredTile = null;
          moveMarker(boardState.hoverMarker, null);
          hideMarker(boardState.buildMarker);
        }
      }),
      // Board and roster clicks share the same toggle semantics so a unit can
      // be added to or removed from a group from either surface.
      this.queries.pressedUnits.subscribe("qualify", (entity) => {
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
      }),
      // Click an enemy with a unit selected: approach the open tile on the
      // mover-facing side. The red marker stays on the unavailable target.
      this.queries.pressedEnemies.subscribe("qualify", (entity) => {
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
        if (units.length === 0 || !enemyObject) return;
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
        setOrderMarker(ex, ey, BLOCKED_COLOR);
        if (assigned > 0) this.clearCommandSelection();
      }),
      // Buildings are production sources. Selecting one opens Crafts and
      // records which building is authorizing the next craft purchase.
      this.queries.pressedBuildings.subscribe("qualify", (entity) => {
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
        if (tablet.getValue(TabletState, "view") === "units") {
          tablet.setValue(TabletState, "spawnBuilding", entity);
          tablet.setValue(TabletState, "spawnBuildingIndex", entity.index);
          tablet.setValue(TabletState, "unitFilter", kind);
          tablet.setValue(TabletState, "unitPage", 0);
          this.setTabletStatus(`Roster filter: ${this.buildingLabel(kind)}`);
          return;
        }
        clearUnitSelections();
        hideMarker(boardState.selectionMarker);
        hideMarker(boardState.buildMarker);
        tablet.setValue(TabletState, "astronaut", null);
        tablet.setValue(TabletState, "astronautIndex", -1);
        tablet.setValue(TabletState, "spawnBuilding", entity);
        tablet.setValue(TabletState, "spawnBuildingIndex", entity.index);
        tablet.setValue(TabletState, "buildPlacementActive", false);
        tablet.setValue(TabletState, "craftPlacementActive", false);
        tablet.setValue(TabletState, "view", "crafts");
        this.setTabletStatus(
          kind === "turret"
            ? "Turret cannot produce crafts"
            : "Choose a craft to produce",
          kind === "turret" ? "error" : "info",
        );
      }),
      // Click a tile: open -> move there. Terrain features and occupied tiles
      // are unavailable destinations, so approach from the nearest open tile.
      this.queries.pressedTiles.subscribe("qualify", (entity) => {
        const tx = entity.getValue(BoardTile, "x") ?? -1;
        const ty = entity.getValue(BoardTile, "y") ?? -1;
        if (this.isCraftPlacementActive()) {
          this.placeCraft(tx, ty);
          return;
        }
        const units = getSelectedUnits();
        const unit = boardState.selectedUnit;
        if (unit && units.length > 0) {
          if (this.isBuildPlacementActive(unit)) {
            this.startConstruction(unit, tx, ty);
            return;
          }
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
            setOrderMarker(tx, ty, BLOCKED_COLOR);
            return;
          }

          const blocked = entity.getValue(BoardTile, "terrain") !== "open";
          const selectedSet = new Set(units);
          const occupied = this.isOccupiedExcept(tx, ty, selectedSet);
          const assigned = this.issueGroupOrder(units, tx, ty);
          setOrderMarker(tx, ty, blocked || occupied ? BLOCKED_COLOR : ORDER_COLOR);
          if (assigned > 0) this.clearCommandSelection();
          return;
        }
        boardState.selectedTile = entity;
        moveMarker(boardState.selectionMarker, entity);
      }),
    );
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
        boardState.tileByKey
          .get(gridKey(x, y))
          ?.getValue(BoardTile, "terrain") === "open" &&
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
    if (
      unit.hasComponent(ConstructionState) &&
      unit.getValue(ConstructionState, "stage") !== "idle"
    ) {
      this.setTabletStatus("Astronaut is already building", "error");
      return false;
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
        const tile = boardState.tileByKey.get(gridKey(x, y));
        return (
          tile?.getValue(BoardTile, "terrain") === "open" &&
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

  private isBuildPlacementActive(unit: Entity): boolean {
    const tablet = boardState.tablet;
    return Boolean(
      tablet &&
        unit.getValue(Unit, "kind") === "astronaut" &&
        tablet.getValue(TabletState, "astronautIndex") === unit.index &&
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
        tablet.getValue(TabletState, "view") === "crafts" &&
        tablet.getValue(TabletState, "craftPlacementActive") &&
        tablet.getValue(TabletState, "selectedCraftKind") !== "none",
    );
  }

  private placeCraft(tx: number, ty: number): void {
    const tablet = boardState.tablet;
    const gameState = boardState.gameState;
    const root = boardState.boardRoot;
    if (!tablet || !gameState || !root) return;
    const source = tablet.getValue(TabletState, "spawnBuilding") as Entity | null;
    const spec = getCraftSpec(
      tablet.getValue(TabletState, "selectedCraftKind") ?? "none",
    );
    const validation = validateCraftPurchase({
      spec,
      crystals: gameState.getValue(GameState, "crystals") ?? 0,
      buildingKind: source?.getValue(Building, "kind") ?? null,
      tileAvailable: this.isCraftTileAvailable(tx, ty),
    });
    if (!validation.ok || !spec) {
      this.setTabletStatus(
        validation.ok ? "Craft placement is unavailable" : validation.error,
        "error",
      );
      setOrderMarker(tx, ty, BLOCKED_COLOR);
      return;
    }

    gameState.setValue(GameState, "crystals", validation.remainingCrystals);
    gameState.setValue(
      GameState,
      "revision",
      (gameState.getValue(GameState, "revision") ?? 0) + 1,
    );
    boardState.tileByKey
      .get(gridKey(tx, ty))
      ?.setValue(BoardTile, "terrain", "blocked");
    createCraftProductionSite(
      this.world,
      root,
      spec,
      tx,
      ty,
      source?.getValue(Building, "kind") ?? "command-center",
    );
    tablet.setValue(TabletState, "craftPlacementActive", false);
    hideMarker(boardState.buildMarker);
    setOrderMarker(tx, ty, 0x22c55e);
    this.setTabletStatus(
      `${spec.label} production started (${spec.duration}s)`,
      "success",
    );
  }

  private isCraftTileAvailable(tx: number, ty: number): boolean {
    return (
      boardState.tileByKey.get(gridKey(tx, ty))?.getValue(
        BoardTile,
        "terrain",
      ) === "open" && !this.isOccupied(tx, ty, null)
    );
  }

  private rejectCraftPlacementTarget(entity: Entity): void {
    const object = entity.object3D;
    if (!object) return;
    const [x, y] = worldToGrid(object.position.x, object.position.z);
    setOrderMarker(x, y, BLOCKED_COLOR);
    this.setTabletStatus("That tile is blocked. Choose an open tile", "error");
  }

  private rejectBuildPlacementTarget(entity: Entity): void {
    const object = entity.object3D;
    if (!object) return;
    const [x, y] = worldToGrid(object.position.x, object.position.z);
    setOrderMarker(x, y, BLOCKED_COLOR);
    this.setTabletStatus(
      "That footprint is blocked. Choose an open tile",
      "error",
    );
  }

  private startConstruction(astronaut: Entity, tx: number, ty: number): void {
    const tablet = boardState.tablet;
    const gameState = boardState.gameState;
    const root = boardState.boardRoot;
    if (!tablet || !gameState || !root) return;
    this.setCombatTarget(astronaut, null);
    const kind = tablet.getValue(TabletState, "selectedBuildingKind") ?? "none";
    const spec = getBuildingSpec(kind);
    const cells = spec ? footprintCells(tx, ty, spec.widthTiles) : [];
    const footprintValid = this.isFootprintAvailable(cells);
    const path = spec
      ? this.findConstructionPath(astronaut, spec, tx, ty, cells)
      : null;
    const validation = validateBuildOrder({
      spec,
      crystals: gameState.getValue(GameState, "crystals") ?? 0,
      builderIdle:
        astronaut.getValue(ConstructionState, "stage") === "idle",
      footprintValid,
      pathFound: path !== null,
    });
    if (!validation.ok || !spec || !path) {
      this.setTabletStatus(
        validation.ok ? "Invalid build order" : validation.error,
        "error",
      );
      setOrderMarker(tx, ty, BLOCKED_COLOR);
      return;
    }

    gameState.setValue(GameState, "crystals", validation.remainingCrystals);
    gameState.setValue(
      GameState,
      "revision",
      (gameState.getValue(GameState, "revision") ?? 0) + 1,
    );
    stampBuildingFootprint(tx, ty, spec.widthTiles);
    const site = createConstructionSite(this.world, root, spec, tx, ty);
    astronaut.setValue(ConstructionState, "stage", "toSite");
    astronaut.setValue(ConstructionState, "buildingKind", spec.kind);
    astronaut.setValue(ConstructionState, "targetX", tx);
    astronaut.setValue(ConstructionState, "targetY", ty);
    astronaut.setValue(ConstructionState, "timer", 0);
    astronaut.setValue(ConstructionState, "duration", spec.duration);
    astronaut.setValue(ConstructionState, "cost", spec.cost);
    astronaut.setValue(ConstructionState, "site", site);
    tablet.setValue(TabletState, "buildPlacementActive", false);
    hideMarker(boardState.buildMarker);

    const remaining = [...path];
    const next = remaining.shift();
    const holder = astronaut.object3D!;
    const [fromX, fromY] = worldToGrid(holder.position.x, holder.position.z);
    const approach = path[path.length - 1] ?? { x: fromX, y: fromY };
    astronaut.setValue(ConstructionState, "approachX", approach.x);
    astronaut.setValue(ConstructionState, "approachY", approach.y);
    boardState.pathByUnit.set(astronaut.index, remaining);
    if (next) this.issueOrder(astronaut, next.x, next.y);
    else astronaut.setValue(Unit, "hasOrder", false);
    this.setTabletStatus(`${spec.label} ordered. Astronaut moving to site`);
    setOrderMarker(tx, ty, ORDER_COLOR);
    this.clearCommandSelection();
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
  }

  private updateHoverMarker(tile: Entity): void {
    if (this.isCraftPlacementActive()) {
      this.updateCraftPlacementHover(tile);
      return;
    }
    const unit = boardState.selectedUnit;
    if (!unit || !this.isBuildPlacementActive(unit)) {
      hideMarker(boardState.buildMarker);
      moveMarker(boardState.hoverMarker, tile);
      return;
    }
    hideMarker(boardState.hoverMarker);
    const tablet = boardState.tablet!;
    const spec = getBuildingSpec(
      tablet.getValue(TabletState, "selectedBuildingKind") ?? "none",
    );
    const marker = boardState.buildMarker?.object3D as Mesh | undefined;
    if (!spec || !marker) return;
    const tx = tile.getValue(BoardTile, "x") ?? -1;
    const ty = tile.getValue(BoardTile, "y") ?? -1;
    const cells = footprintCells(tx, ty, spec.widthTiles);
    const path = this.findConstructionPath(unit, spec, tx, ty, cells);
    const validation = validateBuildOrder({
      spec,
      crystals: boardState.gameState?.getValue(GameState, "crystals") ?? 0,
      builderIdle: unit.getValue(ConstructionState, "stage") === "idle",
      footprintValid: this.isFootprintAvailable(cells),
      pathFound: path !== null,
    });
    const first = cells[0];
    const last = cells[cells.length - 1];
    const [x0, z0] = gridToWorld(first.x, first.y);
    const [x1, z1] = gridToWorld(last.x, last.y);
    marker.position.set((x0 + x1) / 2, marker.position.y, (z0 + z1) / 2);
    marker.scale.set(spec.widthTiles, spec.widthTiles, 1);
    (marker.material as MeshBasicMaterial).color.setHex(
      validation.ok ? 0x22c55e : BLOCKED_COLOR,
    );
    marker.visible = true;
  }

  private updateCraftPlacementHover(tile: Entity): void {
    hideMarker(boardState.hoverMarker);
    const marker = boardState.buildMarker?.object3D as Mesh | undefined;
    const tablet = boardState.tablet;
    if (!marker || !tablet) return;
    const tx = tile.getValue(BoardTile, "x") ?? -1;
    const ty = tile.getValue(BoardTile, "y") ?? -1;
    const source = tablet.getValue(TabletState, "spawnBuilding") as Entity | null;
    const validation = validateCraftPurchase({
      spec: getCraftSpec(
        tablet.getValue(TabletState, "selectedCraftKind") ?? "none",
      ),
      crystals: boardState.gameState?.getValue(GameState, "crystals") ?? 0,
      buildingKind: source?.getValue(Building, "kind") ?? null,
      tileAvailable: this.isCraftTileAvailable(tx, ty),
    });
    const [worldX, worldZ] = gridToWorld(tx, ty);
    marker.position.set(worldX, marker.position.y, worldZ);
    marker.scale.set(1, 1, 1);
    (marker.material as MeshBasicMaterial).color.setHex(
      validation.ok ? 0x22c55e : BLOCKED_COLOR,
    );
    marker.visible = true;
  }

  private isFootprintAvailable(cells: readonly GridPosition[]): boolean {
    return (
      cells.length > 0 &&
      cells.every(({ x, y }) => {
        const tile = boardState.tileByKey.get(gridKey(x, y));
        return (
          tile?.getValue(BoardTile, "terrain") === "open" &&
          !this.isOccupied(x, y, null)
        );
      })
    );
  }

  private findConstructionPath(
    astronaut: Entity,
    spec: BuildingSpec,
    tx: number,
    ty: number,
    cells: readonly GridPosition[],
  ): GridPosition[] | null {
    const holder = astronaut.object3D;
    if (!holder) return null;
    const [fromX, fromY] = worldToGrid(holder.position.x, holder.position.z);
    const footprintKeys = new Set(cells.map(({ x, y }) => gridKey(x, y)));
    const canStandAt = (x: number, y: number) => {
      const tile = boardState.tileByKey.get(gridKey(x, y));
      return (
        !footprintKeys.has(gridKey(x, y)) &&
        tile?.getValue(BoardTile, "terrain") === "open" &&
        !this.isOccupied(x, y, astronaut)
      );
    };
    const goals = footprintApproaches(
      tx,
      ty,
      spec.widthTiles,
      GRID_SIZE,
    ).filter(({ x, y }) => canStandAt(x, y));
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
