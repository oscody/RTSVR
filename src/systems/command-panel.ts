import {
  createSystem,
  eq,
  PanelDocument,
  PanelUI,
  UIKit,
  UIKitDocument,
} from "@iwsdk/core";
import {
  contextActionLabel,
  FactoryState,
  getKind,
  Health,
  labelForKind,
  runContextAction,
  runtime,
} from "../game-state.js";

type TextElement = UIKit.Text;

export class CommandPanelSystem extends createSystem({
  commandPanel: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, "config", "/ui/command-panel.json")],
  },
  resultPanel: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, "config", "/ui/match-result.json")],
  },
}) {
  private commandDocument: UIKitDocument | null = null;
  private resultDocument: UIKitDocument | null = null;
  private renderedRevision = -1;

  init(): void {
    this.cleanupFuncs.push(
      this.queries.commandPanel.subscribe("qualify", (entity) => {
        const document = PanelDocument.data.document[entity.index] as UIKitDocument;
        if (!document) return;
        this.commandDocument = document;
        document.getElementById("action-button")?.addEventListener("click", runContextAction);
        document.getElementById("reset-button")?.addEventListener("click", () => {
          runtime.resetRequested = true;
        });
        this.renderedRevision = -1;
      }, true),
      this.queries.resultPanel.subscribe("qualify", (entity) => {
        const document = PanelDocument.data.document[entity.index] as UIKitDocument;
        if (!document) return;
        this.resultDocument = document;
        document.getElementById("result-reset-button")?.addEventListener("click", () => {
          runtime.resetRequested = true;
        });
        this.renderedRevision = -1;
      }, true),
    );
  }

  update(): void {
    if (runtime.revision === this.renderedRevision) return;
    this.renderedRevision = runtime.revision;
    this.renderCommandPanel();
    this.renderResultPanel();
  }

  private setText(document: UIKitDocument, id: string, text: string): void {
    (document.getElementById(id) as TextElement | null)?.setProperties({ text });
  }

  private renderCommandPanel(): void {
    const document = this.commandDocument;
    if (!document) return;
    const selectedKind = getKind(runtime.selected);
    this.setText(document, "selected-text", labelForKind(selectedKind));
    this.setText(document, "resources-text", `${runtime.resources} crystals`);
    const baseHealth = runtime.base?.getValue(Health, "current") ?? 0;
    const enemyHealth = runtime.enemy?.getValue(Health, "current") ?? 0;
    this.setText(document, "base-health-text", `Base ${Math.ceil(baseHealth)} | Enemy ${Math.ceil(enemyHealth)}`);
    this.setText(document, "status-text", runtime.status);
    this.setText(document, "action-button", contextActionLabel());

    const factory = runtime.factory;
    let factoryText = "Locked | 30 crystals";
    if (factory?.getValue(FactoryState, "building")) {
      factoryText = `Building ${Math.round((factory.getValue(FactoryState, "buildProgress") ?? 0) * 100)}%`;
    } else if (factory?.getValue(FactoryState, "producing")) {
      factoryText = `Producing ${Math.round((factory.getValue(FactoryState, "productionProgress") ?? 0) * 100)}%`;
    } else if (factory?.getValue(FactoryState, "built")) {
      factoryText = "Online | Tank costs 20";
    }
    this.setText(document, "factory-text", factoryText);
  }

  private renderResultPanel(): void {
    const panelEntity = this.queries.resultPanel.entities.values().next().value;
    if (panelEntity?.object3D) panelEntity.object3D.visible = runtime.match !== "playing";
    const document = this.resultDocument;
    if (!document || runtime.match === "playing") return;
    const won = runtime.match === "won";
    this.setText(document, "result-title", won ? "MISSION COMPLETE" : "COMMAND CENTER LOST");
    this.setText(
      document,
      "result-body",
      won ? "The enemy emplacement is down." : "Reset and rebuild before pressure overwhelms the base.",
    );
  }
}
