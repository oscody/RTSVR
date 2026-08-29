import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (p: string): string =>
  readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("every registered system has a stable trace id", () => {
  // `SfxSystem` shipped without one and the gap only surfaced as
  // `WARN unlisted (fallback id): SfxSystem` in a device capture
  // (`console-logs/2026-08-29-Audio-Plan.log:101`). A fallback id is not
  // inert: ids are written into trace events, so a system on a fallback can
  // collide with a different one across runs and make a dump decode wrong.
  //
  // Nothing checked this, which is why adding a system silently degraded the
  // recorder. It costs one assertion.
  const index = read("src/index.ts");
  const ids = read("src/systems/traceSystemIds.ts");

  const registered = [...index.matchAll(/registerSystem\((\w+)\)/g)].map((m) => m[1]);
  assert.ok(registered.length > 20, "did not find the registerSystem calls");

  const missing = registered.filter(
    (name) => !new RegExp(`\\b${name}:\\s*\\d+,`).test(ids),
  );
  assert.deepEqual(
    missing,
    [],
    `these systems have no stable trace id and will use a fallback: ${missing.join(", ")}`,
  );
});

test("stable trace ids are unique", () => {
  // A duplicate silently merges two systems in every trace and every profile
  // line, which reads as one system being mysteriously expensive.
  const ids = read("src/systems/traceSystemIds.ts");
  const block = /const STABLE_IDS[\s\S]*?\n\};/.exec(ids)?.[0] ?? "";
  assert.ok(block, "STABLE_IDS table not found");

  const entries = [...block.matchAll(/(\w+):\s*(\d+),/g)].map((m) => [m[1], Number(m[2])] as const);
  const seen = new Map<number, string>();
  for (const [name, id] of entries) {
    const prior = seen.get(id);
    assert.equal(prior, undefined, `id ${id} is used by both ${prior} and ${name}`);
    seen.set(id, name);
  }

  // ...and must stay clear of the fallback range, or a real system and a
  // fallback can claim the same id.
  const FALLBACK_FIRST = 200;
  for (const [name, id] of entries) {
    assert.ok(id < FALLBACK_FIRST, `${name} (${id}) collides with the fallback range`);
  }
});
