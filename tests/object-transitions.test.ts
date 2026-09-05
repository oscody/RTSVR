import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import {
  CARGO_RETREAT_SECONDS,
  CARGO_REVEAL_SECONDS,
  CARGO_TRANSITION_START_SCALE,
  NODE_DEPLETION_SECONDS,
  OBJECT_TRANSITION_POOL_SIZE,
} from "../src/systems/constants.ts";
import {
  type TransitionTarget,
  advanceObjectTransitions,
  clearObjectTransitions,
  objectTransitionsActive,
  settleObject,
  startRetreat,
  startReveal,
} from "../src/systems/objectTransitions.ts";

const ROOT = new URL("../", import.meta.url);
const source = (path: string): string => readFileSync(new URL(path, ROOT), "utf8");

/** The three fields the controller touches, and nothing else. */
function target(scale = 0.02, y = 0.5, visible = false): TransitionTarget {
  return {
    visible,
    position: { y },
    scale: {
      x: scale,
      setScalar(value: number) {
        this.x = value;
      },
    },
  };
}

/** Run the transition to completion in realistic frames. */
function runFor(seconds: number, step = 1 / 90): void {
  for (let elapsed = 0; elapsed < seconds; elapsed += step) {
    advanceObjectTransitions(step);
  }
}

// Module state is shared, so every test starts from empty.
const fresh = (): void => clearObjectTransitions();

// ── Reveal ─────────────────────────────────────────────────────────────────

test("a reveal starts small, ends at exactly the captured base scale", () => {
  fresh();
  const cargo = target(0.02);
  startReveal(cargo, CARGO_REVEAL_SECONDS, CARGO_TRANSITION_START_SCALE);

  assert.equal(cargo.visible, true, "visible on the first frame; nobody waits for it");
  assert.ok(cargo.scale.x < 0.02, "it starts smaller than it ends");

  runFor(CARGO_REVEAL_SECONDS + 0.05);
  // Exactly, not approximately: a cargo model that settles at 0.9999 of its
  // real size is wrong forever, and drifts further on every round trip.
  assert.equal(cargo.scale.x, 0.02);
  assert.equal(cargo.visible, true);
  assert.equal(objectTransitionsActive(), 0, "the slot must free itself");
});

test("a reveal never overshoots its base scale, whatever the frame length", () => {
  fresh();
  const cargo = target(0.02);
  startReveal(cargo, CARGO_REVEAL_SECONDS, CARGO_TRANSITION_START_SCALE);
  // A 300 ms hitch — this codebase has measured them — inside a 160 ms
  // transition. Unclamped, that scales the cargo well past the miner.
  advanceObjectTransitions(0.3);
  assert.equal(cargo.scale.x, 0.02);
});

// ── Retreat ────────────────────────────────────────────────────────────────

test("a retreat hides the object AND restores its resting transform", () => {
  // Verification item 13. If the base scale is not restored, the next reveal
  // captures a shrunken one as its base and the cargo never comes back.
  fresh();
  const cargo = target(0.02, 0.5, true);
  startRetreat(cargo, CARGO_RETREAT_SECONDS, CARGO_TRANSITION_START_SCALE);
  runFor(CARGO_RETREAT_SECONDS + 0.05);

  assert.equal(cargo.visible, false);
  assert.equal(cargo.scale.x, 0.02, "resting scale restored");
  assert.equal(cargo.position.y, 0.5, "resting height restored");
  assert.equal(objectTransitionsActive(), 0);
});

test("a full round trip returns the cargo to exactly where it started", () => {
  fresh();
  const cargo = target(0.02, 0.5, false);
  for (let trip = 0; trip < 5; trip += 1) {
    startReveal(cargo, CARGO_REVEAL_SECONDS, CARGO_TRANSITION_START_SCALE);
    runFor(CARGO_REVEAL_SECONDS + 0.02);
    startRetreat(cargo, CARGO_RETREAT_SECONDS, CARGO_TRANSITION_START_SCALE);
    runFor(CARGO_RETREAT_SECONDS + 0.02);
  }
  assert.equal(cargo.scale.x, 0.02, "no drift across five round trips");
  assert.equal(cargo.position.y, 0.5);
  assert.equal(cargo.visible, false);
});

test("a node depletion sinks as well as shrinks, then parks", () => {
  fresh();
  const node = target(1, 0.006, true);
  startRetreat(node, NODE_DEPLETION_SECONDS, 0.05, 0.063);
  runFor(NODE_DEPLETION_SECONDS * 0.5);
  assert.ok(node.position.y < 0.006, "it sinks into the terrain, not just shrinks");
  assert.ok(node.scale.x < 1);

  runFor(NODE_DEPLETION_SECONDS);
  assert.equal(node.visible, false);
  assert.equal(node.position.y, 0.006);
  assert.equal(node.scale.x, 1);
});

// ── Repeated calls (verification item 14) ──────────────────────────────────

test("repeated show calls do not restart the entrance", () => {
  // A caller reporting the same state every frame would otherwise pin the
  // object at its smallest scale forever — the entrance would never finish.
  fresh();
  const cargo = target(0.02);
  startReveal(cargo, CARGO_REVEAL_SECONDS, CARGO_TRANSITION_START_SCALE);
  for (let frame = 0; frame < 30; frame += 1) {
    startReveal(cargo, CARGO_REVEAL_SECONDS, CARGO_TRANSITION_START_SCALE);
    advanceObjectTransitions(1 / 90);
  }
  assert.equal(cargo.scale.x, 0.02, "it still finished");
  assert.equal(objectTransitionsActive(), 0);
});

test("showing an already-settled visible object does nothing", () => {
  // Otherwise a resting cargo would shrink and regrow every time the caller
  // repeated itself.
  fresh();
  const cargo = target(0.02, 0.5, true);
  startReveal(cargo, CARGO_REVEAL_SECONDS, CARGO_TRANSITION_START_SCALE);
  assert.equal(objectTransitionsActive(), 0, "no transition started");
  assert.equal(cargo.scale.x, 0.02, "and it was not shrunk to start one");
});

test("hiding an already-hidden object does nothing", () => {
  // `mining.ts` clears cargo on several paths that may never have shown it.
  fresh();
  const cargo = target(0.02, 0.5, false);
  startRetreat(cargo, CARGO_RETREAT_SECONDS, CARGO_TRANSITION_START_SCALE);
  assert.equal(objectTransitionsActive(), 0);
  assert.equal(cargo.scale.x, 0.02);
});

test("a reveal interrupting a retreat keeps the ORIGINAL base, not the shrunken one", () => {
  // Deposit then immediately reload. Capturing the base again mid-retreat
  // would ratchet the cargo smaller on every interrupted trip.
  fresh();
  const cargo = target(0.02, 0.5, true);
  startRetreat(cargo, CARGO_RETREAT_SECONDS, CARGO_TRANSITION_START_SCALE);
  runFor(CARGO_RETREAT_SECONDS * 0.6);
  assert.ok(cargo.scale.x < 0.02, "mid-retreat, so it is currently small");

  startReveal(cargo, CARGO_REVEAL_SECONDS, CARGO_TRANSITION_START_SCALE);
  runFor(CARGO_REVEAL_SECONDS + 0.05);
  assert.equal(cargo.scale.x, 0.02, "back to its real size, not 0.02 * 0.4");
  assert.equal(cargo.position.y, 0.5);
});

test("a retreat interrupting a reveal does not jump to full size first", () => {
  // The bug this replaces: a retreat always started from 1.0, so an
  // interrupted entrance snapped UP to full size and then shrank — a pop, in
  // the file whose whole job is removing pops.
  fresh();
  const model = target(1, 0, false);
  startReveal(model, 0.3, 0.1);
  runFor(0.1);
  const interrupted = model.scale.x;
  assert.ok(interrupted > 0.1 && interrupted < 1, "mid-entrance");

  startRetreat(model, 0.3, 0.05);
  assert.ok(
    model.scale.x <= interrupted + 1e-9,
    `retreat began at ${model.scale.x}, jumping up from ${interrupted}`,
  );
  advanceObjectTransitions(1 / 90);
  assert.ok(model.scale.x <= interrupted, "and it keeps shrinking, never grows");
});

test("a reveal interrupting a retreat does not jump back down first", () => {
  fresh();
  const model = target(1, 0, true);
  startRetreat(model, 0.3, 0.05);
  runFor(0.1);
  const interrupted = model.scale.x;
  assert.ok(interrupted < 1 && interrupted > 0.05, "mid-exit");

  startReveal(model, 0.3, 0.1);
  assert.ok(
    model.scale.x >= interrupted - 1e-9,
    `reveal began at ${model.scale.x}, dropping from ${interrupted}`,
  );
  advanceObjectTransitions(1 / 90);
  assert.ok(model.scale.x >= interrupted, "and it keeps growing");
});

test("an interrupted transition still lands exactly on its endpoint", () => {
  fresh();
  const model = target(1, 0.5, false);
  startReveal(model, 0.3, 0.1);
  runFor(0.1);
  startRetreat(model, 0.3, 0.05, 0.2);
  runFor(0.4);
  assert.equal(model.scale.x, 1, "base scale restored despite the interruption");
  assert.equal(model.position.y, 0.5);
  assert.equal(model.visible, false);
});

// ── Teardown paths ─────────────────────────────────────────────────────────

test("settleObject forces the resting transform and frees the slot", () => {
  fresh();
  const cargo = target(0.02, 0.5, true);
  startRetreat(cargo, CARGO_RETREAT_SECONDS, CARGO_TRANSITION_START_SCALE);
  runFor(CARGO_RETREAT_SECONDS * 0.5);
  settleObject(cargo, false);

  assert.equal(cargo.visible, false);
  assert.equal(cargo.scale.x, 0.02, "not left half-shrunk");
  assert.equal(cargo.position.y, 0.5);
  assert.equal(objectTransitionsActive(), 0);
});

test("settleObject on an untracked object just sets visibility", () => {
  fresh();
  const cargo = target(0.02, 0.5, true);
  settleObject(cargo, false);
  assert.equal(cargo.visible, false);
  assert.equal(cargo.scale.x, 0.02);
});

test("clearObjectTransitions drops every slot without touching the objects", () => {
  // Verification item 13, the "stale controller" half. The reset is about to
  // dispose these objects; restoring their transforms would be work for
  // nothing on the most expensive frame of the match.
  fresh();
  const cargo = target(0.02, 0.5, true);
  startRetreat(cargo, CARGO_RETREAT_SECONDS, CARGO_TRANSITION_START_SCALE);
  runFor(CARGO_RETREAT_SECONDS * 0.5);
  const midScale = cargo.scale.x;

  clearObjectTransitions();
  assert.equal(objectTransitionsActive(), 0);
  assert.equal(cargo.scale.x, midScale, "deliberately left as-is");

  // And nothing keeps advancing it afterwards.
  advanceObjectTransitions(1);
  assert.equal(cargo.scale.x, midScale);
});

test("a stale object left by a dead miner cannot wedge or throw", () => {
  // The owning entity can be released mid-transition. Nothing here reads the
  // scene graph or a material, so the slot simply finishes and frees itself.
  fresh();
  const cargo = target(0.02, 0.5, true);
  startRetreat(cargo, CARGO_RETREAT_SECONDS, CARGO_TRANSITION_START_SCALE);
  runFor(CARGO_RETREAT_SECONDS + 0.05);
  assert.equal(objectTransitionsActive(), 0, "the slot must not be held forever");
});

// ── Pool ───────────────────────────────────────────────────────────────────

test("a full pool snaps instead of allocating a slot", () => {
  // Degrading to the one-frame flip that shipped before this file existed is
  // the correct failure: never allocate inside a system update.
  fresh();
  const busy = Array.from({ length: OBJECT_TRANSITION_POOL_SIZE }, () =>
    target(0.02, 0.5, false),
  );
  for (const object of busy) {
    startReveal(object, CARGO_REVEAL_SECONDS, CARGO_TRANSITION_START_SCALE);
  }
  assert.equal(objectTransitionsActive(), OBJECT_TRANSITION_POOL_SIZE);

  const overflow = target(0.02, 0.5, false);
  startReveal(overflow, CARGO_REVEAL_SECONDS, CARGO_TRANSITION_START_SCALE);
  assert.equal(overflow.visible, true, "it still appears");
  assert.equal(overflow.scale.x, 0.02, "at full size, immediately");
  assert.equal(
    objectTransitionsActive(),
    OBJECT_TRANSITION_POOL_SIZE,
    "and took no slot",
  );

  const overflowHide = target(0.02, 0.5, true);
  startRetreat(overflowHide, CARGO_RETREAT_SECONDS, CARGO_TRANSITION_START_SCALE);
  assert.equal(overflowHide.visible, false);
  assert.equal(overflowHide.scale.x, 0.02, "left at its resting scale");
});

test("a zero or negative delta neither advances nor corrupts a transition", () => {
  fresh();
  const cargo = target(0.02);
  startReveal(cargo, CARGO_REVEAL_SECONDS, CARGO_TRANSITION_START_SCALE);
  const started = cargo.scale.x;
  advanceObjectTransitions(0);
  advanceObjectTransitions(-5);
  assert.equal(cargo.scale.x, started, "a paused frame must not move it");
  assert.ok(Number.isFinite(cargo.scale.x));
  assert.equal(objectTransitionsActive(), 1, "and must not end it early");
});

test("nothing null-passed can throw", () => {
  fresh();
  startReveal(null, 0.2, 0.1);
  startRetreat(undefined, 0.2, 0.1);
  settleObject(null, true);
  assert.equal(objectTransitionsActive(), 0);
});

// ── Source contracts ───────────────────────────────────────────────────────

const controller = (): string => source("src/systems/objectTransitions.ts");
const mining = (): string => source("src/systems/mining.ts");

/**
 * Code with comments stripped.
 *
 * Several assertions below are about what the code does NOT do, and the
 * comments explain exactly that — a raw scan finds the explanation and passes
 * a broken file. Fourth time this shape has bitten here.
 */
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("transitions animate transform only, never a shared material", () => {
  // These objects carry shared AssetManager GLTF materials. Fading one fades
  // every clone of it and recreates the shader churn already fixed elsewhere.
  const src = stripComments(controller());
  assert.ok(!/\.material\b/.test(src), "must not reach for a material");
  assert.ok(!/opacity/.test(src), "must not fade anything");
  assert.ok(!/dispose/.test(src), "must not dispose anything it does not own");
});

test("the controller keys on the object, never on a recycled entity index", () => {
  // EliCS recycles `entity.index`, so a slot keyed on one silently starts
  // animating a different entity's model.
  const src = stripComments(controller());
  assert.ok(!/\bentity\b/i.test(src), "no entity should appear in the controller");
  assert.ok(!/\.index\b/.test(src));
});

test("the slot pool is built once, never inside the advance", () => {
  const src = stripComments(controller());
  const advance = src.slice(src.indexOf("export function advanceObjectTransitions"));
  assert.ok(!advance.includes("slots.push"), "advance must not grow the pool");
  assert.equal((src.match(/slots\.push\(/g) ?? []).length, 1, "one build site only");
});

test("the extraction effect is keyed to the transition, not the miner's stage", () => {
  // A miner sits in one stage across many frames; a stage-driven effect fires
  // on every one of them.
  const src = mining();
  const at = src.indexOf("emitMiningLoadedVfx(");
  assert.ok(at > 0, "emitMiningLoadedVfx is not called");
  const branch = src.lastIndexOf('if (transition === "loadedCargo")', at);
  assert.ok(branch > 0 && at - branch < 400, "it must sit in the loadedCargo branch");
});

test("the deposit effect fires only for a positive credited deposit", () => {
  // Verification item 2: never for `baseUnavailable`, a zero-value cycle, or
  // cargo clearing.
  const src = mining();
  const at = src.indexOf("emitDepositVfx(");
  assert.ok(at > 0, "emitDepositVfx is not called");
  const guard = src.lastIndexOf("if (deposited > 0)", at);
  assert.ok(guard > 0 && at - guard < 300, "it must sit behind a positive-deposit guard");
  // And after the write that proves the crystals actually arrived.
  assert.ok(
    src.indexOf('gameState.setValue(GameState, "crystals"') < at,
    "the effect must follow the stockpile write, not lead it",
  );
});

test("mining teardown parks cargo immediately; the round trip animates", () => {
  const src = mining();
  const stop = src.slice(src.indexOf("private stopMining"));
  const body = stop.slice(0, stop.indexOf("\n  }"));
  assert.match(body, /setCargoVisible\(miner, false, true\)/, "teardown must not animate");

  const setter = src.slice(src.indexOf("private setCargoVisible"));
  const setterBody = setter.slice(0, setter.indexOf("\n  }"));
  assert.match(setterBody, /settleObject\(/);
  assert.match(setterBody, /startReveal\(/);
  assert.match(setterBody, /startRetreat\(/);
});

test("an exhausted node opens its tile and stops being a ray target first", () => {
  // The rules must not wait on the visual: a miner retargeting onto this tile
  // in the same frame cannot be blocked by a rock still disappearing.
  const src = mining();
  const start = src.indexOf("private exhaustNode");
  const body = src.slice(start, src.indexOf("\n  }", start));
  // Counted, not just located: an earlier version of this test used the FIRST
  // `setTerrainAt` and passed a mutation that moved the real one after the
  // retreat, because an early-return branch still had one in front.
  const count = (needle: string) => (body.match(new RegExp(needle, "g")) ?? []).length;
  assert.equal(count("setTerrainAt\\(", ), 1, "exactly one place opens the tile");
  assert.equal(count("disableModelRaycast\\("), 1);
  assert.equal(count("startRetreat\\("), 1);
  const terrain = body.indexOf("setTerrainAt(");
  const raycast = body.indexOf("disableModelRaycast(");
  const retreat = body.indexOf("startRetreat(");
  assert.ok(terrain > 0 && raycast > 0 && retreat > 0, "all three steps must be present");
  assert.ok(terrain < retreat, "the tile must open before the visual leaves");
  assert.ok(raycast < retreat, "and the node must stop being selectable first");
  assert.ok(
    !/object3D\.visible = false/.test(body),
    "the one-frame hide is what this phase replaces",
  );
});

test("the scenario reset is the ONLY caller of clearObjectTransitions", () => {
  // The function deliberately does not restore transforms, which is only safe
  // because the reset destroys these objects immediately afterwards. A second
  // caller that keeps its objects alive would freeze them at a fractional
  // scale, and the next reveal would capture that as their base.
  const callers: string[] = [];
  for (const file of readdirSync(new URL("src/systems/", ROOT))) {
    if (!file.endsWith(".ts") || file === "objectTransitions.ts") continue;
    const text = source(`src/systems/${file}`);
    if (/^\s*clearObjectTransitions\(\)/m.test(text)) callers.push(file);
  }
  assert.deepEqual(callers, ["scenarioReset.ts"], `unexpected callers: ${callers}`);
});

test("the reset drops transitions, and the system runs before it", () => {
  const reset = source("src/systems/scenarioReset.ts");
  assert.match(reset, /clearObjectTransitions\(\)/);
  const gameplay = reset.indexOf("clearGameplayEffects()");
  const transitions = reset.indexOf("clearObjectTransitions()");
  assert.ok(gameplay > 0 && Math.abs(transitions - gameplay) < 300, "keep the clears together");

  const index = source("src/index.ts");
  const at = (name: string) => index.indexOf(`registerSystem(${name})`);
  assert.ok(at("ObjectTransitionSystem") > 0, "system is not registered");
  assert.ok(
    at("MiningSystem") < at("ObjectTransitionSystem"),
    "the system that starts transitions must be registered first",
  );
  assert.ok(
    at("ObjectTransitionSystem") < at("ScenarioResetSystem"),
    "and the reset that drops them must be registered last",
  );
});

test("the system has a stable trace id", () => {
  assert.match(source("src/systems/traceSystemIds.ts"), /ObjectTransitionSystem: \d+,/);
});

test("every timing is a named constant, not a literal in the system", () => {
  // Same rule the pricing work established: one source per number.
  const src = stripComments(mining());
  const setter = src.slice(src.indexOf("private setCargoVisible"));
  const body = setter.slice(0, setter.indexOf("\n  }"));
  assert.ok(!/\b0\.\d+\b/.test(body), "no bare seconds or scales in setCargoVisible");
  const exhaust = src.slice(src.indexOf("private exhaustNode"));
  const exhaustBody = exhaust.slice(0, exhaust.indexOf("\n  }"));
  assert.ok(!/\b0\.\d+\b/.test(exhaustBody), "no bare numbers in exhaustNode");
});
