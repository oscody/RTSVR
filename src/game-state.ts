import { createComponent, Entity, Object3D, Types } from "@iwsdk/core";

export const FACTORY_COST = 30;
export const TANK_COST = 20;

export const Selectable = createComponent("RTSSelectable", {
  kind: { type: Types.String, default: "object" },
});

export const Presentation = createComponent("RTSPresentation", {
  selectionRing: { type: Types.Object, default: undefined },
  healthFill: { type: Types.Object, default: undefined },
  progressFill: { type: Types.Object, default: undefined },
});

export const WorkerState = createComponent("RTSWorkerState", {
  stage: { type: Types.String, default: "idle" },
  timer: { type: Types.Float32, default: 0 },
  cargo: { type: Types.Int16, default: 0 },
});

export const ResourceNode = createComponent("RTSResourceNode", {
  remaining: { type: Types.Int16, default: 999 },
});

export const FactoryState = createComponent("RTSFactoryState", {
  built: { type: Types.Boolean, default: false },
  building: { type: Types.Boolean, default: false },
  buildProgress: { type: Types.Float32, default: 0 },
  producing: { type: Types.Boolean, default: false },
  productionProgress: { type: Types.Float32, default: 0 },
});

export const TankState = createComponent("RTSTankState", {
  ready: { type: Types.Boolean, default: false },
});

export const Health = createComponent("RTSHealth", {
  current: { type: Types.Float32, default: 100 },
  maximum: { type: Types.Float32, default: 100 },
});

export const Combat = createComponent("RTSCombat", {
  target: { type: Types.Entity, default: null },
  cooldown: { type: Types.Float32, default: 0 },
});

export const PlayerBase = createComponent("RTSPlayerBase", {});
export const EnemyObjective = createComponent("RTSEnemyObjective", {});

type MatchState = "playing" | "won" | "lost";

export const runtime = {
  resources: 0,
  match: "playing" as MatchState,
  status: "Select the rover, then start harvesting crystals.",
  selected: null as Entity | null,
  base: null as Entity | null,
  worker: null as Entity | null,
  resourceNode: null as Entity | null,
  factory: null as Entity | null,
  tank: null as Entity | null,
  enemy: null as Entity | null,
  factoryModel: null as Object3D | null,
  workerCargoVisual: null as Object3D | null,
  orderMarker: null as Object3D | null,
  revision: 1,
  resetRequested: false,
};

export function setStatus(message: string): void {
  runtime.status = message;
  runtime.revision += 1;
}

export function getKind(entity: Entity | null): string {
  return entity?.getValue(Selectable, "kind") ?? "none";
}

export function selectEntity(entity: Entity): void {
  runtime.selected = entity;
  setStatus(`${labelForKind(getKind(entity))} selected.`);
}

export function labelForKind(kind: string): string {
  switch (kind) {
    case "worker":
      return "Mining rover";
    case "resource":
      return "Crystal deposit";
    case "factory":
      return "Factory pad";
    case "tank":
      return "Tank";
    case "enemy":
      return "Enemy turret";
    case "base":
      return "Command center";
    default:
      return "Object";
  }
}

export function startHarvest(worker = runtime.worker): void {
  if (!worker || runtime.match !== "playing") return;
  worker.setValue(WorkerState, "stage", "toResource");
  worker.setValue(WorkerState, "timer", 0);
  if (runtime.orderMarker && runtime.resourceNode?.object3D) {
    runtime.orderMarker.position.copy(runtime.resourceNode.object3D.position);
    runtime.orderMarker.visible = true;
  }
  selectEntity(worker);
  setStatus("Harvest loop active: crystal → command center.");
}

export function commandAttack(tank = runtime.tank): void {
  if (!tank || !runtime.enemy || runtime.match !== "playing") return;
  if (!tank.getValue(TankState, "ready")) {
    setStatus("Produce the tank before issuing an attack order.");
    return;
  }
  tank.setValue(Combat, "target", runtime.enemy);
  if (runtime.orderMarker && runtime.enemy.object3D) {
    runtime.orderMarker.position.copy(runtime.enemy.object3D.position);
    runtime.orderMarker.visible = true;
  }
  selectEntity(tank);
  setStatus("Attack order accepted. Tank moving into range.");
}

function activateFactory(factory: Entity): void {
  if (factory.getValue(FactoryState, "built")) {
    if (factory.getValue(FactoryState, "producing")) {
      setStatus("Tank production is already underway.");
      return;
    }
    if (runtime.tank?.getValue(TankState, "ready")) {
      setStatus("Tank ready. Select it and attack the enemy turret.");
      return;
    }
    if (runtime.resources < TANK_COST) {
      setStatus(`Need ${TANK_COST} crystals to produce a tank.`);
      return;
    }
    runtime.resources -= TANK_COST;
    factory.setValue(FactoryState, "producing", true);
    factory.setValue(FactoryState, "productionProgress", 0);
    setStatus("Tank production started.");
    return;
  }

  if (factory.getValue(FactoryState, "building")) {
    setStatus("Factory construction is already underway.");
    return;
  }
  if (runtime.resources < FACTORY_COST) {
    setStatus(`Need ${FACTORY_COST} crystals to activate the factory.`);
    return;
  }
  runtime.resources -= FACTORY_COST;
  factory.setValue(FactoryState, "building", true);
  factory.setValue(FactoryState, "buildProgress", 0);
  setStatus("Factory activation started.");
}

export function contextActionLabel(): string {
  const selected = runtime.selected;
  switch (getKind(selected)) {
    case "worker":
    case "resource":
      return "Start Harvesting";
    case "factory":
      if (selected?.getValue(FactoryState, "built")) return "Produce Tank (20)";
      return "Activate Factory (30)";
    case "tank":
    case "enemy":
      return "Attack Enemy";
    default:
      return "Select a Unit";
  }
}

export function runContextAction(): void {
  const kind = getKind(runtime.selected);
  if (kind === "worker" || kind === "resource") {
    startHarvest();
  } else if (kind === "factory" && runtime.factory) {
    activateFactory(runtime.factory);
  } else if (kind === "tank" || kind === "enemy") {
    commandAttack();
  } else {
    setStatus("Select the rover, factory, or tank first.");
  }
}
