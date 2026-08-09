import { Entity, RayInteractable, createSystem } from "@iwsdk/core";
import {
  advanceAttackCycle,
  canFriendlyTargetWaveStage,
  getEnemyAttackSpec,
  isWithinAttackRange,
  resolveDamageInto,
  shouldAutoAcquireUnitTarget,
  type AttackSpec,
  type AttackCycleState,
  type DamageResult,
  type DamageTargetType,
} from "./combatRules.js";
import { worldToGrid } from "./board.js";
import { footprintCells } from "./constructionRules.js";
import {
  currentTurretAttackSpec,
  currentUnitAttackSpec,
} from "./debugStatOverrides.js";
import { detachAlienAnimation } from "./alienAnimation.js";
import { emitAttackVfx } from "./combatEffects.js";
import { detachCommandCenterAnimation } from "./commandCenterAnimation.js";
import { releaseBuilder } from "./construction.js";
import { updateHealthBar } from "./healthBar.js";
import { detachMinerAnimation } from "./minerAnimation.js";
import {
  disposeTurretRangeRing,
  disposeUnitSelectionVisuals,
  removeUnitFromSelection,
} from "./selection.js";
import { detachTurretAnimation } from "./turretAnimation.js";
import { detachUnitAnimation } from "./unitAnimation.js";
import {
  Building,
  CombatCapability,
  CombatState,
  ConstructionSite,
  ConstructionState,
  DebugSettings,
  Enemy,
  GameStats,
  Health,
  MatchState,
  TabletState,
  Unit,
  UnitSelection,
  WaveSource,
  WaveUnit,
  boardState,
  setTerrainAt,
} from "./state.js";
import {
  INITIAL_WAVE_DELAY_SECONDS,
  enemyFacingYaw,
  isAdjacentToFootprint,
  resolveMatchAfterFriendlyElimination,
  resolveWaveClearOutcome,
  type MatchStatus,
  type WaveStage,
} from "./waveRules.js";
import { getNextWaveSpec } from "./waveCatalog.js";

export class CombatSystem extends createSystem({
  attackers: {
    required: [Unit, UnitSelection, CombatCapability, CombatState, Health],
  },
  turrets: { required: [Building, CombatCapability, CombatState, Health] },
  enemyAttackers: { required: [Enemy, WaveUnit, CombatState, Health] },
  enemyTargets: { required: [Enemy, Health] },
  friendlyUnits: { required: [Unit, Health] },
  friendlyBuildings: { required: [Building, Health] },
}) {
  private readonly cycle: AttackCycleState = { timer: 0, cadence: 1 };
  private readonly damage: DamageResult = {
    remaining: 0,
    died: false,
    enemyKilled: false,
  };

  update(delta: number): void {
    for (const attacker of this.queries.attackers.entities) {
      const spec = currentUnitAttackSpec(
        attacker.getValue(Unit, "kind") ?? "rover",
      );
      if (!spec) {
        this.clearAttack(attacker);
        continue;
      }

      let target = attacker.getValue(CombatState, "target") as Entity | null;
      let targetMode = attacker.getValue(CombatState, "targetMode") ?? "none";
      const selected = attacker.getValue(UnitSelection, "selected") ?? false;
      if (
        targetMode === "automatic" &&
        !this.isEnemyInRange(attacker, target, spec.range)
      ) {
        this.clearAttack(attacker);
        target = null;
        targetMode = "none";
      }

      const constructionActive =
        attacker.hasComponent(ConstructionState) &&
        attacker.getValue(ConstructionState, "stage") !== "idle";
      if (
        !target &&
        shouldAutoAcquireUnitTarget(selected, constructionActive)
      ) {
        target = this.findNearestEnemyInRange(attacker, spec.range);
        if (target) {
          targetMode = "automatic";
          attacker.setValue(CombatState, "target", target);
          attacker.setValue(CombatState, "targetMode", targetMode);
          attacker.setValue(CombatState, "timer", 0);
          attacker.setValue(Unit, "hasOrder", false);
        }
      }

      if (!target) continue;
      if (!attacker.object3D || !target.object3D || !target.hasComponent(Health)) {
        this.clearAttack(attacker);
        continue;
      }
      const current = target.getValue(Health, "current") ?? 0;
      if (current <= 0) {
        this.clearAttack(attacker);
        continue;
      }

      const dx = target.object3D.position.x - attacker.object3D.position.x;
      const dz = target.object3D.position.z - attacker.object3D.position.z;
      const distance = Math.sqrt(dx * dx + dz * dz);
      const inRange = isWithinAttackRange(distance, spec.range);
      if (!inRange) {
        if (targetMode === "automatic") {
          this.clearAttack(attacker);
          continue;
        }
        attacker.setValue(CombatState, "stage", "approaching");
        attacker.setValue(CombatState, "timer", 0);
        this.pursueTarget(attacker, target);
        continue;
      }

      attacker.setValue(Unit, "hasOrder", false);
      this.applyAttack(attacker, target, spec, current, delta, dx, dz);
    }

    const turretSpec = currentTurretAttackSpec();
    for (const turret of this.queries.turrets.entities) {
      if (turret.getValue(Building, "kind") !== "turret") continue;
      let target = turret.getValue(CombatState, "target") as Entity | null;
      if (!this.isEnemyInRange(turret, target, turretSpec.range)) {
        target = this.findNearestEnemyInRange(turret, turretSpec.range);
        turret.setValue(CombatState, "target", target);
        turret.setValue(CombatState, "timer", 0);
      }
      if (!target?.object3D || !turret.object3D) {
        this.clearAttack(turret);
        continue;
      }
      const current = target.getValue(Health, "current") ?? 0;
      const dx = target.object3D.position.x - turret.object3D.position.x;
      const dz = target.object3D.position.z - turret.object3D.position.z;
      this.applyAttack(
        turret,
        target,
        turretSpec,
        current,
        delta,
        dx,
        dz,
      );
    }

    for (const attacker of this.queries.enemyAttackers.entities) {
      const target = attacker.getValue(CombatState, "target") as Entity | null;
      if (!target) continue;
      if (!attacker.object3D || !target.object3D || !target.hasComponent(Health)) {
        this.clearAttack(attacker);
        continue;
      }
      const current = target.getValue(Health, "current") ?? 0;
      if (current <= 0) {
        this.clearAttack(attacker);
        continue;
      }
      if (
        (attacker.getValue(WaveUnit, "hasWaypoint") ?? false) ||
        !this.enemyHasContact(attacker, target)
      ) {
        attacker.setValue(CombatState, "stage", "approaching");
        attacker.setValue(CombatState, "timer", 0);
        continue;
      }
      const dx = target.object3D.position.x - attacker.object3D.position.x;
      const dz = target.object3D.position.z - attacker.object3D.position.z;
      const spec = getEnemyAttackSpec(attacker.getValue(Enemy, "kind") ?? "alien");
      this.applyAttack(attacker, target, spec, current, delta, dx, dz);
    }

    this.completeVictoryIfWaveCleared();
  }

  private applyAttack(
    attacker: Entity,
    target: Entity,
    spec: AttackSpec,
    current: number,
    delta: number,
    dx: number,
    dz: number,
  ): void {
    attacker.setValue(CombatState, "stage", "attacking");
    attacker.object3D!.rotation.y = attacker.hasComponent(Enemy)
      ? enemyFacingYaw(attacker.getValue(Enemy, "kind") ?? "alien", dx, dz)
      : Math.atan2(dx, dz);
    this.cycle.timer = attacker.getValue(CombatState, "timer") ?? 0;
    this.cycle.cadence = spec.cadence;
    const hits = advanceAttackCycle(this.cycle, delta, true);
    attacker.setValue(CombatState, "timer", this.cycle.timer);
    if (hits === 0) return;

    // Visual-only combat feedback: friendly attackers fire bolts/lasers that
    // stop at the body; aliens play a melee energy burst. Damage below stays
    // range/cadence-based (the profile is chosen per attacker in combatEffects).
    emitAttackVfx(attacker, target);

    const targetType = this.targetType(target);
    resolveDamageInto(this.damage, current, spec.damage, hits, targetType);
    target.setValue(Health, "current", this.damage.remaining);
    updateHealthBar(target);
    if (this.damage.died) this.destroyTarget(target, this.damage.enemyKilled);
  }

  private targetType(target: Entity): DamageTargetType {
    if (target.hasComponent(Enemy)) return "enemy";
    if (target.hasComponent(Building)) return "building";
    return "friendly";
  }

  private destroyTarget(target: Entity, enemyKilled: boolean): void {
    for (const attacker of this.queries.attackers.entities) {
      if (attacker.getValue(CombatState, "target") === target) {
        this.clearAttack(attacker);
      }
    }
    for (const turret of this.queries.turrets.entities) {
      if (turret.getValue(CombatState, "target") === target) {
        this.clearAttack(turret);
      }
    }
    for (const attacker of this.queries.enemyAttackers.entities) {
      if (attacker.getValue(CombatState, "target") === target) {
        this.clearAttack(attacker);
        attacker.setValue(WaveUnit, "stage", "released");
        attacker.setValue(WaveUnit, "repathTimer", 0);
      }
    }
    if (target.hasComponent(Unit)) {
      detachMinerAnimation(target);
      detachUnitAnimation(target);
      // A dead builder no longer takes the build with it. The site owns the
      // work now, so it survives, keeps its progress, and waits to be reclaimed
      // — losing the beacon holder just promotes another astronaut.
      releaseBuilder(target);
      removeUnitFromSelection(target);
      disposeUnitSelectionVisuals(target);
      boardState.cargoVisualByUnit.delete(target.index);
      boardState.pathByUnit.delete(target.index);
    }
    if (target.hasComponent(Building)) {
      const kind = target.getValue(Building, "kind") ?? "unknown";
      const x = target.getValue(Building, "x") ?? -1;
      const y = target.getValue(Building, "y") ?? -1;
      const width = target.getValue(Building, "widthTiles") ?? 1;
      for (const cell of footprintCells(x, y, width)) {
        setTerrainAt(cell.x, cell.y, "open");
      }
      if (kind === "turret") disposeTurretRangeRing(target);
      if (kind === "command-center") {
        detachCommandCenterAnimation(target);
        this.markCommandCenterDestroyed();
        boardState.commandCenter = null;
      }
    }
    if (enemyKilled) this.incrementEnemyKills();
    if (target.hasComponent(Unit) || target.hasComponent(Building)) {
      this.completeDefeatIfNoFriendlies();
    }

    // GLTF geometry and materials are shared AssetManager resources. Removing
    // the ECS entity/object is safe; traversing and disposing those resources
    // here would corrupt every clone using the same asset.
    if (target.hasComponent(RayInteractable)) {
      target.removeComponent(RayInteractable);
    }
    if (target.hasComponent(Enemy)) {
      detachAlienAnimation(target);
    }
    if (target.hasComponent(Building) && target.getValue(Building, "kind") === "turret") {
      detachTurretAnimation(target);
    }
    target.dispose();
  }

  private markCommandCenterDestroyed(): void {
    const source = boardState.waveSource;
    if (!source) return;
    source.setValue(MatchState, "commandCenterAlive", false);
    source.setValue(
      MatchState,
      "revision",
      (source.getValue(MatchState, "revision") ?? 0) + 1,
    );
    const tablet = boardState.tablet;
    if (!tablet) return;
    tablet.setValue(
      TabletState,
      "status",
      "Command center destroyed - aliens are attacking remaining forces",
    );
    tablet.setValue(TabletState, "statusKind", "error");
    tablet.setValue(
      TabletState,
      "revision",
      (tablet.getValue(TabletState, "revision") ?? 0) + 1,
    );
  }

  private completeDefeatIfNoFriendlies(): void {
    let remaining = 0;
    for (const unit of this.queries.friendlyUnits.entities) {
      if ((unit.getValue(Health, "current") ?? 0) > 0) remaining += 1;
    }
    for (const building of this.queries.friendlyBuildings.entities) {
      if ((building.getValue(Health, "current") ?? 0) > 0) remaining += 1;
    }
    const source = boardState.waveSource;
    if (!source) return;
    const current = (source.getValue(MatchState, "status") ??
      "playing") as MatchStatus;
    const next = resolveMatchAfterFriendlyElimination(current, remaining);
    if (next === current) return;
    source.setValue(MatchState, "status", next);
    source.setValue(
      MatchState,
      "revision",
      (source.getValue(MatchState, "revision") ?? 0) + 1,
    );
    const tablet = boardState.tablet;
    if (!tablet) return;
    tablet.setValue(TabletState, "status", "All friendly forces destroyed");
    tablet.setValue(TabletState, "statusKind", "error");
    tablet.setValue(
      TabletState,
      "revision",
      (tablet.getValue(TabletState, "revision") ?? 0) + 1,
    );
  }

  private completeVictoryIfWaveCleared(): void {
    let remaining = 0;
    for (const enemy of this.queries.enemyTargets.entities) {
      if ((enemy.getValue(Health, "current") ?? 0) > 0) remaining += 1;
    }
    const source = boardState.waveSource;
    if (!source) return;
    const current = (source.getValue(MatchState, "status") ??
      "playing") as MatchStatus;
    const waveStage = (source.getValue(WaveSource, "stage") ??
      "countdown") as WaveStage;
    const waveNumber = source.getValue(WaveSource, "waveNumber") ?? 1;
    const nextWave = getNextWaveSpec(waveNumber);
    const outcome = resolveWaveClearOutcome(
      current,
      waveStage,
      remaining,
      nextWave !== undefined,
    );
    if (outcome === "none") return;
    const tablet = boardState.tablet;
    if (outcome === "advance" && nextWave) {
      this.advanceToNextWave(source, nextWave.waveNumber, tablet);
      return;
    }
    source.setValue(MatchState, "status", "victory");
    source.setValue(
      MatchState,
      "revision",
      (source.getValue(MatchState, "revision") ?? 0) + 1,
    );
    this.setTabletStatus(tablet, `Wave ${waveNumber} cleared - victory`, "success");
  }

  private advanceToNextWave(
    source: Entity,
    waveNumber: number,
    tablet: Entity | null,
  ): void {
    source.setValue(WaveSource, "waveNumber", waveNumber);
    source.setValue(
      WaveSource,
      "timer",
      boardState.debugSettings?.getValue(
        DebugSettings,
        "initialWaveDelaySeconds",
      ) ?? INITIAL_WAVE_DELAY_SECONDS,
    );
    source.setValue(WaveSource, "stage", "countdown");
    source.setValue(WaveSource, "releaseTimer", 0);
    source.setValue(WaveSource, "releasedAlienCount", 0);
    source.setValue(
      WaveSource,
      "revision",
      (source.getValue(WaveSource, "revision") ?? 0) + 1,
    );
    this.setTabletStatus(tablet, `Wave ${waveNumber} incoming`, "info");
  }

  private setTabletStatus(
    tablet: Entity | null,
    status: string,
    statusKind: string,
  ): void {
    if (!tablet) return;
    tablet.setValue(TabletState, "status", status);
    tablet.setValue(TabletState, "statusKind", statusKind);
    tablet.setValue(
      TabletState,
      "revision",
      (tablet.getValue(TabletState, "revision") ?? 0) + 1,
    );
  }

  private pursueTarget(attacker: Entity, target: Entity): void {
    const targetObject = target.object3D;
    if (!targetObject) return;
    const [x, y] = worldToGrid(
      targetObject.position.x,
      targetObject.position.z,
    );
    attacker.setValue(Unit, "orderX", x);
    attacker.setValue(Unit, "orderY", y);
    attacker.setValue(Unit, "hasOrder", true);
  }

  private isEnemyInRange(
    attacker: Entity,
    target: Entity | null,
    range: number,
  ): target is Entity {
    if (
      !attacker.object3D ||
      !target?.object3D ||
      !target.hasComponent(Enemy) ||
      !target.hasComponent(Health) ||
      !canFriendlyTargetWaveStage(
        target.getValue(WaveUnit, "stage") ?? "waiting",
      ) ||
      (target.getValue(Health, "current") ?? 0) <= 0
    ) {
      return false;
    }
    return isWithinAttackRange(
      attacker.object3D.position.distanceTo(target.object3D.position),
      range,
    );
  }

  private findNearestEnemyInRange(
    attacker: Entity,
    range: number,
  ): Entity | null {
    if (!attacker.object3D) return null;
    let nearest: Entity | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const enemy of this.queries.enemyTargets.entities) {
      if (
        !enemy.object3D ||
        !canFriendlyTargetWaveStage(
          enemy.getValue(WaveUnit, "stage") ?? "waiting",
        ) ||
        (enemy.getValue(Health, "current") ?? 0) <= 0
      ) {
        continue;
      }
      const distance = attacker.object3D.position.distanceTo(
        enemy.object3D.position,
      );
      if (
        isWithinAttackRange(distance, range) &&
        distance < nearestDistance
      ) {
        nearest = enemy;
        nearestDistance = distance;
      }
    }
    return nearest;
  }

  private enemyHasContact(attacker: Entity, target: Entity): boolean {
    const attackerObject = attacker.object3D;
    const targetObject = target.object3D;
    if (!attackerObject || !targetObject) return false;
    const [x, y] = worldToGrid(
      attackerObject.position.x,
      attackerObject.position.z,
    );
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

  private incrementEnemyKills(): void {
    const stats = boardState.gameStats;
    if (!stats) return;
    stats.setValue(
      GameStats,
      "enemiesKilled",
      (stats.getValue(GameStats, "enemiesKilled") ?? 0) + 1,
    );
    stats.setValue(
      GameStats,
      "revision",
      (stats.getValue(GameStats, "revision") ?? 0) + 1,
    );
    const tablet = boardState.tablet;
    if (!tablet) return;
    tablet.setValue(TabletState, "status", "Alien destroyed");
    tablet.setValue(TabletState, "statusKind", "success");
    tablet.setValue(
      TabletState,
      "revision",
      (tablet.getValue(TabletState, "revision") ?? 0) + 1,
    );
  }

  private clearAttack(attacker: Entity): void {
    attacker.setValue(CombatState, "target", null);
    attacker.setValue(CombatState, "targetMode", "none");
    attacker.setValue(CombatState, "stage", "idle");
    attacker.setValue(CombatState, "timer", 0);
  }
}
