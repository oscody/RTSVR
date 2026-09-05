/**
 * Letterbox a tablet thumbnail inside its card slot.
 *
 * ## Why this exists
 *
 * UIKit's `<img>` defaults to **`keepAspectRatio: true`**
 * (`@pmndrs/uikit/dist/components/image.js:22`), and when it is on the image's
 * own shape wins over the CSS `height`. So `.unit-image { width: 76px; height:
 * 70px }` actually means "76px wide, and however tall the picture's shape makes
 * it" — the declared height is silently ignored.
 *
 * That is invisible while every source image is roughly the same shape, and
 * obvious the moment one is not. `astronautA.png` is 40x72 (aspect 0.56), so at
 * a fixed 76px width it renders **137px tall in a 70px box** and spills out of
 * its card. The unit thumbnails span aspects 0.56 to 3.98:
 *
 * | image | intrinsic | aspect | height at width 76 |
 * | --- | --- | ---: | ---: |
 * | `astronautA` | 40x72 | 0.56 | **137px** |
 * | `turret_single` | 73x82 | 0.89 | 85px |
 * | `rover` | 37x35 | 1.06 | 72px |
 * | `craft_fighter` | 176x68 | 2.59 | 29px |
 * | `craft_miner` | 255x64 | 3.98 | 19px |
 *
 * ## Why the size is computed here rather than left to CSS
 *
 * No single fixed box works: sizing by width overflows the tall images, sizing
 * by height makes `craft_miner` 279px wide, and shrinking the width until the
 * astronaut fits leaves the miner 10px tall. `maxWidth`/`maxHeight` exist in
 * UIKit's flex schema but Yoga's aspect-ratio-plus-max-constraint behaviour is
 * not a dependable letterbox.
 *
 * UIKit also has no `objectFit: contain` — only `cover` (crops) and `fill`
 * (stretches), and neither is acceptable for a unit thumbnail: cover would cut
 * the astronaut's head and feet.
 *
 * So the fit is arithmetic instead. Both axes are returned definite and
 * consistent with the source aspect, which leaves nothing for `keepAspectRatio`
 * to override — no crop, no distortion, and every thumbnail bounded by its slot.
 */
import { assetKey } from "../app/assetUrl.ts";


/**
 * Intrinsic pixel dimensions, read from the PNG headers.
 *
 * Hardcoded on purpose: the images are static build assets, and the alternative
 * is decoding them at runtime purely to learn a number that cannot change
 * without someone editing the file. **If an image is re-exported at a different
 * size, update it here** — `tests/tablet-ui.test.ts` verifies every entry
 * against the real file, so a stale number fails the suite rather than shipping.
 */
const INTRINSIC_ASPECT: Readonly<Record<string, number>> = {
  "/images/alien.png": 40 / 77,
  "/images/astronautA.png": 40 / 72,
  "/images/astronautB.png": 40 / 72,
  "/images/craft_miner.png": 255 / 64,
  "/images/craft_racer.png": 176 / 68,
  "/images/hangar_largeA.png": 329 / 91,
  "/images/kenney_style_aircraft_factory_preview.png": 1500 / 1125,
  "/images/meteor.png": 79 / 67,
  "/images/meteor_detailed.png": 79 / 67,
  "/images/meteor_half.png": 79 / 33,
  "/images/rock.png": 90 / 27,
  "/images/rock_crystals.png": 79 / 31,
  "/images/rock_crystalsLargeA.png": 76 / 49,
  "/images/rock_crystalsLargeB.png": 84 / 50,
  "/images/rock_largeA.png": 89 / 46,
  "/images/rock_largeB.png": 92 / 46,
  "/images/rocks_smallA.png": 86 / 10,
  "/images/rocks_smallB.png": 75 / 17,
  "/images/rover.png": 37 / 35,
  "/images/terrain_side.png": 128 / 46,
  "/images/turret_single.png": 73 / 82,
};

export interface ThumbnailSize {
  width: number;
  height: number;
}

/**
 * The largest undistorted size for `src` that fits inside `boxWidth` x
 * `boxHeight`, rounded to whole pixels.
 *
 * An unknown `src` falls back to the full box. That is the pre-existing
 * behaviour, so a newly added image is never worse than it is today — it just
 * does not gain the fit until it is listed above.
 */
export function fitThumbnail(
  src: string,
  boxWidth: number,
  boxHeight: number,
): ThumbnailSize {
  // `src` arrives as a fetchable URL — `./images/x.png` on a subpath deploy —
  // but the table is keyed on the filesystem path, because its test reads
  // `public/<key>` off disk to check the aspects against the real PNG headers.
  // Without this every lookup would miss on a deployed build and every
  // thumbnail would quietly fall back to a square box: a visual regression
  // with no error attached to it.
  const aspect = INTRINSIC_ASPECT[assetKey(src)];
  if (!aspect || !Number.isFinite(aspect)) {
    return { width: boxWidth, height: boxHeight };
  }
  return aspect > boxWidth / boxHeight
    ? { width: boxWidth, height: Math.round(boxWidth / aspect) }
    : { width: Math.round(boxHeight * aspect), height: boxHeight };
}

/** Every image the fit table knows, for the test that keeps it honest. */
export function knownThumbnailSources(): readonly string[] {
  return Object.keys(INTRINSIC_ASPECT);
}
