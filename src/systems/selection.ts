import {
  createSystem,
  Hovered,
  Mesh,
  MeshBasicMaterial,
  Pressed,
} from "@iwsdk/core";
import {
  commandAttack,
  getKind,
  Presentation,
  runtime,
  Selectable,
  selectEntity,
  startHarvest,
} from "../game-state.js";

export class SelectionSystem extends createSystem({
  selectable: { required: [Selectable, Presentation] },
  pressed: { required: [Selectable, Pressed] },
}) {
  init(): void {
    this.cleanupFuncs.push(
      this.queries.pressed.subscribe("qualify", (entity) => {
        const pressedKind = getKind(entity);
        const selectedKind = getKind(runtime.selected);
        if (pressedKind === "resource" && selectedKind === "worker") {
          startHarvest(runtime.selected);
          return;
        }
        if (pressedKind === "enemy" && selectedKind === "tank") {
          commandAttack(runtime.selected);
          return;
        }
        selectEntity(entity);
      }),
    );
  }

  update(): void {
    this.queries.selectable.entities.forEach((entity) => {
      const ring = Presentation.data.selectionRing[entity.index] as Mesh | undefined;
      if (!ring) return;
      const isSelected = entity === runtime.selected;
      const isHovered = entity.hasComponent(Hovered);
      ring.visible = isSelected || isHovered;
      const material = ring.material as MeshBasicMaterial;
      material.color.setHex(isSelected ? 0x65f5a4 : 0x66e8ff);
      material.opacity = isSelected ? 1 : 0.72;
    });
  }
}

