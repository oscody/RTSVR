import { createSystem } from "@iwsdk/core";
import { gridToWorld } from "./board.js";
import { updateUnitSelectionRing } from "./selection.js";
import { Unit, boardState } from "./state.js";

const UNIT_SPEED = 0.35; // meters per second across the tabletop
// Arrival tolerance — a move-to-threshold check without an epsilon can stall
// on Float32 rounding (the pre-reset tank bug).
const ARRIVAL_EPSILON = 0.005;

export class MovementSystem extends createSystem({
  units: { required: [Unit] },
}) {
  update(delta: number): void {
    this.queries.units.entities.forEach((unit) => {
      if (!unit.getValue(Unit, "hasOrder")) return;
      const holder = unit.object3D;
      if (!holder) return;

      const [targetX, targetZ] = gridToWorld(
        unit.getValue(Unit, "orderX") ?? 0,
        unit.getValue(Unit, "orderY") ?? 0,
      );
      const dx = targetX - holder.position.x;
      const dz = targetZ - holder.position.z;
      const distance = Math.sqrt(dx * dx + dz * dz);

      if (distance <= ARRIVAL_EPSILON) {
        holder.position.x = targetX;
        holder.position.z = targetZ;
        unit.setValue(Unit, "hasOrder", false);
        if (boardState.selectedUnit === unit) {
          hideOrderMarker();
        }
        updateUnitSelectionRing(unit);
        return;
      }

      // Travel is intentionally direct and collision-free. Occupancy is only
      // enforced for the final order tile, so units can cross scenery and
      // other pieces until pathfinding is introduced.
      const step = Math.min(distance, UNIT_SPEED * delta);
      holder.position.x += (dx / distance) * step;
      holder.position.z += (dz / distance) * step;
      holder.rotation.y = Math.atan2(dx, dz);

      updateUnitSelectionRing(unit);
    });
  }
}

function hideOrderMarker(): void {
  const marker = boardState.orderMarker?.object3D;
  if (marker) marker.visible = false;
}
