export interface GridPosition {
  x: number;
  y: number;
}

interface ApproachOptions {
  target: GridPosition;
  from: GridPosition;
  gridSize: number;
  canStandAt: (x: number, y: number) => boolean;
}

// Find the nearest usable ring around a target, then choose the point on that
// ring closest to the moving unit. This puts the unit on the facing side of a
// single occupant and also reaches the outside edge of larger buildings.
export function findApproachTile({
  target,
  from,
  gridSize,
  canStandAt,
}: ApproachOptions): GridPosition | null {
  for (let radius = 1; radius < gridSize; radius += 1) {
    let best: GridPosition | null = null;
    let bestDistance = Infinity;

    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;

        const x = target.x + dx;
        const y = target.y + dy;
        if (x < 0 || y < 0 || x >= gridSize || y >= gridSize) continue;
        if (!canStandAt(x, y)) continue;

        const distance = (x - from.x) ** 2 + (y - from.y) ** 2;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = { x, y };
        }
      }
    }

    if (best) return best;
  }

  return null;
}
