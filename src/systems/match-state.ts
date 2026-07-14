import { createSystem, Mesh } from "@iwsdk/core";
import {
  Combat,
  FactoryState,
  Health,
  Presentation,
  runtime,
  selectEntity,
  setStatus,
  TankState,
  WorkerState,
} from "../game-state.js";

function updateHealthBar(entity: NonNullable<typeof runtime.base>): void {
  const fill = Presentation.data.healthFill[entity.index] as Mesh | undefined;
  if (!fill) return;
  const current = entity.getValue(Health, "current") ?? 0;
  const maximum = entity.getValue(Health, "maximum") ?? 1;
  fill.scale.x = Math.max(0.001, current / maximum);
}

export class MatchStateSystem extends createSystem({
  health: { required: [Health, Presentation] },
}) {
  private pressureElapsed = 0;
  private damageElapsed = 0;

  update(delta: number): void {
    this.queries.health.entities.forEach(updateHealthBar);

    if (runtime.resetRequested) {
      this.reset();
      return;
    }
    if (runtime.match !== "playing" || !runtime.base) return;
    this.pressureElapsed += delta;
    if (this.pressureElapsed < 90) return;
    this.damageElapsed += delta;
    if (this.damageElapsed < 1) return;
    this.damageElapsed = 0;
    const health = Math.max(0, (runtime.base.getValue(Health, "current") ?? 0) - 2);
    runtime.base.setValue(Health, "current", health);
    runtime.revision += 1;
    if (health <= 0) {
      runtime.match = "lost";
      setStatus("Command center destroyed. Defeat.");
    } else if (health === 98) {
      setStatus("Enemy pressure has begun. Destroy the turret!");
    }
  }

  private reset(): void {
    runtime.resetRequested = false;
    runtime.resources = 0;
    runtime.match = "playing";
    this.pressureElapsed = 0;
    this.damageElapsed = 0;

    if (runtime.base) runtime.base.setValue(Health, "current", 100);
    if (runtime.worker?.object3D) {
      runtime.worker.object3D.position.set(-0.85, 0.08, 0.36);
      runtime.worker.setValue(WorkerState, "stage", "idle");
      runtime.worker.setValue(WorkerState, "timer", 0);
      runtime.worker.setValue(WorkerState, "cargo", 0);
    }
    if (runtime.workerCargoVisual) runtime.workerCargoVisual.visible = false;
    if (runtime.orderMarker) runtime.orderMarker.visible = false;
    if (runtime.factory) {
      runtime.factory.setValue(FactoryState, "built", false);
      runtime.factory.setValue(FactoryState, "building", false);
      runtime.factory.setValue(FactoryState, "buildProgress", 0);
      runtime.factory.setValue(FactoryState, "producing", false);
      runtime.factory.setValue(FactoryState, "productionProgress", 0);
      const fill = Presentation.data.progressFill[runtime.factory.index] as Mesh | undefined;
      if (fill) fill.scale.x = 0.001;
    }
    runtime.factoryModel?.scale.setScalar(0.12);
    if (runtime.tank) {
      runtime.tank.setValue(TankState, "ready", false);
      runtime.tank.setValue(Health, "current", 100);
      runtime.tank.setValue(Combat, "target", null);
      runtime.tank.setValue(Combat, "cooldown", 0);
      if (runtime.tank.object3D) {
        runtime.tank.object3D.visible = false;
        runtime.tank.object3D.position.set(0.42, 0.07, -0.48);
      }
    }
    if (runtime.enemy) {
      runtime.enemy.setValue(Health, "current", 100);
      if (runtime.enemy.object3D) runtime.enemy.object3D.visible = true;
    }
    if (runtime.worker) selectEntity(runtime.worker);
    setStatus("Scenario reset. Start the rover's harvest loop.");
  }
}
