import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { DEBUG_SETTINGS_CATALOG } from "../src/systems/debugSettingsCatalog.ts";
import { SETTINGS_PANEL_DROP } from "../src/systems/constants.ts";

test("tablet avoids unsupported multi-value Yoga spacing", () => {
  const source = readFileSync(
    new URL("../ui/rts-tablet.uikitml", import.meta.url),
    "utf8",
  );
  for (const match of source.matchAll(/^\s*(padding|margin):\s*([^;]+);/gm)) {
    const [, property, value] = match;
    assert.equal(
      value.trim().split(/\s+/).length,
      1,
      `${property} must use one value; use explicit side properties instead`,
    );
  }
});

test("build and craft catalogs require an explicit produce command", () => {
  const source = readFileSync(
    new URL("../ui/rts-tablet.uikitml", import.meta.url),
    "utf8",
  );
  assert.match(source, /id="build-produce"/);
  assert.match(source, /id="craft-produce"/);
});

test("build view exposes astronaut production and hides removed buildings", () => {
  const source = readFileSync(
    new URL("../ui/rts-tablet.uikitml", import.meta.url),
    "utf8",
  );
  assert.match(source, /id="build-astronaut"/);
  for (const kind of ["hangar", "factory", "relay", "shield", "lab"]) {
    assert.match(
      source,
      new RegExp(`id="build-${kind}"[^>]*style="display: none;"`),
    );
  }
});

test("wave banner exposes dynamic wave countdown text", () => {
  const source = readFileSync(
    new URL("../ui/rts-tablet.uikitml", import.meta.url),
    "utf8",
  );
  assert.match(source, /id="current-level"/);
  assert.match(source, /id="wave-banner-label"/);
  assert.match(source, /id="wave-countdown"/);
  assert.match(source, /Wave 1 incoming in/);
});

test("settings controls live in their own document, not the tablet", () => {
  const settings = readFileSync(
    new URL("../ui/rts-settings.uikitml", import.meta.url),
    "utf8",
  );
  const tablet = readFileSync(
    new URL("../ui/rts-tablet.uikitml", import.meta.url),
    "utf8",
  );

  // Every control still exists — it just moved.
  assert.match(settings, /class="settings-columns"/);
  for (const { key } of DEBUG_SETTINGS_CATALOG) {
    assert.match(settings, new RegExp(`id="setting-${key}-minus"`));
    assert.match(settings, new RegExp(`id="setting-${key}-value"`));
    assert.match(settings, new RegExp(`id="setting-${key}-plus"`));
    // ...and must NOT come back to the tablet. PanelUISystem ticks every
    // configured panel each frame with no visibility check, so these rows cost
    // the same hidden in the tablet as they did on screen.
    assert.doesNotMatch(tablet, new RegExp(`id="setting-${key}-minus"`));
  }
  assert.doesNotMatch(tablet, /class="settings-columns"/);
});

test("the tablet document stays far smaller than it was", () => {
  const tablet = readFileSync(
    new URL("../ui/rts-tablet.uikitml", import.meta.url),
    "utf8",
  );
  // 328 elements before the split, 158 of them settings rows. This guards the
  // regression, not an exact number.
  const elements = tablet.match(/<[a-zA-Z]/g)?.length ?? 0;
  assert.ok(
    elements < 220,
    `tablet document has ${elements} elements; the settings split took it ` +
      `from 328 to ~174 and it should not creep back`,
  );
});

test("Units view exposes four roster slots and pagination controls", () => {
  const source = readFileSync(
    new URL("../ui/rts-tablet.uikitml", import.meta.url),
    "utf8",
  );
  assert.match(source, /id="units-view"/);
  assert.doesNotMatch(source, /id="future-view"/);
  for (let slot = 0; slot < 4; slot += 1) {
    assert.match(source, new RegExp(`id="unit-card-${slot}"`));
    assert.match(source, new RegExp(`id="unit-image-${slot}"`));
  }
  assert.match(source, /id="unit-prev"/);
  assert.match(source, /id="unit-next"/);
  assert.match(source, /id="unit-clear"/);
});

test("the settings panel is created from observed view state, not setView", () => {
  const tablet = readFileSync(
    new URL("../src/systems/tablet.ts", import.meta.url),
    "utf8",
  );
  const reset = readFileSync(
    new URL("../src/systems/scenarioReset.ts", import.meta.url),
    "utf8",
  );

  // scenarioReset writes the view directly, so hanging the panel's lifecycle
  // off setView() would leak it across a Restart taken from the Settings tab.
  assert.match(reset, /setValue\(TabletState, "view", "overview"\)/);
  assert.match(tablet, /this\.syncSettingsPanel\(view\);/);
  assert.doesNotMatch(
    tablet,
    /tablet\.setValue\(TabletState, "view", view\);\s*\n\s*this\.syncSettingsPanel/,
    "syncSettingsPanel must be driven from the observed view, not from setView",
  );

  // Destroyed with releaseEntity: Entity.dispose() traverse-frees the font
  // atlas and materials this panel shares with the tablet.
  assert.match(tablet, /releaseEntity\(panel\)/);
  assert.doesNotMatch(tablet, /panel\.dispose\(\)/);
});

test("the settings panel hangs off the tablet shell, not the board root", () => {
  const tablet = readFileSync(
    new URL("../src/systems/tablet.ts", import.meta.url),
    "utf8",
  );

  // The tablet is two levels: shell (carries the pose) -> screen (a small z
  // offset). Parenting the settings panel to the board root and copying the
  // SCREEN's transform put it at the board origin, under the command center,
  // which is why it looked like the tab did nothing.
  assert.match(tablet, /this\.tabletShellEntity = shell;/);
  assert.match(
    tablet,
    /const shell = this\.tabletShellEntity;[\s\S]{0,200}\{ parent: shell \}/,
    "the settings panel must be parented to the shell",
  );
  assert.doesNotMatch(
    tablet,
    /placeSettingsPanel[\s\S]{0,300}quaternion\.copy/,
    "the shell already supplies rotation; copying it double-applies the pose",
  );
});

test("the settings panel clears the tablet frame", () => {
  // Frame half-height 0.275 + settings panel half-height 0.18 = 0.455 is where
  // they touch. A smaller drop renders the panel inside the tablet.
  assert.ok(
    SETTINGS_PANEL_DROP > 0.455,
    `SETTINGS_PANEL_DROP is ${SETTINGS_PANEL_DROP}; anything <= 0.455 overlaps`,
  );
});

test("the settings document is tall enough for its rows", () => {
  const settings = readFileSync(
    new URL("../ui/rts-settings.uikitml", import.meta.url),
    "utf8",
  );

  // UIKit drops a child that does not fit instead of clipping it, silently.
  // The 244px column inherited from the tablet was 26px short of column 2's
  // ten rows, and the whole content vanished: 198 meshes built, 3 visible.
  const rows = (settings.match(/class="settings-row"/g) ?? []).length;
  const perColumn = Math.ceil(rows / 2);
  const needed = perColumn * 27; // 25px row + 2px margin
  const declared = Number(
    /\.settings-column \{[^}]*height: (\d+)px/.exec(settings)?.[1] ?? 0,
  );
  assert.ok(
    declared >= needed,
    `settings-column is ${declared}px but ${perColumn} rows need ${needed}px`,
  );
});
