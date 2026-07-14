import { createSystem, Object3D } from "@iwsdk/core";
import {
  FACTORY_COST,
  FactoryState,
  runtime,
  setStatus,
  WorkerState,
} from "../game-state.js";

const WORKER_SPEED = 0.72;
const ARRIVAL_DISTANCE = 0.04;

function moveToward(
  object: Object3D,
  target: Object3D,
  delta: number,
): boolean {
  const dx = target.position.x - object.position.x;
  const dz = target.position.z - object.position.z;
  const distance = Math.sqrt(dx * dx + dz * dz);
  if (distance <= ARRIVAL_DISTANCE) {
    object.position.x = target.position.x;
    object.position.z = target.position.z;
    return true;
  }
  const step = Math.min(distance, WORKER_SPEED * delta);
  object.position.x += (dx / distance) * step;
  object.position.z += (dz / distance) * step;
  object.rotation.y = Math.atan2(dx, dz);
  return false;
}

export class EconomySystem extends createSystem({
  workers: { required: [WorkerState] },
}) {
  update(delta: number): void {
    if (runtime.match !== "playing" || !runtime.base || !runtime.resourceNode) return;
    const baseObject = runtime.base.object3D;
    const resourceObject = runtime.resourceNode.object3D;
    if (!baseObject || !resourceObject) return;

    this.queries.workers.entities.forEach((worker) => {
      const object = worker.object3D;
      if (!object) return;
      const stage = worker.getValue(WorkerState, "stage");
      if (stage === "toResource") {
        if (moveToward(object, resourceObject, delta)) {
          if (runtime.orderMarker) runtime.orderMarker.visible = false;
          worker.setValue(WorkerState, "stage", "gathering");
          worker.setValue(WorkerState, "timer", 0);
          setStatus("Mining crystals…");
        }
      } else if (stage === "gathering") {
        const timer = (worker.getValue(WorkerState, "timer") ?? 0) + delta;
        worker.setValue(WorkerState, "timer", timer);
        if (timer >= 1.1) {
          worker.setValue(WorkerState, "cargo", 10);
          worker.setValue(WorkerState, "stage", "toBase");
          if (runtime.workerCargoVisual) runtime.workerCargoVisual.visible = true;
          setStatus("Cargo loaded. Returning to command center.");
        }
      } else if (stage === "toBase") {
        if (moveToward(object, baseObject, delta)) {
          const cargo = worker.getValue(WorkerState, "cargo") ?? 0;
          runtime.resources += cargo;
          worker.setValue(WorkerState, "cargo", 0);
          worker.setValue(WorkerState, "stage", "toResource");
          if (runtime.workerCargoVisual) runtime.workerCargoVisual.visible = false;
          const factoryLocked =
            !runtime.factory?.getValue(FactoryState, "built") &&
            !runtime.factory?.getValue(FactoryState, "building");
          if (runtime.resources >= FACTORY_COST && factoryLocked) {
            setStatus("Factory activation is now affordable.");
          } else {
            setStatus(`Deposited ${cargo} crystals. Harvest loop continues.`);
          }
          runtime.revision += 1;
        }
      }
    });
  }
}
