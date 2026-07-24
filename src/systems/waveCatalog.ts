import { GRID_SIZE } from "./constants.ts";

export type EnemyKind = "alien" | "alienDrake" | "strongAlienMech";
export type WaveEdge = "north" | "east" | "south" | "west";

export interface WaveSpawnGroup {
  enemy: EnemyKind;
  count: number;
  edges: readonly WaveEdge[];
  minSpacingTiles?: number;
}

export interface WaveSpec {
  waveNumber: number;
  groups: readonly WaveSpawnGroup[];
}

export interface ResolvedWaveSpawn {
  asset: string;
  enemy: EnemyKind;
  name: string;
  widthTiles: number;
  x: number;
  y: number;
  yawDeg: number;
}

interface EnemySpawnProfile {
  asset: string;
  namePrefix: string;
}

interface EdgeCandidate {
  edge: WaveEdge;
  x: number;
  y: number;
}

interface ResolveWaveSpawnOptions {
  canSpawnAt: (x: number, y: number) => boolean;
  gridSize?: number;
}

const ENEMY_SPAWN_PROFILES: Readonly<Record<EnemyKind, EnemySpawnProfile>> = {
  alien: { asset: "alienWalkingSlam", namePrefix: "Alien" },
  alienDrake: { asset: "alienDrakeFlyingAttack", namePrefix: "AlienDrake" },
  strongAlienMech: { asset: "strongAlienMech", namePrefix: "StrongAlienMech" },
};

export const WAVE_CATALOG: readonly WaveSpec[] = [
  {
    waveNumber: 1,
    groups: [
      { enemy: "alien", count: 7, edges: ["north", "east", "south"], minSpacingTiles: 3 },
      { enemy: "alienDrake", count: 3, edges: ["south"], minSpacingTiles: 3 },
      { enemy: "strongAlienMech", count: 1, edges: ["south"], minSpacingTiles: 3 },
    ],
  },
];

export function getWaveSpec(waveNumber: number): WaveSpec | undefined {
  return WAVE_CATALOG.find((spec) => spec.waveNumber === waveNumber);
}

export function resolveWaveSpawns(
  spec: WaveSpec,
  { canSpawnAt, gridSize = GRID_SIZE }: ResolveWaveSpawnOptions,
): ResolvedWaveSpawn[] {
  const occupied = new Set<string>();
  const accepted: EdgeCandidate[] = [];
  const spawns: ResolvedWaveSpawn[] = [];

  for (let groupIndex = 0; groupIndex < spec.groups.length; groupIndex += 1) {
    const group = spec.groups[groupIndex];
    const candidates = edgeCandidates(group.edges, gridSize, spec.waveNumber, groupIndex);
    let groupCount = 0;
    for (const candidate of candidates) {
      if (groupCount >= group.count) break;
      const key = spawnKey(candidate.x, candidate.y);
      if (occupied.has(key)) continue;
      if (!canSpawnAt(candidate.x, candidate.y)) continue;
      if (tooClose(candidate, accepted, group.minSpacingTiles ?? 2)) continue;

      const profile = ENEMY_SPAWN_PROFILES[group.enemy];
      const serial = spawns.length + 1;
      spawns.push({
        asset: profile.asset,
        enemy: group.enemy,
        name: `Wave${spec.waveNumber}_${profile.namePrefix}${serial}`,
        widthTiles: 1,
        x: candidate.x,
        y: candidate.y,
        yawDeg: inwardYaw(candidate.edge),
      });
      occupied.add(key);
      accepted.push(candidate);
      groupCount += 1;
    }

    if (groupCount < group.count) {
      throw new Error(
        `Wave ${spec.waveNumber} could only place ${groupCount}/${group.count} ${group.enemy} spawns`,
      );
    }
  }

  return spawns;
}

function edgeCandidates(
  edges: readonly WaveEdge[],
  gridSize: number,
  waveNumber: number,
  groupIndex: number,
): EdgeCandidate[] {
  const lanes = edges.map((edge, edgeIndex) =>
    rotate(edgeCells(edge, gridSize), (waveNumber - 1) * 3 + groupIndex * 5 + edgeIndex),
  );
  const maxLength = Math.max(0, ...lanes.map((lane) => lane.length));
  const candidates: EdgeCandidate[] = [];
  for (let i = 0; i < maxLength; i += 1) {
    for (const lane of lanes) {
      const candidate = lane[i];
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates;
}

function edgeCells(edge: WaveEdge, gridSize: number): EdgeCandidate[] {
  const last = gridSize - 1;
  const cells: EdgeCandidate[] = [];
  for (let i = 0; i < gridSize; i += 1) {
    if (edge === "north") cells.push({ edge, x: i, y: 0 });
    if (edge === "east") cells.push({ edge, x: last, y: i });
    if (edge === "south") cells.push({ edge, x: last - i, y: last });
    if (edge === "west") cells.push({ edge, x: 0, y: last - i });
  }
  return cells;
}

function rotate<T>(items: readonly T[], offset: number): T[] {
  if (items.length === 0) return [];
  const start = ((offset % items.length) + items.length) % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

function tooClose(
  candidate: EdgeCandidate,
  accepted: readonly EdgeCandidate[],
  minSpacingTiles: number,
): boolean {
  return accepted.some(
    (other) =>
      Math.max(Math.abs(candidate.x - other.x), Math.abs(candidate.y - other.y)) <
      minSpacingTiles,
  );
}

function inwardYaw(edge: WaveEdge): number {
  if (edge === "north") return 180;
  if (edge === "east") return 270;
  if (edge === "south") return 0;
  return 90;
}

function spawnKey(x: number, y: number): string {
  return `${x},${y}`;
}
