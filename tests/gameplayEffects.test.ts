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
  // `createTransformEntity` appears exactly three times — once per pool.
  // Anywhere else would mean an emitter is allocating.
  //
  // Two live in `ensurePool`, the third in `ensureCarryPool`, which is separate
  // because it waits on a loaded GLTF rather than just a board root.
  const creations = src.match(/createTransformEntity/g) ?? [];
  assert.equal(creations.length, 4, "only the four pool builders may create entities");
  const builders = src.slice(src.indexOf("function ensurePool"), src.indexOf("function toRootLocal"));
  assert.equal(
    (builders.match(/createTransformEntity/g) ?? []).length,
    4,
    "every creation must sit inside a pool builder",
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
  // The carry pool flies a Group, so it marks the holder rather than a `mesh`;
  // the census inherits `drawCat` down the tree, so tagging the holder covers
  // every mesh the GLTF brought with it.
  const nonInteractive = (src.match(/makeNonInteractive\((mesh|holder)\)/g) ?? []).length;
  // Remnants get their own bucket rather than `vfx`, so Phase 2 can read what
  // they cost off the `Draw` line without unpicking them from the flash pools.
  const categorised = (src.match(/userData\.drawCat = "(vfx|remnant)"/g) ?? []).length;
  assert.equal(nonInteractive, 4, "all four pools must mark their objects non-interactive");
  assert.equal(categorised, 4, "all four pools must set a draw category");
});

test("both shader variants are GPU-warmed before the first event", () => {
  // Otherwise the first deposit of a session pays for a shader compile in the
  // middle of a frame — the same class of hitch the combat pool warms against.
  const src = effects();
  assert.match(src, /warmObjectForRender\(flashSlots\[0\]\?\.mesh/);
  assert.match(src, /warmObjectForRender\(pulseSlots\[0\]\?\.mesh/);
  assert.match(src, /warmObjectForRender\(carrySlots\[0\]\?\.object/);
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

// ── The crystal hand-over (deposit stage) ───────────────────────────────────

test("the hand-over launches on arrival, not on the credit", () => {
  const mining = source("src/systems/mining.ts");
  const reached = mining.indexOf('transition === "reachedBase"');
  const credited = mining.indexOf('transition === "deposited"');
  const launch = mining.indexOf("startCrystalCarry(");
  assert.ok(reached > 0 && credited > reached, "both branches must exist, in order");
  assert.ok(
    launch > reached && launch < credited,
    "startCrystalCarry belongs to the arrival branch: the flight fills the " +
      "deposit stage, so launching it at the credit would fly the crystal " +
      "after the stockpile had already taken it",
  );
});

test("the flight is shorter than the stage it fills", () => {
  // The crystal must be home BEFORE the counter moves, never after.
  const constants = source("src/systems/constants.ts");
  const fraction = /GAMEPLAY_VFX_CARRY_ARRIVE_FRACTION = ([0-9.]+)/.exec(constants)?.[1];
  assert.ok(fraction, "the fraction must be declared");
  assert.ok(Number(fraction) < 1, `flight fraction must be < 1, got ${fraction}`);
});

test("the crystal glides into the open door, and is not lobbed at the base", () => {
  const src = effectsCode();
  const update = src.slice(src.indexOf("for (const slot of carrySlots) {"));
  const body = update.slice(0, update.indexOf("\n    }"));
  // An arc reads as throwing. The crystal is being carried in.
  assert.ok(
    !body.includes("Math.sin") && !body.includes("ARC_HEIGHT"),
    "the flight must be a straight glide, with no arc term",
  );

  // Aimed at a door, not at the building's origin — those pivots all sit at the
  // model centre, so the target has to come from the door geometry's bounds.
  assert.match(src, /function nearestDoor/);
  assert.match(src, /setFromObject\(node\)/);
  assert.ok(
    src.includes("COMMAND_CENTER_DOOR_NODES"),
    "the door nodes must come from the shared constant, not a literal",
  );
});

test("every path that ends a mining job cancels the flight", () => {
  // A crystal that lands after its miner died shows a delivery the stockpile
  // never received.
  for (const [path, why] of [
    ["src/systems/mining.ts", "base lost, retarget failure, manual reassign"],
    ["src/systems/combat.ts", "the miner was killed mid-hand-over"],
    ["src/systems/demolition.ts", "the miner was recycled mid-hand-over"],
  ] as const) {
    assert.ok(
      source(path).includes("cancelCrystalCarry("),
      `${path} must cancel the flight (${why})`,
    );
  }
});

test("a landed flight releases its slot in the same frame", () => {
  // The slot is keyed on `entity.index`, which EliCS recycles. A slot left
  // claiming a dead miner's index would be cancelled by whichever unit is
  // handed that index next.
  const src = effectsCode();
  const update = src.slice(src.indexOf("for (const slot of carrySlots) {"));
  const body = update.slice(0, update.indexOf("\n    }"));
  assert.match(body, /slot\.active = false/);
  assert.match(body, /slot\.owner = -1/);
});

test("the clear parks the carry slots too", () => {
  const clear = effects().slice(effects().indexOf("export function clearGameplayEffects"));
  const body = clear.slice(0, clear.indexOf("\n}"));
  assert.ok(body.includes("carrySlots"), "a reset must park flights in progress");
  assert.ok(!body.includes(".dispose()"), "clear must park slots, not dispose them");
});

// ── Phase 4: deaths and the alien entrance ─────────────────────────────────

test("only combat kills emit a death effect", () => {
  // In `releaseEntity` it would fire for scenario resets, cancelled
  // construction sites and discarded reserve aliens alike — the plan's
  // ownership rule, and the reason the call is not in the teardown helper.
  assert.ok(
    source("src/systems/combat.ts").includes("emitDeathVfx("),
    "the combat kill path must emit it",
  );
  for (const path of [
    "src/systems/entityTeardown.ts",
    "src/systems/scenarioReset.ts",
    "src/systems/wave.ts",
    "src/systems/demolition.ts",
  ]) {
    assert.ok(
      !source(path).includes("emitDeathVfx"),
      `${path} must stay silent: releasing an entity is not a death`,
    );
  }
});

test("the death effect fires before the entity is released", () => {
  // It samples the target's world position, so a call after teardown has
  // nothing to read.
  const src = source("src/systems/combat.ts");
  const emit = src.indexOf("emitDeathVfx(target");
  const release = src.indexOf("releaseEntity(target)", emit);
  assert.ok(emit > 0, "emitDeathVfx must be called on the target");
  assert.ok(release > emit, "emitDeathVfx must precede releaseEntity");

  // And the classification has to happen before the branches start detaching.
  const classify = src.indexOf("const deathKind");
  assert.ok(
    classify > 0 && classify < src.indexOf("clearThreat(target)"),
    "the kind must be read while every component is still attached",
  );
});

test("the alien entrance grows the model, never the holder or the proxy", () => {
  // Scaling the holder would move the alien off its tile; scaling the proxy
  // would desynchronise the hit box from what the player sees.
  const src = source("src/systems/wave.ts");
  assert.match(src, /startReveal\(\s*model,/);
  assert.ok(
    src.includes("modelChildOf(alien.object3D)"),
    "the reveal target must come from the shared model lookup",
  );
  // `startReveal` refuses an already-visible object, so the model must be
  // hidden first or the entrance silently never plays.
  const release = src.slice(src.indexOf("private releaseReserveAliens"));
  const body = release.slice(0, release.indexOf("\n  }"));
  assert.ok(
    body.indexOf("model.visible = false") < body.indexOf("startReveal("),
    "the model must be hidden before the reveal starts",
  );
});

test("an alien killed mid-entrance releases its transition slot", () => {
  const src = source("src/systems/combat.ts");
  assert.ok(
    src.includes("settleObject(modelChildOf(target.object3D), false)"),
    "a corpse must not hold a transition slot for the rest of the duration",
  );
});

// ── Phase 1 of the death plan: the alien remnant ───────────────────────────

test("the remnant is a pooled object, not the dying entity", () => {
  // `releaseEntity` destroys the entity on the frame of the kill, and delaying
  // that would leave a corpse holding a tile claim and a ray target. So the
  // body that falls has to outlive the entity, which means a pool.
  const combat = source("src/systems/combat.ts");
  const spawn = combat.indexOf("startAlienRemnant(target");
  const release = combat.indexOf("releaseEntity(target)", spawn);
  assert.ok(spawn > 0, "the kill path must start a remnant");
  assert.ok(release > spawn, "the pose must be copied before the entity is released");

  const effects = effectsCode();
  const fn = effects.slice(effects.indexOf("export function startAlienRemnant"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /remnantSlots\.find/, "it must claim a pooled slot");
  assert.ok(!body.includes("new Group("), "a full pool must drop the body, not allocate one");
});

test("Phase 1 is the basic walker only", () => {
  // Drakes die in the air and a mech toppling like a body would look wrong;
  // both wait for Phase 3 and their own timing profiles.
  const effects = effectsCode();
  const fn = effects.slice(effects.indexOf("export function startAlienRemnant"));
  assert.match(fn.slice(0, fn.indexOf("\n}")), /kind !== "alien"/);
});

test("the remnant is measurable on its own", () => {
  // Phase 2 gates on numbers, so remnants need their own census bucket rather
  // than sharing one with live aliens or with the flash pools.
  assert.ok(
    effectsCode().includes('userData.drawCat = "remnant"'),
    "remnants must be countable separately on the Draw line",
  );
  assert.match(effects(), /remnants: number/, "and reported by gameplayEffectsActive");
});

test("a reset parks remnants with everything else", () => {
  const clear = effects().slice(effects().indexOf("export function clearGameplayEffects"));
  const body = clear.slice(0, clear.indexOf("\n}"));
  assert.ok(body.includes("remnantSlots"), "a stale body must not survive a rebuild");
});
