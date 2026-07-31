import { Entity, RayInteractable, createSystem } from "@iwsdk/core";
import { GRID_SIZE, gridToWorld, worldToGrid } from "./board.js";
import {
  ALIEN_PATHFINDS_PER_FRAME,
  UNIT_APPROACH_OFFSETS,
  WAVE_PREP_PER_FRAME,
} from "./constants.ts";
import { ReusableGridPathfinder } from "./navigation.js";
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
  type ResolvedWaveSpawn,
} from "./waveCatalog.js";

interface AlienRoute {
  steps: Int16Array;
  length: number;
  cursor: number;
  targetIndex: number;
}

function compareEntityIndex(left: Entity, right: Entity): number {
  return left.index - right.index;
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
  private readonly waitingReadyBuffer: Entity[] = [];
  private readonly routeByAlien = new Map<number, AlienRoute>();
  private readonly navigationOccupancy = new Uint8Array(GRID_SIZE * GRID_SIZE);
  private readonly targetByGoalCell = new Int32Array(GRID_SIZE * GRID_SIZE);
  private readonly pathfinder = new ReusableGridPathfinder(GRID_SIZE);
  private navigationStartIndex = -1;
  private readonly canNavigateForPath = (x: number, y: number): boolean =>
    this.canNavigateAt(x, y, this.navigationStartIndex);
  private preparedWaveNumber = 0;
  private pendingSpawns: ResolvedWaveSpawn[] = [];
  private spawnCursor = 0;
  private prepMs = 0;
  private slowestBuildMs = 0;
  private slowestBuildAsset = "";
  private slowestBuildName = "";
  private prepSourceRevision = -1;
  private preparationFailedWaveNumber = 0;

  init(): void {
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
    if (this.clock.stage === "countdown" && matchStatus === "playing") {
      this.prepareWaveIncrementally(source);
    }
    if (this.clock.stage === "active" && matchStatus === "playing") {
      this.spawnWaveIfNeeded(source);
      this.updateWaveRelease(source, delta);
    }
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

    this.rebuildNavigationOccupancy();
    let pathfindsRemaining = ALIEN_PATHFINDS_PER_FRAME;
    for (const alien of this.queries.aliens.entities) {
      if ((alien.getValue(Health, "current") ?? 0) <= 0) continue;
      if (alien.getValue(WaveUnit, "stage") === "waiting") continue;
      if (alien.getValue(WaveUnit, "hasWaypoint") ?? false) {
        this.advanceAlien(alien, delta);
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

  private spawnWaveIfNeeded(source: Entity): void {
    if ((source.getValue(WaveSource, "spawnedWaveNumber") ?? 0) === this.clock.waveNumber) {
      return;
    }
    const spec = getWaveSpec(this.clock.waveNumber);
    if (!spec) {
      source.setValue(WaveSource, "spawnedWaveNumber", this.clock.waveNumber);
      return;
    }

    let spawns: ResolvedWaveSpawn[];
    let buildMs: number;
    let activationFinishMs: number;
    if (this.preparedWaveNumber === this.clock.waveNumber) {
      spawns = this.pendingSpawns;
      const finishStart = performance.now();
      while (this.spawnCursor < spawns.length) {
        this.createPreparedAlien(spawns[this.spawnCursor]);
        this.spawnCursor += 1;
      }
      activationFinishMs = performance.now() - finishStart;
      buildMs = this.prepMs + activationFinishMs;
    } else {
      const buildStart = performance.now();
      spawns = resolveWaveSpawns(spec, {
        canSpawnAt: (x, y) => this.canSpawnAlienAt(x, y),
      });
      for (const spawn of spawns) this.createPreparedAlien(spawn);
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
      const resolveStart = performance.now();
      try {
        this.pendingSpawns = resolveWaveSpawns(spec, {
          canSpawnAt: (x, y) => this.canSpawnAlienAt(x, y),
        });
      } catch (error) {
        this.preparationFailedWaveNumber = waveNumber;
        console.warn(
          `[WaveBuild] wave ${waveNumber}: countdown preparation failed; activation will retry`,
          error,
        );
        return;
      }
      this.prepMs += performance.now() - resolveStart;
      this.preparedWaveNumber = waveNumber;
    }

    const end = Math.min(
      this.pendingSpawns.length,
      this.spawnCursor + WAVE_PREP_PER_FRAME,
    );
    while (this.spawnCursor < end) {
      const prepStart = performance.now();
      this.createPreparedAlien(this.pendingSpawns[this.spawnCursor]);
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
    alien.setValue(WaveUnit, "stage", "waiting");
    alien.setValue(WaveUnit, "releaseDelay", spawn.releaseDelaySeconds);
    alien.setValue(WaveUnit, "speedMultiplier", spawn.speedMultiplier);
    const buildMs = performance.now() - buildStart;
    if (buildMs > this.slowestBuildMs) {
      this.slowestBuildMs = buildMs;
      this.slowestBuildAsset = spawn.asset;
      this.slowestBuildName = spawn.name;
    }
  }

  private resetWavePreparation(): void {
    this.preparedWaveNumber = 0;
    this.pendingSpawns = [];
    this.spawnCursor = 0;
    this.prepMs = 0;
    this.slowestBuildMs = 0;
    this.slowestBuildAsset = "";
    this.slowestBuildName = "";
    this.prepSourceRevision = -1;
    this.preparationFailedWaveNumber = 0;
  }

  private updateWaveRelease(source: Entity, delta: number): void {
    const spec = getWaveSpec(this.clock.waveNumber);
    if (!spec) return;
    this.tickWaitingReleaseDelays(delta);
    const waitingReady = this.waitingReadyAliens();
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
    const releaseCount = advanceWaveRelease(
      state,
      {
        activeLiving: this.activeLivingAlienCount(),
        waitingReady: waitingReady.length,
      },
      pacing,
      delta,
    );
    if (releaseCount > 0) {
      this.releaseReserveAliens(waitingReady, releaseCount);
    }
    source.setValue(WaveSource, "releaseTimer", state.releaseTimer);
    source.setValue(WaveSource, "releasedAlienCount", state.releasedAlienCount);
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

  private waitingReadyAliens(): Entity[] {
    this.waitingReadyBuffer.length = 0;
    for (const alien of this.queries.aliens.entities) {
      if ((alien.getValue(Health, "current") ?? 0) <= 0) continue;
      if (alien.getValue(WaveUnit, "stage") !== "waiting") continue;
      if ((alien.getValue(WaveUnit, "releaseDelay") ?? 0) > 0) continue;
      this.waitingReadyBuffer.push(alien);
    }
    this.waitingReadyBuffer.sort(compareEntityIndex);
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
  ): void {
    const releaseCount = Math.min(waitingReady.length, Math.max(0, count));
    for (let index = 0; index < releaseCount; index += 1) {
      const alien = waitingReady[index];
      if (alien.object3D) alien.object3D.visible = true;
      if (!alien.hasComponent(RayInteractable)) {
        alien.addComponent(RayInteractable);
      }
      this.clearAlienTarget(alien, "released");
      alien.setValue(WaveUnit, "releaseDelay", 0);
      alien.setValue(WaveUnit, "repathTimer", 0);
    }
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
