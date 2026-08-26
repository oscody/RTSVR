import { VisibilityState, launchXR, type World } from "@iwsdk/core";
import { initialLoad } from "./initialLoad.js";
import { matchAwaitingStart, startMatch } from "../systems/matchStart.js";

/**
 * The landing chrome — the player's way in.
 *
 * ## Why it is DOM rather than an in-world panel
 *
 * A spatial panel floating over an empty board is the first thing a player
 * sees and reads as debug UI, and more practically: `launchXR` needs a real
 * user-activation gesture, which a raycast at a UIKit quad is not.
 *
 * ## Capability detection
 *
 * **`world.xrEnabled` does not exist in IWSDK 0.4.2.** The connect-island donor
 * uses it, but nothing in the shipped `.d.ts` declares it — only the internal
 * `renderer.xr.enabled`. So this asks WebXR directly with
 * `navigator.xr.isSessionSupported("immersive-vr")`, which is the standard
 * check and does not depend on an SDK version.
 *
 * Both a headset and a plain desktop browser get a way in. A VR-only landing
 * page would turn a working flat build into an apparent dead end, and RTSVR is
 * playable flat.
 */

let landing: HTMLElement | null = null;
let xrSupported = false;
let loaded = false;
let immersive = false;

/**
 * Show the chrome only when all three are true.
 *
 * The third condition is the one the plan did not list and the game needs:
 * **the match has not begun**. Without it the buttons stay on screen over a
 * running game, and the player can press START again on a match already in
 * progress.
 */
function applyLandingChrome(): void {
  if (!landing) return;
  const show = loaded && !immersive && matchAwaitingStart();
  landing.classList.toggle("visible", show);
}

export function setupLanding(world: World): void {
  landing = document.getElementById("landing");
  if (!landing) return;
  const enterButton = document.getElementById("enter-vr-button");
  const exploreButton = document.getElementById("explore-button");
  const note = document.getElementById("xr-note");

  // ENTER VR: request the session and **do not touch the gate**.
  //
  // Releasing it here was a bug, and a subtle one. `launchXR` is asynchronous,
  // so for the frames between the click and the session opening the app is
  // `playing` *and still non-immersive* — which is precisely the signature of a
  // desktop start. `TutorialSystem` reads exactly that
  // (`isTutorialEnabled() && matchAwaitingStart()`), concluded the player had
  // chosen desktop, and **retired the tutorial before the headset was even in
  // the session**. Measured: XR opened at t+10.8 s and wave 0 went active at
  // t+11.8 s with no tutorial, where entering by the browser's own pill runs it.
  //
  // `attachMatchStart` already releases the gate from the visibility change, so
  // every route in — this button, the browser pill, a headset-native entry —
  // starts the match at the same moment: when the session actually opens.
  enterButton?.addEventListener("click", () => {
    launchXR(world);
  });

  // Explore in browser: the desktop player's start. RTSVR plays flat, and
  // without this a machine with no headset has no way to begin at all.
  exploreButton?.addEventListener("click", () => {
    startMatch();
    applyLandingChrome();
  });

  void navigator.xr
    ?.isSessionSupported("immersive-vr")
    .then((supported) => {
      xrSupported = supported;
    })
    .catch(() => {
      xrSupported = false;
    })
    .finally(() => {
      // Same rule as the loading tracker: decide on every path. A rejected
      // capability probe must still produce a usable landing page rather than
      // leaving both buttons hidden.
      enterButton?.toggleAttribute("hidden", !xrSupported);
      note?.toggleAttribute("hidden", xrSupported);
    });

  world.visibilityState.subscribe((state) => {
    immersive = state !== VisibilityState.NonImmersive;
    // Entering XR by any route — including the browser's own Enter XR pill —
    // starts the match, so the chrome must re-evaluate rather than linger.
    applyLandingChrome();
  });

  void initialLoad.whenDone.then(() => {
    loaded = true;
    applyLandingChrome();
  });
}
