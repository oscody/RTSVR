import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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
