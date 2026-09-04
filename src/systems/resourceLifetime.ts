import { DIAGNOSTICS_ENABLED } from "./traceFlags.ts";

/**
 * Development-only lifetime accounting for app-created GPU resources.
 *
 * Design: `RTSVR_repos/devlog/plan/Game_balancing/2026-09-03-Resource-Disposal-Tracking-Plan.md`.
 *
 * ## The gap this fills
 *
 * `renderer.info.memory` reports current geometry and texture totals and
 * nothing else. Create five and dispose five and it does not move — so it
 * cannot distinguish "balanced churn" from "nothing happened", and it cannot
 * say *which* resource leaked or who owned it. It also mixes SDK, UIKit and
 * AssetManager resources with ours, so a rising number is not even evidence the
 * app is at fault.
 *
 * This records what app code creates, with a label and an owner, and counts
 * what is actually disposed.
 *
 * ## Why the `dispose` event, and not a constructor patch
 *
 * Three.js's `BufferGeometry`, `Material`, `Texture` and `RenderTarget` all
 * dispatch a `dispose` event. Patching their constructors or prototypes instead
 * would capture every SDK and renderer resource as though the app owned it,
 * which is precisely the confusion this module exists to remove — and it would
 * couple us to Three.js internals that change between releases.
 *
 * **The event is dispatched unconditionally on every `dispose()` call** —
 * verified in `three.core.js`, where all four sites are a bare
 * `this.dispatchEvent( { type: 'dispose' } )` with no guard. A repeat therefore
 * fires again, and {@link trackResource} must not count it as a second
 * disposal.
 *
 * It must not *ignore* it either. The repeat is counted as
 * `duplicateDisposals` and named once per resource:
 *
 * ```
 * [DoubleDispose] id=42 kind=material scope=scenario label=health-bar owner=entity:133
 * ```
 *
 * **Read that as a cleanup smell, not corruption.** Disposing an
 * already-disposed resource is inert at the GL level — the renderer finds
 * nothing to release — so this detects *repeated calls*, not a harmful
 * double-free. What it proves is that two code paths both believe they own the
 * resource's lifetime, which is how a real leak or a premature disposal gets
 * authored later. It is a lead to follow, not an incident.
 *
 * ## Diagnostics must not keep resources alive
 *
 * A leak detector that retains what it measures reports itself. The object
 * appears only as a {@link WeakMap} key; the outstanding map is keyed by a
 * number and holds metadata alone. Nothing here can prevent a resource from
 * being collected.
 */

export type ResourceKind = "geometry" | "material" | "texture" | "render-target";

/**
 * How long a resource is meant to live, which decides what "correct" means.
 *
 * The split matters because a non-zero count is not automatically a leak:
 *
 * - `scenario` and `temporary` must reach **zero** — they belong to one unit,
 *   building, site, ring, panel or piece of in-flight work, all of which end.
 * - `pool` and `session` must **plateau** — reusable capacity and app
 *   singletons legitimately survive a reset. Growth on every identical cycle is
 *   the warning, not the count itself.
 *
 * `external` is deliberately absent: AssetManager, UIKit and SDK resources are
 * not ours to register or dispose, and classifying them here would invite
 * someone to dispose them. They are observed through renderer totals instead.
 */
export type ResourceScope = "scenario" | "pool" | "session" | "temporary";

export interface ResourceMetadata {
  kind: ResourceKind;
  scope: ResourceScope;
  /** What this is, e.g. `health-bar-fill`. Shown in outstanding reports. */
  label: string;
  /** Who owns it, e.g. `entity:133`. Optional, but the fastest way to a fix. */
  owner?: string;
}

interface ResourceRecord extends ResourceMetadata {
  /** Stable for the session, so a record can be followed across log lines. */
  id: number;
  disposed: boolean;
  /** Latches the one-per-resource `[DoubleDispose]` line. */
  duplicateReported?: boolean;
}

/**
 * Minimal shape of a Three.js disposable. Declared structurally so this module
 * imports nothing from Three or the SDK and stays unit-testable with a plain
 * object that has `addEventListener`.
 */
export interface TrackableResource {
  /**
   * Declared as a METHOD, not a property, on purpose.
   *
   * Three.js types `addEventListener` generically over each class's event map
   * (`type: T extends Extract<keyof TEventMap, string>`), so a property
   * declaration — checked contravariantly under `strictFunctionTypes` — rejects
   * every real geometry, material and texture. Method syntax is bivariant,
   * which is the looseness needed to accept them all without a cast at each of
   * ~30 call sites.
   *
   * `"dispose"` rather than `string` because the generic constraint means a
   * wider parameter can never match, and this module listens for nothing else.
   * The listener takes no arguments because the event payload is unused — and a
   * zero-argument function is what makes Three's typed listener assignable.
   */
  addEventListener?(type: "dispose", listener: () => void): void;
}

interface Counters {
  created: number;
  disposed: number;
  createdSinceInterval: number;
  disposedSinceInterval: number;
  /**
   * `dispose()` calls beyond the first for one resource.
   *
   * Kept apart from `disposed` on purpose: the totals must stay truthful (one
   * resource, one disposal) while the repeat is still reported. Folding it into
   * `disposed` would make `outstanding` negative and turn a cleanup smell into
   * an apparent accounting bug.
   *
   * **This is not proof of a harmful double-free.** Three.js dispatches the
   * event on every call regardless of state, and disposing an
   * already-disposed resource is inert at the GL level — the renderer simply
   * finds nothing to release. What it does prove is that two code paths both
   * believe they own this resource's lifetime, which is how a *real* leak or
   * premature disposal gets authored later.
   */
  duplicateDisposals: number;
}

const KINDS: readonly ResourceKind[] = [
  "geometry",
  "material",
  "texture",
  "render-target",
];
const SCOPES: readonly ResourceScope[] = [
  "scenario",
  "pool",
  "session",
  "temporary",
];

/** Object -> record. Weak, so tracking never keeps a resource alive. */
const registry = new WeakMap<TrackableResource, ResourceRecord>();

/**
 * id -> record for everything created and not yet disposed.
 *
 * **Metadata only.** Putting the resource in here would make the tracker the
 * reason it is still alive, and every reading would be self-fulfilling.
 */
const outstanding = new Map<number, ResourceRecord>();

const counters = new Map<string, Counters>();
const problems: string[] = [];
let nextId = 1;

function key(kind: ResourceKind, scope: ResourceScope): string {
  return `${kind}|${scope}`;
}

function countersFor(kind: ResourceKind, scope: ResourceScope): Counters {
  const k = key(kind, scope);
  let c = counters.get(k);
  if (!c) {
    c = {
      created: 0,
      disposed: 0,
      createdSinceInterval: 0,
      disposedSinceInterval: 0,
      duplicateDisposals: 0,
    };
    counters.set(k, c);
  }
  return c;
}

function reportProblem(message: string): void {
  problems.push(message);
  // `console.error` deliberately, not the gated action log: a metadata conflict
  // means two owners disagree about who disposes this, which is how a
  // double-free or a leak is authored.
  console.error(`[ResourceLifetime] ${message}`);
}

/**
 * Register one app-created resource.
 *
 * **Idempotent for the same object.** Re-registering with identical metadata is
 * a no-op rather than a second `created`, because pooled builders legitimately
 * re-run over resources they already own.
 *
 * Registering the *same object* with *different* metadata is a genuine
 * authoring error — two owners believe they control one resource's lifetime —
 * and is reported rather than silently overwritten.
 *
 * A complete no-op when diagnostics are off: no listener, no record, no string
 * work. The label is passed as a plain string the caller already has, so
 * nothing is formatted at the call site either.
 */
export function trackResource(
  resource: TrackableResource | null | undefined,
  metadata: ResourceMetadata,
): void {
  if (!DIAGNOSTICS_ENABLED || !resource) return;

  const existing = registry.get(resource);
  if (existing) {
    if (
      existing.kind !== metadata.kind ||
      existing.scope !== metadata.scope ||
      existing.label !== metadata.label ||
      existing.owner !== metadata.owner
    ) {
      reportProblem(
        `conflicting metadata for id=${existing.id}: ` +
          `have ${existing.kind}/${existing.scope}/${existing.label}` +
          `${existing.owner ? `/${existing.owner}` : ""}, ` +
          `got ${metadata.kind}/${metadata.scope}/${metadata.label}` +
          `${metadata.owner ? `/${metadata.owner}` : ""}`,
      );
    }
    return;
  }

  const record: ResourceRecord = {
    id: nextId,
    kind: metadata.kind,
    scope: metadata.scope,
    label: metadata.label,
    owner: metadata.owner,
    disposed: false,
  };
  nextId += 1;
  registry.set(resource, record);
  outstanding.set(record.id, record);

  const c = countersFor(record.kind, record.scope);
  c.created += 1;
  c.createdSinceInterval += 1;

  // The listener closes over the record, not the resource, so the resource is
  // referenced only by whatever legitimately owns it.
  resource.addEventListener?.("dispose", () => {
    // Three dispatches on EVERY dispose() call, so this fires again on a repeat.
    // Counting it as a second disposal would report more disposals than
    // creations and drive `outstanding` negative — an accounting bug that reads
    // as an app bug. But swallowing it silently throws away a real signal, so it
    // is counted separately and named once.
    if (record.disposed) {
      const repeat = countersFor(record.kind, record.scope);
      repeat.duplicateDisposals += 1;
      // Named once per resource, not once per call: a dispose inside a loop
      // would otherwise flood the capture, and the id below is enough to find
      // it. The counter keeps every occurrence.
      if (!record.duplicateReported) {
        record.duplicateReported = true;
        console.warn(
          `[DoubleDispose] id=${record.id} kind=${record.kind} ` +
            `scope=${record.scope} label=${record.label}` +
            `${record.owner ? ` owner=${record.owner}` : ""}` +
            ` — dispose() called again; two owners believe they own this`,
        );
      }
      return;
    }
    record.disposed = true;
    outstanding.delete(record.id);
    const counts = countersFor(record.kind, record.scope);
    counts.disposed += 1;
    counts.disposedSinceInterval += 1;
  });
}

/**
 * Register a resource and return it, for use inline as a constructor argument.
 *
 * Most resources are built inside a `new Mesh(geometry, material)` call and
 * cannot be named without restructuring it. Wrapping is the alternative, and
 * before this existed each file grew its own copy of the wrapper — ten of them,
 * seven byte-identical, plus three near-duplicates with the scope or kind baked
 * in. One shared helper is the same code with one place to change it.
 */
export function tracked<T extends object>(
  resource: T,
  kind: ResourceKind,
  scope: ResourceScope,
  label: string,
  owner?: string,
): T {
  trackResource(resource, { kind, scope, label, owner });
  return resource;
}

export interface ResourceScopeTotals {
  created: number;
  disposed: number;
  outstanding: number;
  createdSinceInterval: number;
  disposedSinceInterval: number;
  /** Repeat `dispose()` calls. See {@link Counters.duplicateDisposals}. */
  duplicateDisposals: number;
}

export interface ResourceLifetimeSnapshot {
  /** Keyed `"<kind>|<scope>"`; only pairs that have ever been used appear. */
  byKindScope: Map<string, ResourceScopeTotals>;
  byScope: Map<ResourceScope, ResourceScopeTotals>;
  totalOutstanding: number;
  /** Authoring errors seen so far — metadata conflicts. Empty is the goal. */
  problems: readonly string[];
}

function emptyTotals(): ResourceScopeTotals {
  return {
    created: 0,
    disposed: 0,
    outstanding: 0,
    createdSinceInterval: 0,
    disposedSinceInterval: 0,
    duplicateDisposals: 0,
  };
}

function add(into: ResourceScopeTotals, c: Counters): void {
  into.created += c.created;
  into.disposed += c.disposed;
  into.outstanding += c.created - c.disposed;
  into.createdSinceInterval += c.createdSinceInterval;
  into.disposedSinceInterval += c.disposedSinceInterval;
  into.duplicateDisposals += c.duplicateDisposals;
}

/**
 * Read the current picture. Pure — it does not reset interval deltas.
 *
 * The reset is {@link beginResourceInterval}, kept separate because a getter
 * with a side effect means whoever reads twice gets different answers and
 * cannot tell why.
 */
export function resourceLifetimeSnapshot(): ResourceLifetimeSnapshot {
  const byKindScope = new Map<string, ResourceScopeTotals>();
  const byScope = new Map<ResourceScope, ResourceScopeTotals>();
  let totalOutstanding = 0;

  for (const [k, c] of counters) {
    const totals = emptyTotals();
    add(totals, c);
    byKindScope.set(k, totals);
    totalOutstanding += totals.outstanding;

    const scope = k.split("|")[1] as ResourceScope;
    let scopeTotals = byScope.get(scope);
    if (!scopeTotals) {
      scopeTotals = emptyTotals();
      byScope.set(scope, scopeTotals);
    }
    add(scopeTotals, c);
  }

  return { byKindScope, byScope, totalOutstanding, problems: [...problems] };
}

/** Start a new delta window. Called once per profile flush. */
export function beginResourceInterval(): void {
  if (!DIAGNOSTICS_ENABLED) return;
  for (const c of counters.values()) {
    c.createdSinceInterval = 0;
    c.disposedSinceInterval = 0;
  }
}

/** Short kind tags, so one scope fits on one profile row. */
const KIND_TAG: Readonly<Record<ResourceKind, string>> = {
  geometry: "g",
  material: "m",
  texture: "t",
  "render-target": "rt",
};

/**
 * One row per scope that has any resources, for the periodic profile.
 *
 * Each triplet is `created/disposed/outstanding`. Scopes with nothing tracked
 * are omitted rather than printed as zeros, so the rows stay short enough to
 * read in a headset capture.
 */
export function resourceLifetimeLine(): string[] {
  if (!DIAGNOSTICS_ENABLED) return [];
  const snapshot = resourceLifetimeSnapshot();
  const rows: string[] = [];
  for (const scope of SCOPES) {
    const totals = snapshot.byScope.get(scope);
    if (!totals || totals.created === 0) continue;
    const parts = KINDS.map((kind) => {
      const c = snapshot.byKindScope.get(key(kind, scope));
      const created = c?.created ?? 0;
      const disposed = c?.disposed ?? 0;
      return `${KIND_TAG[kind]} ${created}/${disposed}/${created - disposed}`;
    });
    // `dup=` only when non-zero: a column of zeros on every row would train
    // the eye to skip the one row where it matters.
    const dup = totals.duplicateDisposals;
    // Churn in THIS interval, shown only when something moved.
    //
    // The triplets above are running totals, and a running total cannot show
    // rate: a scope that creates and disposes forty resources a second looks
    // identical to one that has been idle since boot. That difference is the
    // whole reason `createdSinceInterval` is tracked — and until 2026-09-04 it
    // was tracked, aggregated and reset without ever being printed, which is
    // the same defect `renderTargetLine()` had.
    const made = totals.createdSinceInterval;
    const gone = totals.disposedSinceInterval;
    const churn = made > 0 || gone > 0 ? ` +${made}/-${gone}` : "";
    rows.push(
      `AppRes ${scope} ${parts.join(" ")}${churn}${dup > 0 ? ` dup=${dup}` : ""}`,
    );
  }
  return rows;
}

/**
 * Render targets, always reported, and honest about what is not visible.
 *
 * There are no app-created `WebGLRenderTarget`s in `src/` today, so this reads
 * zero — but a bare `rt 0/0/0` invites the conclusion "no render targets
 * exist", when the SDK, UIKit and the renderer's own passes may hold several.
 * The app simply cannot see them: they are never registered here, and
 * `renderer.info` does not break them out.
 *
 * `unavailable` says that, where `0` would quietly lie. A future app-created
 * target becomes visible the moment it is tracked.
 */
export function renderTargetLine(): string {
  if (!DIAGNOSTICS_ENABLED) return "";
  const snapshot = resourceLifetimeSnapshot();
  let created = 0;
  let disposed = 0;
  for (const scope of SCOPES) {
    const c = snapshot.byKindScope.get(key("render-target", scope));
    created += c?.created ?? 0;
    disposed += c?.disposed ?? 0;
  }
  return (
    `rt(app) created=${created} disposed=${disposed} live=${created - disposed}` +
    ` | rt(external)=unavailable`
  );
}

/** Detail lines are capped so one bad cycle cannot flood a capture. */
export const RESOURCE_DETAIL_CAP = 50;

/**
 * Bounded per-record detail for scopes that should be empty.
 *
 * Printed only at a reset or a manual dump — a leak is identified by its label
 * and owner, and neither is useful once a second.
 */
export function resourceLifetimeDetails(
  scopes: readonly ResourceScope[],
): string[] {
  if (!DIAGNOSTICS_ENABLED) return [];
  const wanted = new Set(scopes);
  const lines: string[] = [];
  let omitted = 0;
  for (const record of outstanding.values()) {
    if (!wanted.has(record.scope)) continue;
    if (lines.length >= RESOURCE_DETAIL_CAP) {
      omitted += 1;
      continue;
    }
    lines.push(
      `[ResourceOutstanding] id=${record.id} kind=${record.kind} ` +
        `scope=${record.scope} label=${record.label}` +
        `${record.owner ? ` owner=${record.owner}` : ""}`,
    );
  }
  if (omitted > 0) {
    lines.push(`[ResourceOutstanding] ...and ${omitted} more not shown`);
  }
  return lines;
}

/** Authoring errors seen so far. Tests assert this is empty. */
export function resourceLifetimeProblems(): readonly string[] {
  return problems;
}

/** Test-only reset. Never called by the app; module state is session-long. */
export function resetResourceLifetimeForTest(): void {
  counters.clear();
  outstanding.clear();
  problems.length = 0;
  nextId = 1;
}
