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

const model = (filename: string): AssetManifest[string] => ({
  url: `/gltf/kenney-space-kit/${filename}.glb`,
  type: AssetType.GLTF,
  priority: "critical",
});

const assets: AssetManifest = {
  terrain: model("terrain"),
  platformLarge: model("platform_large"),
  platformStraight: model("platform_straight"),
  platformEnd: model("platform_end"),
  platformSmall: model("platform_small"),
  hangarLargeA: model("hangar_largeA"),
  satelliteDish: model("satelliteDish"),
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
    .registerSystem(CommandPanelSystem);

  addSceneLighting(world);
  createScenario(world);
  createPanels(world);

  world.camera.position.set(0, 2.35, 3.7);
  world.camera.lookAt(new Vector3(0, 0.85, -2.15));
});
