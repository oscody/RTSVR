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
  // {
  //   kind: "cargo",
  //   label: "Cargo Craft",
  //   asset: "craftCargoA",
  //   glb: "/gltf/craft/craft_cargoA.glb",
  //   image: "/images/craft_cargoA.png",
  //   cost: 50,
  //   duration: 5,
  //   locked: false,
  // },
  {
    kind: "miner",
    label: "Mining Craft",
    asset: "craftMinerAnimated",
    glb: "/gltf/craft/craft_miner_A.glb",
    image: "/images/craft_miner.png",
    cost: 30,
    duration: 6,
    locked: false,
  },
  {
    kind: "fighter",
    label: "Fighter Craft",
    asset: "craftFighter",
    glb: "/gltf/craft/craft_racerA.glb",
    image: "/images/craft_racer.png",
    cost: 50,
    duration: 8,
    locked: false,
  },
  // {
  //   kind: "rover",
  //   label: "Rover",
  //   asset: "rover",
  //   glb: "/gltf/craft/rover.glb",
  //   image: "/images/rover.png",
  //   cost: 40,
  //   duration: 4,
  //   locked: false,
  // },
];

export const ASTRONAUT_PRODUCTION_SPEC: CraftSpec = {
  kind: "astronaut",
  label: "Astronaut",
  asset: "astronautAAnimated",
  glb: "/gltf/astronautA_A.glb",
  image: "/images/astronautA.png",
  cost: 20,
  duration: 4,
  locked: false,
};

export const PRODUCTION_UNIT_CATALOG: readonly CraftSpec[] = [
  ASTRONAUT_PRODUCTION_SPEC,
];

export function getCraftSpec(kind: string): CraftSpec | undefined {
  return CRAFT_CATALOG.find((spec) => spec.kind === kind);
}

export function getProductionSpec(kind: string): CraftSpec | undefined {
  return (
    getCraftSpec(kind) ??
    PRODUCTION_UNIT_CATALOG.find((spec) => spec.kind === kind)
  );
}
