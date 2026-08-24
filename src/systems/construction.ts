import {
  BoxGeometry,
  Entity,
  Group,
  Mesh,
  MeshBasicMaterial,
  RayInteractable,
  Vector3,
  createSystem,
  type World,
} from "@iwsdk/core";
import { GRID_SIZE, TILE_SIZE, gridToWorld, worldToGrid } from "./board.js";
import {
  attachQueueBadge,
  faceQueueBadge,
  setQueueBadge,
} from "./queueBadge.js";
import { UNIT_BOX_GEOMETRY, makeNonInteractive } from "./sharedGeometry.js";
import {
  BUILDER_ASSIGNMENTS_PER_FRAME,
  CONSTRUCTION_FOUNDATION_COLOR,
  CONSTRUCTION_FOUNDATION_OPACITY,
  CONSTRUCTION_PENDING_FOUNDATION_COLOR,
  CONSTRUCTION_PENDING_FOUNDATION_OPACITY,
  PROGRESS_BACKGROUND_COLOR,
  PROGRESS_FILL_COLOR,
} from "./constants.ts";
import { createBuildingEntity } from "./buildingFactory.js";
import { getBuildingSpec, type BuildingSpec } from "./buildingCatalog.js";
import {
  advanceSiteConstruction,
  cancelRefund,
  constructionProgress,
  footprintApproaches,
  footprintCells,
  pickCancelTarget,
  type SiteCycleState,
  type SiteStage,
} from "./constructionRules.js";
import { findGridPath, type GridPosition } from "./navigation.js";
import { markOwnedResources, releaseEntity } from "./entityTeardown.js";
import {
  ConstructionSite,
  ConstructionState,
  CraftProductionSite,
  Enemy,
  GameState,
  ScenarioObject,
  TabletState,
  Unit,
  boardState,
  getTerrainAt,
  gridKey,
  setTerrainAt,
} from "./state.js";
import { Consumer } from "./traceContracts.js";
import { observePlacedSite } from "./phase2Trace.js";
import { traceDecision, traceEntityDestroyed } from "./trace.js";
import { EntityKind, Reason } from "./traceIds.js";

const siteProxyMaterial = new MeshBasicMaterial({
  colorWrite: false,
  depthWrite: false,
});

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
    // A freshly placed site starts unclaimed, so it uses the pending look; the
    // system swaps it to the active colour when a builder arrives.
    new MeshBasicMaterial({
      color: CONSTRUCTION_PENDING_FOUNDATION_COLOR,
      transparent: true,
      opacity: CONSTRUCTION_PENDING_FOUNDATION_OPACITY,
      depthWrite: false,
    }),
  );
  makeNonInteractive(markOwnedResources(foundation));
  foundation.name = "ConstructionFoundation";
  holder.add(foundation);

  const progressBackground = new Mesh(
    new BoxGeometry(footprintSize, 0.028, 0.035),
    new MeshBasicMaterial({ color: PROGRESS_BACKGROUND_COLOR }),
  );

  makeNonInteractive(markOwnedResources(progressBackground));
  progressBackground.name = "ConstructionProgressBackground";
  progressBackground.position.set(0, TILE_SIZE * 0.8, 0);
  // A pending site has no progress to show. The bar appears the moment the
  // first builder starts, which is what makes "claimed" readable at a glance.
  progressBackground.visible = false;
  holder.add(progressBackground);
  const progressFill = new Mesh(
    new BoxGeometry(footprintSize, 0.032, 0.04),
    new MeshBasicMaterial({ color: PROGRESS_FILL_COLOR }),
  );
  makeNonInteractive(markOwnedResources(progressFill));
  progressFill.name = "ConstructionProgressFill";
  progressFill.position.set(-footprintSize / 2, TILE_SIZE * 0.8, 0.001);
  progressFill.scale.x = 0.001;
  progressFill.visible = false;
  holder.add(progressFill);

  // Sites are now clickable — that is how a builder is assigned manually and
  // how the Cancel action selects one. Same single-box-proxy discipline as
  // buildings and aliens so the pointer never hit-tests the decorative meshes.
  const proxyFootprint = spec.widthTiles * TILE_SIZE * 0.86;
  const proxyHeight = TILE_SIZE * 0.8;
  const proxy = new Mesh(UNIT_BOX_GEOMETRY, siteProxyMaterial);
  proxy.name = "ConstructionSiteInteractionProxy";
  proxy.scale.set(proxyFootprint, proxyHeight, proxyFootprint);
  proxy.position.y = proxyHeight / 2;
  proxy.userData.drawCat = "proxy";
  holder.add(proxy);
  // The floating queue number, positioned and sized like a health bar.
  attachQueueBadge(holder);

  return world
    .createTransformEntity(holder, { parent })
    .addComponent(ScenarioObject)
    .addComponent(RayInteractable)
    .addComponent(ConstructionSite, {
      queueOrder: takeQueueOrder(),
      kind: spec.kind,
      x: anchorX,
      y: anchorY,
      widthTiles: spec.widthTiles,
      progress: 0,
      stage: "pending",
      timer: 0,
      duration: spec.duration,
      cost: spec.cost,
      builderCount: 0,
      beaconBuilder: null,
    });
}

// ---------------------------------------------------------------------------
// Site accessors. A builder can now be assigned to EITHER a building site or a
// craft-production site, so everything that touches "the site" goes through
// these rather than assuming ConstructionSite. Craft sites are always 1 tile.
// ---------------------------------------------------------------------------

export function takeQueueOrder(): number {
  return boardState.nextQueueOrder++;
}

export function siteQueueOrder(site: Entity): number {
  if (site.hasComponent(ConstructionSite)) {
    return site.getValue(ConstructionSite, "queueOrder") ?? 0;
  }
  if (site.hasComponent(CraftProductionSite)) {
    return site.getValue(CraftProductionSite, "queueOrder") ?? 0;
  }
  return 0;
}

export function siteBuilderCount(site: Entity): number {
  if (site.hasComponent(ConstructionSite)) {
    return site.getValue(ConstructionSite, "builderCount") ?? 0;
  }
  if (site.hasComponent(CraftProductionSite)) {
    return site.getValue(CraftProductionSite, "builderCount") ?? 0;
  }
  return 0;
}

export function isBuildableSite(site: Entity | null): site is Entity {
  return Boolean(
    site &&
      (site.hasComponent(ConstructionSite) ||
        site.hasComponent(CraftProductionSite)),
  );
}

export function siteAnchor(
  site: Entity,
): { x: number; y: number; widthTiles: number } | null {
  if (site.hasComponent(ConstructionSite)) {
    return {
      x: site.getValue(ConstructionSite, "x") ?? -1,
      y: site.getValue(ConstructionSite, "y") ?? -1,
      widthTiles: site.getValue(ConstructionSite, "widthTiles") ?? 1,
    };
  }
  if (site.hasComponent(CraftProductionSite)) {
    return {
      x: site.getValue(CraftProductionSite, "x") ?? -1,
      y: site.getValue(CraftProductionSite, "y") ?? -1,
      widthTiles: 1,
    };
  }
  return null;
}

export function siteNeedsBuilder(site: Entity): boolean {
  if (site.hasComponent(ConstructionSite)) return true;
  if (site.hasComponent(CraftProductionSite)) {
    return site.getValue(CraftProductionSite, "requiresBuilder") ?? false;
  }
  return false;
}

export function siteBeaconBuilder(site: Entity): Entity | null {
  if (site.hasComponent(ConstructionSite)) {
    return site.getValue(ConstructionSite, "beaconBuilder") as Entity | null;
  }
  if (site.hasComponent(CraftProductionSite)) {
    return site.getValue(CraftProductionSite, "beaconBuilder") as Entity | null;
  }
  return null;
}

function setSiteBeaconBuilder(site: Entity, builder: Entity | null): void {
  if (site.hasComponent(ConstructionSite)) {
    site.setValue(ConstructionSite, "beaconBuilder", builder);
  } else if (site.hasComponent(CraftProductionSite)) {
    site.setValue(CraftProductionSite, "beaconBuilder", builder);
  }
}

function setSiteBuilderCount(site: Entity, count: number): void {
  if (site.hasComponent(ConstructionSite)) {
    site.setValue(ConstructionSite, "builderCount", count);
  } else if (site.hasComponent(CraftProductionSite)) {
    site.setValue(CraftProductionSite, "builderCount", count);
  }
}

// Releases a builder back to idle without touching the site. Used when a
// builder dies, is reassigned, or is deliberately destroyed — the site itself
// survives and waits for someone else, which is the whole point of the site
// owning the build.
export function releaseBuilder(astronaut: Entity): void {
  if (!astronaut.hasComponent(ConstructionState)) return;
  const site = astronaut.getValue(ConstructionState, "site") as Entity | null;
  astronaut.setValue(ConstructionState, "stage", "idle");
  astronaut.setValue(ConstructionState, "site", null);
  astronaut.setValue(ConstructionState, "approachX", -1);
  astronaut.setValue(ConstructionState, "approachY", -1);
  astronaut.setValue(Unit, "hasOrder", false);
  boardState.pathByUnit.delete(astronaut.index);
  if (!isBuildableSite(site)) return;
  // Losing the beacon holder must not leave the site with only assist
  // animations; clearing it lets the next update promote a remaining builder.
  if (siteBeaconBuilder(site) === astronaut) setSiteBeaconBuilder(site, null);
}

// Attaches a builder to a site and starts it walking. Shared by the
// auto-assigner and by the player clicking a site with astronauts selected, so
// both routes produce identical state.
export function attachBuilderToSite(
  astronaut: Entity,
  site: Entity,
  path: readonly GridPosition[],
): void {
  traceDecision(Reason.Assigned, astronaut.index, site.index);
  astronaut.setValue(ConstructionState, "stage", "toSite");
  astronaut.setValue(ConstructionState, "site", site);
  const object = astronaut.object3D;
  const [fromX, fromY] = object
    ? worldToGrid(object.position.x, object.position.z)
    : [-1, -1];
  const approach = path[path.length - 1] ?? { x: fromX, y: fromY };
  astronaut.setValue(ConstructionState, "approachX", approach.x);
  astronaut.setValue(ConstructionState, "approachY", approach.y);
  const remaining = [...path];
  const next = remaining.shift();
  boardState.pathByUnit.set(astronaut.index, remaining);
  if (next) {
    astronaut.setValue(Unit, "orderX", next.x);
    astronaut.setValue(Unit, "orderY", next.y);
    astronaut.setValue(Unit, "hasOrder", true);
  } else {
    astronaut.setValue(Unit, "hasOrder", false);
    astronaut.setValue(ConstructionState, "stage", "building");
  }
}

export function releaseSiteBuilders(site: Entity): void {
  for (const astronaut of boardState.buildersBySite.get(site.index) ?? []) {
    if (
      (astronaut.getValue(ConstructionState, "site") as Entity | null) === site
    ) {
      releaseBuilder(astronaut);
    }
  }
}

export function clearSelectedSite(site: Entity): void {
  if (boardState.selectedSite === site) boardState.selectedSite = null;
  const tablet = boardState.tablet;
  if (!tablet) return;
  if ((tablet.getValue(TabletState, "selectedSite") as Entity | null) !== site) {
    return;
  }
  tablet.setValue(TabletState, "selectedSite", null);
  tablet.setValue(TabletState, "selectedSiteIndex", -1);
}

// Frees the reserved footprint, refunds, and disposes. Shared by the player's
// Cancel action and by anything that removes a site for other reasons.
export function cancelConstructionSite(site: Entity, refund = true): number {
  if (!site.hasComponent(ConstructionSite)) return 0;
  const x = site.getValue(ConstructionSite, "x") ?? -1;
  const y = site.getValue(ConstructionSite, "y") ?? -1;
  const width = site.getValue(ConstructionSite, "widthTiles") ?? 1;
  for (const cell of footprintCells(x, y, width)) {
    setTerrainAt(cell.x, cell.y, "open");
  }
  releaseSiteBuilders(site);
  clearSelectedSite(site);
  boardState.buildersBySite.delete(site.index);
  const amount = refund
    ? cancelRefund(site.getValue(ConstructionSite, "cost") ?? 0)
    : 0;
  if (amount > 0) grantCrystals(amount);
  releaseEntity(site);
  return amount;
}

// Which build the tablet's Cancel acts on, per the rule you set: the one an
// astronaut is actually working on; if nobody has started anything, the first
// in the queue. With several under way, the earliest-queued of those wins, so
// repeated presses always unwind from the front.
export function currentBuildTarget(): Entity | null {
  const builds = [];
  for (const site of boardState.liveSites) {
    if (!isBuildableSite(site)) continue;
    builds.push({
      site,
      queueOrder: siteQueueOrder(site),
      // A site that needs no builder (astronaut production) is always making
      // progress, so it counts as "being worked on".
      inProgress: siteBuilderCount(site) > 0 || !siteNeedsBuilder(site),
    });
  }
  return pickCancelTarget(builds)?.site ?? null;
}

export function grantCrystals(amount: number): void {
  const gameState = boardState.gameState;
  if (!gameState || amount === 0) return;
  gameState.setValue(
    GameState,
    "crystals",
    (gameState.getValue(GameState, "crystals") ?? 0) + amount,
  );
  gameState.setValue(
    GameState,
    "revision",
    (gameState.getValue(GameState, "revision") ?? 0) + 1,
  );
}

export class ConstructionSystem extends createSystem({
  builders: { required: [Unit, ConstructionState] },
  sites: { required: [ConstructionSite] },
  craftSites: { required: [CraftProductionSite] },
  units: { required: [Unit] },
  enemies: { required: [Enemy] },
}) {
  private readonly cycle: SiteCycleState = {
    stage: "pending",
    timer: 0,
    duration: 0,
  };
  // Rebuilt in place every frame: how many builders have ARRIVED at each site
  // (drives the fill rate) and how many are attached at all including walkers
  // (gates auto-assignment so one site is not swarmed by every free astronaut).
  private readonly arrivedBySite = new Map<number, number>();
  private readonly attachedBySite = new Map<number, number>();
  private readonly completed: Entity[] = [];
  // Reused scratch arrays — sorting the queue must not allocate every frame.
  private readonly unstaffed: Entity[] = [];
  private readonly pending: Entity[] = [];
  private readonly cameraWorld = new Vector3();

  update(delta: number): void {
    this.advanceBuilders();
    this.advanceSites(delta);
    this.assignIdleBuilders();
    this.refreshQueueBadges();
  }

  // Walk assigned builders to their site and flip them to "building" on
  // arrival. No timer here any more — arrival is the only transition a builder
  // owns; the site advances itself.
  private advanceBuilders(): void {
    this.arrivedBySite.clear();
    this.attachedBySite.clear();
    // Reset the per-site builder lists in place rather than dropping them, so
    // a steady-state frame allocates nothing (CLAUDE.md: no allocation in
    // update). Entries are deleted when their site is disposed.
    for (const list of boardState.buildersBySite.values()) list.length = 0;
    for (const astronaut of this.queries.builders.entities) {
      const stage = astronaut.getValue(ConstructionState, "stage") ?? "idle";
      if (stage === "idle") continue;
      const site = astronaut.getValue(ConstructionState, "site") as Entity | null;
      if (!isBuildableSite(site)) {
        releaseBuilder(astronaut);
        continue;
      }

      if (stage === "toSite" && !(astronaut.getValue(Unit, "hasOrder") ?? false)) {
        const remaining = boardState.pathByUnit.get(astronaut.index) ?? [];
        const next = remaining.shift();
        if (next) {
          astronaut.setValue(Unit, "orderX", next.x);
          astronaut.setValue(Unit, "orderY", next.y);
          astronaut.setValue(Unit, "hasOrder", true);
        } else {
          astronaut.setValue(ConstructionState, "stage", "building");
          this.setTabletStatus("Astronaut is constructing");
        }
      }

      const current = astronaut.getValue(ConstructionState, "stage") ?? "idle";
      let list = boardState.buildersBySite.get(site.index);
      if (!list) {
        list = [];
        boardState.buildersBySite.set(site.index, list);
      }
      list.push(astronaut);
      this.attachedBySite.set(
        site.index,
        (this.attachedBySite.get(site.index) ?? 0) + 1,
      );
      if (current !== "building") continue;
      this.arrivedBySite.set(
        site.index,
        (this.arrivedBySite.get(site.index) ?? 0) + 1,
      );
      // First arrival claims the beacon role; everyone else assists.
      const beacon = siteBeaconBuilder(site);
      if (!beacon || !beacon.hasComponent(ConstructionState)) {
        setSiteBeaconBuilder(site, astronaut);
      }
    }
    // Publish the count onto craft sites too. CraftProductionSystem is
    // registered after this one (index.ts), so it reads a fresh value.
    for (const site of this.queries.craftSites.entities) {
      setSiteBuilderCount(site, this.arrivedBySite.get(site.index) ?? 0);
    }
  }

  private advanceSites(delta: number): void {
    for (const site of this.queries.sites.entities) {
      // The site is created by InteractionSystem earlier in the same world
      // update. This observes the actual first owning-system read, rather than
      // assuming a direct call made the order complete.
      observePlacedSite(site.index, Consumer.Construction);
      const builderCount = this.arrivedBySite.get(site.index) ?? 0;
      this.cycle.stage = (site.getValue(ConstructionSite, "stage") ??
        "pending") as SiteStage;
      this.cycle.timer = site.getValue(ConstructionSite, "timer") ?? 0;
      this.cycle.duration = site.getValue(ConstructionSite, "duration") ?? 0;
      const transition = advanceSiteConstruction(
        this.cycle,
        delta,
        builderCount,
      );
      site.setValue(ConstructionSite, "stage", this.cycle.stage);
      site.setValue(ConstructionSite, "timer", this.cycle.timer);
      site.setValue(ConstructionSite, "builderCount", builderCount);
      this.updateSiteVisual(site, builderCount);
      // Never dispose while iterating the query it came from.
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
      this.completeBuilding(site);
    }
    this.completed.length = 0;
  }

  private updateSiteVisual(site: Entity, builderCount: number): void {
    const progress = constructionProgress(
      site.getValue(ConstructionSite, "timer") ?? 0,
      site.getValue(ConstructionSite, "duration") ?? 0,
    );
    site.setValue(ConstructionSite, "progress", progress);
    const holder = site.object3D;
    if (!holder) return;
    const started = (site.getValue(ConstructionSite, "stage") ?? "pending") !== "pending";
    const background = holder.getObjectByName("ConstructionProgressBackground");
    if (background) background.visible = started;
    const fill = holder.getObjectByName("ConstructionProgressFill");
    if (!fill) return;
    fill.visible = started;
    if (!started) return;
    const spec = getBuildingSpec(site.getValue(ConstructionSite, "kind") ?? "");
    if (!spec) return;
    const width = spec.widthTiles * TILE_SIZE * 0.9;
    fill.scale.x = Math.max(0.001, progress);
    fill.position.x = -(width * (1 - progress)) / 2;
    // Claimed sites read as blue; more builders read as more opaque, so "help
    // arrived and this is going faster" is visible without a numeric readout.
    const foundation = holder.getObjectByName("ConstructionFoundation") as
      | Mesh
      | undefined;
    if (!foundation) return;
    const material = foundation.material as MeshBasicMaterial;
    const claimed = builderCount > 0;
    material.color.setHex(
      claimed
        ? CONSTRUCTION_FOUNDATION_COLOR
        : CONSTRUCTION_PENDING_FOUNDATION_COLOR,
    );
    material.opacity = claimed
      ? Math.min(
          0.75,
          CONSTRUCTION_FOUNDATION_OPACITY + 0.15 * (builderCount - 1),
        )
      : CONSTRUCTION_PENDING_FOUNDATION_OPACITY;
  }

  private completeBuilding(site: Entity): void {
    const kind = site.getValue(ConstructionSite, "kind") ?? "none";
    const spec = getBuildingSpec(kind);
    const root = boardState.boardRoot;
    const x = site.getValue(ConstructionSite, "x") ?? -1;
    const y = site.getValue(ConstructionSite, "y") ?? -1;
    releaseSiteBuilders(site);
    clearSelectedSite(site);
    boardState.buildersBySite.delete(site.index);
    traceEntityDestroyed(site.index, EntityKind.ConstructionSite, Reason.Completed);
    releaseEntity(site);
    if (!spec || !root) return;
    createBuildingEntity(this.world, root, spec, x, y);
    this.setTabletStatus(`${spec.label} complete`, "success");
  }

  // One path search per frame, at most. Only runs when a site has nobody
  // attached at all, so a normal frame with every site staffed does no work.
  // Builders take jobs in QUEUE ORDER, not by proximity. The number floating
  // over a queued site promises "this one is next", so the assigner has to keep
  // that promise — otherwise the badge is a lie. Proximity still decides *which*
  // astronaut goes, just not which job. The cost is that an astronaut may walk
  // past job #2 to reach job #1.
  private assignIdleBuilders(): void {
    let budget = BUILDER_ASSIGNMENTS_PER_FRAME;
    this.unstaffed.length = 0;
    for (const site of this.queries.sites.entities) {
      if ((this.attachedBySite.get(site.index) ?? 0) === 0) {
        this.unstaffed.push(site);
      }
    }
    for (const site of this.queries.craftSites.entities) {
      if (
        siteNeedsBuilder(site) &&
        (this.attachedBySite.get(site.index) ?? 0) === 0
      ) {
        this.unstaffed.push(site);
      }
    }
    this.unstaffed.sort((a, b) => siteQueueOrder(a) - siteQueueOrder(b));
    for (const site of this.unstaffed) {
      if (budget <= 0) return;
      budget -= this.claimNearestIdleAstronaut(site) ? 1 : 0;
    }
  }

  // The badge shows a site's place among the sites still WAITING. A site with
  // builders on it loses its number — its progress bar has taken over — and the
  // rest renumber 1, 2, 3 so the display always starts at 1.
  private refreshQueueBadges(): void {
    this.pending.length = 0;
    // Republished each frame so the tablet's Cancel can pick a target without
    // running its own ECS query.
    boardState.liveSites.length = 0;
    for (const site of this.queries.sites.entities) {
      boardState.liveSites.push(site);
      if (siteBuilderCount(site) === 0) this.pending.push(site);
      else setQueueBadge(site.object3D, null);
    }
    for (const site of this.queries.craftSites.entities) {
      boardState.liveSites.push(site);
      if (siteNeedsBuilder(site) && siteBuilderCount(site) === 0) {
        this.pending.push(site);
      } else {
        setQueueBadge(site.object3D, null);
      }
    }
    this.pending.sort((a, b) => siteQueueOrder(a) - siteQueueOrder(b));
    this.camera.getWorldPosition(this.cameraWorld);
    for (let i = 0; i < this.pending.length; i += 1) {
      const holder = this.pending[i].object3D;
      setQueueBadge(holder, i + 1);
      faceQueueBadge(holder, this.cameraWorld);
    }
  }

  private claimNearestIdleAstronaut(site: Entity): boolean {
    const anchor = siteAnchor(site);
    if (!anchor) return false;
    const candidates: { astronaut: Entity; distance: number }[] = [];
    const siteX = anchor.x;
    const siteY = anchor.y;
    for (const astronaut of this.queries.builders.entities) {
      if ((astronaut.getValue(ConstructionState, "stage") ?? "idle") !== "idle") {
        continue;
      }
      if (astronaut.getValue(Unit, "kind") !== "astronaut") continue;
      if (astronaut.getValue(Unit, "hasOrder") ?? false) continue;
      const object = astronaut.object3D;
      if (!object) continue;
      const [x, y] = worldToGrid(object.position.x, object.position.z);
      candidates.push({
        astronaut,
        distance: Math.abs(x - siteX) + Math.abs(y - siteY),
      });
    }
    if (candidates.length === 0) return false;
    // Sort by straight-line distance, then take the first one that actually has
    // a route. Pathing every candidate would be the strictly correct "nearest
    // by path" but costs one full search each; this gets the same answer in the
    // normal case and still refuses an astronaut that is close but walled off.
    candidates.sort((a, b) => a.distance - b.distance);
    for (const { astronaut } of candidates) {
      const path = this.findPathToSite(astronaut, site);
      if (!path) continue;
      attachBuilderToSite(astronaut, site, path);
      return true;
    }
    return false;
  }

  private findPathToSite(
    astronaut: Entity,
    site: Entity,
  ): GridPosition[] | null {
    const holder = astronaut.object3D;
    const anchor = siteAnchor(site);
    if (!holder || !anchor) return null;
    const { x: anchorX, y: anchorY, widthTiles: width } = anchor;
    const [fromX, fromY] = worldToGrid(holder.position.x, holder.position.z);
    const footprintKeys = new Set(
      footprintCells(anchorX, anchorY, width).map(({ x, y }) => gridKey(x, y)),
    );
    const canStandAt = (x: number, y: number) =>
      !footprintKeys.has(gridKey(x, y)) &&
      getTerrainAt(x, y) === "open" &&
      !this.isOccupied(x, y, astronaut);
    const goals = footprintApproaches(anchorX, anchorY, width, GRID_SIZE).filter(
      ({ x, y }) => canStandAt(x, y),
    );
    if (goals.length === 0) return null;
    return findGridPath({
      start: { x: fromX, y: fromY },
      goals,
      gridSize: GRID_SIZE,
      canStandAt,
    });
  }

  private isOccupied(tx: number, ty: number, exclude: Entity): boolean {
    for (const other of this.queries.units.entities) {
      if (other === exclude) continue;
      const object = other.object3D;
      if (!object) continue;
      const [x, y] = worldToGrid(object.position.x, object.position.z);
      if (x === tx && y === ty) return true;
    }
    for (const enemy of this.queries.enemies.entities) {
      const object = enemy.object3D;
      if (!object) continue;
      const [x, y] = worldToGrid(object.position.x, object.position.z);
      if (x === tx && y === ty) return true;
    }
    return false;
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
