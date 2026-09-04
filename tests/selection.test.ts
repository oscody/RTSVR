import assert from "node:assert/strict";
import test from "node:test";

import {
  assignGroupDestinations,
  countRosterKinds,
  paginateRoster,
  toggleSelectionMembership,
} from "../src/systems/selectionRules.ts";

const roster = [
  { index: 1, kind: "rover", category: "command-center" },
  { index: 2, kind: "astronaut", category: "command-center" },
  { index: 3, kind: "astronaut", category: "command-center" },
  { index: 4, kind: "cargo", category: "hangar" },
  { index: 5, kind: "fighter", category: "hangar" },
  { index: 6, kind: "miner", category: "factory" },
];

test("live roster filtering and pagination use building categories", () => {
  const allFirstPage = paginateRoster(roster, "all", 0);
  const allSecondPage = paginateRoster(roster, "all", 1);
  const hangar = paginateRoster(roster, "hangar", 0);

  assert.equal(allFirstPage.pageCount, 2);
  assert.equal(allFirstPage.entries.length, 4);
  assert.equal(allSecondPage.entries.length, 2);
  assert.deepEqual(
    hangar.entries.map(({ kind }) => kind),
    ["cargo", "fighter"],
  );
  assert.equal(countRosterKinds(roster).get("astronaut"), 2);
});

test("selection membership adds and removes the same unit", () => {
  const selected = new Set([1, 2]);
  assert.equal(toggleSelectionMembership(selected, 3), true);
  assert.deepEqual([...selected], [1, 2, 3]);
  assert.equal(toggleSelectionMembership(selected, 2), false);
  assert.deepEqual([...selected], [1, 3]);
});

test("twenty consecutive unit selections update membership reliably", () => {
  const selected = new Set<object>();
  const units = Array.from({ length: 20 }, () => ({}));

  for (const unit of units) {
    assert.equal(toggleSelectionMembership(selected, unit), true);
  }

  assert.equal(selected.size, 20);
  for (const unit of units) assert.equal(selected.has(unit), true);
});

test("group orders allocate distinct valid destinations near the target", () => {
  const blocked = new Set(["5,5", "5,4"]);
  const assignments = assignGroupDestinations({
    members: [
      { unit: "a", x: 1, y: 1 },
      { unit: "b", x: 1, y: 2 },
      { unit: "c", x: 2, y: 1 },
    ],
    target: { x: 5, y: 5 },
    gridSize: 8,
    canStandAt: (x, y) => !blocked.has(`${x},${y}`),
  });

  assert.equal(assignments.length, 3);
  assert.equal(new Set(assignments.map(({ x, y }) => `${x},${y}`)).size, 3);
  assert.ok(assignments.every(({ x, y }) => !blocked.has(`${x},${y}`)));
  assert.ok(
    assignments.every(
      ({ x, y }) => Math.max(Math.abs(x - 5), Math.abs(y - 5)) === 1,
    ),
  );
});

test("Phase 6 flow toggles three same-category units and leaves others unordered", () => {
  const commandCenterUnits = paginateRoster(
    roster,
    "command-center",
    0,
  ).entries;
  const selected = new Set<number>();
  for (const unit of commandCenterUnits) {
    toggleSelectionMembership(selected, unit.index);
  }
  assert.equal(selected.size, 3);

  toggleSelectionMembership(selected, commandCenterUnits[1].index);
  assert.equal(selected.size, 2);
  toggleSelectionMembership(selected, commandCenterUnits[1].index);
  assert.equal(selected.size, 3);

  const assignments = assignGroupDestinations({
    members: commandCenterUnits.map((unit, index) => ({
      unit: unit.index,
      x: index,
      y: 0,
    })),
    target: { x: 5, y: 5 },
    gridSize: 8,
    canStandAt: () => true,
  });
  assert.equal(assignments.length, 3);
  assert.equal(new Set(assignments.map(({ x, y }) => `${x},${y}`)).size, 3);
  assert.equal(assignments.some(({ unit }) => unit === 4), false);
});
