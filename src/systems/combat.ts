import { createSystem } from "@iwsdk/core";
import {
  Combat,
  EnemyObjective,
  Health,
  runtime,
  setStatus,
  TankState,
} from "../game-state.js";

const ATTACK_RANGE = 0.78;
// Firing tolerance: the approach converges asymptotically onto ATTACK_RANGE,
// and the final sub-ulp Float32 steps can leave distance permanently a few
// nanometers above it, freezing the tank without ever firing.
const ATTACK_EPSILON = 0.01;
const TANK_SPEED = 0.62;

export class CombatSystem extends createSystem({
  tanks: { required: [TankState, Combat, Health] },
  enemies: { required: [EnemyObjective, Health] },
}) {
  update(delta: number): void {
    if (runtime.match !== "playing") return;
    this.queries.tanks.entities.forEach((tank) => {
      if (!tank.getValue(TankState, "ready")) return;
      const target = tank.getValue(Combat, "target");
      const tankObject = tank.object3D;
      const targetObject = target?.object3D;
      if (!target || !tankObject || !targetObject || !targetObject.visible) return;

      const dx = targetObject.position.x - tankObject.position.x;
      const dz = targetObject.position.z - tankObject.position.z;
      const distance = Math.sqrt(dx * dx + dz * dz);
      tankObject.rotation.y = Math.atan2(dx, dz);
      if (distance > ATTACK_RANGE + ATTACK_EPSILON) {
        const step = Math.min(distance - ATTACK_RANGE, TANK_SPEED * delta);
        tankObject.position.x += (dx / distance) * step;
        tankObject.position.z += (dz / distance) * step;
        return;
      }
      if (runtime.orderMarker) runtime.orderMarker.visible = false;

      const cooldown = (tank.getValue(Combat, "cooldown") ?? 0) - delta;
      if (cooldown > 0) {
        tank.setValue(Combat, "cooldown", cooldown);
        return;
      }
      tank.setValue(Combat, "cooldown", 0.72);
      const health = Math.max(0, (target.getValue(Health, "current") ?? 0) - 20);
      target.setValue(Health, "current", health);
      runtime.revision += 1;
      if (health <= 0) {
        targetObject.visible = false;
        tank.setValue(Combat, "target", null);
        runtime.match = "won";
        setStatus("Enemy turret destroyed. Victory!");
      }
    });
  }
}
