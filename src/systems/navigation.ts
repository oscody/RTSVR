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

export class ReusableGridPathfinder {
  readonly path: Int16Array;
  goalValue = -1;
  pathLength = 0;

  private readonly queue: Int16Array;
  private readonly previous: Int16Array;
  private readonly visited: Uint32Array;
  private readonly gridSize: number;
  private searchRevision = 0;

  constructor(gridSize: number) {
    this.gridSize = gridSize;
    const cellCount = gridSize * gridSize;
    this.path = new Int16Array(cellCount);
    this.queue = new Int16Array(cellCount);
    this.previous = new Int16Array(cellCount);
    this.visited = new Uint32Array(cellCount);
  }

  // One reusable BFS finds the nearest reachable cell belonging to any target.
  // goalByCell stores -1 for non-goals and a caller-defined target value for goals.
  findPathToAny(
    startX: number,
    startY: number,
    goalByCell: Int32Array,
    canStandAt: (x: number, y: number) => boolean,
  ): boolean {
    this.goalValue = -1;
    this.pathLength = 0;
    if (
      startX < 0 ||
      startY < 0 ||
      startX >= this.gridSize ||
      startY >= this.gridSize ||
      goalByCell.length !== this.path.length
    ) {
      return false;
    }

    this.searchRevision += 1;
    if (this.searchRevision === 0xffffffff) {
      this.visited.fill(0);
      this.searchRevision = 1;
    }

    const startIndex = startY * this.gridSize + startX;
    const startGoal = goalByCell[startIndex];
    if (startGoal >= 0) {
      this.goalValue = startGoal;
      return true;
    }

    let readCursor = 0;
    let writeCursor = 1;
    this.queue[0] = startIndex;
    this.visited[startIndex] = this.searchRevision;

    while (readCursor < writeCursor) {
      const currentIndex = this.queue[readCursor];
      readCursor += 1;
      const currentX = currentIndex % this.gridSize;
      const currentY = Math.floor(currentIndex / this.gridSize);

      for (const [dx, dy] of PATH_DIRECTIONS) {
        const nextX = currentX + dx;
        const nextY = currentY + dy;
        if (
          nextX < 0 ||
          nextY < 0 ||
          nextX >= this.gridSize ||
          nextY >= this.gridSize
        ) {
          continue;
        }
        const nextIndex = nextY * this.gridSize + nextX;
        if (
          this.visited[nextIndex] === this.searchRevision ||
          !canStandAt(nextX, nextY)
        ) {
          continue;
        }

        this.visited[nextIndex] = this.searchRevision;
        this.previous[nextIndex] = currentIndex;
        const goalValue = goalByCell[nextIndex];
        if (goalValue >= 0) {
          this.goalValue = goalValue;
          this.reconstructPath(startIndex, nextIndex);
          return true;
        }
        this.queue[writeCursor] = nextIndex;
        writeCursor += 1;
      }
    }
    return false;
  }

  private reconstructPath(startIndex: number, goalIndex: number): void {
    let step = goalIndex;
    while (step !== startIndex) {
      this.path[this.pathLength] = step;
      this.pathLength += 1;
      step = this.previous[step];
    }
    for (
      let left = 0, right = this.pathLength - 1;
      left < right;
      left += 1, right -= 1
    ) {
      const swap = this.path[left];
      this.path[left] = this.path[right];
      this.path[right] = swap;
    }
  }
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
