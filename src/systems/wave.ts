import { Entity, createSystem } from "@iwsdk/core";
import { GRID_SIZE, gridToWorld, worldToGrid } from "./board.js";
import { UNIT_APPROACH_OFFSETS } from "./constants.ts";
import { footprintApproaches } from "./constructionRules.js";
import { findGridPath, type GridPosition } from "./navigation.js";
import {
  BoardTile,
  Building,
  CombatState,
  Enemy,
  Health,
  MatchState,
  Unit,
  WaveSource,
  WaveUnit,
  boardState,
  gridKey,
} from "./state.js";
import {
  ALIEN_MOVE_SPEED,
  ALIEN_REPATH_DELAY,
  INITIAL_WAVE_DELAY_SECONDS,
  advanceAlienMovement,
  advanceWaveClock,
  alienFacingYaw,
  isAdjacentToFootprint,
  type MatchStatus,
  type WaveClockState,
  type WaveStage,
} from "./waveRules.js";

interface TargetPath {
  target: Entity;
  path: GridPosition[];
}

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

  update(delta: number): void {
    const source = this.queries.sources.entities.values().next().value as
      | Entity
      | undefined;
    if (!source) return;

    this.clock.waveNumber = source.getValue(WaveSource, "waveNumber") ?? 1;
    this.clock.timer = source.getValue(WaveSource, "timer") ?? 0;
    this.clock.stage = (source.getValue(WaveSource, "stage") ??
      "countdown") as WaveStage;
    const matchStatus = (source.getValue(MatchState, "status") ??
      "playing") as MatchStatus;
    const activated = advanceWaveClock(this.clock, delta, matchStatus);
    source.setValue(WaveSource, "timer", this.clock.timer);
    source.setValue(WaveSource, "stage", this.clock.stage);
    if (activated) {
      source.setValue(
        WaveSource,
        "revision",
        (source.getValue(WaveSource, "revision") ?? 0) + 1,
      );
    }

    if (this.clock.stage !== "active" || matchStatus !== "playing") {
      if (matchStatus !== "playing") this.stopAliens();
      return;
    }

    for (const alien of this.queries.aliens.entities) {
      if ((alien.getValue(Health, "current") ?? 0) <= 0) continue;
      if (alien.getValue(WaveUnit, "hasWaypoint") ?? false) {
        this.advanceAlien(alien, delta);
        continue;
      }

      const currentTarget = alien.getValue(CombatState, "target") as Entity | null;
      if (this.isAliveTarget(currentTarget) && this.isInContact(alien, currentTarget)) {
        alien.setValue(WaveUnit, "stage", "attacking");
        alien.setValue(CombatState, "stage", "attacking");
        continue;
      }

      const repathTimer = Math.max(
        0,
        (alien.getValue(WaveUnit, "repathTimer") ?? 0) - Math.max(0, delta),
      );
      alien.setValue(WaveUnit, "repathTimer", repathTimer);
      if (repathTimer > 0) continue;

      const targetPath = this.findNearestTargetPath(alien);
      if (!targetPath) {
        this.clearAlienTarget(alien, "waiting");
        alien.setValue(WaveUnit, "repathTimer", ALIEN_REPATH_DELAY);
        continue;
      }
      alien.setValue(CombatState, "target", targetPath.target);
      alien.setValue(CombatState, "timer", 0);
      const next = targetPath.path[0];
      if (!next) {
        alien.setValue(WaveUnit, "stage", "attacking");
        alien.setValue(CombatState, "stage", "attacking");
        continue;
      }
      alien.setValue(WaveUnit, "nextX", next.x);
      alien.setValue(WaveUnit, "nextY", next.y);
      alien.setValue(WaveUnit, "hasWaypoint", true);
      alien.setValue(WaveUnit, "stage", "marching");
      alien.setValue(CombatState, "stage", "approaching");
    }
  }

  private advanceAlien(alien: Entity, delta: number): void {
    const object = alien.object3D;
    if (!object) return;
    const [targetX, targetZ] = gridToWorld(
      alien.getValue(WaveUnit, "nextX") ?? 0,
      alien.getValue(WaveUnit, "nextY") ?? 0,
    );
    const movement = advanceAlienMovement(
      { x: object.position.x, z: object.position.z },
      { x: targetX, z: targetZ },
      ALIEN_MOVE_SPEED,
      delta,
    );
    const dx = targetX - object.position.x;
    const dz = targetZ - object.position.z;
    object.position.x = movement.x;
    object.position.z = movement.z;
    if (dx !== 0 || dz !== 0) object.rotation.y = alienFacingYaw(dx, dz);
    if (!movement.arrived) return;
    alien.setValue(WaveUnit, "hasWaypoint", false);
    alien.setValue(WaveUnit, "nextX", -1);
    alien.setValue(WaveUnit, "nextY", -1);
    alien.setValue(WaveUnit, "repathTimer", 0);
  }

  private findNearestTargetPath(alien: Entity): TargetPath | null {
    let best: TargetPath | null = null;
    const consider = (target: Entity) => {
      if (!this.isAliveTarget(target)) return;
      const path = this.findPathToTarget(alien, target);
      if (!path) return;
      if (!best || path.length < best.path.length) best = { target, path };
    };
    for (const unit of this.queries.units.entities) consider(unit);
    for (const building of this.queries.buildings.entities) consider(building);
    return best;
  }

  private findPathToTarget(alien: Entity, target: Entity): GridPosition[] | null {
    const object = alien.object3D;
    const targetObject = target.object3D;
    if (!object || !targetObject) return null;
    const [startX, startY] = worldToGrid(object.position.x, object.position.z);
    const goals = this.targetApproaches(target).filter(({ x, y }) =>
      this.canStandAt(x, y, alien),
    );
    if (goals.length === 0) return null;
    return findGridPath({
      start: { x: startX, y: startY },
      goals,
      gridSize: GRID_SIZE,
      canStandAt: (x, y) => this.canStandAt(x, y, alien),
    });
  }

  private targetApproaches(target: Entity): GridPosition[] {
    if (target.hasComponent(Building)) {
      return footprintApproaches(
        target.getValue(Building, "x") ?? -1,
        target.getValue(Building, "y") ?? -1,
        target.getValue(Building, "widthTiles") ?? 1,
        GRID_SIZE,
      );
    }
    const object = target.object3D;
    if (!object) return [];
    const [x, y] = worldToGrid(object.position.x, object.position.z);
    const goals: GridPosition[] = [];
    for (const [dx, dy] of UNIT_APPROACH_OFFSETS) {
      const goalX = x + dx;
      const goalY = y + dy;
      if (goalX >= 0 && goalY >= 0 && goalX < GRID_SIZE && goalY < GRID_SIZE) {
        goals.push({ x: goalX, y: goalY });
      }
    }
    return goals;
  }

  private canStandAt(x: number, y: number, exclude: Entity): boolean {
    const terrain = boardState.tileByKey
      .get(gridKey(x, y))
      ?.getValue(BoardTile, "terrain");
    return terrain === "open" && !this.isOccupied(x, y, exclude);
  }

  private isOccupied(x: number, y: number, exclude: Entity): boolean {
    for (const unit of this.queries.units.entities) {
      const object = unit.object3D;
      if (!object || (unit.getValue(Health, "current") ?? 0) <= 0) continue;
      const [unitX, unitY] = worldToGrid(object.position.x, object.position.z);
      if (unitX === x && unitY === y) return true;
    }
    for (const alien of this.queries.aliens.entities) {
      if (alien === exclude || (alien.getValue(Health, "current") ?? 0) <= 0) {
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
