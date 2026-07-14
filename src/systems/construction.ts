import { createSystem, Mesh } from "@iwsdk/core";
import {
  FactoryState,
  Presentation,
  runtime,
  setStatus,
} from "../game-state.js";

const FACTORY_SCALE = 0.42;

export class ConstructionSystem extends createSystem({
  factories: { required: [FactoryState, Presentation] },
}) {
  update(delta: number): void {
    this.queries.factories.entities.forEach((factory) => {
      if (!factory.getValue(FactoryState, "building")) return;
      const progress = Math.min(
        1,
        (factory.getValue(FactoryState, "buildProgress") ?? 0) + delta / 5,
      );
      factory.setValue(FactoryState, "buildProgress", progress);
      const eased = 0.28 + progress * 0.72;
      runtime.factoryModel?.scale.setScalar(FACTORY_SCALE * eased);
      const fill = Presentation.data.progressFill[factory.index] as Mesh | undefined;
      if (fill) fill.scale.x = Math.max(0.001, progress);
      runtime.revision += 1;
      if (progress >= 1) {
        factory.setValue(FactoryState, "building", false);
        factory.setValue(FactoryState, "built", true);
        setStatus("Factory online. Select it to produce a tank.");
      }
    });
  }
}

