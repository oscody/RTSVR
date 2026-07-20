import {
  BoxGeometry,
  Entity,
  Group,
  Mesh,
  MeshBasicMaterial,
  createSystem,
  type World,
} from "@iwsdk/core";
import { TILE_SIZE, gridToWorld } from "./board.js";
import { createBuildingEntity } from "./buildingFactory.js";
import { getBuildingSpec, type BuildingSpec } from "./buildingCatalog.js";
import {
  advanceConstruction,
  constructionProgress,
  footprintCells,
  type ConstructionCycleState,
  type ConstructionStage,
} from "./constructionRules.js";
import {
  ConstructionSite,
  ConstructionState,
  ScenarioObject,
  TabletState,
  Unit,
  boardState,
} from "./state.js";

export function createConstructionSite(
  world: World,
  parent: Entity,
  spec: BuildingSpec,
  anchorX: number,
  anchorY: number,
): Entity {
  const cells = footprintCells(anchorX, anchorY, spec.widthTiles);
  const first = cells[0];
  const last = cells[cells.length - 1];
  const [wx0, wz0] = gridToWorld(first.x, first.y);
  const [wx1, wz1] = gridToWorld(last.x, last.y);
  const footprintSize = spec.widthTiles * TILE_SIZE * 0.9;

  const holder = new Group();
  holder.name = `ConstructionSite_${spec.kind}_${anchorX}_${anchorY}`;
  holder.position.set((wx0 + wx1) / 2, 0.012, (wz0 + wz1) / 2);
  const foundation = new Mesh(
    new BoxGeometry(footprintSize, 0.024, footprintSize),
    new MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    }),
  );
  foundation.name = "ConstructionFoundation";
  holder.add(foundation);

  const progressBackground = new Mesh(
    new BoxGeometry(footprintSize, 0.028, 0.035),
    new MeshBasicMaterial({ color: 0x263845 }),
  );
  progressBackground.position.set(0, TILE_SIZE * 0.8, 0);
  holder.add(progressBackground);
  const progressFill = new Mesh(
    new BoxGeometry(footprintSize, 0.032, 0.04),
    new MeshBasicMaterial({ color: 0x22c55e }),
  );
  progressFill.name = "ConstructionProgressFill";
  progressFill.position.set(-footprintSize / 2, TILE_SIZE * 0.8, 0.001);
  progressFill.scale.x = 0.001;
  holder.add(progressFill);

  return world
    .createTransformEntity(holder, { parent })
    .addComponent(ScenarioObject)
    .addComponent(ConstructionSite, {
      kind: spec.kind,
      x: anchorX,
      y: anchorY,
      widthTiles: spec.widthTiles,
      progress: 0,
    });
}

export class ConstructionSystem extends createSystem({
  builders: { required: [Unit, ConstructionState] },
}) {
  private readonly cycle: ConstructionCycleState = {
    stage: "idle",
    timer: 0,
    duration: 0,
  };

  update(delta: number): void {
    for (const astronaut of this.queries.builders.entities) {
      const stage = (astronaut.getValue(ConstructionState, "stage") ??
        "idle") as ConstructionStage;
      if (stage === "idle") continue;

      if (
        stage === "toSite" &&
        !(astronaut.getValue(Unit, "hasOrder") ?? false)
      ) {
        const remaining = boardState.pathByUnit.get(astronaut.index) ?? [];
        const next = remaining.shift();
        if (next) {
          astronaut.setValue(Unit, "orderX", next.x);
          astronaut.setValue(Unit, "orderY", next.y);
          astronaut.setValue(Unit, "hasOrder", true);
          continue;
        }
      }

      this.cycle.stage = stage;
      this.cycle.timer = astronaut.getValue(ConstructionState, "timer") ?? 0;
      this.cycle.duration =
        astronaut.getValue(ConstructionState, "duration") ?? 0;
      const transition = advanceConstruction(
        this.cycle,
        delta,
        stage === "toSite" &&
          !(astronaut.getValue(Unit, "hasOrder") ?? false),
      );
      astronaut.setValue(ConstructionState, "stage", this.cycle.stage);
      astronaut.setValue(ConstructionState, "timer", this.cycle.timer);
      this.updateSiteProgress(astronaut);

      if (transition === "reachedSite") {
        this.setTabletStatus("Astronaut is constructing");
      } else if (transition === "completed") {
        this.completeBuilding(astronaut);
      }
    }
  }

  private updateSiteProgress(astronaut: Entity): void {
    const site = astronaut.getValue(ConstructionState, "site") as Entity | null;
    if (!site) return;
    const progress = constructionProgress(
      astronaut.getValue(ConstructionState, "timer") ?? 0,
      astronaut.getValue(ConstructionState, "duration") ?? 0,
    );
    site.setValue(ConstructionSite, "progress", progress);
    const fill = site.object3D?.getObjectByName("ConstructionProgressFill");
    if (!fill) return;
    const spec = getBuildingSpec(site.getValue(ConstructionSite, "kind") ?? "");
    if (!spec) return;
    const width = spec.widthTiles * TILE_SIZE * 0.9;
    fill.scale.x = Math.max(0.001, progress);
    fill.position.x = -(width * (1 - progress)) / 2;
  }

  private completeBuilding(astronaut: Entity): void {
    const kind = astronaut.getValue(ConstructionState, "buildingKind") ?? "none";
    const spec = getBuildingSpec(kind);
    const root = boardState.boardRoot;
    if (!spec || !root) return;
    const x = astronaut.getValue(ConstructionState, "targetX") ?? -1;
    const y = astronaut.getValue(ConstructionState, "targetY") ?? -1;
    createBuildingEntity(this.world, root, spec, x, y);

    const site = astronaut.getValue(ConstructionState, "site") as Entity | null;
    site?.dispose();
    astronaut.setValue(ConstructionState, "site", null);
    astronaut.setValue(ConstructionState, "timer", 0);
    astronaut.setValue(ConstructionState, "buildingKind", "none");
    astronaut.setValue(ConstructionState, "targetX", -1);
    astronaut.setValue(ConstructionState, "targetY", -1);
    astronaut.setValue(ConstructionState, "approachX", -1);
    astronaut.setValue(ConstructionState, "approachY", -1);
    astronaut.setValue(ConstructionState, "duration", 0);
    astronaut.setValue(ConstructionState, "cost", 0);
    boardState.pathByUnit.delete(astronaut.index);
    this.setTabletStatus(`${spec.label} complete`, "success");
  }

  private setTabletStatus(status: string, statusKind = "info"): void {
    const tablet = boardState.tablet;
    if (!tablet) return;
    tablet.setValue(TabletState, "status", status);
    tablet.setValue(TabletState, "statusKind", statusKind);
    tablet.setValue(
      TabletState,
      "revision",
      (tablet.getValue(TabletState, "revision") ?? 0) + 1,
    );
  }
}
