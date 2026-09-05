import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ROOT = new URL("../", import.meta.url);
const source = (path: string): string =>
  readFileSync(new URL(path, ROOT), "utf8");

const effects = () => source("src/systems/gameplayEffects.ts");

/**
 * The file with comments stripped.
 *
 * Several of these assertions are about what the code does NOT do, and the
 * comments explain exactly that — so scanning the raw file finds the
 * explanation and fails. Third time this shape has bitten in this codebase;
 * check code, not prose.
 */
const effectsCode = (): string =>
  effects()
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

// ── Pool contracts (plan section "Phase 1", verification items 7-10) ────────

test("nothing is allocated inside the per-frame update", () => {
  // The frame six aliens die on is the worst possible moment to build a mesh.
  const src = effectsCode();
  const update = src.slice(src.indexOf("update(delta: number): void {"));
  const body = update.slice(0, update.lastIndexOf("\n  }"));

  for (const forbidden of [
    "new Mesh(",
    "new SphereGeometry",
    "new RingGeometry",
    "new MeshBasicMaterial",
    "createTransformEntity",
  ]) {
    assert.ok(
      !body.includes(forbidden),
      `update() must not call ${forbidden} — it runs every frame`,
    );
  }
});

test("the pool is built before the first event, not by it", () => {
  // Phase 1 built the pool lazily from the first emitter and this test used to
  // FORBID `ensurePool()` in update(), which enforced that. It was wrong, and
  // Phase 3 exposed it the moment a real emitter existed:
  // `warmObjectForRender` only QUEUES a compile and `GpuWarmupSystem` drains
  // one entry per frame, so a pool built by the first deposit had its flash
  // drawn one to two frames AHEAD of its own warm-up. The shader compiled
  // mid-gameplay and the warm-up meant to prevent that arrived too late.
  //
  // Building from update() instead means the pool exists — and its queue has
  // drained — while the loading screen is still up.
  const src = effectsCode();
  const update = src.slice(src.indexOf("update(delta: number): void {"));
  const body = update.slice(0, update.lastIndexOf("\n  }"));
  assert.match(body, /ensurePool\(\)/, "update() must build the pool eagerly");

  // And it must be safe to call every frame: an identity check, not a rebuild.
  const ensure = src.slice(src.indexOf("function ensurePool"));
  const ensureBody = ensure.slice(0, ensure.indexOf("\n}"));
  assert.match(
    ensureBody,
    /if \(pooledRoot === rootObject && flashSlots\.length > 0\) return true;/,
    "ensurePool must return early once the pool exists for this root",
  );
});

test("emitters never create entities, components, or timers", () => {
  // The whole point of the pool: an event during a burst reuses a slot or is
  // dropped. Nothing here may reach for the ECS.
  const src = effectsCode();
  for (const forbidden of [
    "addComponent",
    "setTimeout",
    "entity.dispose()",
    "requestAnimationFrame",
  ]) {
    assert.ok(!src.includes(forbidden), `gameplayEffects must not use ${forbidden}`);
  }
  // `createTransformEntity` appears exactly twice — once per pool, inside
  // ensurePool. Anywhere else would mean an emitter is allocating.
  const creations = src.match(/createTransformEntity/g) ?? [];
  assert.equal(creations.length, 2, "only the two pool builders may create entities");
  const ensure = src.slice(src.indexOf("function ensurePool"), src.indexOf("function toRootLocal"));
  assert.equal(
    (ensure.match(/createTransformEntity/g) ?? []).length,
    2,
    "both creations must be inside ensurePool",
  );
});

test("a full pool drops the extra visual instead of allocating", () => {
  const src = effectsCode();
  for (const fn of ["function spawnFlash", "function spawnPulse"]) {
    const start = src.indexOf(fn);
    assert.ok(start > 0, `${fn} not found`);
    const body = src.slice(start, src.indexOf("\n}", start));
    // The loop returns on the first free slot; falling out of it is the
    // drop. There must be no fallback that builds one.
    assert.match(body, /if \(slot\.active\) continue;/);
    assert.ok(!body.includes("new Mesh("), "a full pool must not allocate a slot");
  }
});

test("every effect mesh is non-interactive and counted as vfx", () => {
  // A decorative mesh that is ray-testable would steal clicks from the unit
  // underneath it, and one without a draw category would be invisible to the
  // profiler that has to prove this system costs nothing.
  const src = effects();
  const nonInteractive = (src.match(/makeNonInteractive\(mesh\)/g) ?? []).length;
  const categorised = (src.match(/userData\.drawCat = "vfx"/g) ?? []).length;
  assert.equal(nonInteractive, 2, "both pools must mark their meshes non-interactive");
  assert.equal(categorised, 2, "both pools must set a draw category");
});

test("both shader variants are GPU-warmed before the first event", () => {
  // Otherwise the first deposit of a session pays for a shader compile in the
  // middle of a frame — the same class of hitch the combat pool warms against.
  const src = effects();
  assert.match(src, /warmObjectForRender\(flashSlots\[0\]\?\.mesh/);
  assert.match(src, /warmObjectForRender\(pulseSlots\[0\]\?\.mesh/);
});

// ── Lifetime contracts (plan verification items 9, and the reset section) ───

test("the pool survives a scenario reset instead of being disposed", () => {
  const src = effects();
  // No ScenarioObject means teardown walks past it. Checked against code:
  // the doc comment says "has no ScenarioObject", which a raw scan would find.
  assert.ok(
    !effectsCode().includes("ScenarioObject"),
    "the pool must not be tagged as a scenario object",
  );
  assert.match(src, /export function clearGameplayEffects/);

  const clear = src.slice(src.indexOf("export function clearGameplayEffects"));
  const body = clear.slice(0, clear.indexOf("\n}"));
  // Parks, never disposes: disposing would destroy a pool the next match reuses.
  assert.ok(!body.includes(".dispose()"), "clear must park slots, not dispose them");
  assert.match(body, /slot\.active = false/);
  assert.match(body, /slot\.mesh\.visible = false/);
  assert.match(body, /slot\.material\.opacity = 0/);
});

test("the reset actually calls the clear", () => {
  // A clear nothing invokes leaves a stale effect visible over a rebuilt board.
  const reset = source("src/systems/scenarioReset.ts");
  assert.match(reset, /clearGameplayEffects\(\)/);
  // Beside the sibling clears, so the three stay together when edited.
  const gameplay = reset.indexOf("clearGameplayEffects()");
  const combat = reset.indexOf("clearCombatEffects()");
  assert.ok(combat > 0 && gameplay > 0);
  assert.ok(Math.abs(gameplay - combat) < 120, "keep the effect clears adjacent");
});

test("no effect state keeps an entity reference after reset", () => {
  // Entity indices are recycled by EliCS, so a retained index silently starts
  // naming a different entity. The slots deliberately store only meshes.
  const src = effects();
  for (const shape of ["FlashSlot", "PulseSlot"]) {
    const start = src.indexOf(`interface ${shape} {`);
    const body = src.slice(start, src.indexOf("}", start));
    assert.ok(!/Entity/.test(body), `${shape} must not hold an Entity`);
    assert.ok(!/index/.test(body), `${shape} must not hold an entity index`);
  }
});

// ── Wiring (plan: "Register … after the systems that emit its events") ──────

test("the system is registered after every emitter and before the reset", () => {
  // Emitters activate slots directly, so this order does not affect same-frame
  // visibility — it controls when lifetimes advance, and advancing before the
  // reset is what lets the reset park a settled pool.
  const index = source("src/index.ts");
  const at = (name: string) => index.indexOf(`registerSystem(${name})`);

  const gameplay = at("GameplayEffectsSystem");
  assert.ok(gameplay > 0, "GameplayEffectsSystem is not registered");
  for (const emitter of [
    "WaveSystem",
    "CombatSystem",
    "MiningSystem",
    "ConstructionSystem",
    "CraftProductionSystem",
  ]) {
    assert.ok(at(emitter) > 0, `${emitter} not registered`);
    assert.ok(at(emitter) < gameplay, `${emitter} must be registered before the effects system`);
  }
  assert.ok(
    gameplay < at("ScenarioResetSystem"),
    "the effects system must advance before the reset parks it",
  );
});

test("the system has a stable trace id", () => {
  // Without one it falls back to a generated id and every capture disagrees
  // with the last about which system is which.
  const ids = source("src/systems/traceSystemIds.ts");
  assert.match(ids, /GameplayEffectsSystem: \d+,/);
});

// ── Colour contract (plan section 3: "the event reads without text") ────────

test("each death faction has its own colour, and buildings read larger", () => {
  const constants = source("src/systems/constants.ts");
  const colours = new Set<string>();
  for (const name of [
    "GAMEPLAY_VFX_DEATH_ALIEN_COLOR",
    "GAMEPLAY_VFX_DEATH_UNIT_COLOR",
    "GAMEPLAY_VFX_DEATH_BUILDING_COLOR",
  ]) {
    const match = new RegExp(`${name} = (0x[0-9a-f]+)`).exec(constants);
    assert.ok(match, `${name} is missing or not a hex literal`);
    colours.add(match[1]);
  }
  assert.equal(colours.size, 3, "the three death kinds must be distinguishable");

  const scale = /GAMEPLAY_VFX_BUILDING_DEATH_SCALE = ([0-9.]+)/.exec(constants);
  assert.ok(scale && Number(scale[1]) > 1, "a building death must read larger than a unit's");
});

test("every effect is brief — these punctuate a rule that already resolved", () => {
  // A long effect trails the truth: the damage, credit or teardown it marks
  // has already happened.
  const constants = source("src/systems/constants.ts");
  for (const name of [
    "GAMEPLAY_VFX_MINING_SECONDS",
    "GAMEPLAY_VFX_DEPOSIT_SECONDS",
    "GAMEPLAY_VFX_DEATH_SECONDS",
    "GAMEPLAY_VFX_COMPLETION_SECONDS",
  ]) {
    const match = new RegExp(`${name} = ([0-9.]+)`).exec(constants);
    assert.ok(match, `${name} is missing`);
    const seconds = Number(match[1]);
    assert.ok(seconds > 0 && seconds <= 0.5, `${name} is ${seconds}s; keep it under half a second`);
  }
});
