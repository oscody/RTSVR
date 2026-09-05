import { assetUrl } from "../app/assetUrl.ts";

export interface BuildingSpec {
  kind: string;
  label: string;
  asset: string;
  image: string;
  widthTiles: number;
  cost: number;
  duration: number;
  locked: boolean;
  yawDeg?: number;
}

export const BUILDING_CATALOG: readonly BuildingSpec[] = [
  {
    kind: "hangar",
    label: "Hangar",
    asset: "hangarLargeA",
    image: assetUrl("/images/hangar_largeA.png"),
    widthTiles: 2,
    cost: 40,
    duration: 4,
    locked: false,
  },
  {
    kind: "factory",
    label: "Aircraft Factory",
    asset: "aircraft_factory",
    image: assetUrl("/images/kenney_style_aircraft_factory_preview.png"),
    widthTiles: 3,
    cost: 60,
    duration: 6,
    locked: false,
  },
  {
    kind: "turret",
    label: "Turret",
    asset: "turretSingle",
    image: assetUrl("/images/turret_single.png"),
    widthTiles: 1,
    cost: 80,
    duration: 3,
    locked: false,
    yawDeg: 180,
  },
  {
    kind: "relay",
    label: "Relay",
    asset: "",
    image: "",
    widthTiles: 1,
    cost: 80,
    duration: 5,
    locked: true,
  },
  {
    kind: "shield",
    label: "Shield",
    asset: "",
    image: "",
    widthTiles: 2,
    cost: 100,
    duration: 7,
    locked: true,
  },
  {
    kind: "lab",
    label: "Research Lab",
    asset: "",
    image: "",
    widthTiles: 2,
    cost: 120,
    duration: 8,
    locked: true,
  },
];

export function getBuildingSpec(kind: string): BuildingSpec | undefined {
  return BUILDING_CATALOG.find((spec) => spec.kind === kind);
}
