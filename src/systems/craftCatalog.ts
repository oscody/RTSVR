export interface CraftSpec {
  kind: string;
  label: string;
  asset: string;
  glb: string;
  image: string;
  cost: number;
  duration: number;
  locked: boolean;
}

export const CRAFT_CATALOG: readonly CraftSpec[] = [
  {
    kind: "cargo",
    label: "Cargo Craft",
    asset: "craftCargoA",
    glb: "/gltf/craft/craft_cargoA.glb",
    image: "/images/craft_cargoA.png",
    cost: 50,
    duration: 5,
    locked: false,
  },
  {
    kind: "miner",
    label: "Mining Craft",
    asset: "craftMinerAnimated",
    glb: "/gltf/craft/craft_miner_A.glb",
    image: "/images/craft_miner.png",
    cost: 60,
    duration: 6,
    locked: false,
  },
  {
    kind: "racer",
    label: "Racing Craft",
    asset: "craftRacer",
    glb: "/gltf/craft/craft_racer.glb",
    image: "/images/craft_racer.png",
    cost: 80,
    duration: 8,
    locked: false,
  },
  {
    kind: "rover",
    label: "Rover",
    asset: "rover",
    glb: "/gltf/craft/rover.glb",
    image: "/images/rover.png",
    cost: 40,
    duration: 4,
    locked: false,
  },
];

export function getCraftSpec(kind: string): CraftSpec | undefined {
  return CRAFT_CATALOG.find((spec) => spec.kind === kind);
}
