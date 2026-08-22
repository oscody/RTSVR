import { createSystem, type Material, type Mesh, type Object3D } from "@iwsdk/core";

/**
 * Diagnostic for Phase 2a step 1: find out WHY three.js re-derives the shader
 * program on most draw calls.
 *
 * Measured on Quest 2026-08-22: program selection costs 7.3 µs per draw call at
 * 60-119 calls and **17.5 µs at 360-419**, where the frame rate falls to 32. In
 * `three.cjs:76743` `getProgram()` runs only when `needsProgramChange` is true,
 * so a healthy scene pays this once per material and never again. Something is
 * making it fire continuously, and roughly twenty branches could be responsible.
 *
 * Rather than patching `node_modules`, this reads `renderer.properties`, which
 * three.js exposes (`three.cjs:74968`).
 *
 * **The detection trick.** Most of those branches compare a value cached on the
 * material against a value derived from the *object being drawn*. So a single
 * material shared by two objects that disagree on any one of them re-derives on
 * every switch between them, forever. Catching that flip mid-frame would need
 * per-draw instrumentation; instead this groups visible meshes by material and
 * looks for a material whose users do not all agree. That is snapshot-safe and
 * names both the material and the field.
 *
 * Two things it cannot see, because they are renderer-frame state rather than
 * per-object state: `lightsStateVersion` and `envMap`/`outputColorSpace`. Those
 * fall into the `unexplained` bucket, which is itself the answer if it dominates.
 */
const PROGRAM_CHURN_ENABLED = true;

/** Seconds between samples. The walk is O(scene), so not every frame. */
const SAMPLE_INTERVAL = 5;

/** Report at most this many offending materials, worst first. */
const REPORT_LIMIT = 4;

/**
 * The per-object half of `needsProgramChange`, in `setProgram`'s own order
 * (`three.cjs:76755` onward). Every entry here is exactly computable from the
 * object and its geometry, which is what makes disagreement detectable.
 */
function objectSignature(mesh: Mesh, material: Material): string {
  const geometry = mesh.geometry;
  const object = mesh as unknown as Record<string, boolean>;
  const attributes = geometry.attributes as Record<string, { itemSize?: number } | undefined>;
  const morph = geometry.morphAttributes ?? {};
  const morphAttribute = morph.position ?? morph.normal ?? morph.color;
  const mat = material as unknown as Record<string, unknown>;
  return [
    object.isSkinnedMesh ? "skin" : "-",
    object.isInstancedMesh ? "inst" : "-",
    object.isBatchedMesh ? "batch" : "-",
    morph.position ? "mT" : "-",
    morph.normal ? "mN" : "-",
    morph.color ? "mC" : "-",
    `mCount${morphAttribute ? morphAttribute.length : 0}`,
    mat.vertexColors === true && attributes.color?.itemSize === 4 ? "vAlpha" : "-",
    attributes.tangent && (mat.normalMap || (mat.anisotropy as number) > 0) ? "vTan" : "-",
  ].join("|");
}

/** Which field differs between two signatures — the thing to actually fix. */
const FIELD_NAMES = [
  "skinning", "instancing", "batching", "morphTargets", "morphNormals",
  "morphColors", "morphTargetsCount", "vertexAlphas", "vertexTangents",
];
function differingFields(signatures: Iterable<string>): string[] {
  const columns = [...signatures].map((s) => s.split("|"));
  const out: string[] = [];
  for (let i = 0; i < FIELD_NAMES.length; i += 1) {
    if (new Set(columns.map((c) => c[i])).size > 1) out.push(FIELD_NAMES[i]);
  }
  return out;
}

interface Offender {
  label: string;
  users: number;
  variants: number;
  fields: string[];
}

/**
 * Exact re-derivation counter.
 *
 * The first version of this probe diffed the cached per-material state between
 * samples. That cannot work, and it produced a false all-clear: after a
 * re-derivation three.js writes the *current* value into the cache
 * (`three.cjs:76614` onward), so consecutive samples always agree even when the
 * value flips on every draw. `lightsStateVersion` is the one exception, being a
 * monotonic counter — and reading it off a single witness material is a false
 * negative whenever that material happens to be unlit.
 *
 * This replaces the diff with a direct count. `getProgram` ends with
 * `materialProperties.currentProgram = program` (`three.cjs:76644`), and that
 * line runs on every re-derivation and nowhere else. Installing an accessor over
 * that one property counts them exactly, per material, with no guessing about
 * which branch fired.
 */
interface Instrumented {
  currentProgram?: unknown;
  __churnCount?: number;
  __churnInstalled?: boolean;
  /** Fields seen to differ between consecutive re-derivations — the answer. */
  __churnFields?: Set<string>;
  __churnPrev?: Record<string, unknown>;
}

/**
 * Everything `getProgram` refreshes on the record. By the time `currentProgram`
 * is assigned (`three.cjs:76644`, the last write) these all hold the values the
 * new program was built from, so comparing consecutive re-derivations of the
 * same material names the branch that fired — no inference, no replication of
 * three.js's own computation.
 */
const WATCHED = [
  "envMap", "fog", "numClippingPlanes", "numIntersection", "vertexAlphas",
  "vertexTangents", "morphTargets", "morphNormals", "morphColors",
  "morphTargetsCount", "toneMapping", "numMultiviewViews", "outputColorSpace",
  "lightsStateVersion", "skinning", "instancing", "batching", "__version",
] as const;

/** Put a counting accessor over `currentProgram`, preserving its value. */
function instrument(record: Instrumented): void {
  if (record.__churnInstalled) return;
  let backing = record.currentProgram;
  Object.defineProperty(record, "__churnCount", { value: 0, writable: true, enumerable: false });
  Object.defineProperty(record, "__churnFields", { value: new Set<string>(), writable: true, enumerable: false });
  Object.defineProperty(record, "__churnPrev", { value: undefined, writable: true, enumerable: false });
  Object.defineProperty(record, "__churnInstalled", { value: true, writable: false, enumerable: false });
  Object.defineProperty(record, "currentProgram", {
    configurable: true,
    enumerable: true,
    get: () => backing,
    set: (v) => {
      backing = v;
      record.__churnCount = (record.__churnCount ?? 0) + 1;
      const snapshot: Record<string, unknown> = {};
      for (const key of WATCHED) snapshot[key] = (record as Record<string, unknown>)[key];
      const prev = record.__churnPrev;
      if (prev) {
        for (const key of WATCHED) {
          if (prev[key] !== snapshot[key]) record.__churnFields?.add(key);
        }
      }
      record.__churnPrev = snapshot;
    },
  });
}

/**
 * The field probe answered `__version`: something calls
 * `material.needsUpdate = true` on the VFX materials every frame, and it is
 * nothing in `src/` (the only six call sites are one-shot). This traps the
 * caller directly: a per-instance `needsUpdate` setter that records one stack
 * trace, then keeps counting. Installed on at most a handful of churning
 * materials, so the Error construction happens once per material, not per frame.
 */
const stackByMaterial = new Map<string, string>();
function trapVersionBumps(material: Material, label: string): void {
  const m = material as Material & { __bumpTrapped?: boolean; version: number };
  if (m.__bumpTrapped) return;
  m.__bumpTrapped = true;
  Object.defineProperty(m, "needsUpdate", {
    configurable: true,
    set(value: boolean) {
      if (value === true) {
        m.version += 1;
        if (!stackByMaterial.has(label)) {
          const stack = (new Error().stack ?? "").split("\n").slice(2, 7).join("\n");
          stackByMaterial.set(label, stack);
          console.log(`[ProgramChurn] needsUpdate caller for ${label}:\n${stack}`);
        }
      }
    },
  });
}

export class ProgramChurnSystem extends createSystem({}) {
  private nextSample = 2;
  /** Renders per frame. Two would re-derive every material twice over. */
  private renderCalls = 0;
  private frames = 0;
  private wrapped = false;

  /**
   * Count `renderer.render` calls. If the scene is drawn more than once per
   * frame — a desktop mirror beside the headset view, say — the two passes can
   * disagree on colour space or multiview, and then every material re-derives on
   * every pass no matter how well the rest of the scene behaves.
   */
  private wrapRenderer(renderer: { render?: unknown }): void {
    if (this.wrapped || typeof renderer.render !== "function") return;
    this.wrapped = true;
    const original = (renderer.render as (...a: unknown[]) => unknown).bind(renderer);
    (renderer as { render: unknown }).render = (...args: unknown[]) => {
      this.renderCalls += 1;
      return original(...args);
    };
  }

  update(delta: number): void {
    if (!PROGRAM_CHURN_ENABLED) return;
    this.frames += 1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (this.world as any)?.renderer;
    if (r) this.wrapRenderer(r);
    this.nextSample -= delta;
    if (this.nextSample > 0) return;
    this.nextSample = SAMPLE_INTERVAL;
    this.sample();
  }

  private sample(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const world = this.world as any;
    const renderer = world?.renderer;
    const scene = world?.scene;
    if (!renderer?.properties || !scene) return;

    // material -> signatures of the objects drawing with it, and a user count.
    const byMaterial = new Map<Material, { sigs: Set<string>; users: number; name: string }>();
    let visibleMeshes = 0;
    let staleVersion = 0; // material.version moved: someone set needsUpdate
    const staleNames = new Set<string>();

    scene.traverse((node: Object3D) => {
      if (!node.visible) return;
      const mesh = node as Mesh;
      if (!mesh.isMesh || !mesh.material || Array.isArray(mesh.material)) return;
      visibleMeshes += 1;
      const material = mesh.material as Material;
      let entry = byMaterial.get(material);
      if (!entry) {
        entry = { sigs: new Set(), users: 0, name: material.name || material.type };
        byMaterial.set(material, entry);
      }
      entry.sigs.add(objectSignature(mesh, material));
      entry.users += 1;

      const cached = renderer.properties.get(material) as { __version?: number } | undefined;
      if (cached && cached.__version !== undefined && cached.__version !== material.version) {
        staleVersion += 1;
        staleNames.add(entry.name);
      }
    });

    const offenders: Offender[] = [];
    let churningDraws = 0;
    for (const entry of byMaterial.values()) {
      if (entry.sigs.size < 2) continue;
      churningDraws += entry.users;
      offenders.push({
        label: entry.name,
        users: entry.users,
        variants: entry.sigs.size,
        fields: differingFields(entry.sigs),
      });
    }
    offenders.sort((a, b) => b.users - a.users);

    // Re-derivations since the last sample, counted exactly.
    let churnTotal = 0;
    const worst: Array<[string, number]> = [];
    for (const [material, entry] of byMaterial) {
      const record = renderer.properties.get(material) as Instrumented | undefined;
      if (!record) continue;
      if (!record.__churnInstalled) {
        instrument(record);
        continue; // first sighting: no count yet
      }
      const n = record.__churnCount ?? 0;
      record.__churnCount = 0;
      churnTotal += n;
      if (n > 0) {
        const fields = [...(record.__churnFields ?? [])];
        record.__churnFields?.clear();
        if (fields.includes("__version")) trapVersionBumps(material, entry.name);
        worst.push([`${entry.name} [${fields.join(",") || "SAME VALUES — cause is outside the record"}]`, n]);
      }
    }
    worst.sort((x, y) => y[1] - x[1]);
    const framesSince = Math.max(1, this.frames);
    const perFrame = churnTotal / framesSince;
    const rendersPerFrame = this.renderCalls / framesSince;

    // Lights are gathered from the scene each frame, so a light toggling
    // `visible` changes the count exactly as adding one would.
    let lights = 0;
    let visibleLights = 0;
    scene.traverse((n: Object3D) => {
      if (!(n as { isLight?: boolean }).isLight) return;
      lights += 1;
      if (n.visible) visibleLights += 1;
    });
    this.renderCalls = 0;
    this.frames = 0;

    const parts = [
      `visibleMeshes ${visibleMeshes}`,
      `materials ${byMaterial.size}`,
      `mixedMaterials ${offenders.length}`,
      `drawsAffected ${churningDraws}`,
      `versionBumped ${staleVersion}`,
      `lights ${visibleLights}/${lights}`,
      `rendersPerFrame ${rendersPerFrame.toFixed(2)}`,
      `REDERIVES ${churnTotal} in ${framesSince}f = ${perFrame.toFixed(1)}/frame`,
      `materialsChurning ${worst.length}`,
    ];
    // If nothing above explains it, the cause is renderer-frame state — a
    // changing light count, envMap, or colour space — and that is the finding.
    if (offenders.length === 0 && staleVersion === 0 && churnTotal > 0) {
      // Every per-object cause is ruled out, so the reason is renderer-frame
      // state. Which materials churn narrows it: all of them points at colour
      // space or multiview, only the lit ones at the light hash, only the
      // MeshStandard ones at envMap.
      parts.push(`=> renderer-frame cause; churning ${worst.length}/${byMaterial.size} materials`);
    }
    let line = `[ProgramChurn] ${parts.join(" | ")}`;
    for (const [matName, n] of worst.slice(0, REPORT_LIMIT)) {
      line += `\n  rederives ${(n / framesSince).toFixed(1)}/frame: ${matName}`;
    }
    for (const o of offenders.slice(0, REPORT_LIMIT)) {
      line += `\n  ${o.label}: ${o.users} draws, ${o.variants} variants, differs on ${o.fields.join(",") || "(unknown)"}`;
    }
    if (staleNames.size > 0) {
      line += `\n  version-bumped: ${[...staleNames].slice(0, 6).join(", ")}`;
    }
    console.log(line);
  }
}
