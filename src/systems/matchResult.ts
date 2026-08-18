import {
  PanelDocument,
  PanelUI,
  RayInteractable,
  UIKit,
  UIKitDocument,
  createSystem,
  type Entity,
} from "@iwsdk/core";
import {
  MatchResultPanel,
  MatchState,
  WaveSource,
  boardState,
} from "./state.js";
import {
  liftAboveScene,
  placeAtCommandCenterAlertPosition,
} from "./underAttackBanner.js";

type UiElement = UIKit.Text & {
  setProperties(properties: Record<string, unknown>): void;
};

export class MatchResultSystem extends createSystem({
  panels: { required: [MatchResultPanel, PanelUI, PanelDocument] },
}) {
  private panel: Entity | null = null;
  private document: UIKitDocument | null = null;
  private lastStatus = "";

  init(): void {
    this.createPanel();
    this.cleanupFuncs.push(
      this.queries.panels.subscribe("qualify", (entity) => {
        this.panel = entity;
        this.document = PanelDocument.data.document[
          entity.index
        ] as UIKitDocument;
        this.document.getElementById("result-exit-vr")?.addEventListener("click", () => {
          this.world.exitXR();
        });
        this.document.getElementById("result-restart")?.addEventListener("click", () => {
          const source = boardState.waveSource;
          if (!source) return;
          source.setValue(MatchState, "status", "restarting");
          source.setValue(
            MatchState,
            "revision",
            (source.getValue(MatchState, "revision") ?? 0) + 1,
          );
        });
      }),
    );
  }

  update(): void {
    const panel = this.panel ?? boardState.matchResultPanel;
    const status =
      boardState.waveSource?.getValue(MatchState, "status") ?? "playing";
    const visible = status === "defeat" || status === "victory";
    if (!panel?.object3D || status === this.lastStatus) return;
    this.lastStatus = status;
    if (visible) {
      this.presentResult(status);
      placeAtCommandCenterAlertPosition(panel.object3D, this.camera);
      // Same spot as the alert banner, so it needs the same protection from the
      // tablet parked beside the base. Applied on show because uikit builds the
      // mesh tree lazily. Raycasting is unaffected, so the buttons still work.
      liftAboveScene(panel.object3D);
    }
    panel.object3D.visible = visible;
    panel.setValue(MatchResultPanel, "visible", visible);
  }

  private presentResult(status: string): void {
    const victory = status === "victory";
    const waveNumber =
      boardState.waveSource?.getValue(WaveSource, "waveNumber") ?? 1;
    this.element("result-panel")?.setProperties({
      borderColor: victory ? "#22c55e" : "#ef4444",
    });
    this.element("result-title")?.setProperties({
      text: victory ? "LEVEL 1 COMPLETE" : "COMMAND CENTER LOST",
      color: victory ? "#86efac" : "#fca5a5",
    });
    this.element("result-body")?.setProperties({
      text: victory
        ? `Wave ${waveNumber} cleared. All aliens were defeated.`
        : "All friendly forces were destroyed.",
    });
  }

  private element(id: string): UiElement | null {
    return this.document?.getElementById(id) as UiElement | null;
  }

  private createPanel(): void {
    const root = boardState.boardRoot;
    if (!root) throw new Error("MatchResultSystem requires BoardSystem first");
    const panel = this.world
      .createTransformEntity(undefined, { parent: root })
      .addComponent(PanelUI, {
        config: "./ui/match-result.json",
        maxWidth: 0.58,
        maxHeight: 0.3,
      })
      .addComponent(RayInteractable)
      .addComponent(MatchResultPanel);
    panel.object3D!.name = "MatchResultPanel";
    placeAtCommandCenterAlertPosition(panel.object3D!, this.camera);
    panel.object3D!.visible = false;
    boardState.matchResultPanel = panel;
  }
}
