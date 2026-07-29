import { MARS_OUTLINE_SCALE_PER_BOARD_UNIT } from "./constants.ts";

export type TerrainOutlinePoint = [x: number, z: number];

// Rocket's hand-shaped Martian mesa, normalized around the board origin.
const ROCKET_TERRAIN_OUTLINE: readonly (readonly [number, number])[] = [
  [-0.42, -0.18],
  [-0.36, -0.29],
  [-0.21, -0.33],
  [-0.05, -0.3],
  [0.08, -0.34],
  [0.27, -0.27],
  [0.39, -0.16],
  [0.43, 0.02],
  [0.34, 0.16],
  [0.18, 0.26],
  [0.03, 0.3],
  [-0.12, 0.27],
  [-0.27, 0.31],
  [-0.4, 0.21],
  [-0.48, 0.07],
  [-0.51, -0.08],
];

export function createMartianTerrainOutline(
  playableBoardSize: number,
): TerrainOutlinePoint[] {
  const scale = playableBoardSize * MARS_OUTLINE_SCALE_PER_BOARD_UNIT;
  return ROCKET_TERRAIN_OUTLINE.map(
    ([x, z]): TerrainOutlinePoint => [x * scale, z * scale],
  );
}

export function terrainOutlineContainsPoint(
  outline: readonly TerrainOutlinePoint[],
  x: number,
  z: number,
): boolean {
  let inside = false;
  for (
    let current = 0, previous = outline.length - 1;
    current < outline.length;
    previous = current, current += 1
  ) {
    const [currentX, currentZ] = outline[current];
    const [previousX, previousZ] = outline[previous];
    const crossesZ = currentZ > z !== previousZ > z;
    if (
      crossesZ &&
      x <
        ((previousX - currentX) * (z - currentZ)) /
          (previousZ - currentZ) +
          currentX
    ) {
      inside = !inside;
    }
  }
  return inside;
}

export function terrainOutlineContainsBoard(
  outline: readonly TerrainOutlinePoint[],
  playableBoardSize: number,
): boolean {
  const half = playableBoardSize / 2;
  return [
    [-half, -half],
    [half, -half],
    [half, half],
    [-half, half],
  ].every(([x, z]) => terrainOutlineContainsPoint(outline, x, z));
}
