import {
  AssetManifest,
  AssetType,
  SessionMode,
  Vector3,
  World,
} from "@iwsdk/core";
import { addSceneLighting, createPanels, createScenario } from "./scenario.js";
import { CombatSystem } from "./systems/combat.js";
import { CommandPanelSystem } from "./systems/command-panel.js";
import { ConstructionSystem } from "./systems/construction.js";
import { EconomySystem } from "./systems/economy.js";
import { MatchStateSystem } from "./systems/match-state.js";
import { ProductionSystem } from "./systems/production.js";
import { SelectionSystem } from "./systems/selection.js";
import { StateMirrorSystem } from "./systems/state-mirror.js";

const model = (filename: string): AssetManifest[string] => ({
  url: `/gltf/kenney-space-kit/${filename}.glb`,
  type: AssetType.GLTF,
  priority: "critical",
});

// Static board geometry (terrain tiles, table) lives in the GLXF level; this
// manifest only carries the models code spawns at runtime via AssetManager.
const assets: AssetManifest = {
  hangarLargeA: model("hangar_largeA"),
  rover: model("rover"),
  rockCrystals: model("rock_crystals"),
  rockCrystalsLargeA: model("rock_crystalsLargeA"),
  hangarSmallA: model("hangar_smallA"),
  craftCargoB: model("craft_cargoB"),
  craftMiner: model("craft_miner"),
  turretSingle: model("turret_single"),
};

World.create(document.getElementById("scene-container") as HTMLDivElement, {
  assets,
  level: "./glxf/Composition.glxf",
  xr: {
    sessionMode: SessionMode.ImmersiveVR,
    offer: "always",
    features: { handTracking: true, layers: true },
  },
  features: {
    locomotion: false,
    grabbing: false,
    physics: false,
    sceneUnderstanding: false,
    environmentRaycast: false,
  },
}).then((world) => {
  world
    .registerSystem(SelectionSystem)
    .registerSystem(EconomySystem)
    .registerSystem(ConstructionSystem)
    .registerSystem(ProductionSystem)
    .registerSystem(CombatSystem)
    .registerSystem(MatchStateSystem)
    .registerSystem(CommandPanelSystem)
    .registerSystem(StateMirrorSystem);

  addSceneLighting(world);
  createScenario(world);
  createPanels(world);

  // City-builder-style framing: angled close-up with the board filling the
  // frame (their camera sits ~1.2 board-widths from center, 1.45m above it).
  world.camera.position.set(3.6, 3.1, 1.9);
  world.camera.lookAt(new Vector3(0, 0.8, -3.0));
});
