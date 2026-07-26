import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { DEBUG_SETTINGS_CATALOG } from "../src/systems/debugSettingsCatalog.ts";

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

test("settings view exposes every debug catalog control", () => {
  const source = readFileSync(
    new URL("../ui/rts-tablet.uikitml", import.meta.url),
    "utf8",
  );
  assert.match(source, /class="settings-columns"/);
  for (const { key } of DEBUG_SETTINGS_CATALOG) {
    assert.match(source, new RegExp(`id="setting-${key}-minus"`));
    assert.match(source, new RegExp(`id="setting-${key}-value"`));
    assert.match(source, new RegExp(`id="setting-${key}-plus"`));
  }
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
