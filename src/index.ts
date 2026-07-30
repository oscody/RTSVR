import {
  AssetManifest,
  AssetType,
  SessionMode,
  World,
} from "@iwsdk/core";
import { BoardSystem } from "./systems/board.js";
import { ConstructionSystem } from "./systems/construction.js";
import { CombatSystem } from "./systems/combat.js";
import { CombatEffectsSystem } from "./systems/combatEffects.js";
import { AlienAnimationSystem } from "./systems/alienAnimation.js";
import { CommandCenterAnimationSystem } from "./systems/commandCenterAnimation.js";
import { CraftProductionSystem } from "./systems/craftProduction.js";
import { CraftVisualRiseSystem } from "./systems/craftVisualRise.js";
import { InteractionSystem } from "./systems/interaction.js";
import { MiningSystem } from "./systems/mining.js";
import { MatchResultSystem } from "./systems/matchResult.js";
import { MovementSystem } from "./systems/movement.js";
import { MinerAnimationSystem } from "./systems/minerAnimation.js";
import { PerformanceSystem } from "./systems/performance.js";
import { ScenarioResetSystem } from "./systems/scenarioReset.js";
import { StructuresSystem } from "./systems/structures.js";
import { TabletSystem } from "./systems/tablet.js";
import { TurretAnimationSystem } from "./systems/turretAnimation.js";
import { UnitAnimationSystem } from "./systems/unitAnimation.js";
import { WaveSystem } from "./systems/wave.js";

const assets: AssetManifest = {
  commandCenter: {
    url: "/gltf/command_center.glb",
    type: AssetType.GLTF,
    priority: "critical",
  },
  aircraft_factory: {
    url: "/gltf/kenney_style_aircraft_factory.glb",
    type: AssetType.GLTF,
    priority: "critical",
  },
  hangarLargeA: {
    url: "/gltf/kenney-space-kit/hangar_largeA.glb",
    type: AssetType.GLTF,
    priority: "critical",
  },
  rock: { url: "/gltf/terrain/rock.glb", type: AssetType.GLTF, priority: "critical" },
  rockCrystals: { url: "/gltf/terrain/rock_crystals.glb", type: AssetType.GLTF, priority: "critical" },
  rockCrystalsLargeA: { url: "/gltf/terrain/rock_crystalsLargeA.glb", type: AssetType.GLTF, priority: "critical" },
  rockCrystalsLargeB: { url: "/gltf/terrain/rock_crystalsLargeB.glb", type: AssetType.GLTF, priority: "critical" },
  rockLargeA: { url: "/gltf/terrain/rock_largeA.glb", type: AssetType.GLTF, priority: "critical" },
  rockLargeB: { url: "/gltf/terrain/rock_largeB.glb", type: AssetType.GLTF, priority: "critical" },
  rocksSmallA: { url: "/gltf/terrain/rocks_smallA.glb", type: AssetType.GLTF, priority: "critical" },
  rocksSmallB: { url: "/gltf/terrain/rocks_smallB.glb", type: AssetType.GLTF, priority: "critical" },
  astronautA: { url: "/gltf/astronautA.glb", type: AssetType.GLTF, priority: "critical" },
  astronautAAnimated: { url: "/gltf/astronautA_A.glb", type: AssetType.GLTF, priority: "critical" },
  astronautB: { url: "/gltf/astronautB.glb", type: AssetType.GLTF, priority: "critical" },
  alien: { url: "/gltf/alien.glb", type: AssetType.GLTF, priority: "critical" },
  alienWalkingSlam: { url: "/gltf/alien_walking_slam_no_fx.glb", type: AssetType.GLTF, priority: "critical" },
  alienDrakeFlyingAttack: { url: "/gltf/alien_drake.glb", type: AssetType.GLTF, priority: "critical" },
  strongAlienMech: { url: "/gltf/alien_strong.glb", type: AssetType.GLTF, priority: "critical" },
  craftCargoA: { url: "/gltf/craft/craft_cargoA.glb", type: AssetType.GLTF, priority: "critical" },
  craftMinerAnimated: { url: "/gltf/craft/craft_miner_A.glb", type: AssetType.GLTF, priority: "critical" },
  craftMiner: { url: "/gltf/craft/craft_miner.glb", type: AssetType.GLTF, priority: "critical" },
  craftRacer: { url: "/gltf/craft/craft_racerA.glb", type: AssetType.GLTF, priority: "critical" },
  rover: { url: "/gltf/craft/rover.glb", type: AssetType.GLTF, priority: "critical" },
  turretSingle: { url: "/gltf/equipment/turret_single.glb", type: AssetType.GLTF, priority: "critical" },
  meteor: { url: "/gltf/terrain/meteor/meteor.glb", type: AssetType.GLTF, priority: "critical" },
  meteorDetailed: { url: "/gltf/terrain/meteor/meteor_detailed.glb", type: AssetType.GLTF, priority: "critical" },
  meteorHalf: { url: "/gltf/terrain/meteor/meteor_half.glb", type: AssetType.GLTF, priority: "critical" },
};

World.create(document.getElementById("scene-container") as HTMLDivElement, {
  assets,
  xr: {
    sessionMode: SessionMode.ImmersiveVR,
    offer: "always",
    features: { handTracking: true },
  },
  features: {
    locomotion: false,
    grabbing: true,
    physics: false,
    sceneUnderstanding: false,
    environmentRaycast: false,
  },
  render: {
    defaultLighting: true,
    camera: {
      position: [2.6, 2.25, 4.25],
      lookAt: [0, 0.8, 0],
    },
  },
}).then((world) => {
  world
    .registerSystem(BoardSystem)
    .registerSystem(StructuresSystem)
    .registerSystem(PerformanceSystem)
    .registerSystem(TabletSystem)
    .registerSystem(InteractionSystem)
    .registerSystem(MovementSystem)
    .registerSystem(WaveSystem)
    .registerSystem(CombatSystem)
    .registerSystem(CombatEffectsSystem)
    .registerSystem(AlienAnimationSystem)
    .registerSystem(CommandCenterAnimationSystem)
    .registerSystem(TurretAnimationSystem)
    .registerSystem(UnitAnimationSystem)
    .registerSystem(MiningSystem)
    .registerSystem(MinerAnimationSystem)
    .registerSystem(ConstructionSystem)
    .registerSystem(CraftProductionSystem)
    .registerSystem(CraftVisualRiseSystem)
    .registerSystem(MatchResultSystem)
    .registerSystem(ScenarioResetSystem);
});
