export const UNIT_ROSTER_PAGE_SIZE = 4;

export interface RosterEntry {
  index: number;
  kind: string;
  category: string;
}

export interface RosterPage<T extends RosterEntry> {
  entries: T[];
  page: number;
  pageCount: number;
  total: number;
}

export function paginateRoster<T extends RosterEntry>(
  roster: readonly T[],
  category: string,
  requestedPage: number,
  pageSize = UNIT_ROSTER_PAGE_SIZE,
): RosterPage<T> {
  const filtered = roster
    .filter((entry) => category === "all" || entry.category === category)
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.index - b.index);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.max(0, Math.min(pageCount - 1, requestedPage));
  return {
    entries: filtered.slice(page * pageSize, (page + 1) * pageSize),
    page,
    pageCount,
    total: filtered.length,
  };
}

export function countRosterKinds(
  roster: readonly RosterEntry[],
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const entry of roster) {
    totals.set(entry.kind, (totals.get(entry.kind) ?? 0) + 1);
  }
  return totals;
}

export function toggleSelectionMembership<T>(
  selected: Set<T>,
  value: T,
): boolean {
  if (selected.has(value)) {
    selected.delete(value);
    return false;
  }
  selected.add(value);
  return true;
}

export interface FormationMember<T> {
  unit: T;
  x: number;
  y: number;
}

export interface FormationAssignment<T> {
  unit: T;
  x: number;
  y: number;
}

interface FormationOptions<T> {
  members: readonly FormationMember<T>[];
  target: { x: number; y: number };
  gridSize: number;
  canStandAt: (x: number, y: number) => boolean;
}

export function assignGroupDestinations<T>({
  members,
  target,
  gridSize,
  canStandAt,
}: FormationOptions<T>): FormationAssignment<T>[] {
  const ordered = [...members].sort((a, b) => {
    const aDistance = (a.x - target.x) ** 2 + (a.y - target.y) ** 2;
    const bDistance = (b.x - target.x) ** 2 + (b.y - target.y) ** 2;
    return aDistance - bDistance;
  });
  const claimed = new Set<string>();
  const assignments: FormationAssignment<T>[] = [];

  for (const member of ordered) {
    let best: { x: number; y: number } | null = null;
    let bestTargetRadius = Infinity;
    let bestTravelDistance = Infinity;
    for (let y = 0; y < gridSize; y += 1) {
      for (let x = 0; x < gridSize; x += 1) {
        const key = `${x},${y}`;
        if (claimed.has(key) || !canStandAt(x, y)) continue;
        const targetRadius = Math.max(
          Math.abs(x - target.x),
          Math.abs(y - target.y),
        );
        const travelDistance = (x - member.x) ** 2 + (y - member.y) ** 2;
        if (
          targetRadius < bestTargetRadius ||
          (targetRadius === bestTargetRadius &&
            (travelDistance < bestTravelDistance ||
              (travelDistance === bestTravelDistance &&
                (!best || y < best.y || (y === best.y && x < best.x)))))
        ) {
          best = { x, y };
          bestTargetRadius = targetRadius;
          bestTravelDistance = travelDistance;
        }
      }
    }
    if (!best) continue;
    claimed.add(`${best.x},${best.y}`);
    assignments.push({ unit: member.unit, x: best.x, y: best.y });
  }

  return assignments;
}
