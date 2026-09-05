import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import test from "node:test";

import { assetKey, assetUrl } from "../src/app/assetUrl.ts";

const ROOT = new URL("../", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, ROOT), "utf8");

/** Every .ts under src/, recursively. */
function sourceFiles(dir = "src"): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(new URL(`${dir}/`, ROOT))) {
    const path = `${dir}/${entry}`;
    if (statSync(new URL(path, ROOT)).isDirectory()) out.push(...sourceFiles(path));
    else if (entry.endsWith(".ts")) out.push(path);
  }
  return out;
}

const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// Directories under `public/` that are fetched at runtime by URL.
const PUBLIC_DIRS = "gltf|audio|textures|ui|images";
const ABSOLUTE = new RegExp(`"/(${PUBLIC_DIRS})/[^"]*"`, "g");

// ── The regression guard ───────────────────────────────────────────────────

test("no source file asks for an asset by root-absolute path", () => {
  // THE failure this file exists for. GitHub Pages serves a project site from
  // `/RTSVR/`, and Vite rewrites only the URLs it emits itself — never a
  // string literal in the code. Measured before the fix by serving the real
  // `dist/` under a `/RTSVR/` prefix: the page and bundle returned 200 while
  // every `/gltf/...` and `/images/...` returned 404. The game loaded to a
  // blank room.
  //
  // It is invisible in dev, where the base is `/` and the literals are already
  // correct, so nothing short of an assertion catches a new one.
  const offenders: string[] = [];
  for (const path of sourceFiles()) {
    // The helper's own doc comment quotes these paths; the table below keys on
    // them deliberately.
    if (path === "src/app/assetUrl.ts" || path === "src/systems/tabletThumbnails.ts") {
      continue;
    }
    for (const match of stripComments(read(path)).matchAll(ABSOLUTE)) {
      // Wrapped is the whole point: `assetUrl("/gltf/x.glb")` is correct.
      const before = stripComments(read(path)).slice(0, match.index ?? 0);
      if (before.endsWith("assetUrl(")) continue;
      offenders.push(`${path}: ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, [], `wrap these in assetUrl(): ${offenders.join(", ")}`);
});

test("no UIKitML document asks for an image by root-absolute path", () => {
  // Same failure, different file type. UIKit hands `src` to a bare three.js
  // TextureLoader with no `path` set, so the browser resolves it against the
  // document — which makes `./images/x.png` right at any base and
  // `/images/x.png` wrong at every base but the root.
  const offenders: string[] = [];
  for (const file of readdirSync(new URL("ui/", ROOT))) {
    if (!file.endsWith(".uikitml")) continue;
    const markup = read(`ui/${file}`).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of markup.matchAll(/(?:src|href)="(\/[^"]*)"/g)) {
      offenders.push(`ui/${file}: ${match[1]}`);
    }
  }
  assert.deepEqual(offenders, [], `make these relative: ${offenders.join(", ")}`);
});

// ── The helper ─────────────────────────────────────────────────────────────

test("under node the helper is a no-op, so every other test sees today's strings", () => {
  // There is no `import.meta.env` in the test runner. If the fallback ever
  // stopped being "/", ~90 catalog values would shift under every suite at
  // once and the failures would point everywhere except here.
  assert.equal(assetUrl("/gltf/x.glb"), "/gltf/x.glb");
  assert.equal(assetUrl("gltf/x.glb"), "/gltf/x.glb", "a missing leading slash is added");
});

test("assetKey inverts assetUrl", () => {
  // `tabletThumbnails` depends on this: it is handed a fetchable URL and has
  // to recover the filesystem path its table is keyed on.
  for (const path of ["/images/turret_single.png", "/gltf/alien.glb", "/audio/sfx-click.wav"]) {
    assert.equal(assetKey(assetUrl(path)), path);
  }
});

test("the helper reads the base from Vite and never hardcodes one", () => {
  // A hardcoded "/RTSVR/" would work on exactly one URL and break the dev
  // server, the emulator, and any move to a custom domain.
  const helper = stripComments(read("src/app/assetUrl.ts"));
  assert.match(helper, /import\.meta[\s\S]*?BASE_URL/);
  assert.ok(!/RTSVR/.test(helper), "the deploy base must not be hardcoded");
});

// ── The consumers that would fail silently ─────────────────────────────────

test("the thumbnail table stays keyed on filesystem paths", () => {
  // Its own test reads `public/<key>` off disk to check each aspect against
  // the real PNG header, so a key must remain a path, not a URL.
  const table = read("src/systems/tabletThumbnails.ts");
  assert.match(table, /"\/images\/[a-zA-Z_]+\.png": /, "keys must keep their leading slash");
  assert.ok(
    !/"\.\/images\//.test(table),
    "keys must not be relative — the disk read would break",
  );
});

test("fitThumbnail normalizes its input before the lookup", () => {
  // Without this every lookup misses on a deployed build and every thumbnail
  // falls back to a square box: a visual regression with no error attached.
  const code = stripComments(read("src/systems/tabletThumbnails.ts"));
  assert.match(code, /INTRINSIC_ASPECT\[assetKey\(src\)\]/);
});

test("the Build tab takes its image src from the catalog, not the markup", () => {
  // The last four static-markup images. Everything else on the tablet already
  // sets `src` in code, which is what makes it survive a subpath deploy.
  const tablet = read("src/systems/tablet.ts");
  const fn = tablet.slice(tablet.indexOf("private sizeBuildThumbnails"));
  const body = fn.slice(0, fn.indexOf("\n  }"));
  assert.match(body, /src: image,/, "the src must come from the catalog entry");
});

// ── Deploy configuration ───────────────────────────────────────────────────

test("vite keeps a relative base, so one build serves from any path", () => {
  // `base: "./"` is what makes `assetUrl` produce document-relative URLs.
  // The Meta guide suggests `base: '/<repo>/'`, which pins the build to one
  // URL; every deployed example in vr_examples uses "./" instead.
  assert.match(read("vite.config.ts"), /base: *"\.\/"/);
});

test("the deploy workflow watches the branch this repo actually uses", () => {
  // The guide's workflow triggers on `main`. This repository's default branch
  // is `master`, so that version would never have run.
  const workflow = read(".github/workflows/deploy.yml");
  assert.match(workflow, /branches: \["master"\]/);
  assert.match(workflow, /node-version-file: "\.nvmrc"/, "CI and local must agree on Node");
  assert.match(workflow, /run: npm test/, "Pages serves whatever is uploaded; gate it");
});
