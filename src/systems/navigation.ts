import { PATH_DIRECTIONS } from "./constants.ts";

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

interface PathOptions {
  start: GridPosition;
  goals: readonly GridPosition[];
  gridSize: number;
  canStandAt: (x: number, y: number) => boolean;
}

// Four-neighbor BFS returns a shortest grid path without the starting cell.
// The goal list can contain every open work tile around a building footprint.
export function findGridPath({
  start,
  goals,
  gridSize,
  canStandAt,
}: PathOptions): GridPosition[] | null {
  const key = (x: number, y: number) => `${x},${y}`;
  const goalKeys = new Set(goals.map(({ x, y }) => key(x, y)));
  if (goalKeys.has(key(start.x, start.y))) return [];

  const queue: GridPosition[] = [start];
  const visited = new Set([key(start.x, start.y)]);
  const previous = new Map<string, GridPosition>();

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    for (const [dx, dy] of PATH_DIRECTIONS) {
      const next = { x: current.x + dx, y: current.y + dy };
      const nextKey = key(next.x, next.y);
      if (
        next.x < 0 ||
        next.y < 0 ||
        next.x >= gridSize ||
        next.y >= gridSize ||
        visited.has(nextKey) ||
        !canStandAt(next.x, next.y)
      ) {
        continue;
      }
      visited.add(nextKey);
      previous.set(nextKey, current);
      if (goalKeys.has(nextKey)) {
        const path: GridPosition[] = [next];
        let step = current;
        while (step.x !== start.x || step.y !== start.y) {
          path.push(step);
          step = previous.get(key(step.x, step.y))!;
        }
        return path.reverse();
      }
      queue.push(next);
    }
  }
  return null;
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
