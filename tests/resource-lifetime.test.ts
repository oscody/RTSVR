import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import {
  RESOURCE_DETAIL_CAP,
  beginResourceInterval,
  resetResourceLifetimeForTest,
  resourceLifetimeDetails,
  renderTargetLine,
  resourceLifetimeLine,
  resourceLifetimeProblems,
  resourceLifetimeSnapshot,
  trackResource,
  type TrackableResource,
} from "../src/systems/resourceLifetime.ts";

/**
 * A stand-in for a Three.js disposable.
 *
 * The tracker is declared structurally against `addEventListener`, so this
 * needs no Three import — which is the point: the accounting is testable
 * without a WebGL context.
 *
 * `dispose()` dispatches on EVERY call with no internal guard, exactly like
 * `three.core.js` does at all four of its dispose sites. Double-free must be
 * reproducible here or the guard against it is untested.
 */
class FakeResource implements TrackableResource {
  private listeners: Array<() => void> = [];
  addEventListener(type: string, listener: () => void): void {
    if (type === "dispose") this.listeners.push(listener);
  }
  dispose(): void {
    for (const listener of this.listeners) listener();
  }
}

const fresh = (): void => resetResourceLifetimeForTest();

/** Run `body` with console.warn captured, so the assertion sees what shipped. */
function captureWarnings(body: () => void): string[] {
  const captured: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => captured.push(args.join(" "));
  try {
    body();
  } finally {
    console.warn = original;
  }
  return captured;
}

test("a tracked resource counts once as created", () => {
  fresh();
  trackResource(new FakeResource(), {
    kind: "geometry",
    scope: "scenario",
    label: "health-bar-fill",
  });

  const snapshot = resourceLifetimeSnapshot();
  const scenario = snapshot.byScope.get("scenario")!;
  assert.equal(scenario.created, 1);
  assert.equal(scenario.disposed, 0);
  assert.equal(scenario.outstanding, 1);
  assert.deepEqual(resourceLifetimeProblems(), []);
});

test("registering the same object twice is idempotent", () => {
  fresh();
  const resource = new FakeResource();
  const metadata = {
    kind: "material",
    scope: "pool",
    label: "combat-bolt",
  } as const;

  // Pool builders legitimately re-run over resources they already own, so a
  // second identical registration must not invent a second resource.
  trackResource(resource, metadata);
  trackResource(resource, metadata);

  assert.equal(resourceLifetimeSnapshot().byScope.get("pool")!.created, 1);
  assert.deepEqual(resourceLifetimeProblems(), []);
});

test("the same object with different metadata is reported, not overwritten", () => {
  fresh();
  const resource = new FakeResource();
  trackResource(resource, { kind: "geometry", scope: "scenario", label: "ring" });
  // Two owners believing they control one resource's lifetime is how a
  // double-free or a leak gets authored. Silently taking the last writer would
  // hide it.
  trackResource(resource, { kind: "geometry", scope: "session", label: "ring" });

  const problems = resourceLifetimeProblems();
  assert.equal(problems.length, 1, problems.join("; "));
  assert.match(problems[0], /conflicting metadata/);
  // The first registration stands, and no second resource was invented.
  const snapshot = resourceLifetimeSnapshot();
  assert.equal(snapshot.byScope.get("scenario")!.created, 1);
  assert.equal(snapshot.byScope.get("session"), undefined);
});

test("one dispose is counted exactly once", () => {
  fresh();
  const resource = new FakeResource();
  trackResource(resource, { kind: "texture", scope: "session", label: "hud" });
  resource.dispose();

  const totals = resourceLifetimeSnapshot().byScope.get("session")!;
  assert.equal(totals.created, 1);
  assert.equal(totals.disposed, 1);
  assert.equal(totals.outstanding, 0);
});

test("repeat disposals keep the totals honest AND are reported", () => {
  fresh();
  const resource = new FakeResource();
  trackResource(resource, {
    kind: "material",
    scope: "scenario",
    label: "health-bar",
    owner: "entity:133",
  });

  // Three.js dispatches on every dispose() call — verified in three.core.js,
  // where all four sites are a bare dispatchEvent with no guard.
  const warnings = captureWarnings(() => {
    resource.dispose();
    resource.dispose();
    resource.dispose();
  });

  const totals = resourceLifetimeSnapshot().byScope.get("scenario")!;
  // The totals stay truthful: one resource, one disposal. Counting the repeats
  // as disposals would drive `outstanding` negative — an accounting bug that
  // reads as an app bug.
  assert.equal(totals.disposed, 1);
  assert.equal(totals.outstanding, 0);
  assert.ok(totals.outstanding >= 0, "outstanding must never go negative");

  // …but the repeat is not swallowed. Two code paths both believing they own
  // this resource is the cleanup bug worth finding, and silence would hide it.
  assert.equal(totals.duplicateDisposals, 2);

  // Named once per resource, not once per call — a dispose inside a loop would
  // otherwise flood a capture. The id is enough to find it; the counter keeps
  // every occurrence.
  assert.equal(warnings.length, 1, warnings.join("\n"));
  assert.match(warnings[0], /\[DoubleDispose\]/);
  assert.match(warnings[0], /id=\d+/);
  assert.match(warnings[0], /kind=material/);
  assert.match(warnings[0], /label=health-bar/);
  assert.match(warnings[0], /owner=entity:133/);
});

test("a repeat dispose is a cleanup smell, not proof of a GPU double-free", () => {
  // Worth stating in a test because the counter name invites the stronger
  // reading. Three dispatches the event regardless of state, and disposing an
  // already-disposed resource is inert at the GL level — the renderer finds
  // nothing to release. So `dup` means "two owners", not "corruption", and a
  // non-zero value is a lead to follow rather than an incident.
  fresh();
  const resource = new FakeResource();
  trackResource(resource, { kind: "geometry", scope: "pool", label: "bolt" });
  captureWarnings(() => {
    resource.dispose();
    resource.dispose();
  });

  const totals = resourceLifetimeSnapshot().byScope.get("pool")!;
  assert.equal(totals.duplicateDisposals, 1);
  // Crucially it is NOT counted as a resource problem: `problems` is for
  // authoring errors the tracker is certain about, and this is not one.
  assert.deepEqual(resourceLifetimeProblems(), []);
});

test("the profile row shows dup= only when there is something to see", () => {
  fresh();
  const clean = new FakeResource();
  trackResource(clean, { kind: "geometry", scope: "pool", label: "ok" });
  clean.dispose();
  // A column of zeros on every row trains the eye to skip the one row where it
  // matters.
  assert.equal(resourceLifetimeLine().some((row) => row.includes("dup=")), false);

  const dirty = new FakeResource();
  trackResource(dirty, { kind: "geometry", scope: "pool", label: "twice" });
  captureWarnings(() => {
    dirty.dispose();
    dirty.dispose();
  });
  const pool = resourceLifetimeLine().find((row) => row.startsWith("AppRes pool"));
  assert.match(pool!, /dup=1/);
});

test("counters are separated by kind and by scope", () => {
  fresh();
  trackResource(new FakeResource(), { kind: "geometry", scope: "pool", label: "a" });
  trackResource(new FakeResource(), { kind: "material", scope: "pool", label: "b" });
  trackResource(new FakeResource(), { kind: "geometry", scope: "session", label: "c" });

  const snapshot = resourceLifetimeSnapshot();
  assert.equal(snapshot.byKindScope.get("geometry|pool")!.created, 1);
  assert.equal(snapshot.byKindScope.get("material|pool")!.created, 1);
  assert.equal(snapshot.byKindScope.get("geometry|session")!.created, 1);
  assert.equal(snapshot.byScope.get("pool")!.created, 2);
  assert.equal(snapshot.byScope.get("session")!.created, 1);
  assert.equal(snapshot.totalOutstanding, 3);
});

test("outstanding records carry id, label, owner, kind and scope", () => {
  fresh();
  trackResource(new FakeResource(), {
    kind: "material",
    scope: "scenario",
    label: "health-bar-fill",
    owner: "entity:133",
  });

  const [line] = resourceLifetimeDetails(["scenario"]);
  // This line is the whole payoff: a leak is found by its label and owner, not
  // by a count going up.
  assert.match(line, /id=\d+/);
  assert.match(line, /kind=material/);
  assert.match(line, /scope=scenario/);
  assert.match(line, /label=health-bar-fill/);
  assert.match(line, /owner=entity:133/);
});

test("details are capped, and say how many were omitted", () => {
  fresh();
  for (let i = 0; i < RESOURCE_DETAIL_CAP + 7; i += 1) {
    trackResource(new FakeResource(), {
      kind: "geometry",
      scope: "scenario",
      label: `leak-${i}`,
    });
  }

  const lines = resourceLifetimeDetails(["scenario"]);
  // One bad cycle must not flood a headset capture and push the rest out.
  assert.equal(lines.length, RESOURCE_DETAIL_CAP + 1);
  assert.match(lines[lines.length - 1], /and 7 more not shown/);
});

test("details only cover the scopes asked for", () => {
  fresh();
  trackResource(new FakeResource(), { kind: "geometry", scope: "scenario", label: "s" });
  trackResource(new FakeResource(), { kind: "geometry", scope: "pool", label: "p" });

  const lines = resourceLifetimeDetails(["scenario"]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /label=s/);
});

test("interval deltas measure one window, and the totals keep running", () => {
  fresh();
  const first = new FakeResource();
  trackResource(first, { kind: "geometry", scope: "pool", label: "a" });

  let totals = resourceLifetimeSnapshot().byScope.get("pool")!;
  assert.equal(totals.createdSinceInterval, 1);

  // A pure read must not move the window — otherwise reading twice gives
  // different answers with nothing to explain why.
  totals = resourceLifetimeSnapshot().byScope.get("pool")!;
  assert.equal(totals.createdSinceInterval, 1);

  beginResourceInterval();
  totals = resourceLifetimeSnapshot().byScope.get("pool")!;
  assert.equal(totals.createdSinceInterval, 0);
  assert.equal(totals.created, 1, "the running total must survive the window reset");

  first.dispose();
  totals = resourceLifetimeSnapshot().byScope.get("pool")!;
  assert.equal(totals.disposedSinceInterval, 1);
  assert.equal(totals.disposed, 1);
});

test("the profile row shows created/disposed/outstanding per scope", () => {
  fresh();
  const a = new FakeResource();
  trackResource(a, { kind: "geometry", scope: "pool", label: "a" });
  trackResource(new FakeResource(), { kind: "geometry", scope: "pool", label: "b" });
  a.dispose();

  const rows = resourceLifetimeLine();
  const pool = rows.find((row) => row.startsWith("AppRes pool"));
  assert.ok(pool, rows.join("\n"));
  assert.match(pool, /g 2\/1\/1/);
  // Scopes with nothing tracked are omitted, not printed as zeros — the rows
  // have to stay readable in a headset capture.
  assert.equal(rows.some((row) => row.includes("scenario")), false);
});

test("nothing here can keep a resource alive", () => {
  // The one property that makes a leak detector trustworthy: if it retained
  // what it measures, every reading would be self-fulfilling. Enforced by
  // reading the source, because a GC-based assertion cannot be made reliable.
  const module = readFileSync(
    new URL("../src/systems/resourceLifetime.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    module,
    /const registry = new WeakMap<TrackableResource, ResourceRecord>\(\)/,
    "the object may only be held weakly",
  );
  assert.match(
    module,
    /const outstanding = new Map<number, ResourceRecord>\(\)/,
    "the outstanding map must be keyed by id, never by the resource",
  );
  // A record holding the resource would put it back into the strong map.
  const record = module.slice(module.indexOf("interface ResourceRecord"));
  assert.doesNotMatch(
    record.slice(0, record.indexOf("}")),
    /TrackableResource/,
    "ResourceRecord must not reference the resource itself",
  );
});

test("tracking is a complete no-op when diagnostics are off", () => {
  // Not a runtime check: DIAGNOSTICS_ENABLED is fixed per build, so this reads
  // the guards. Every entry point must bail BEFORE any string work, listener
  // registration or map write — a disabled build must pay nothing at all.
  const module = readFileSync(
    new URL("../src/systems/resourceLifetime.ts", import.meta.url),
    "utf8",
  );

  for (const fn of [
    "export function trackResource",
    "export function beginResourceInterval",
    "export function resourceLifetimeLine",
    "export function resourceLifetimeDetails",
  ]) {
    const start = module.indexOf(fn);
    assert.ok(start > 0, `${fn} not found`);
    const body = module.slice(start, start + 400);
    assert.match(
      body,
      /if \(!DIAGNOSTICS_ENABLED[^)]*\) return/,
      `${fn} must bail out first when diagnostics are off`,
    );
  }
});

test("no app render target bypasses the tracker", () => {
  // Section C: render targets are the one kind with no current instances, so
  // the tracker's support for them is untested by real code. This is what makes
  // the FIRST one visible instead of silently invisible — a render target is
  // the most expensive thing on the list and the least likely to be noticed,
  // because `renderer.info.memory` does not break them out at all.
  const dir = new URL("../src/systems/", import.meta.url);
  const offenders: string[] = [];

  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts")) continue;
    const text = readFileSync(new URL(file, dir), "utf8");
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const match of code.matchAll(/new\s+(\w*RenderTarget)\s*\(/g)) {
      // Tracked at the construction site is the approved form.
      const after = code.slice(match.index ?? 0, (match.index ?? 0) + 600);
      if (/trackResource\(/.test(after)) continue;
      offenders.push(`${file}: ${match[1]}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "a render target was constructed without a nearby trackResource() call; " +
      "register it with kind \"render-target\" and an explicit scope",
  );
});

test("the render-target row says external targets are unavailable, not zero", () => {
  fresh();
  const line = renderTargetLine();
  // "0" would read as "none exist". The SDK, UIKit and the renderer's own
  // passes may hold several; the app simply cannot see them.
  assert.match(line, /rt\(app\) created=0 disposed=0 live=0/);
  assert.match(line, /rt\(external\)=unavailable/);

  const target = new FakeResource();
  trackResource(target, {
    kind: "render-target",
    scope: "session",
    label: "future-pass",
  });
  assert.match(renderTargetLine(), /rt\(app\) created=1 disposed=0 live=1/);
  target.dispose();
  assert.match(renderTargetLine(), /rt\(app\) created=1 disposed=1 live=0/);
});

/**
 * Files allowed to create GPU resources without registering them.
 *
 * **Empty, and it should stay that way.** Section D of the plan warned that its
 * inventory "must not become a stale allowlist"; this is the enforcement. It
 * was 16 files on 2026-09-03 and reached zero on 2026-09-04, so the guard below
 * is now an absolute rule rather than a shrinking exception list.
 *
 * Adding an entry here is a deliberate act that should be justified in review,
 * not a way to make a failing test pass.
 */
const UNINSTRUMENTED = new Set<string>([]);

function resourceConstructorFiles(): Map<string, number> {
  const dir = new URL("../src/systems/", import.meta.url);
  const found = new Map<string, number>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts")) continue;
    const text = readFileSync(new URL(file, dir), "utf8");
    const code = text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const ctors = code.match(
      /new\s+\w*(?:Geometry|Material|Texture|RenderTarget)\s*\(/g,
    );
    if (ctors) found.set(file, ctors.length);
  }
  return found;
}

test("a file that creates GPU resources either tracks them or is on the list", () => {
  const files = resourceConstructorFiles();
  assert.ok(files.size > 0, "the constructor scan found nothing — is it broken?");

  const untracked: string[] = [];
  for (const [file, count] of files) {
    const text = readFileSync(
      new URL(`../src/systems/${file}`, import.meta.url),
      "utf8",
    );
    // Either form counts: an explicit trackResource, or markOwnedResources with
    // metadata (which registers the mesh's geometry and material together).
    const instrumented =
      /trackResource\(/.test(text) ||
      /\btracked\(/.test(text) ||
      /markOwnedResources\([^)]*,\s*\{/.test(text);
    if (!instrumented) untracked.push(`${file} (${count} constructors)`);
  }

  const unexpected = untracked.filter(
    (entry) => !UNINSTRUMENTED.has(entry.split(" ")[0]),
  );
  assert.deepEqual(
    unexpected,
    [],
    "these files create GPU resources with no tracking and are not on the " +
      "known list — register them, or add them deliberately",
  );
});

/**
 * Every way this codebase produces a disposable GPU resource.
 *
 * `new XGeometry(...)` is the obvious one and was the only one checked until
 * the 2026-09-04 review: `meshMerge.ts` builds geometry with `mergeGeometries`
 * and `.clone()`, so a whole file's output sat outside the inventory. A scan
 * that only recognises constructors will keep missing utilities like it.
 */
const RESOURCE_SOURCE =
  /new\s+\w*(?:Geometry|Material|Texture|RenderTarget)\s*\(|mergeGeometries\s*\(|\.geometry\.clone\s*\(/g;

/**
 * Whether a construction site is registered, by structure rather than proximity.
 *
 * The first version of this checked only whether the *file* contained any
 * tracking call. A mutation removing one of `board.ts`'s fourteen
 * registrations passed it. The second version looked for a tracking call
 * within 900 characters; the same mutation passed that too, because the
 * material beside it was still wrapped.
 *
 * This one asks how the resource is actually reached, and it found **ten real
 * gaps** the other two hid — a texture registered but not its material, a
 * geometry but not the material beside it, in six different files.
 *
 * Three legitimate forms:
 *
 * 1. **Directly wrapped** — `bt(new X(...))`, `trackedRes(new X(...))`. Used
 *    where the resource is built inline as a constructor argument and cannot
 *    be named without restructuring the call.
 * 2. **Named and registered** — `const g = new X(...)` with a
 *    `trackResource(g, ...)` somewhere in the file. Member assignment counts,
 *    so a replaced `mesh.geometry` is covered.
 * 3. **Owned by a marked mesh** — built inline into a `new Mesh(...)` whose
 *    result goes to `markOwnedResources(mesh, { ... })`, which registers the
 *    mesh's geometry and material together.
 * 4. **Disposed locally** — an intermediate that never reaches the GPU, such as
 *    the clones `meshMerge.ts` feeds to `mergeGeometries`. Registering those
 *    would inflate every count with resources that hold no memory; disposing
 *    them is the correct handling, so a nearby `.dispose()` counts as covered.
 */
function trackingFormFor(code: string, at: number): string | null {
  const before = code.slice(Math.max(0, at - 70), at);
  // `tracked(...)` is the shared wrapper exported by `resourceLifetime`. The
  // `tracked[A-Z]` alternative covers the local `trackedFoo` helpers that
  // predated it; `\bbt` covered board.ts's. Both are gone, but a future file
  // may reasonably grow another special-case wrapper.
  if (/(?:\bbt|\btracked[A-Z]?\w*)\(\s*$/.test(before)) return "wrapped";

  const named = /(?:const|let)?\s*([A-Za-z_][\w.]*)\s*=\s*$/.exec(before);
  if (named) {
    // Scoped to what follows, NOT the whole file. Searching the file let any
    // `trackResource(material, ...)` anywhere satisfy every site that happened
    // to name its variable `material` — deleting one real registration from
    // `combatEffects.ts` produced zero offenders. Names like `material`,
    // `geometry` and `texture` repeat constantly, so file-wide matching is
    // close to no check at all.
    // 400, the tightest window with no false positive in the codebase. 1200
    // was wide enough for the flash loop's registration to vouch for the bolt
    // loop's, so deleting the bolt's went unnoticed.
    const scope = code.slice(at, at + 400);
    const escaped = named[1].replace(/\./g, "\\.");
    if (new RegExp(`trackResource\\(\\s*${escaped}\\b`).test(scope)) return "named";
  }

  const segment = code.slice(Math.max(0, at - 300), at + 900);
  if (/new Mesh\(/.test(segment) && /markOwnedResources\([^)]*,\s*\{/.test(segment)) {
    return "owned-mesh";
  }
  // A weaker claim than the others, and deliberately so: it says the resource
  // is released rather than accounted for. Only right for intermediates that
  // never render.
  //
  // It must name the collection, not merely find a `.dispose()` nearby. The
  // first version looked for any disposal within the window and promptly
  // vouched for `mergeGeometries(...)` — a KEPT resource — because the clone
  // cleanup loop sat a few lines below it.
  // `[\w.]*$` because the resource is usually reached through a chain:
  // `geometries.push(target.geometry.clone())`.
  const pushed = /([A-Za-z_]\w*)\.push\(\s*[\w.]*$/.exec(before);
  if (pushed) {
    const loop = new RegExp(
      `of\\s+${pushed[1]}\\b[\\s\\S]{0,80}?\\.dispose\\(\\)`,
    );
    if (loop.test(code)) return "disposed-locally";
  }
  return null;
}

test("every construction site is registered, by structure not proximity", () => {
  const dir = new URL("../src/systems/", import.meta.url);
  const offenders: string[] = [];
  let sites = 0;

  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts")) continue;
    const code = readFileSync(new URL(file, dir), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const match of code.matchAll(RESOURCE_SOURCE)) {
      sites += 1;
      if (trackingFormFor(code, match.index ?? 0) === null) {
        offenders.push(`${file}: ${match[0].trim()}`);
      }
    }
  }

  assert.ok(sites > 50, `only ${sites} construction sites found — is the scan broken?`);
  assert.deepEqual(
    offenders,
    [],
    "these constructors are not registered in any recognised form",
  );
});

test("the uninstrumented list cannot go stale", () => {
  // The half that keeps the list honest. Without it, instrumenting a file
  // leaves a permanent entry claiming work that is already done, and the list
  // stops describing anything.
  const files = resourceConstructorFiles();
  const stale: string[] = [];
  for (const file of UNINSTRUMENTED) {
    if (!files.has(file)) {
      stale.push(`${file} — no longer creates GPU resources`);
      continue;
    }
    const text = readFileSync(
      new URL(`../src/systems/${file}`, import.meta.url),
      "utf8",
    );
    if (
      /trackResource\(/.test(text) ||
      /\btracked\(/.test(text) ||
      /markOwnedResources\([^)]*,\s*\{/.test(text)
    ) {
      stale.push(`${file} — now instrumented`);
    }
  }
  assert.deepEqual(stale, [], "remove these from UNINSTRUMENTED");
});

test("the profile row shows this interval's churn, not just running totals", () => {
  // A running total cannot show rate: a scope creating and disposing forty
  // resources a second reads identically to one idle since boot. That is the
  // reason the interval counters exist — and they were tracked, aggregated and
  // reset for a day without ever being printed.
  fresh();
  const a = new FakeResource();
  trackResource(a, { kind: "geometry", scope: "pool", label: "a" });
  trackResource(new FakeResource(), { kind: "geometry", scope: "pool", label: "b" });
  a.dispose();

  const busy = resourceLifetimeLine().find((r) => r.startsWith("AppRes pool"));
  assert.match(busy, /\+2\/-1/, "two created and one disposed in this window");

  // After the window closes with nothing happening, the churn suffix is gone —
  // a `+0/-0` on every row would train the eye to skip the one that matters.
  beginResourceInterval();
  const idle = resourceLifetimeLine().find((r) => r.startsWith("AppRes pool"));
  assert.doesNotMatch(idle, /\+\d+\/-\d+/);
  // …while the running totals are untouched.
  assert.match(idle, /g 2\/1\/1/);
});
