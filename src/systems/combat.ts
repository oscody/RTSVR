import { Entity, RayInteractable, createSystem } from "@iwsdk/core";
import {
  advanceAttackCycle,
  getEnemyAttackSpec,
  getUnitAttackSpec,
  isWithinAttackRange,
  resolveDamageInto,
  type AttackSpec,
  type AttackCycleState,
  type DamageResult,
  type DamageTargetType,
} from "./combatRules.js";
import { worldToGrid } from "./board.js";
import { footprintCells } from "./constructionRules.js";
import { updateHealthBar } from "./healthBar.js";
import { removeUnitFromSelection } from "./selection.js";
import {
  Building,
  BoardTile,
  CombatState,
  ConstructionSite,
  ConstructionState,
  Enemy,
  GameStats,
  Health,
  MatchState,
  TabletState,
  Unit,
  WaveUnit,
  boardState,
  gridKey,
} from "./state.js";
import {
  alienFacingYaw,
  isAdjacentToFootprint,
  resolveMatchAfterFriendlyElimination,
  type MatchStatus,
} from "./waveRules.js";

export class CombatSystem extends createSystem({
  attackers: { required: [Unit, CombatState, Health] },
  enemyAttackers: { required: [Enemy, WaveUnit, CombatState, Health] },
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

      const spec = getUnitAttackSpec(attacker.getValue(Unit, "kind") ?? "rover");
      const dx = target.object3D.position.x - attacker.object3D.position.x;
      const dz = target.object3D.position.z - attacker.object3D.position.z;
      const distance = Math.sqrt(dx * dx + dz * dz);
      const inRange = isWithinAttackRange(distance, spec.range);
      if ((attacker.getValue(Unit, "hasOrder") ?? false) || !inRange) {
        attacker.setValue(CombatState, "stage", "approaching");
        attacker.setValue(CombatState, "timer", 0);
        continue;
      }

      this.applyAttack(attacker, target, spec, current, delta, dx, dz);
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
      ? alienFacingYaw(dx, dz)
      : Math.atan2(dx, dz);
    this.cycle.timer = attacker.getValue(CombatState, "timer") ?? 0;
    this.cycle.cadence = spec.cadence;
    const hits = advanceAttackCycle(this.cycle, delta, true);
    attacker.setValue(CombatState, "timer", this.cycle.timer);
    if (hits === 0) return;

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
    for (const attacker of this.queries.enemyAttackers.entities) {
      if (attacker.getValue(CombatState, "target") === target) {
        this.clearAttack(attacker);
        attacker.setValue(WaveUnit, "stage", "waiting");
        attacker.setValue(WaveUnit, "repathTimer", 0);
      }
    }
    if (target.hasComponent(Unit)) {
      this.cancelConstruction(target);
      removeUnitFromSelection(target);
      boardState.cargoVisualByUnit.delete(target.index);
      boardState.pathByUnit.delete(target.index);
    }
    if (target.hasComponent(Building)) {
      const kind = target.getValue(Building, "kind") ?? "unknown";
      const x = target.getValue(Building, "x") ?? -1;
      const y = target.getValue(Building, "y") ?? -1;
      const width = target.getValue(Building, "widthTiles") ?? 1;
      for (const cell of footprintCells(x, y, width)) {
        boardState.tileByKey
          .get(gridKey(cell.x, cell.y))
          ?.setValue(BoardTile, "terrain", "open");
      }
      if (kind === "command-center") {
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
    target.dispose();
  }

  private cancelConstruction(target: Entity): void {
    if (!target.hasComponent(ConstructionState)) return;
    const site = target.getValue(ConstructionState, "site") as Entity | null;
    if (!site?.hasComponent(ConstructionSite)) return;
    const x = site.getValue(ConstructionSite, "x") ?? -1;
    const y = site.getValue(ConstructionSite, "y") ?? -1;
    const width = site.getValue(ConstructionSite, "widthTiles") ?? 1;
    for (const cell of footprintCells(x, y, width)) {
      boardState.tileByKey
        .get(gridKey(cell.x, cell.y))
        ?.setValue(BoardTile, "terrain", "open");
    }
    site.dispose();
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
    attacker.setValue(CombatState, "stage", "idle");
    attacker.setValue(CombatState, "timer", 0);
  }
}
