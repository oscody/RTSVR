import { createSystem, Mesh } from "@iwsdk/core";
import {
  FactoryState,
  Health,
  Presentation,
  runtime,
  selectEntity,
  setStatus,
  TankState,
} from "../game-state.js";

export class ProductionSystem extends createSystem({
  factories: { required: [FactoryState, Presentation] },
}) {
  update(delta: number): void {
    this.queries.factories.entities.forEach((factory) => {
      if (!factory.getValue(FactoryState, "producing")) return;
      const progress = Math.min(
        1,
        (factory.getValue(FactoryState, "productionProgress") ?? 0) + delta / 2.5,
      );
      factory.setValue(FactoryState, "productionProgress", progress);
      const fill = Presentation.data.progressFill[factory.index] as Mesh | undefined;
      if (fill) fill.scale.x = Math.max(0.001, progress);
      runtime.revision += 1;
      if (progress < 1 || !runtime.tank) return;

      factory.setValue(FactoryState, "producing", false);
      runtime.tank.setValue(TankState, "ready", true);
      runtime.tank.setValue(Health, "current", 100);
      if (runtime.tank.object3D) runtime.tank.object3D.visible = true;
      selectEntity(runtime.tank);
      setStatus("Tank deployed. Attack the enemy turret.");
    });
  }
}

