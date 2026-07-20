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
import { BUILDING_CATALOG } from "./buildingCatalog.js";
import {
  Building,
  Enemy,
  GameState,
  GameStats,
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
    on("tab-production", () =>
      this.setView(tablet, "future", "Production arrives in Phase 5"),
    );
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
        tablet.setValue(TabletState, "selectedBuildingKind", spec.kind);
        this.touch(tablet, `${spec.label}: ${spec.cost} crystals. Choose a tile`);
      });
    }
  }

  private setView(tablet: Entity, view: string, status: string): void {
    tablet.setValue(TabletState, "view", view);
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
    element(this.document!, "future-view")?.setProperties({
      display: view === "future" ? "flex" : "none",
    });
  }

  private applySelectedCard(kind: string): void {
    for (const spec of BUILDING_CATALOG.filter((item) => !item.locked)) {
      element(this.document!, `build-${spec.kind}`)?.setProperties({
        borderColor: spec.kind === kind ? "#38bdf8" : "#9aa8b4",
        borderWidth: spec.kind === kind ? 3 : 1,
      });
    }
  }

  private setText(id: string, text: string): void {
    element(this.document!, id)?.setProperties({ text });
  }
}
