import {
  AssetManager,
  Box3,
  BoxGeometry,
  Entity,
  Group,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Vector3,
  createSystem,
  type World,
} from "@iwsdk/core";
import type { AnimationClip } from "three";
import { makeNonInteractive } from "./sharedGeometry.js";
import { TILE_SIZE, gridToWorld } from "./board.js";
import {
  CRAFT_PRODUCTION_FOUNDATION_COLOR,
  CRAFT_PRODUCTION_FOUNDATION_OPACITY,
  PROGRESS_BACKGROUND_COLOR,
  PROGRESS_FILL_COLOR,
} from "./constants.ts";
import { getProductionSpec, type CraftSpec } from "./craftCatalog.js";
import { createCraftEntity } from "./craftFactory.js";
import {
  advanceCraftProduction,
  craftProductionProgress,
  type CraftProductionCycleState,
} from "./craftRules.js";
import {
  attachCraftProductionAnimation,
  detachCraftProductionAnimation,
  updateCraftProductionAnimation,
} from "./craftProductionAnimation.js";
import {
  CraftProductionSite,
  ScenarioObject,
  TabletState,
  boardState,
  setTerrainAt,
} from "./state.js";

export function createCraftProductionSite(
  world: World,
  parent: Entity,
  spec: CraftSpec,
  x: number,
  y: number,
  sourceKind: string,
): Entity {
  const size = TILE_SIZE * 0.9;
  const holder = new Group();
  holder.name = `CraftProductionSite_${spec.kind}_${x}_${y}`;
  const [worldX, worldZ] = gridToWorld(x, y);
  holder.position.set(worldX, 0.012, worldZ);

  const foundation = new Mesh(
    new BoxGeometry(size, 0.024, size),
    new MeshBasicMaterial({
      color: CRAFT_PRODUCTION_FOUNDATION_COLOR,
      transparent: true,
      opacity: CRAFT_PRODUCTION_FOUNDATION_OPACITY,
      depthWrite: false,
    }),
  );

  makeNonInteractive(foundation);
  foundation.name = "CraftProductionFoundation";
  holder.add(foundation);

  const progressBackground = new Mesh(
    new BoxGeometry(size, 0.028, 0.035),
    new MeshBasicMaterial({ color: PROGRESS_BACKGROUND_COLOR }),
  );

  makeNonInteractive(progressBackground);
  progressBackground.position.set(0, TILE_SIZE * 0.8, 0);
  holder.add(progressBackground);
  const progressFill = new Mesh(
    new BoxGeometry(size, 0.032, 0.04),
    new MeshBasicMaterial({ color: PROGRESS_FILL_COLOR }),
  );
  makeNonInteractive(progressFill);
  progressFill.name = "CraftProductionProgressFill";
  progressFill.position.set(-size / 2, TILE_SIZE * 0.8, 0.001);
  progressFill.scale.x = 0.001;
  holder.add(progressFill);

  let animatedModel: Object3D | null = null;
  let animatedClips: AnimationClip[] = [];
  if (spec.asset === "craftMinerAnimated" || spec.asset === "craftRacer") {
    // Completed miners use the reduced model. Construction temporarily uses
    // the full source model so its one-shot spawn effect remains unchanged.
    const animationAsset = spec.asset === "craftMinerAnimated"
      ? "craftMinerConstruction"
      : spec.asset === "craftRacer"
        ? "craftRacerConstruction"
        : spec.asset;
    const gltf = AssetManager.getGLTF(animationAsset);
    if (!gltf) throw new Error(`${animationAsset} not preloaded`);
    animatedModel = gltf.scene;
    animatedModel.rotation.y = Math.PI;
    const width = new Box3().setFromObject(animatedModel).getSize(new Vector3()).x;
    animatedModel.scale.setScalar((TILE_SIZE * 0.9) / width);
    seatModel(animatedModel);
    holder.add(animatedModel);
    animatedClips = gltf.animations;
  }

  const entity = world
    .createTransformEntity(holder, { parent })
    .addComponent(ScenarioObject)
    .addComponent(CraftProductionSite, {
      kind: spec.kind,
      sourceKind,
      x,
      y,
      timer: 0,
      duration: spec.duration,
      progress: 0,
    });
  if (animatedModel) {
    attachCraftProductionAnimation(
      entity,
      animatedModel,
      animatedClips,
      spec.duration,
    );
  }
  return entity;
}

export class CraftProductionSystem extends createSystem({
  sites: { required: [CraftProductionSite] },
}) {
  private readonly cycle: CraftProductionCycleState = {
    timer: 0,
    duration: 0,
  };

  update(delta: number): void {
    for (const site of this.queries.sites.entities) {
      this.cycle.timer = site.getValue(CraftProductionSite, "timer") ?? 0;
      this.cycle.duration =
        site.getValue(CraftProductionSite, "duration") ?? 0;
      const transition = advanceCraftProduction(this.cycle, delta);
      site.setValue(CraftProductionSite, "timer", this.cycle.timer);
      this.updateProgress(site);
      updateCraftProductionAnimation(site, delta);
      if (transition === "completed") this.completeCraft(site);
    }
  }

  private updateProgress(site: Entity): void {
    const progress = craftProductionProgress(
      site.getValue(CraftProductionSite, "timer") ?? 0,
      site.getValue(CraftProductionSite, "duration") ?? 0,
    );
    site.setValue(CraftProductionSite, "progress", progress);
    const fill = site.object3D?.getObjectByName("CraftProductionProgressFill");
    if (!fill) return;
    const width = TILE_SIZE * 0.9;
    fill.scale.x = Math.max(0.001, progress);
    fill.position.x = -(width * (1 - progress)) / 2;
  }

  private completeCraft(site: Entity): void {
    const spec = getProductionSpec(
      site.getValue(CraftProductionSite, "kind") ?? "none",
    );
    const root = boardState.boardRoot;
    if (!spec || !root) return;
    const x = site.getValue(CraftProductionSite, "x") ?? -1;
    const y = site.getValue(CraftProductionSite, "y") ?? -1;
    const sourceKind =
      site.getValue(CraftProductionSite, "sourceKind") ?? "command-center";
    setTerrainAt(x, y, "open");
    detachCraftProductionAnimation(site);
    site.dispose();
    createCraftEntity(
      this.world,
      root,
      spec,
      x,
      y,
      sourceKind,
    );
    this.setTabletStatus(`${spec.label} production complete`, "success");
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

function seatModel(model: Object3D): void {
  const box = new Box3().setFromObject(model);
  model.position.x -= (box.min.x + box.max.x) / 2;
  model.position.z -= (box.min.z + box.max.z) / 2;
  model.position.y -= box.min.y;
}
