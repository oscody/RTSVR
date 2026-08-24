import {
  AssetManager,
  Box3,
  BoxGeometry,
  Entity,
  Group,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  RayInteractable,
  Vector3,
  createSystem,
  type World,
} from "@iwsdk/core";
import type { AnimationClip } from "three";
import { UNIT_BOX_GEOMETRY, makeNonInteractive } from "./sharedGeometry.js";
import { disableModelRaycast } from "./structures.js";
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
import { buildRateMultiplier } from "./constructionRules.js";
import { releaseSiteBuilders, takeQueueOrder } from "./construction.js";
import { attachQueueBadge } from "./queueBadge.js";
import { markOwnedResources, releaseEntity } from "./entityTeardown.js";
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
import { Consumer } from "./traceContracts.js";
import { observePlacedSite } from "./phase2Trace.js";
import { traceEntityDestroyed } from "./trace.js";
import { EntityKind, Reason } from "./traceIds.js";

const craftSiteProxyMaterial = new MeshBasicMaterial({
  colorWrite: false,
  depthWrite: false,
});

export function createCraftProductionSite(
  world: World,
  parent: Entity,
  spec: CraftSpec,
  x: number,
  y: number,
  sourceKind: string,
  // Crafts wait for an astronaut; astronaut production does not (a deadlock
  // otherwise: no astronauts means no way to make one).
  requiresBuilder = false,
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

  makeNonInteractive(markOwnedResources(foundation));
  foundation.name = "CraftProductionFoundation";
  holder.add(foundation);

  const progressBackground = new Mesh(
    new BoxGeometry(size, 0.028, 0.035),
    new MeshBasicMaterial({ color: PROGRESS_BACKGROUND_COLOR }),
  );

  makeNonInteractive(markOwnedResources(progressBackground));
  progressBackground.position.set(0, TILE_SIZE * 0.8, 0);
  holder.add(progressBackground);
  const progressFill = new Mesh(
    new BoxGeometry(size, 0.032, 0.04),
    new MeshBasicMaterial({ color: PROGRESS_FILL_COLOR }),
  );
  makeNonInteractive(markOwnedResources(progressFill));
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
    // Its own draw-call bucket, and this one earned it.
    //
    // Untagged, these meshes inherited `static` from the board root and hid
    // inside the largest bucket in the census. A 15-minute capture shows `static`
    // sitting at ~102 calls for 91% of the run and jumping to **150 and 188** for
    // the rest — spikes of +50 and +86 that match these two models exactly
    // (`craftRacerConstruction` 53 meshes, `craftMinerConstruction` 78).
    //
    // They are the leftover from the Phase B fix: moving the one-shot spawn FX
    // OUT of the miner and racer is what let those collapse to 14 and 10 meshes,
    // but the extracted FX models were never merged themselves (93 -> 78 and
    // 69 -> 53) because every animated FX node is its own rigid group.
    //
    // The whole point of the Draw census is that no category can quietly become
    // the most expensive thing on screen. This one did, for months, because it
    // was not named.
    animatedModel.userData.drawCat = "construction";
    animatedModel.rotation.y = Math.PI;
    const width = new Box3().setFromObject(animatedModel).getSize(new Vector3()).x;
    animatedModel.scale.setScalar((TILE_SIZE * 0.9) / width);
    seatModel(animatedModel);
    holder.add(animatedModel);
    animatedClips = gltf.animations;
  }

  // Clickable so an in-flight craft can be cancelled for a refund, same as a
  // construction site. Single box proxy, so the animated model itself is never
  // hit-tested by the pointer.
  const proxyHeight = TILE_SIZE * 0.9;
  const proxy = new Mesh(UNIT_BOX_GEOMETRY, craftSiteProxyMaterial);
  proxy.name = "CraftProductionSiteInteractionProxy";
  proxy.scale.set(size, proxyHeight, size);
  proxy.position.y = proxyHeight / 2;
  proxy.userData.drawCat = "proxy";
  holder.add(proxy);
  if (animatedModel) disableModelRaycast(animatedModel);
  // Craft orders share the same build queue and badge as buildings.
  attachQueueBadge(holder);

  const entity = world
    .createTransformEntity(holder, { parent })
    .addComponent(ScenarioObject)
    .addComponent(RayInteractable)
    .addComponent(CraftProductionSite, {
      queueOrder: takeQueueOrder(),
      kind: spec.kind,
      sourceKind,
      x,
      y,
      timer: 0,
      duration: spec.duration,
      progress: 0,
      cost: spec.cost,
      stage: "pending",
      requiresBuilder,
      builderCount: 0,
      beaconBuilder: null,
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
  // Never dispose while iterating the query the site came from.
  private readonly completed: Entity[] = [];

  update(delta: number): void {
    for (const site of this.queries.sites.entities) {
      observePlacedSite(site.index, Consumer.Production);
      // Crafts now wait for an astronaut, and go faster with more of them.
      // Astronaut production sets requiresBuilder = false and keeps the old
      // self-building behaviour — see the CraftProductionSite comment for why
      // that exemption is not optional.
      const requiresBuilder =
        site.getValue(CraftProductionSite, "requiresBuilder") ?? false;
      const builderCount = requiresBuilder
        ? (site.getValue(CraftProductionSite, "builderCount") ?? 0)
        : 1;
      if (builderCount <= 0) {
        this.updateProgress(site);
        continue;
      }
      site.setValue(CraftProductionSite, "stage", "building");
      this.cycle.timer = site.getValue(CraftProductionSite, "timer") ?? 0;
      this.cycle.duration =
        site.getValue(CraftProductionSite, "duration") ?? 0;
      const transition = advanceCraftProduction(
        this.cycle,
        delta * buildRateMultiplier(builderCount),
      );
      site.setValue(CraftProductionSite, "timer", this.cycle.timer);
      this.updateProgress(site);
      updateCraftProductionAnimation(site, delta);
      if (transition === "completed") this.completed.push(site);
    }
    // A queued site may already be gone by the time the queue drains.
    //
    // Completion is deferred — a site that finishes is pushed here and disposed
    // in a second pass, because disposing while iterating the query it came from
    // is not safe. Anything that disposes a site in between (a cancel, a
    // demolition, a scenario reset, or a cascade out of an earlier completion in
    // this very loop) leaves a dead handle behind.
    //
    // **This is worse than a duplicate warning.** Entity indices are POOLED and
    // reused, and the line below deletes from `boardState.buildersBySite` keyed
    // on `site.index` — so a recycled index means deleting a *live* site's
    // builder list. See the entity-index-recycling rule.
    for (const site of this.completed) {
      if (!site.active) continue;
      this.completeCraft(site);
    }
    this.completed.length = 0;
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
    // Hand its astronauts back before the site goes away, or they keep a
    // dangling `ConstructionState.site` until the next frame notices.
    releaseSiteBuilders(site);
    boardState.buildersBySite.delete(site.index);
    traceEntityDestroyed(site.index, EntityKind.CraftProductionSite, Reason.Completed);
    releaseEntity(site);
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
