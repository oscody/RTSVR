import {
  AssetManifest,
  AssetType,
  SessionMode,
  World,
} from "@iwsdk/core";
import { BoardSystem } from "./systems/board.js";

const assets: AssetManifest = {
  terrain: {
    url: "/gltf/terrain.glb",
    type: AssetType.GLTF,
    priority: "critical",
  },
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
    grabbing: false,
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
  world.registerSystem(BoardSystem);
});
