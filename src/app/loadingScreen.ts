import { initialLoad } from "./initialLoad.js";

/**
 * Drives the HTML loading overlay from {@link initialLoad}, then fades it away.
 *
 * The markup lives in `index.html` so it paints before this module executes —
 * see the comment there for why that ordering is the whole point.
 */

let screenElement: HTMLElement | null = null;
let statusElement: HTMLElement | null = null;
let failed = false;

/** Remove the overlay once, from whichever path gets there first. */
function dismiss(screen: HTMLElement): void {
  screen.remove();
  screenElement = null;
  statusElement = null;
}

export function setupLoadingScreen(): void {
  const screen = document.getElementById("loading-screen");
  const fill = document.getElementById("loading-bar-fill");
  if (!screen || !fill) return;
  screenElement = screen;
  statusElement = document.getElementById("loading-status");

  // Indeterminate until something real is reported. Phase 2 swaps this for a
  // percentage by giving the tracker tasks that can actually report partials.
  fill.classList.add("indeterminate");

  const unsubscribe = initialLoad.subscribe((progress) => {
    if (progress <= 0) return;
    fill.classList.remove("indeterminate");
    fill.style.width = `${(progress * 100).toFixed(1)}%`;
  });

  void initialLoad.whenDone.then(() => {
    unsubscribe();
    // A failed boot has already rewritten the overlay to explain itself. Leave
    // it up: dismissing would hand the player a black scene and no reason.
    if (failed) return;
    fill.classList.remove("indeterminate");
    fill.style.width = "100%";

    // Wait for a frame to actually draw before fading.
    //
    // `World.create()` resolving is not the same as "visible": three.js defers
    // every GL upload to the first draw that touches it, so the whole scene's
    // geometry, textures and programs land in one frame just after this — with
    // the main thread blocked while they do. Revealing on the resolve alone
    // shows the player a blank scene across that stall.
    requestAnimationFrame(() => {
      screen.classList.add("done");
      // The fade is an `opacity` transition so the compositor can play it
      // through that same stall.
      screen.addEventListener("transitionend", () => dismiss(screen), {
        once: true,
      });
      // Transitions do not run in hidden tabs. Without this, a player who tabs
      // away during load returns to a permanently opaque overlay.
      window.setTimeout(() => dismiss(screen), 1000);
    });
  });
}

/**
 * Rewrite the overlay to say why it is still here.
 *
 * Complements the `finally` discipline in {@link initialLoad} rather than
 * duplicating it: the `finally` guarantees the overlay **leaves** when an asset
 * fails, this guarantees it **explains itself** when the boot itself dies. A
 * bare spinner forever is the one outcome neither should allow.
 */
export function showLoadingFailure(message: string): void {
  failed = true;
  const status = statusElement ?? document.getElementById("loading-status");
  const fill = document.getElementById("loading-bar-fill");
  fill?.classList.remove("indeterminate");
  if (fill) fill.style.width = "100%";
  if (status) status.textContent = message;
  screenElement?.classList.remove("done");
}
