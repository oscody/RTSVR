import { createSystem } from "@iwsdk/core";
import { GameState, getKind, runtime } from "../game-state.js";

export class StateMirrorSystem extends createSystem({
  gameState: { required: [GameState] },
}) {
  update(): void {
    const entity = this.queries.gameState.entities.values().next().value;
    if (!entity) return;
    if (entity.getValue(GameState, "revision") === runtime.revision) return;
    entity.setValue(GameState, "revision", runtime.revision);
    entity.setValue(GameState, "resources", runtime.resources);
    entity.setValue(GameState, "match", runtime.match);
    entity.setValue(GameState, "status", runtime.status);
    entity.setValue(GameState, "selectedKind", getKind(runtime.selected));
    entity.setValue(GameState, "selectedIndex", runtime.selected?.index ?? -1);
  }
}
