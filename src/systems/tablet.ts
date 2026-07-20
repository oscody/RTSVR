import {
  BoxGeometry,
  Entity,
  Group,
  Mesh,
  MeshStandardMaterial,
  OneHandGrabbable,
  PanelDocument,
  PanelUI,
  RayInteractable,
  UIKit,
  UIKitDocument,
  createSystem,
} from "@iwsdk/core";
import { BUILDING_CATALOG, getBuildingSpec } from "./buildingCatalog.js";
import { CRAFT_CATALOG, getCraftSpec } from "./craftCatalog.js";
import { validateCraftPurchase } from "./craftRules.js";
import { validateBuildOrder } from "./constructionRules.js";
import {
  Building,
  ConstructionState,
  Enemy,
  GameState,
  GameStats,
  SelectionState,
  TabletState,
  Unit,
  boardState,
} from "./state.js";

type UiElement = UIKit.Text & {
  setProperties(properties: Record<string, unknown>): void;
};

function element(document: UIKitDocument, id: string): UiElement | null {
  return document.getElementById(id) as UiElement | null;
}

export class TabletSystem extends createSystem({
  tablets: { required: [TabletState, PanelUI, PanelDocument] },
  buildings: { required: [Building] },
  units: { required: [Unit] },
  enemies: { required: [Enemy] },
}) {
  private document: UIKitDocument | null = null;
  private tabletEntity: Entity | null = null;
  private lastSignature = "";

  init(): void {
    this.createTablet();
    this.cleanupFuncs.push(
      this.queries.tablets.subscribe("qualify", (entity) => {
        this.tabletEntity = entity;
        this.document = PanelDocument.data.document[entity.index] as UIKitDocument;
        this.bind(this.document, entity);
        this.lastSignature = "";
      }),
    );
  }

  update(): void {
    const tablet = this.tabletEntity;
    const document = this.document;
    if (!tablet || !document) return;

    const game = boardState.gameState;
    const stats = boardState.gameStats;
    const crystals = game?.getValue(GameState, "crystals") ?? 0;
    const mined = stats?.getValue(GameStats, "crystalsMined") ?? 0;
    let astronauts = 0;
    let crafts = 0;
    for (const unit of this.queries.units.entities) {
      if (unit.getValue(Unit, "kind") === "astronaut") astronauts += 1;
      else crafts += 1;
    }
    const signature = [
      tablet.getValue(TabletState, "revision") ?? 0,
      crystals,
      mined,
      this.queries.buildings.entities.size,
      astronauts,
      crafts,
      this.queries.enemies.entities.size,
      stats?.getValue(GameStats, "enemiesKilled") ?? 0,
    ].join(":");
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;

    this.setText("crystal-balance", `${crystals}`);
    this.setText("overview-crystals", `${crystals}`);
    this.setText("overview-mined", `${mined}`);
    this.setText("overview-buildings", `${this.queries.buildings.entities.size}`);
    this.setText("overview-crafts", `${crafts}`);
    this.setText("overview-units", `${crafts + astronauts}`);
    this.setText("overview-astronauts", `${astronauts}`);
    this.setText("overview-enemies", `${this.queries.enemies.entities.size}`);
    this.setText(
      "overview-kills",
      `${stats?.getValue(GameStats, "enemiesKilled") ?? 0}`,
    );
    this.setText("tablet-status", tablet.getValue(TabletState, "status") ?? "");
    element(document, "tablet-status")?.setProperties({
      color:
        tablet.getValue(TabletState, "statusKind") === "error"
          ? "#b42318"
          : tablet.getValue(TabletState, "statusKind") === "success"
            ? "#176b55"
            : "#365466",
    });
    const astronautIndex = tablet.getValue(TabletState, "astronautIndex") ?? -1;
    this.setText(
      "builder-label",
      astronautIndex >= 0 ? `Astronaut #${astronautIndex}` : "Select an astronaut",
    );
    this.applyView(tablet.getValue(TabletState, "view") ?? "overview");
    this.applySelectedCard(
      tablet.getValue(TabletState, "selectedBuildingKind") ?? "none",
    );
    const building = getBuildingSpec(
      tablet.getValue(TabletState, "selectedBuildingKind") ?? "none",
    );
    const placingBuilding =
      tablet.getValue(TabletState, "buildPlacementActive") ?? false;
    this.setText(
      "build-action-label",
      building
        ? placingBuilding
          ? `Choose tile for ${building.label}`
          : `Produce ${building.label} - ${building.cost}`
        : "Choose a building",
    );
    const source = tablet.getValue(TabletState, "spawnBuilding") as Entity | null;
    const sourceKind = source?.getValue(Building, "kind") ?? null;
    this.setText(
      "craft-source-label",
      sourceKind
        ? `Production: ${this.buildingLabel(sourceKind)}`
        : "Select a production building",
    );
    const craftKind = tablet.getValue(TabletState, "selectedCraftKind") ?? "none";
    const craft = getCraftSpec(craftKind);
    const placingCraft =
      tablet.getValue(TabletState, "craftPlacementActive") ?? false;
    this.setText(
      "craft-action-label",
      craft
        ? placingCraft
          ? `Choose tile for ${craft.label}`
          : `Produce ${craft.label} - ${craft.cost}`
        : "Choose a craft",
    );
    this.applyCraftPage(tablet, craftKind);
  }

  private createTablet(): void {
    const root = boardState.boardRoot;
    if (!root) throw new Error("TabletSystem requires BoardSystem first");
    const frame = new Group();
    frame.name = "RTSVRTablet";
    const backing = new Mesh(
      new BoxGeometry(0.7, 0.55, 0.026),
      new MeshStandardMaterial({
        color: 0x536a7d,
        roughness: 0.62,
        metalness: 0.18,
      }),
    );
    backing.name = "RTSVRTabletFrame";
    backing.position.z = -0.018;
    // The backing covers the whole panel. Keep it visual-only so it cannot
    // intercept pointer rays before UIKit's buttons receive them.
    backing.raycast = () => {};
    frame.add(backing);
    const handle = new Mesh(
      new BoxGeometry(0.045, 0.26, 0.045),
      new MeshStandardMaterial({
        color: 0x1d2b36,
        roughness: 0.48,
        metalness: 0.25,
      }),
    );
    handle.name = "RTSVRTabletGrabHandle";
    handle.position.set(0.382, 0, 0);
    frame.add(handle);

    const shell = this.world
      .createTransformEntity(frame, { parent: root })
      .addComponent(OneHandGrabbable, { rotate: true, translate: true });
    shell.object3D!.name = "RTSVRTabletShell";

    const tablet = this.world
      .createTransformEntity(undefined, { parent: shell })
      .addComponent(PanelUI, {
        config: "./ui/rts-tablet.json",
        maxWidth: 0.66,
        maxHeight: 0.51,
      })
      .addComponent(RayInteractable)
      .addComponent(TabletState);
    if (boardState.commandCenter) {
      tablet.setValue(TabletState, "spawnBuilding", boardState.commandCenter);
      tablet.setValue(
        TabletState,
        "spawnBuildingIndex",
        boardState.commandCenter.index,
      );
    }
    tablet.object3D!.name = "RTSVRTabletScreen";
    tablet.object3D!.position.z = 0.002;
    const commandCenter = boardState.commandCenter?.object3D;
    shell.object3D!.position.set(
      (commandCenter?.position.x ?? 0) + 0.72,
      0.78,
      commandCenter?.position.z ?? 0,
    );
    shell.object3D!.rotation.set(-0.16, 0.25, 0);
    boardState.tablet = tablet;
  }

  private bind(document: UIKitDocument, tablet: Entity): void {
    const on = (id: string, handler: () => void) => {
      document.getElementById(id)?.addEventListener("click", handler);
    };
    on("tab-overview", () => this.setView(tablet, "overview", "Economy overview"));
    on("tab-build", () => this.setView(tablet, "build", "Choose a building"));
    on("tab-crafts", () => this.openCrafts(tablet));
    on("tab-units", () =>
      this.setView(tablet, "future", "Unit roster arrives in Phase 6"),
    );
    on("exit-vr", () => {
      this.world.exitXR();
    });

    for (const spec of BUILDING_CATALOG) {
      on(`build-${spec.kind}`, () => {
        if (spec.locked) {
          this.touch(tablet, `${spec.label} is locked`, "error");
          return;
        }
        tablet.setValue(TabletState, "view", "build");
        tablet.setValue(TabletState, "buildPlacementActive", false);
        tablet.setValue(TabletState, "craftPlacementActive", false);
        this.hidePlacementMarker();
        tablet.setValue(TabletState, "selectedBuildingKind", spec.kind);
        this.touch(tablet, `${spec.label}: ${spec.cost} crystals`);
      });
    }
    for (let slot = 0; slot < 4; slot += 1) {
      on(`craft-card-${slot}`, () => {
        const page = tablet.getValue(TabletState, "craftPage") ?? 0;
        const spec = CRAFT_CATALOG[page * 4 + slot];
        if (!spec) return;
        if (spec.locked) {
          this.touch(tablet, `${spec.label} is locked`, "error");
          return;
        }
        tablet.setValue(TabletState, "view", "crafts");
        tablet.setValue(TabletState, "selectedCraftKind", spec.kind);
        tablet.setValue(TabletState, "selectedCraftCost", spec.cost);
        tablet.setValue(TabletState, "buildPlacementActive", false);
        tablet.setValue(TabletState, "craftPlacementActive", false);
        this.hidePlacementMarker();
        this.touch(tablet, `${spec.label}: ${spec.cost} crystals`);
      });
    }
    on("craft-prev", () => this.changeCraftPage(tablet, -1));
    on("craft-next", () => this.changeCraftPage(tablet, 1));
    on("build-produce", () => this.produceSelectedBuilding(tablet));
    on("craft-produce", () => this.produceSelectedCraft(tablet));
  }

  private changeCraftPage(tablet: Entity, direction: number): void {
    const pageCount = Math.max(1, Math.ceil(CRAFT_CATALOG.length / 4));
    const current = tablet.getValue(TabletState, "craftPage") ?? 0;
    const next = Math.max(0, Math.min(pageCount - 1, current + direction));
    if (next === current) return;
    tablet.setValue(TabletState, "craftPage", next);
    tablet.setValue(TabletState, "craftPlacementActive", false);
    this.hidePlacementMarker();
    this.touch(tablet, `Craft catalog page ${next + 1} of ${pageCount}`);
  }

  private openCrafts(tablet: Entity): void {
    if (!(tablet.getValue(TabletState, "spawnBuilding") as Entity | null)) {
      const commandCenter = boardState.commandCenter;
      if (commandCenter) {
        tablet.setValue(TabletState, "spawnBuilding", commandCenter);
        tablet.setValue(TabletState, "spawnBuildingIndex", commandCenter.index);
      }
    }
    this.setView(tablet, "crafts", "Choose a craft to produce");
  }

  private setView(tablet: Entity, view: string, status: string): void {
    tablet.setValue(TabletState, "view", view);
    tablet.setValue(TabletState, "buildPlacementActive", false);
    tablet.setValue(TabletState, "craftPlacementActive", false);
    this.hidePlacementMarker();
    this.touch(tablet, status);
  }

  private touch(tablet: Entity, status: string, statusKind = "info"): void {
    tablet.setValue(TabletState, "status", status);
    tablet.setValue(TabletState, "statusKind", statusKind);
    tablet.setValue(
      TabletState,
      "revision",
      (tablet.getValue(TabletState, "revision") ?? 0) + 1,
    );
  }

  private applyView(view: string): void {
    element(this.document!, "overview-view")?.setProperties({
      display: view === "overview" ? "flex" : "none",
    });
    element(this.document!, "build-view")?.setProperties({
      display: view === "build" ? "flex" : "none",
    });
    element(this.document!, "crafts-view")?.setProperties({
      display: view === "crafts" ? "flex" : "none",
    });
    element(this.document!, "future-view")?.setProperties({
      display: view === "future" ? "flex" : "none",
    });
    const tabs = [
      ["tab-overview", "overview"],
      ["tab-build", "build"],
      ["tab-crafts", "crafts"],
      ["tab-units", "future"],
    ];
    for (const [id, tabView] of tabs) {
      element(this.document!, id)?.setProperties({
        backgroundColor: view === tabView ? "#93b4c5" : "#c8d4dc",
        borderColor: view === tabView ? "#315d73" : "#8497a5",
        borderWidth: view === tabView ? 2 : 1,
      });
    }
  }

  private applySelectedCard(kind: string): void {
    for (const spec of BUILDING_CATALOG.filter((item) => !item.locked)) {
      element(this.document!, `build-${spec.kind}`)?.setProperties({
        borderColor: spec.kind === kind ? "#38bdf8" : "#9aa8b4",
        borderWidth: spec.kind === kind ? 3 : 1,
      });
    }
  }

  private applyCraftPage(tablet: Entity, selectedKind: string): void {
    const pageCount = Math.max(1, Math.ceil(CRAFT_CATALOG.length / 4));
    const page = Math.max(
      0,
      Math.min(pageCount - 1, tablet.getValue(TabletState, "craftPage") ?? 0),
    );
    for (let slot = 0; slot < 4; slot += 1) {
      const spec = CRAFT_CATALOG[page * 4 + slot];
      element(this.document!, `craft-card-${slot}`)?.setProperties({
        display: spec ? "flex" : "none",
        borderColor: spec?.kind === selectedKind ? "#0e7490" : "#9aa8b4",
        borderWidth: spec?.kind === selectedKind ? 3 : 1,
      });
      if (!spec) continue;
      element(this.document!, `craft-image-${slot}`)?.setProperties({
        src: spec.image,
      });
      this.setText(`craft-name-${slot}`, spec.label);
      this.setText(`craft-cost-${slot}`, `${spec.cost} crystals`);
    }
    this.setText("craft-page-label", `Page ${page + 1} / ${pageCount}`);
    element(this.document!, "craft-prev")?.setProperties({
      opacity: page > 0 ? 1 : 0.35,
    });
    element(this.document!, "craft-next")?.setProperties({
      opacity: page < pageCount - 1 ? 1 : 0.35,
    });
  }

  private produceSelectedCraft(tablet: Entity): void {
    const source = tablet.getValue(TabletState, "spawnBuilding") as Entity | null;
    const game = boardState.gameState;
    const spec = getCraftSpec(
      tablet.getValue(TabletState, "selectedCraftKind") ?? "none",
    );
    const validation = validateCraftPurchase({
      spec,
      crystals: game?.getValue(GameState, "crystals") ?? 0,
      buildingKind: source?.getValue(Building, "kind") ?? null,
      // Tile availability is validated when the player clicks the board.
      tileAvailable: true,
    });
    if (!validation.ok || !spec || !game) {
      this.touch(
        tablet,
        validation.ok ? "Craft production is unavailable" : validation.error,
        "error",
      );
      return;
    }

    tablet.setValue(TabletState, "craftPlacementActive", true);
    tablet.setValue(TabletState, "buildPlacementActive", false);
    tablet.setValue(TabletState, "astronaut", null);
    tablet.setValue(TabletState, "astronautIndex", -1);
    boardState.selectedUnit = null;
    if (boardState.selectionMarker?.object3D) {
      boardState.selectionMarker.object3D.visible = false;
    }
    const selection = boardState.selection;
    if (selection) {
      selection.setValue(SelectionState, "unitIndex", -1);
      selection.setValue(SelectionState, "unitKind", "none");
      selection.setValue(
        SelectionState,
        "revision",
        (selection.getValue(SelectionState, "revision") ?? 0) + 1,
      );
    }
    this.touch(tablet, `Choose an open tile for ${spec.label}`);
  }

  private produceSelectedBuilding(tablet: Entity): void {
    const astronaut = tablet.getValue(TabletState, "astronaut") as Entity | null;
    if (!astronaut) {
      this.touch(tablet, "Select an astronaut to build", "error");
      return;
    }
    const spec = getBuildingSpec(
      tablet.getValue(TabletState, "selectedBuildingKind") ?? "none",
    );
    const validation = validateBuildOrder({
      spec,
      crystals: boardState.gameState?.getValue(GameState, "crystals") ?? 0,
      builderIdle:
        astronaut.hasComponent(ConstructionState) &&
        astronaut.getValue(ConstructionState, "stage") === "idle",
      // Footprint and path are validated against the tile the player clicks.
      footprintValid: true,
      pathFound: true,
    });
    if (!validation.ok || !spec) {
      this.touch(
        tablet,
        validation.ok ? "Building production is unavailable" : validation.error,
        "error",
      );
      return;
    }

    tablet.setValue(TabletState, "buildPlacementActive", true);
    tablet.setValue(TabletState, "craftPlacementActive", false);
    this.touch(tablet, `Choose a build tile for ${spec.label}`);
  }

  private hidePlacementMarker(): void {
    if (boardState.buildMarker?.object3D) {
      boardState.buildMarker.object3D.visible = false;
    }
  }

  private buildingLabel(kind: string): string {
    if (kind === "command-center") return "Command Center";
    if (kind === "factory") return "Aircraft Factory";
    if (kind === "hangar") return "Hangar";
    if (kind === "turret") return "Turret";
    return kind;
  }

  private setText(id: string, text: string): void {
    element(this.document!, id)?.setProperties({ text });
  }
}
