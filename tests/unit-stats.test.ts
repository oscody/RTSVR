import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  formatUnitStats,
  type UnitStats,
} from "../src/systems/unitStatsRules.ts";

const src = (p: string): string =>
  readFileSync(new URL(`../src/systems/${p}`, import.meta.url), "utf8");
const code = (p: string): string =>
  src(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

test("a fighting unit shows a labelled attack figure", () => {
  const turret: UnitStats = { buildSeconds: 3, damage: 18, cadence: 0.75, maxHealth: 250 };
  assert.equal(formatUnitStats(turret), "Build: 3s  Attack: 18  Hp: 250");
});

test("a unit that cannot fight says so, rather than showing zero", () => {
  // The miner has no entry in UNIT_ATTACK_SPECS. `Attack: 0` would claim it
  // attacks for no damage, which is a different and wrong statement.
  const miner: UnitStats = { buildSeconds: 6, damage: null, cadence: null, maxHealth: 100 };
  assert.equal(formatUnitStats(miner), "Build: 6s  No attack  Hp: 100");
});

test("the stat line fits the box it cannot overflow", () => {
  // `.card-stats` is 162px at font-size 10 — the build card's full content
  // width. UIKit DROPS overflowing children silently rather than clipping, so a
  // line that grows too long vanishes with no error. That is not hypothetical:
  // it is how this feature first shipped, invisible, on 2026-09-01.
  //
  // ~5px per character at 10px gives roughly 32 characters. The real lines run
  // to 30, so the ceiling is deliberately close to them — a label change that
  // pushes past it should fail here rather than on a headset.
  const real: UnitStats[] = [
    { buildSeconds: 3, damage: 18, cadence: 0.75, maxHealth: 250 },
    { buildSeconds: 8, damage: 12, cadence: 0.7, maxHealth: 90 },
    { buildSeconds: 6, damage: null, cadence: null, maxHealth: 100 },
  ];
  for (const stats of real) {
    const line = formatUnitStats(stats);
    assert.ok(line.length <= 32, `"${line}" is ${line.length} chars, over the 32 the box holds`);
  }
  // A pathological value must still be caught rather than silently dropped.
  const worst = formatUnitStats({ buildSeconds: 88, damage: 999, cadence: 1, maxHealth: 9999 });
  assert.ok(worst.length <= 36, `worst case is ${worst.length} chars: ${worst}`);
});

test("stats come from the live values, never the raw catalogs", () => {
  // Settings has knobs for `turretAttackDamage`, `astronautHealth`,
  // `craftRacerHealth` and more. Reading the catalog constants would make the
  // tile lie the moment one is tuned — which is exactly when a playtester is
  // most likely to be reading it.
  const stats = code("unitStats.ts");
  for (const fn of [
    "currentTurretAttackSpec",
    "currentUnitAttackSpec",
    "currentUnitMaxHealth",
    "currentBuildingMaxHealth",
  ]) {
    assert.match(stats, new RegExp(fn), `unitStats must resolve through ${fn}`);
  }
  // The raw tables must not be read directly.
  assert.doesNotMatch(stats, /UNIT_MAX_HEALTH|BUILDING_MAX_HEALTH|UNIT_ATTACK_SPECS|TURRET_ATTACK_SPEC/);
});

test("a turret's health comes from the BUILDING table, not the unit one", () => {
  // The trap this module exists to prevent: a turret is a building, so its
  // health and attack live in different tables from every craft. Getting that
  // wrong shows a turret with a racer's 90 hp instead of 250.
  const stats = code("unitStats.ts");
  const turretBranch = /if \(kind === "turret"\)[\s\S]*?\n  \}/.exec(stats)?.[0] ?? "";
  assert.ok(turretBranch, "turret branch not found");
  assert.match(turretBranch, /currentBuildingMaxHealth/);
  assert.match(turretBranch, /currentTurretAttackSpec/);
  assert.doesNotMatch(turretBranch, /currentUnitMaxHealth/);
});

test("every tile the player can press has a stat line", () => {
  const ui = readFileSync(new URL("../ui/rts-tablet.uikitml", import.meta.url), "utf8");
  for (const kind of ["turret", "astronaut", "hangar", "factory"]) {
    assert.ok(ui.includes(`id="build-stats-${kind}"`), `no stat line on the ${kind} tile`);
  }
  // Craft slots are paged, so every slot needs one, not just the first two.
  const slots = (ui.match(/id="craft-image-(\d)"/g) ?? []).length;
  const statSlots = (ui.match(/id="craft-stats-(\d)"/g) ?? []).length;
  assert.equal(statSlots, slots, `${slots} craft slots but ${statSlots} stat lines`);

  const tablet = code("tablet.ts");
  assert.match(tablet, /this\.setText\(`craft-stats-\$\{slot\}`/);
  assert.match(tablet, /this\.setText\(`build-stats-\$\{kind\}`/);
});

test("the tile refreshes when a Settings knob moves", () => {
  // Otherwise a tile keeps claiming 18 damage after the player has set it to 9.
  const tablet = code("tablet.ts");
  assert.match(tablet, /private applySettingsView\(\): void \{\s*this\.refreshBuildStats\(\);/);
});

test("the build thumbnail was shrunk to pay for the line", () => {
  // The build card is a fixed 94px: 82px of content for an image, a 19px name,
  // a 17px cost and a 15px stat line. Growing the card was rejected —
  // `.card-row` has 4px of slack in a 274px `.view`, and overflow disappears
  // silently. If someone restores 42px, the stat line is what vanishes.
  assert.match(src("constants.ts"), /export const TABLET_BUILD_THUMB_HEIGHT = 26;/);
  const ui = readFileSync(new URL("../ui/rts-tablet.uikitml", import.meta.url), "utf8");
  const card = /\.build-card \{([^}]*)\}/.exec(ui)?.[1] ?? "";
  const stats = /\.card-stats \{([^}]*)\}/.exec(ui)?.[1] ?? "";
  const px = (block: string, prop: string): number =>
    Number(new RegExp(`${prop}: (\\d+)px`).exec(block)?.[1] ?? 0);
  const content = px(card, "height") - px(card, "padding") * 2;
  const used = 26 + 19 + 17 + px(stats, "height");
  assert.ok(used <= content, `build card content is ${content}px but needs ${used}px`);
});

test("no span that gets setText() ships empty", () => {
  // THE bug, 2026-09-01. The stat spans were written as `<span id="..."></span>`
  // and nothing appeared on any tile. An empty span compiles to
  // `"children": []` — an element with no text node — and `setProperties({text})`
  // then has nothing to update. A populated one compiles to
  // `"children": ["50 crystals"]`.
  //
  // Nothing errors. `setText` returns silently when it cannot find a target,
  // and here it found one, so even that guard stayed quiet. Every other dynamic
  // span in the document already carried placeholder text; that is a
  // requirement, not decoration.
  const ui = readFileSync(new URL("../ui/rts-tablet.uikitml", import.meta.url), "utf8");
  const tablet = code("tablet.ts");

  // Every id the code writes text into...
  const written = new Set<string>();
  for (const m of tablet.matchAll(/setText\(\s*`([a-z-]+)-\$\{[a-z]+\}`/g)) {
    written.add(m[1]);
  }
  for (const m of tablet.matchAll(/setText\(\s*"([a-z-]+)"/g)) written.add(m[1]);
  assert.ok(written.size > 3, "did not find the setText call sites");

  // ...must not be an empty element in the markup.
  const empties: string[] = [];
  for (const m of ui.matchAll(/<span id="([a-z0-9-]+)"[^>]*><\/span>/g)) {
    const id = m[1];
    const prefix = id.replace(/-?\d+$/, "").replace(/-(turret|astronaut|hangar|factory)$/, "");
    if (written.has(prefix) || written.has(id)) empties.push(id);
  }
  assert.deepEqual(
    empties,
    [],
    `these spans are written by setText but ship with no text node, so the write silently does nothing:\n  ${empties.join("\n  ")}`,
  );
});

test("refreshing stats cannot crash on an unbound tablet", () => {
  // `applySettingsView` runs from the SETTINGS panel subscription, and that is a
  // different entity from the tablet — it can qualify first. `setText` reaches
  // for `this.document!` and `element()` has no null guard, so calling this
  // before the tablet binds would throw and take the frame down.
  //
  // The existing code in `applySettingsView` guards its own document; the stats
  // refresh was added ABOVE that guard, reaching for a different one.
  const tablet = code("tablet.ts");
  assert.match(
    tablet,
    /private refreshBuildStats\(\): void \{\s*if \(!this\.document\) return;/,
    "refreshBuildStats must check the document before using setText",
  );
  // `document` really is nullable — the `!` in setText is an assertion, not a
  // guarantee, which is what makes the check load-bearing.
  assert.match(tablet, /private document: UIKitDocument \| null = null;/);
  assert.match(tablet, /element\(this\.document!, id\)/);
  // And `element` itself has no guard, so the caller is the only defence.
  assert.match(
    tablet,
    /function element\(document: UIKitDocument, id: string\)[\s\S]{0,80}document\.getElementById/,
  );
});
