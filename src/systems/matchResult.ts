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
  TutorialState,
  WaveSource,
  boardState,
} from "./state.js";
import {
  liftAboveScene,
  placeAtCommandCenterAlertPosition,
} from "./underAttackBanner.js";
import { getFinalWaveNumber } from "./waveCatalog.js";

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
    const matchStatus =
      boardState.waveSource?.getValue(MatchState, "status") ?? "playing";
    // The tutorial's dead end is read straight off `TutorialState`, NOT pushed
    // through `MatchState.status`.
    //
    // That is deliberate and load-bearing: `advanceTutorial` goes inactive the
    // moment `matchStatus !== "playing"`, which would clear the very `deadEnd`
    // flag that raised the panel — the panel would appear and immediately
    // un-appear. Reading the flag directly keeps the match "playing" (waves are
    // already held while `deadEnd` is set) and breaks the interlock.
    const deadEnd =
      boardState.tutorial?.getValue(TutorialState, "deadEnd") ?? false;
    const status = deadEnd ? "tutorialDeadEnd" : matchStatus;
    const visible =
      status === "defeat" || status === "victory" || status === "tutorialDeadEnd";
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
    // The third variant: the tutorial cannot continue. Amber rather than red —
    // nothing was destroyed and the player did nothing wrong, they simply ran
    // out of the one resource that buys more resources. Styling it as a defeat
    // would tell them they lost a fight they were never in.
    if (status === "tutorialDeadEnd") {
      this.element("result-panel")?.setProperties({ borderColor: "#f59e0b" });
      this.element("result-title")?.setProperties({
        text: "TUTORIAL OVER",
        color: "#fcd34d",
      });
      const baseAlive =
        boardState.waveSource?.getValue(MatchState, "commandCenterAlive") ??
        true;
      this.element("result-body")?.setProperties({
        text: baseAlive
          ? "No miner, and too few crystals to build one."
          : "Your command center was destroyed.",
      });
      return;
    }
    this.element("result-panel")?.setProperties({
      borderColor: victory ? "#22c55e" : "#ef4444",
    });
    // "LEVEL 1 COMPLETE" was hardcoded here, and told a player who had just
    // cleared wave 6 that they had finished level 1. Victory only ever fires
    // when the catalog has no next wave, so the number the player is congratulated
    // with must come from the catalog too — add a wave and this follows.
    const finalWave = getFinalWaveNumber();
    this.element("result-title")?.setProperties({
      text: victory ? `ALL ${finalWave} WAVES CLEARED` : "COMMAND CENTER LOST",
      color: victory ? "#86efac" : "#fca5a5",
    });
    // Two ways to lose, and they want different words: the title says
    // "COMMAND CENTER LOST" either way, so the body has to say which happened.
    const baseAlive =
      boardState.waveSource?.getValue(MatchState, "commandCenterAlive") ?? true;
    this.element("result-body")?.setProperties({
      text: victory
        ? `Wave ${waveNumber} was the last. All aliens were defeated.`
        : baseAlive
          ? "All friendly forces were destroyed."
          : "Your command center was destroyed.",
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
