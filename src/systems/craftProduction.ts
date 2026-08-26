import {
  BoxGeometry,
  Entity,
  Group,
  Mesh,
  MeshBasicMaterial,
  RayInteractable,
  createSystem,
  type World,
} from "@iwsdk/core";
import { UNIT_BOX_GEOMETRY, makeNonInteractive } from "./sharedGeometry.js";
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

  // No craft model while building — the site is foundation + progress bar, the
  // same treatment astronaut production has always had.
  //
  // **This replaced the single most expensive thing on screen.** Construction
  // used to instantiate the full source model (`craftMinerConstruction` 78
  // meshes, `craftRacerConstruction` 53) purely so its baked one-shot spawn
  // effect would play, and `AssetManager.getGLTF` returns a *clone*, so every
  // concurrent site paid again. Measured over two Quest sessions on 2026-08-24,
  // the `construction` draw bucket ran 53/78/106/131/156/159 — exactly the sums
  // of 53 and 78 — and cost roughly 75-80 draw calls and 6-8 FPS per site:
  //
  //   sites | 0     1     2     3
  //   calls | 167   237   300   320
  //   FPS   | 75.7  67.5  59.9  58.0   (run A; run B agreed on calls, not FPS)
  //   miss% | 3.9   16.1  46.8  60.4
  //
  // The models merged badly because every animated FX node is its own rigid
  // group (93 -> 78 and 69 -> 53), so mesh merging could not touch them. The
  // astronaut never appeared in that bucket for one reason: it has no
  // construction model at all. Miner and racer now match it.
  //
  // Restoring the effect means reinstating `craftProductionAnimation.ts` and
  // the two `*Construction` manifest entries, both removed in the same change.

  // Clickable so an in-flight craft can be cancelled for a refund, same as a
  // construction site. Single box proxy — the only ray target the site owns.
  const proxyHeight = TILE_SIZE * 0.9;
  const proxy = new Mesh(UNIT_BOX_GEOMETRY, craftSiteProxyMaterial);
  proxy.name = "CraftProductionSiteInteractionProxy";
  proxy.scale.set(size, proxyHeight, size);
  proxy.position.y = proxyHeight / 2;
  proxy.userData.drawCat = "proxy";
  holder.add(proxy);
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

