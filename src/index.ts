import {
  AssetManager,
  AssetManifest,
  AssetType,
  SessionMode,
  World,
} from "@iwsdk/core";
import { BoardSystem } from "./systems/board.js";
import { ConstructionSystem } from "./systems/construction.js";
import { CombatSystem } from "./systems/combat.js";
import { CombatEffectsSystem } from "./systems/combatEffects.js";
import { CommandCenterHudSystem } from "./systems/commandCenterHud.js";
import {
  installFrameProfiler,
  isFrameProfilerEnabled,
} from "./systems/frameProfiler.js";
import { installTransparentPassProbe } from "./systems/transparentPassProbe.js";
import { AlienAnimationSystem } from "./systems/alienAnimation.js";
import { CommandCenterAnimationSystem } from "./systems/commandCenterAnimation.js";
import { CraftProductionSystem } from "./systems/craftProduction.js";
import { CraftVisualRiseSystem } from "./systems/craftVisualRise.js";
import { InteractionSystem } from "./systems/interaction.js";
import { MeteorSystem } from "./systems/meteorSystem.js";
import { MiningSystem } from "./systems/mining.js";
import { MatchResultSystem } from "./systems/matchResult.js";
import { optimizeLoadedAssets } from "./systems/meshMerge.js";
import { MovementSystem } from "./systems/movement.js";
import { MinerAnimationSystem } from "./systems/minerAnimation.js";
import { PerformanceSystem } from "./systems/performance.js";
import { ScenarioResetSystem } from "./systems/scenarioReset.js";
import { SkySystem } from "./systems/skySystem.js";
import { StructuresSystem } from "./systems/structures.js";
import { TabletSystem } from "./systems/tablet.js";
import { TurretAnimationSystem } from "./systems/turretAnimation.js";
import { TutorialSystem } from "./systems/tutorial.js";
import { UnderAttackAlertSystem } from "./systems/underAttackAlert.js";
import { UnderAttackAudioSystem } from "./systems/underAttackAudio.js";
import { UnderAttackBannerSystem } from "./systems/underAttackBanner.js";
import { UnderAttackVfxSystem } from "./systems/underAttackVfx.js";
import { UnitAnimationSystem } from "./systems/unitAnimation.js";
import { attachAudioUnlock } from "./systems/audioUnlock.js";
import { attachGpuWarmup, GpuWarmupSystem } from "./systems/gpuWarmup.js";
import { ProgramChurnSystem } from "./systems/programChurn.js";
import { attachAssetLoadProgress, initialLoad } from "./app/initialLoad.js";
import { setupLanding } from "./app/landing.js";
import { ActionKind, logAction } from "./systems/actionLog.js";
import {
  DIAGNOSTICS_ENABLED,
  anyTraceEnabled,
} from "./systems/traceFlags.js";
import { TUTORIAL_ENABLED } from "./systems/tutorialCatalog.js";
import { setupLoadingScreen, showLoadingFailure } from "./app/loadingScreen.js";
import { attachMatchStart } from "./systems/matchStart.js";
import { placeViewpoint } from "./systems/viewpoint.js";
import { TraceDiagnosticsSystem } from "./systems/traceDiagnosticsSystem.js";
import { SfxSystem } from "./systems/sfx.js";
import { WaveSystem } from "./systems/wave.js";
import { assetUrl } from "./app/assetUrl.ts";

const assets: AssetManifest = {
  commandCenter: {
    url: assetUrl("/gltf/command_center.glb"),
    type: AssetType.GLTF,
    priority: "critical",
  },
  aircraft_factory: {
    url: assetUrl("/gltf/kenney_style_aircraft_factory.glb"),
    type: AssetType.GLTF,
    priority: "critical",
  },
  hangarLargeA: {
    url: assetUrl("/gltf/kenney-space-kit/hangar_largeA.glb"),
    type: AssetType.GLTF,
    priority: "critical",
  },
  rock: {
    url: assetUrl("/gltf/terrain/rock.glb"),
    type: AssetType.GLTF,
    priority: "critical",
  },
  rockCrystals: {
    url: assetUrl("/gltf/terrain/rock_crystals.glb"),
    type: AssetType.GLTF,
    priority: "critical",
  },
  rockCrystalsLargeA: {
    url: assetUrl("/gltf/terrain/rock_crystalsLargeA.glb"),
    type: AssetType.GLTF,
    priority: "critical",
  },
  rockCrystalsLargeB: {
    url: assetUrl("/gltf/terrain/rock_crystalsLargeB.glb"),
    type: AssetType.GLTF,
    priority: "critical",
  },
  rockLargeA: {
    url: assetUrl("/gltf/terrain/rock_largeA.glb"),
    type: AssetType.GLTF,
    priority: "critical",
  },
  rockLargeB: {
    url: assetUrl("/gltf/terrain/rock_largeB.glb"),
    type: AssetType.GLTF,
    priority: "critical",
  },
  rocksSmallA: {
    url: assetUrl("/gltf/terrain/rocks_smallA.glb"),
    type: AssetType.GLTF,
    priority: "critical",
  },
  rocksSmallB: {
    url: assetUrl("/gltf/terrain/rocks_smallB.glb"),
    type: AssetType.GLTF,
    priority: "critical",
  },
  astronautA: {
    url: assetUrl("/gltf/astronautA.glb"),
    type: AssetType.GLTF,
    priority: "critical",
  },
  astronautAAnimated: {
    url: assetUrl("/gltf/astronautA_A.glb"),
    type: AssetType.GLTF,
    priority: "critical",
  },
  astronautB: {
    url: assetUrl("/gltf/astronautB.glb"),
    type: AssetType.GLTF,
    priority: "critical",
  },
  alien: { url: assetUrl("/gltf/alien.glb"), type: AssetType.GLTF, priority: "critical" },
  alienWalkingSlam: {
    url: assetUrl("/gltf/alien_walking_slam_no_fx.glb"),
    type: AssetType.GLTF,
    priority: "critical",
  },
  alienDrakeFlyingAttack: {
    url: assetUrl("/gltf/alien_drake.glb"),
    type: AssetType.GLTF,
    priority: "critical",
  },
  strongAlienMech: {
    url: assetUrl("/gltf/alien_strong.glb"),
    type: AssetType.GLTF,
    priority: "critical",
  },
  craftMinerAnimated: {
    url: assetUrl("/gltf/craft/craft_miner_A.glb"),
    type: AssetType.GLTF,
    priority: "critical",
  },
  craftMiner: {
    url: assetUrl("/gltf/craft/craft_miner.glb"),
    type: AssetType.GLTF,
    priority: "critical",
  },
  craftFighter: {
    url: assetUrl("/gltf/craft/craft_racerA.glb"),
    type: AssetType.GLTF,
    priority: "critical",
  },
  rover: {
    url: assetUrl("/gltf/craft/rover.glb"),
    type: AssetType.GLTF,
    priority: "critical",
  },
  turretSingle: {
    url: assetUrl("/gltf/equipment/turret_single.glb"),
    type: AssetType.GLTF,
    priority: "critical",
  },
  meteor: {
    url: assetUrl("/gltf/terrain/meteor/meteor.glb"),
    type: AssetType.GLTF,
    priority: "critical",
  },
  meteorDetailed: {
    url: assetUrl("/gltf/terrain/meteor/meteor_detailed.glb"),
    type: AssetType.GLTF,
    priority: "critical",
  },
  meteorHalf: {
    url: assetUrl("/gltf/terrain/meteor/meteor_half.glb"),
    type: AssetType.GLTF,
    priority: "critical",
  },
  // Under-attack alerting. AudioSource.src repeats these URLs verbatim
  // (UNDER_ATTACK_*_SRC) so playback reuses the preloaded buffer. WAV because
  // compressed formats produced no sound on Quest — see the constants note.
  alertSting: {
    url: assetUrl("/audio/attack-alarm-sting.wav"),
    type: AssetType.Audio,
    priority: "background",
  },
  alertAlarm: {
    url: assetUrl("/audio/attack-alarm-loop.wav"),
    type: AssetType.Audio,
    priority: "background",
  },
  // Sound bank. Each `url` is byte-identical to its `SFX_CATALOG` entry, and a
  // test asserts that — the mismatch failure is silent on desktop and total on
  // device. Generated by `scripts/generate-audio.mjs`; preview and tune with
  // `scripts/audio-preview.html`.
  sfxClick: {
    url: assetUrl("/audio/sfx-click.wav"),
    type: AssetType.Audio,
    priority: "background",
  },
  sfxTurretZap: {
    url: assetUrl("/audio/sfx-turret-zap.wav"),
    type: AssetType.Audio,
    priority: "background",
  },
  sfxAlienDeath: {
    url: assetUrl("/audio/sfx-alien-death.wav"),
    type: AssetType.Audio,
    priority: "background",
  },
  sfxPlasma: {
    url: assetUrl("/audio/sfx-plasma.wav"),
    type: AssetType.Audio,
    priority: "background",
  },
  sfxLaser: {
    url: assetUrl("/audio/sfx-laser.wav"),
    type: AssetType.Audio,
    priority: "background",
  },
  sfxMelee: {
    url: assetUrl("/audio/sfx-melee.wav"),
    type: AssetType.Audio,
    priority: "background",
  },
  sfxFriendlyDeath: {
    url: assetUrl("/audio/sfx-friendly-death.wav"),
    type: AssetType.Audio,
    priority: "background",
  },
  sfxCrystal: {
    url: assetUrl("/audio/sfx-crystal.wav"),
    type: AssetType.Audio,
    priority: "background",
  },
  sfxDeposit: {
    url: assetUrl("/audio/sfx-deposit.wav"),
    type: AssetType.Audio,
    priority: "background",
  },
  sfxPlace: {
    url: assetUrl("/audio/sfx-place.wav"),
    type: AssetType.Audio,
    priority: "background",
  },
  sfxBuildDone: {
    url: assetUrl("/audio/sfx-build-done.wav"),
    type: AssetType.Audio,
    priority: "background",
  },
  sfxCraftReady: {
    url: assetUrl("/audio/sfx-craft-ready.wav"),
    type: AssetType.Audio,
    priority: "background",
  },
  sfxDemolish: {
    url: assetUrl("/audio/sfx-demolish.wav"),
    type: AssetType.Audio,
    priority: "background",
  },
  sfxWaveSiren: {
    url: assetUrl("/audio/sfx-wave-siren.wav"),
    type: AssetType.Audio,
    priority: "background",
  },
  sfxVictory: {
    url: assetUrl("/audio/sfx-victory.wav"),
    type: AssetType.Audio,
    priority: "background",
  },
  sfxDefeat: {
    url: assetUrl("/audio/sfx-defeat.wav"),
    type: AssetType.Audio,
    priority: "background",
  },
};

// BEFORE World.create, not inside its .then(): the overlay has to be driven
// across the preload it exists to cover, and the preload happens inside that
// call. Wiring it in the .then() would attach the driver after the only stretch
// of time it matters.
setupLoadingScreen();
// The shared LoadingManager does not exist until AssetManager.init runs inside
// World.create, so this polls for it rather than reaching for it now.
attachAssetLoadProgress(() => AssetManager.loadingManager);

World.create(document.getElementById("scene-container") as HTMLDivElement, {
  assets,
  xr: {
    sessionMode: SessionMode.ImmersiveVR,
    offer: "always",
    features: { handTracking: true },
  },
  features: {
    locomotion: false,
    grabbing: true,
    physics: false,
    sceneUnderstanding: false,
    environmentRaycast: false,
  },
  render: {
    defaultLighting: true,
    // No `camera` block: the preview pose is owned by `placeViewpoint()` below,
    // together with the player rig it is parented to. This block runs during
    // World.create, before the rig has moved, so it cannot be the owner.
  },
})
  .then((world) => {
    // Before any system runs: the player stands beside the board rather than
    // inside their own command center, and the preview camera is placed relative
    // to that rig. Systems that measure against the viewer read the right pose
    // from their first update.
    placeViewpoint(world);
    // Before any sound can be requested: browsers only honour an AudioContext
    // resume inside a user gesture, and the SDK's resume-on-session-start is not
    // reliably credited as one. Without this the under-attack alarm can be
    // silently suspended for the whole session.
    attachAudioUnlock(world);
    // Lets WaveSystem compile a prepared alien's shaders while it is still
    // detached, so the work happens during the countdown rather than on the frame
    // the whole reserve is released.
    attachGpuWarmup(world);
    // Collapse each GLB's kit-bashed parts into one mesh per (rigid group,
    // material) BEFORE any system clones an asset, so every instance inherits it.
    try {
      // `verbose` was hardcoded `true`, which made it not a switch at all.
      // Feeding it the build mode is the one change that silences the whole
      // merge report, instead of four guards inside the module.
      optimizeLoadedAssets(Object.keys(assets), DIAGNOSTICS_ENABLED, (done, total) =>
        initialLoad.setProgress("mesh-merge", done / total),
      );
    } finally {
      initialLoad.complete("mesh-merge");
    }
    world
      .registerSystem(BoardSystem)
      .registerSystem(SkySystem)
      .registerSystem(StructuresSystem)
      .registerSystem(PerformanceSystem)
      .registerSystem(TabletSystem)
      .registerSystem(InteractionSystem)
      .registerSystem(MovementSystem)
      .registerSystem(SfxSystem)
      .registerSystem(WaveSystem)
      .registerSystem(CombatSystem)
      .registerSystem(CombatEffectsSystem)
      // After CombatSystem: it publishes damage and threat, these render it.
      .registerSystem(UnderAttackAlertSystem)
      .registerSystem(UnderAttackVfxSystem)
      .registerSystem(UnderAttackBannerSystem)
      .registerSystem(UnderAttackAudioSystem)
      .registerSystem(CommandCenterHudSystem)
      .registerSystem(TutorialSystem)
      .registerSystem(AlienAnimationSystem)
      .registerSystem(CommandCenterAnimationSystem)
      .registerSystem(TurretAnimationSystem)
      .registerSystem(UnitAnimationSystem)
      .registerSystem(MiningSystem)
      .registerSystem(MinerAnimationSystem)
      .registerSystem(ConstructionSystem)
      .registerSystem(CraftProductionSystem)
      .registerSystem(CraftVisualRiseSystem)
      .registerSystem(MeteorSystem)
      .registerSystem(MatchResultSystem)
      .registerSystem(ScenarioResetSystem)
      // Run last so systems can enqueue one target and the worker can start it
      // during the same frame, after their normal work has completed.
      .registerSystem(GpuWarmupSystem)
      // Phase 2a step 1 diagnostic: reports why three.js re-derives shader
      // programs. Flip PROGRAM_CHURN_ENABLED off once the branch is identified.
      .registerSystem(ProgramChurnSystem)
      // Dead last, and that position is the design: the interaction and contract
      // deadline sweeps must see the frame after every other system has had its
      // turn in it. A handoff that is legitimately one frame late — the tablet
      // reads the crystal balance at index 16, MiningSystem writes it at 32 —
      // would fail every time if the sweep ran mid-frame.
      .registerSystem(TraceDiagnosticsSystem);
    installFrameProfiler(world);
    // Hooks `scene.onAfterRender`, so it must be installed before the first
    // frame but after the renderer exists. Inert unless its flag is on.
    installTransparentPassProbe(world);
    // The one line that makes every capture attributable. Until now a log could
    // not say which code produced it, which is the ambiguity the landing plan's
    // deferred `[Build]` line was meant to close.
    logAction(
      ActionKind.Session,
      `start tutorialDefault=${TUTORIAL_ENABLED} ` +
        `diagnostics=${anyTraceEnabled()} profiler=${isFrameProfilerEnabled()}`,
    );
    // Both of these run LAST, and the ordering is load-bearing.
    //
    // `visibilityState.subscribe` fires **immediately** with the current value
    // (`@preact/signals-core`: `subscribe` wraps `effect`, which runs its body
    // at once). `xr.offer: "always"` means a session can already be open by the
    // time this `.then()` runs — a headset that was already on accepts the
    // offered session during `World.create`. Subscribing before `BoardSystem`
    // registers would then fire the callback while `boardState.waveSource` is
    // still null, `startMatch()` would return false, and because the visibility
    // never changes again **the gate would never be released** — the game would
    // sit at `awaiting-start` forever with no way in.
    //
    // Both `attachMatchStart` and `setupLanding` read that singleton, so both
    // wait until the systems that create it have registered.
    attachMatchStart(world);
    setupLanding(world);
  })
  .catch((error: unknown) => {
    // Say why the overlay is still there. Without this a dead boot is a bare
    // splash forever, which the player cannot tell from a slow network.
    console.error("[RTSVR] boot failed", error);
    showLoadingFailure(
      "Could not start RTSVR. Check the console and reload the page.",
    );
  })
  .finally(() => {
    // The rule: complete in a `finally`, on every path. The overlay must never
    // wait on a failure — a boot that throws still releases it, and
    // `showLoadingFailure` above is what keeps it up with an explanation
    // instead of fading onto a black scene.
    // Every task, on every path. A boot that throws before mesh-merge or the
    // scenario still releases the overlay — `showLoadingFailure` is what keeps
    // it up with an explanation instead of fading onto a black scene.
    initialLoad.complete("assets");
    initialLoad.complete("mesh-merge");
    initialLoad.complete("world");
    initialLoad.complete("scenario");
  });
