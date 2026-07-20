import {
  PanelDocument,
  PanelUI,
  RayInteractable,
  UIKitDocument,
  createSystem,
  type Entity,
} from "@iwsdk/core";
import {
  MatchResultPanel,
  MatchState,
  boardState,
} from "./state.js";

export class MatchResultSystem extends createSystem({
  panels: { required: [MatchResultPanel, PanelUI, PanelDocument] },
}) {
  private panel: Entity | null = null;
  private lastVisible = false;

  init(): void {
    this.createPanel();
    this.cleanupFuncs.push(
      this.queries.panels.subscribe("qualify", (entity) => {
        this.panel = entity;
        const document = PanelDocument.data.document[
          entity.index
        ] as UIKitDocument;
        document.getElementById("result-exit-vr")?.addEventListener("click", () => {
          this.world.exitXR();
        });
        document.getElementById("result-restart")?.addEventListener("click", () => {
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
    const visible =
      boardState.waveSource?.getValue(MatchState, "status") === "defeat";
    if (!panel?.object3D || visible === this.lastVisible) return;
    this.lastVisible = visible;
    panel.object3D.visible = visible;
    panel.setValue(MatchResultPanel, "visible", visible);
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
    panel.object3D!.position.set(0, 1.02, 0.45);
    panel.object3D!.visible = false;
    boardState.matchResultPanel = panel;
  }
}
