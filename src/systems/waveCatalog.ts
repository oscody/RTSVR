import { GRID_SIZE } from "./constants.ts";
import { enemyFacingYaw } from "./waveRules.ts";

export type EnemyKind = "alien" | "alienDrake" | "strongAlienMech";
export type WaveEdge = "north" | "east" | "south" | "west";

export interface WaveSpawnGroup {
  enemy: EnemyKind;
  count: number;
  edges: readonly WaveEdge[];
  minSpacingTiles?: number;
  releaseDelaySeconds?: number;
}

export interface WaveThreatBudget {
  budget: number;
  enemies: readonly EnemyKind[];
  edges: readonly WaveEdge[];
  minSpacingTiles?: number;
  releaseDelaySeconds?: number;
}

export interface WaveDifficulty {
  healthMultiplier?: number;
  speedMultiplier?: number;
  maxActiveAliensMultiplier?: number;
  releaseIntervalMultiplier?: number;
}

export interface WaveSpec {
  waveNumber: number;
  maxActiveAliens: number;
  releaseIntervalSeconds: number;
  groups?: readonly WaveSpawnGroup[];
  threatBudget?: WaveThreatBudget;
  difficulty?: WaveDifficulty;
}

export interface ResolvedWaveSpawn {
  asset: string;
  enemy: EnemyKind;
  name: string;
  widthTiles: number;
  x: number;
  y: number;
  yawDeg: number;
  releaseDelaySeconds: number;
  healthMultiplier: number;
  speedMultiplier: number;
}

interface EnemySpawnProfile {
  asset: string;
  namePrefix: string;
  threatCost: number;
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
  alien: { asset: "alienWalkingSlam", namePrefix: "Alien", threatCost: 1 },
  alienDrake: {
    asset: "alienDrakeFlyingAttack",
    namePrefix: "AlienDrake",
    threatCost: 2,
  },
  strongAlienMech: {
    asset: "strongAlienMech",
    namePrefix: "StrongAlienMech",
    threatCost: 4,
  },
};

export const WAVE_CATALOG: readonly WaveSpec[] = [
  {
    waveNumber: 1,
    maxActiveAliens: 3,
    releaseIntervalSeconds: 8,
    groups: [
      { enemy: "alien", count: 7, edges: ["north", "east", "south"], minSpacingTiles: 3 },
      { enemy: "alienDrake", count: 3, edges: ["south"], minSpacingTiles: 3 },
      { enemy: "strongAlienMech", count: 1, edges: ["south"], minSpacingTiles: 3 },
    ],
  },
  {
    waveNumber: 2,
    maxActiveAliens: 3,
    releaseIntervalSeconds: 8,
    threatBudget: {
      budget: 24,
      enemies: ["strongAlienMech", "alienDrake", "alien"],
      edges: ["north", "east", "south", "west"],
      minSpacingTiles: 3,
    },
    difficulty: {
      healthMultiplier: 1.25,
      speedMultiplier: 1.1,
      maxActiveAliensMultiplier: 1.34,
      releaseIntervalMultiplier: 0.85,
    },
  },
  {
    waveNumber: 3,
    maxActiveAliens: 3,
    releaseIntervalSeconds: 8,
    threatBudget: {
      budget: 34,
      enemies: ["strongAlienMech", "alienDrake", "alien"],
      edges: ["north", "east", "south", "west"],
      minSpacingTiles: 3,
    },
    difficulty: {
      healthMultiplier: 1.45,
      speedMultiplier: 1.18,
      maxActiveAliensMultiplier: 1.67,
      releaseIntervalMultiplier: 0.75,
    },
  },
];

export function getWaveSpec(waveNumber: number): WaveSpec | undefined {
  return WAVE_CATALOG.find((spec) => spec.waveNumber === waveNumber);
}

export function hasWaveSpec(waveNumber: number): boolean {
  return getWaveSpec(waveNumber) !== undefined;
}

export function getNextWaveSpec(waveNumber: number): WaveSpec | undefined {
  return WAVE_CATALOG
    .filter((spec) => spec.waveNumber > waveNumber)
    .sort((left, right) => left.waveNumber - right.waveNumber)[0];
}

export function resolveWaveSpawnGroups(spec: WaveSpec): WaveSpawnGroup[] {
  if (spec.groups) return [...spec.groups];
  if (!spec.threatBudget) return [];
  return composeThreatBudgetGroups(spec);
}

export function resolveWavePacing(spec: WaveSpec): {
  maxActiveAliens: number;
  releaseIntervalSeconds: number;
} {
  const maxActiveAliens = Math.max(
    1,
    Math.round(
      spec.maxActiveAliens * (spec.difficulty?.maxActiveAliensMultiplier ?? 1),
    ),
  );
  const releaseIntervalSeconds = Math.max(
    0,
    spec.releaseIntervalSeconds *
      (spec.difficulty?.releaseIntervalMultiplier ?? 1),
  );
  return { maxActiveAliens, releaseIntervalSeconds };
}

export function resolveWaveSpawns(
  spec: WaveSpec,
  { canSpawnAt, gridSize = GRID_SIZE }: ResolveWaveSpawnOptions,
): ResolvedWaveSpawn[] {
  const occupied = new Set<string>();
  const accepted: EdgeCandidate[] = [];
  const spawns: ResolvedWaveSpawn[] = [];
  const groups = resolveWaveSpawnGroups(spec);

  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex];
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
        yawDeg: inwardYaw(candidate.edge, group.enemy),
        releaseDelaySeconds: group.releaseDelaySeconds ?? 0,
        healthMultiplier: spec.difficulty?.healthMultiplier ?? 1,
        speedMultiplier: spec.difficulty?.speedMultiplier ?? 1,
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

function composeThreatBudgetGroups(spec: WaveSpec): WaveSpawnGroup[] {
  const threatBudget = spec.threatBudget;
  if (!threatBudget) return [];
  const pool = threatBudget.enemies.filter(
    (enemy) => ENEMY_SPAWN_PROFILES[enemy].threatCost <= threatBudget.budget,
  );
  if (pool.length === 0) return [];

  const counts = new Map<EnemyKind, number>();
  let remaining = Math.max(0, Math.floor(threatBudget.budget));
  let cursor = (spec.waveNumber - 1) % pool.length;
  const minCost = Math.min(
    ...pool.map((enemy) => ENEMY_SPAWN_PROFILES[enemy].threatCost),
  );

  while (remaining >= minCost) {
    const nextIndex = nextAffordableEnemyIndex(pool, cursor, remaining);
    if (nextIndex < 0) break;
    const enemy = pool[nextIndex];
    counts.set(enemy, (counts.get(enemy) ?? 0) + 1);
    remaining -= ENEMY_SPAWN_PROFILES[enemy].threatCost;
    cursor = (nextIndex + 1) % pool.length;
  }

  return pool
    .map((enemy) => ({
      enemy,
      count: counts.get(enemy) ?? 0,
      edges: threatBudget.edges,
      minSpacingTiles: threatBudget.minSpacingTiles,
      releaseDelaySeconds: threatBudget.releaseDelaySeconds,
    }))
    .filter((group) => group.count > 0);
}

function nextAffordableEnemyIndex(
  enemies: readonly EnemyKind[],
  cursor: number,
  remainingBudget: number,
): number {
  for (let offset = 0; offset < enemies.length; offset += 1) {
    const index = (cursor + offset) % enemies.length;
    if (ENEMY_SPAWN_PROFILES[enemies[index]].threatCost <= remainingBudget) {
      return index;
    }
  }
  return -1;
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

function inwardYaw(edge: WaveEdge, enemy: EnemyKind): number {
  if (edge === "north") return radiansToDegrees(enemyFacingYaw(enemy, 0, 1));
  if (edge === "east") return radiansToDegrees(enemyFacingYaw(enemy, -1, 0));
  if (edge === "south") return radiansToDegrees(enemyFacingYaw(enemy, 0, -1));
  return radiansToDegrees(enemyFacingYaw(enemy, 1, 0));
}

function radiansToDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

function spawnKey(x: number, y: number): string {
  return `${x},${y}`;
}
