import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { DEBUG_SETTINGS_CATALOG } from "../src/systems/debugSettingsCatalog.ts";
import { SETTINGS_PANEL_DROP } from "../src/systems/constants.ts";
import { ASTRONAUT_PRODUCTION_SPEC } from "../src/systems/craftCatalog.ts";
import { BUILDING_CATALOG } from "../src/systems/buildingCatalog.ts";
import {
  fitThumbnail,
  knownThumbnailSources,
} from "../src/systems/tabletThumbnails.ts";
import {
  TABLET_BUILD_THUMB_HEIGHT,
  TABLET_BUILD_THUMB_WIDTH,
  TABLET_CRAFT_THUMB_HEIGHT,
  TABLET_CRAFT_THUMB_WIDTH,
  TABLET_UNIT_THUMB_HEIGHT,
  TABLET_UNIT_THUMB_WIDTH,
} from "../src/systems/constants.ts";


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

test("build view exposes astronaut production and hides removed buildings", () => {
  const source = readFileSync(
    new URL("../ui/rts-tablet.uikitml", import.meta.url),
    "utf8",
  );
  assert.match(source, /id="build-astronaut"/);
  for (const kind of ["hangar", "factory", "relay", "shield", "lab"]) {
    assert.match(
      source,
      new RegExp(`id="build-${kind}"[^>]*style="display: none;"`),
    );
  }
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

test("settings controls live in their own document, not the tablet", () => {
  const settings = readFileSync(
    new URL("../ui/rts-settings.uikitml", import.meta.url),
    "utf8",
  );
  const tablet = readFileSync(
    new URL("../ui/rts-tablet.uikitml", import.meta.url),
    "utf8",
  );

  // Every control still exists — it just moved.
  assert.match(settings, /class="settings-columns"/);
  for (const { key } of DEBUG_SETTINGS_CATALOG) {
    assert.match(settings, new RegExp(`id="setting-${key}-minus"`));
    assert.match(settings, new RegExp(`id="setting-${key}-value"`));
    assert.match(settings, new RegExp(`id="setting-${key}-plus"`));
    // ...and must NOT come back to the tablet. PanelUISystem ticks every
    // configured panel each frame with no visibility check, so these rows cost
    // the same hidden in the tablet as they did on screen.
    assert.doesNotMatch(tablet, new RegExp(`id="setting-${key}-minus"`));
  }
  assert.doesNotMatch(tablet, /class="settings-columns"/);
});

test("the tablet document stays far smaller than it was", () => {
  const tablet = readFileSync(
    new URL("../ui/rts-tablet.uikitml", import.meta.url),
    "utf8",
  );
  // 328 elements before the split, 158 of them settings rows. This guards the
  // regression, not an exact number.
  const elements = tablet.match(/<[a-zA-Z]/g)?.length ?? 0;
  assert.ok(
    elements < 220,
    `tablet document has ${elements} elements; the settings split took it ` +
      `from 328 to ~174 and it should not creep back`,
  );
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

test("the settings panel is created from observed view state, not setView", () => {
  const tablet = readFileSync(
    new URL("../src/systems/tablet.ts", import.meta.url),
    "utf8",
  );
  const reset = readFileSync(
    new URL("../src/systems/scenarioReset.ts", import.meta.url),
    "utf8",
  );

  // scenarioReset writes the view directly, so hanging the panel's lifecycle
  // off setView() would leak it across a Restart taken from the Settings tab.
  assert.match(reset, /setValue\(TabletState, "view", "overview"\)/);
  assert.match(tablet, /this\.syncSettingsPanel\(view\);/);
  assert.doesNotMatch(
    tablet,
    /tablet\.setValue\(TabletState, "view", view\);\s*\n\s*this\.syncSettingsPanel/,
    "syncSettingsPanel must be driven from the observed view, not from setView",
  );

  // Destroyed with releaseEntity: Entity.dispose() traverse-frees the font
  // atlas and materials this panel shares with the tablet.
  assert.match(tablet, /releaseEntity\(panel\)/);
  assert.doesNotMatch(tablet, /panel\.dispose\(\)/);
});

test("the settings panel hangs off the tablet shell, not the board root", () => {
  const tablet = readFileSync(
    new URL("../src/systems/tablet.ts", import.meta.url),
    "utf8",
  );

  // The tablet is two levels: shell (carries the pose) -> screen (a small z
  // offset). Parenting the settings panel to the board root and copying the
  // SCREEN's transform put it at the board origin, under the command center,
  // which is why it looked like the tab did nothing.
  assert.match(tablet, /this\.tabletShellEntity = shell;/);
  assert.match(
    tablet,
    /const shell = this\.tabletShellEntity;[\s\S]{0,200}\{ parent: shell \}/,
    "the settings panel must be parented to the shell",
  );
  assert.doesNotMatch(
    tablet,
    /placeSettingsPanel[\s\S]{0,300}quaternion\.copy/,
    "the shell already supplies rotation; copying it double-applies the pose",
  );
});

test("the settings panel clears the tablet frame", () => {
  // Frame half-height 0.275 + settings panel half-height 0.18 = 0.455 is where
  // they touch. A smaller drop renders the panel inside the tablet.
  assert.ok(
    SETTINGS_PANEL_DROP > 0.455,
    `SETTINGS_PANEL_DROP is ${SETTINGS_PANEL_DROP}; anything <= 0.455 overlaps`,
  );
});

test("the settings document is tall enough for its rows", () => {
  const settings = readFileSync(
    new URL("../ui/rts-settings.uikitml", import.meta.url),
    "utf8",
  );

  // UIKit drops a child that does not fit instead of clipping it, silently.
  // The 244px column inherited from the tablet was 26px short of column 2's
  // ten rows, and the whole content vanished: 198 meshes built, 3 visible.
  const rows = (settings.match(/class="settings-row"/g) ?? []).length;
  const perColumn = Math.ceil(rows / 2);
  const needed = perColumn * 27; // 25px row + 2px margin
  const declared = Number(
    /\.settings-column \{[^}]*height: (\d+)px/.exec(settings)?.[1] ?? 0,
  );
  assert.ok(
    declared >= needed,
    `settings-column is ${declared}px but ${perColumn} rows need ${needed}px`,
  );
});

// ── Thumbnail letterboxing ─────────────────────────────────────────────────

test("every thumbnail fits inside its slot without distortion", () => {
  // UIKit's <img> defaults to keepAspectRatio:true, which overrides the CSS
  // height with width/aspect. astronautA.png (40x72) rendered 137px tall in a
  // 70px box and spilled out of its card. fitThumbnail computes both axes so
  // there is nothing left for keepAspectRatio to override.
  for (const src of knownThumbnailSources()) {
    for (const [w, h] of [
      [TABLET_UNIT_THUMB_WIDTH, TABLET_UNIT_THUMB_HEIGHT],
      [TABLET_CRAFT_THUMB_WIDTH, TABLET_CRAFT_THUMB_HEIGHT],
      [TABLET_BUILD_THUMB_WIDTH, TABLET_BUILD_THUMB_HEIGHT],
    ]) {
      const fit = fitThumbnail(src, w, h);
      assert.ok(fit.width <= w, `${src} is ${fit.width}px wide in a ${w}px box`);
      assert.ok(fit.height <= h, `${src} is ${fit.height}px tall in a ${h}px box`);
      // One axis must touch the bound, or the image is smaller than it needs to be.
      assert.ok(
        fit.width === w || fit.height === h,
        `${src} does not fill either axis of ${w}x${h}`,
      );
    }
  }
});

test("the astronaut specifically fits, since that is the reported bug", () => {
  const fit = fitThumbnail(
    "/images/astronautA.png",
    TABLET_UNIT_THUMB_WIDTH,
    TABLET_UNIT_THUMB_HEIGHT,
  );
  // 40x72 letterboxed into 76x70 -> height-bound, width follows.
  assert.equal(fit.height, TABLET_UNIT_THUMB_HEIGHT);
  assert.equal(fit.width, Math.round(TABLET_UNIT_THUMB_HEIGHT * (40 / 72)));
  assert.ok(fit.width < TABLET_UNIT_THUMB_WIDTH);
});

test("the intrinsic aspect table matches the real PNG headers", () => {
  // The table is hardcoded because the images are static build assets. This is
  // what stops it going stale: a re-export at a different size fails here.
  for (const src of knownThumbnailSources()) {
    const file = readFileSync(new URL(`../public${src}`, import.meta.url));
    // PNG IHDR: width and height are big-endian uint32 at byte offsets 16, 20.
    const width = file.readUInt32BE(16);
    const height = file.readUInt32BE(20);
    const fit = fitThumbnail(src, 1000, 1000);
    const declared = fit.width / fit.height;
    const actual = width / height;
    // RELATIVE tolerance. The aspects span 0.52 to 8.60, and fitThumbnail
    // rounds to whole pixels, so an absolute epsilon that suits 0.52 is far too
    // tight at 8.60 (rounding alone moves it 0.02 there).
    assert.ok(
      Math.abs(declared - actual) / actual < 0.01,
      `${src} is ${width}x${height} (${actual.toFixed(2)}) on disk but the ` +
        `table implies ${declared.toFixed(2)}`,
    );
  }
});

test("image classes declare no size — the fit is computed", () => {
  const tablet = readFileSync(
    new URL("../ui/rts-tablet.uikitml", import.meta.url),
    "utf8",
  );
  const box = (cls: string): [number, number] => {
    const rule = new RegExp(`\\.${cls} \\{[^}]*\\}`).exec(tablet)?.[0] ?? "";
    return [
      Number(/width: (\d+)px/.exec(rule)?.[1] ?? -1),
      Number(/height: (\d+)px/.exec(rule)?.[1] ?? -1),
    ];
  };
  // The classes must NOT declare a size. A box declared there can disagree
  // with the image's own aspect, which is the bug: UIKit derives one axis from
  // the picture and the taller sources overflow. Size comes from fitThumbnail.
  assert.deepEqual(box("unit-image"), [-1, -1]);
  assert.deepEqual(box("craft-image"), [-1, -1]);
  assert.deepEqual(box("card-image"), [-1, -1]);
});

test("every image the tablet can show is sized from code", () => {
  const tablet = readFileSync(
    new URL("../ui/rts-tablet.uikitml", import.meta.url),
    "utf8",
  );
  // An <img> with no id cannot be reached by setProps, so it would keep the
  // unsized class and fall back to UIKit's aspect-derived height. This is what
  // the Build tab was doing — its four cards are static markup.
  // Strip /* */ comments first — the explanatory notes in the stylesheet
  // mention "<img>" and would otherwise be matched as markup.
  const markup = tablet.replace(/\/\*[\s\S]*?\*\//g, "");
  const images = markup.match(/<img[^>]*>/g) ?? [];
  for (const img of images) {
    assert.match(
      img,
      /id="/,
      `image without an id cannot be sized from code: ${img.slice(0, 90)}`,
    );
  }
});

// The MSDF font atlases bundled with @pmndrs/msdfonts (inter, firaCode,
// inconsolata, crimsonText — all four carry the same set) cover printable ASCII
// 32-126 plus exactly nine Latin-1 codepoints. Anything else has no glyph and
// renders as nothing at all: silent, and invisible until someone puts a headset
// on. Canvas-drawn text (the tutorial card, the queue badges, the command
// center HUD) uses system fonts and is NOT subject to this — only .uikitml is.
const UIKIT_EXTRA_GLYPHS = [167, 176, 196, 214, 220, 223, 228, 246, 252];

function renderableInUikit(codePoint: number): boolean {
  if (codePoint >= 32 && codePoint <= 126) return true;
  return UIKIT_EXTRA_GLYPHS.includes(codePoint);
}

/** Text the panel actually paints: no <style> block, no HTML comments. */
function renderedText(markup: string): string[] {
  const body = markup
    .replace(/<style>[\s\S]*?<\/style>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  return [...body.matchAll(/>([^<>]+)</g)]
    .map((m) => m[1].trim())
    .filter((t) => t.length > 0);
}

test("every character the panels render has a glyph in the font", () => {
  // The regression this guards, 2026-09-03: an em-dash was used as the "no
  // value yet" placeholder in 28 spans across both documents. U+2014 is not in
  // the atlas — max codepoint there is 252 — so every one of those would have
  // rendered blank on the headset while looking correct in the source.
  for (const file of ["rts-tablet", "rts-settings", "match-result", "command-center-alert"]) {
    const markup = readFileSync(
      new URL(`../ui/${file}.uikitml`, import.meta.url),
      "utf8",
    );
    const texts = renderedText(markup);
    assert.ok(
      texts.length > 0,
      `${file}.uikitml yielded no rendered text — the extractor is broken`,
    );
    const offenders: string[] = [];
    for (const text of texts) {
      for (const ch of text) {
        const cp = ch.codePointAt(0)!;
        if (!renderableInUikit(cp)) {
          offenders.push(
            `U+${cp.toString(16).toUpperCase().padStart(4, "0")} in ${JSON.stringify(text.slice(0, 40))}`,
          );
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `${file}.uikitml renders characters the MSDF atlas has no glyph for`,
    );
  }
});

test("no card in the markup hardcodes a price", () => {
  const tablet = readFileSync(
    new URL("../ui/rts-tablet.uikitml", import.meta.url),
    "utf8",
  );

  // The regression this guards, found 2026-09-03: the Build tab advertised a
  // 30-crystal turret for weeks after the catalog repriced it to 80. The cost
  // span had no `id`, so no code could write it even in principle — the number
  // was frozen in the markup. The Craft tab was right the whole time because
  // it writes `craft-cost-N` from the catalog.
  const priced = [...tablet.matchAll(/>(\s*\d+)\s+crystals</g)].map((m) =>
    m[1].trim(),
  );
  assert.deepEqual(
    priced,
    [],
    `markup states ${priced.length} literal price(s) (${priced.join(", ")}); ` +
      "costs must come from the catalog at runtime, not from the markup",
  );
});

test("the settings panel states no stat value of its own", () => {
  const settings = readFileSync(
    new URL("../ui/rts-settings.uikitml", import.meta.url),
    "utf8",
  );

  // Every one of these is written from DEBUG_SETTINGS_CATALOG at render time,
  // so a number in the markup is a copy that nothing keeps true. Two of them
  // (astronautAttackRange, craftFighterAttackRange) still read 0.29 on
  // 2026-09-03, months after the ranges moved — harmless only because the
  // write happens quickly. A placeholder must not be mistakable for a value.
  const rows = [
    ...settings.matchAll(
      /id="setting-([A-Za-z]+)-value" class="settings-value">([^<]*)</g,
    ),
  ];
  assert.ok(
    rows.length >= DEBUG_SETTINGS_CATALOG.length,
    `matched ${rows.length} value spans but the catalog has ${DEBUG_SETTINGS_CATALOG.length}`,
  );
  const stated = rows.filter(([, , text]) => /\d/.test(text));

  assert.deepEqual(
    stated.map(([, key, text]) => `${key}=${text}`),
    [],
    "settings markup states values that DEBUG_SETTINGS_CATALOG owns",
  );
});

test("no card in the markup states a stat", () => {
  const tablet = readFileSync(
    new URL("../ui/rts-tablet.uikitml", import.meta.url),
    "utf8",
  );

  // Build time, attack power and health are catalog values, exactly like cost.
  // These spans held `Build: 0s  Attack: 0  Hp: 0` until 2026-09-03 — harmless
  // zeros, but a placeholder shaped like a real stat line is how a stale one
  // hides. `refreshBuildStats` and the craft loop write every one of them, so
  // the markup never needs a number here.
  const all = [
    ...tablet.matchAll(
      /id="(?:build|craft)-stats-[a-z0-9-]+" class="card-stats">([^<]*)</g,
    ),
  ]
    .map((m) => m[1]);

  // Floor first: an id rename would otherwise leave this matching nothing and
  // passing for the wrong reason.
  assert.ok(
    all.length >= 8,
    `expected at least 8 stat spans, matched ${all.length} — has an id changed?`,
  );
  assert.deepEqual(
    all.filter((text) => /\d/.test(text)),
    [],
    "stat spans state numbers; build time, attack and health come from the catalogs",
  );
});

test("every cost span has an id, and code writes all of them", () => {
  const tablet = readFileSync(
    new URL("../ui/rts-tablet.uikitml", import.meta.url),
    "utf8",
  );
  const source = readFileSync(
    new URL("../src/systems/tablet.ts", import.meta.url),
    "utf8",
  );

  // An id is what makes a value writable at all. Without one the markup is the
  // only source and it cannot be kept true.
  const costSpans = [...tablet.matchAll(/<span([^>]*class="(?:card|craft)-cost")/g)];
  assert.ok(costSpans.length > 0, "no cost spans found in the markup");
  for (const [, attrs] of costSpans) {
    assert.match(
      attrs,
      /id="[a-z0-9-]+"/,
      `a cost span has no id, so nothing can write its price: <span${attrs}`,
    );
  }

  // …and an id nothing writes is just as stale. Both families must be written
  // through a template literal in the tablet system.
  for (const family of ["build-cost-", "craft-cost-"]) {
    assert.ok(
      tablet.includes(`id="${family}`),
      `markup has no ${family}* span`,
    );
    assert.ok(
      source.includes(`\`${family}\${`),
      `${family}* exists in the markup but tablet.ts never writes it`,
    );
  }
});

test("every build-image id in the markup is sized by code", () => {
  const tablet = readFileSync(
    new URL("../ui/rts-tablet.uikitml", import.meta.url),
    "utf8",
  );

  // The regression this guards: the astronaut is NOT in BUILDING_CATALOG, so a
  // sizing loop over that catalog skipped it. With no size in .card-image it
  // rendered at zero and disappeared from the Build tab entirely.
  const inMarkup = [...tablet.matchAll(/id="build-image-([a-z]+)"/g)].map(
    (m) => m[1],
  );
  assert.ok(inMarkup.length > 0, "no build-image ids found");

  const sized = new Set([
    ...BUILDING_CATALOG.map((spec) => spec.kind),
    ASTRONAUT_PRODUCTION_SPEC.kind,
  ]);
  for (const kind of inMarkup) {
    assert.ok(
      sized.has(kind),
      `build-image-${kind} exists in the markup but no catalog entry sizes it`,
    );
  }
  assert.ok(
    inMarkup.includes("astronaut"),
    "the astronaut card is the one that regressed; keep it covered",
  );
});
