import { Entity, createSystem } from "@iwsdk/core";
import {
  advanceAttackCycle,
  getUnitAttackSpec,
  isWithinAttackRange,
  resolveDamageInto,
  type AttackCycleState,
  type DamageResult,
  type DamageTargetType,
} from "./combatRules.js";
import { footprintCells } from "./constructionRules.js";
import { updateHealthBar } from "./healthBar.js";
import { removeUnitFromSelection } from "./selection.js";
import {
  Building,
  BoardTile,
  CombatState,
  Enemy,
  GameStats,
  Health,
  TabletState,
  Unit,
  boardState,
  gridKey,
} from "./state.js";

export class CombatSystem extends createSystem({
  attackers: { required: [Unit, CombatState, Health] },
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

      attacker.setValue(CombatState, "stage", "attacking");
      attacker.object3D.rotation.y = Math.atan2(dx, dz);
      this.cycle.timer = attacker.getValue(CombatState, "timer") ?? 0;
      this.cycle.cadence = spec.cadence;
      const hits = advanceAttackCycle(this.cycle, delta, true);
      attacker.setValue(CombatState, "timer", this.cycle.timer);
      if (hits === 0) continue;

      const targetType = this.targetType(target);
      resolveDamageInto(this.damage, current, spec.damage, hits, targetType);
      target.setValue(Health, "current", this.damage.remaining);
      updateHealthBar(target);
      if (this.damage.died) this.destroyTarget(target, this.damage.enemyKilled);
    }
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
    if (target.hasComponent(Unit)) {
      removeUnitFromSelection(target);
      boardState.cargoVisualByUnit.delete(target.index);
      boardState.pathByUnit.delete(target.index);
    }
    if (target.hasComponent(Building)) {
      const x = target.getValue(Building, "x") ?? -1;
      const y = target.getValue(Building, "y") ?? -1;
      const width = target.getValue(Building, "widthTiles") ?? 1;
      for (const cell of footprintCells(x, y, width)) {
        boardState.tileByKey
          .get(gridKey(cell.x, cell.y))
          ?.setValue(BoardTile, "terrain", "open");
      }
    }
    if (enemyKilled) this.incrementEnemyKills();

    // GLTF geometry and materials are shared AssetManager resources. Removing
    // the ECS entity/object is safe; traversing and disposing those resources
    // here would corrupt every clone using the same asset.
    target.dispose();
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
