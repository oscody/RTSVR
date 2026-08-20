export const GRID_SIZE = 24;
export const TILE_SIZE = 0.18;
export const BOARD_Y = 0.78;

export const UNIT_MOVE_SPEED = 0.35;
export const UNIT_ARRIVAL_EPSILON = 0.005;

// Multi-builder construction. Each astronaut past the first adds
// BUILD_RATE_PER_EXTRA_BUILDER to the site's fill rate, capped so a swarm
// cannot trivialise a build: 1 / 1.6 / 2.2 / 2.5 (capped) builders.
// Diminishing rather than linear keeps a lone astronaut viable while still
// making "send everyone" meaningfully faster.
export const BUILD_RATE_PER_EXTRA_BUILDER = 0.6;
export const BUILD_RATE_MAX_MULTIPLIER = 2.5;
// Auto-assignment runs one path search per frame, same budget discipline as
// ALIEN_PATHFINDS_PER_FRAME, so a burst of queued sites cannot stack several
// full-board searches onto one Quest frame.
export const BUILDER_ASSIGNMENTS_PER_FRAME = 1;

// Refunds. Cancelling an order that was never finished returns everything —
// you are undoing a placement, not scrapping a built thing. Deliberately
// scrapping something finished returns only part, so placement stays a real
// decision instead of a free, reversible move.
export const CANCEL_REFUND_RATE = 1;
export const DESTROY_REFUND_RATE = 0.5;

// How many aliens the WaveSystem creates per frame while amortizing the next
// wave's build across the between-wave countdown (spawn spike -> spread out).
// Fixed count (not a time budget) for predictability; 30s countdown ~= 2160
// frames at 72fps, so even a large wave finishes well within it.
export const WAVE_PREP_PER_FRAME = 1;
// Bound expensive route creation so simultaneous alien releases cannot put
// several full-board searches on the same Quest frame.
export const ALIEN_PATHFINDS_PER_FRAME = 1;

export const ORDER_MARKER_COLOR = 0xffbd59;
export const BLOCKED_MARKER_COLOR = 0xff5050;
export const VALID_PLACEMENT_MARKER_COLOR = 0x22c55e;
export const HOVER_MARKER_COLOR = 0xfacc15;
export const SELECTION_MARKER_COLOR = 0x38bdf8;
export const BUILD_MARKER_COLOR = VALID_PLACEMENT_MARKER_COLOR;
export const MARKER_TILE_SCALE = 1.08;
export const MARKER_OPACITY = 0.42;
export const MARKER_Y_OFFSET = 0.023;
export const ORDER_MARKER_INNER_SCALE = 0.38;
export const ORDER_MARKER_OUTER_SCALE = 0.5;
export const ORDER_MARKER_OPACITY = 0.9;
export const ORDER_MARKER_Y_OFFSET = 0.024;
export const BUILD_MARKER_OPACITY = 0.5;

export const ATTACK_RANGE_RING_COLOR = 0xff2222;
export const ATTACK_RANGE_RING_THICKNESS = 0.02;
export const ATTACK_RANGE_RING_OPACITY = 0.7;
export const ATTACK_RANGE_RING_SEGMENTS = 48;
export const ATTACK_RANGE_RING_Y_OFFSET = 0.026;

export const BOARD_BACKGROUND_COLOR = 0xb8d8f1;

// Procedural sky dome (DomeGradient on the level root) — a Martian dusk/space
// backdrop replacing the flat blue. Colors are RGBA 0..1 (Types.Color):
// sky = zenith, equator = horizon glow, ground = below.
// Deep-space look: near-black with a faint blue so stars pop.
export const SKY_DOME_SKY: [number, number, number, number] = [0.006, 0.008, 0.02, 1];
export const SKY_DOME_EQUATOR: [number, number, number, number] = [0.02, 0.025, 0.05, 1];
export const SKY_DOME_GROUND: [number, number, number, number] = [0.004, 0.004, 0.012, 1];
export const SKY_DOME_INTENSITY = 1.0;
// Flat dark fallback set on scene.background in case the level root isn't ready
// for DomeGradient; the dome overrides it when it applies.
export const SKY_FALLBACK_COLOR = 0x02020a;

// Procedural starfield (THREE.Points on a large sphere) for the space backdrop.
export const STARFIELD_COUNT = 1400;
export const STARFIELD_RADIUS = 42;
export const STARFIELD_SIZE = 2; // pixels (sizeAttenuation off = crisp stars)
export const STARFIELD_COLOR = 0xffffff;

// Meteor shower cycle (cosmetic): a set batch of rocks appears floating high
// above the map, then all fall onto random OPEN (non-blocked) tiles, rest on the
// ground, disappear together, and the cycle restarts after a gap.
export const METEOR_POOL_SIZE = 6; // rocks per batch
export const METEOR_SIZE_TILES = 1.3;
export const METEOR_FLOAT_HEIGHT = 4.5; // board-local Y the batch hovers at (in view)
export const METEOR_FLOAT_SECONDS = 2.5; // hover time before the drop starts
export const METEOR_FLOAT_BOB = 0.22; // gentle hover bob amplitude
export const METEOR_STAGGER_SECONDS = 5.0; // delay between each rock's drop
export const METEOR_FALL_SPEED = 0.9; // initial units/sec (slow, graceful fall)
export const METEOR_FALL_ACCEL = 1.0; // units/sec^2 (gentle gravity)
export const METEOR_SPIN_RATE = 2.6; // rad/sec tumble
export const METEOR_ARRIVAL_EPSILON = 0.06;
// A landed batch rests on the ground this long, then all disappear together.
export const METEOR_REST_SECONDS = 10;
export const METEOR_REST_Y_OFFSET = TILE_SIZE * 0.35;
export const METEOR_CYCLE_GAP_SECONDS = 3; // pause between shower cycles
export const METEOR_TRAIL_LENGTH = 1.8;
export const METEOR_TRAIL_THICKNESS = 0.05;
export const METEOR_TRAIL_COLOR = 0xff7a2c; // hot orange (additive, pops on dark space)
export const METEOR_IMPACT_COLOR = 0xffcf8f;
export const METEOR_IMPACT_FLASH_SECONDS = 0.4;
export const METEOR_IMPACT_FLASH_RADIUS = TILE_SIZE * 0.55;
// Directional "sun" — warm key light low on the horizon for directional shading.
export const SUN_COLOR = 0xffe9c7;
export const SUN_INTENSITY = 1.3;
export const SUN_POSITION: [number, number, number] = [8, 4, 6];

export const TILE_PROXY_HEIGHT = 0.06;
export const TILE_PROXY_Y_OFFSET = 0.03;

// Continuous Martian ground (replaces the 576 terrain.glb tile clones).
export const MARS_GROUND_COLOR = 0xa85d43;
export const MARS_GROUND_Y_OFFSET = 0;
export const MARS_OUTLINE_SCALE_PER_BOARD_UNIT = 2.32;
export const MARS_DUST_COLOR = 0xc27759;
export const MARS_DUST_OPACITY = 0.36;
export const MARS_DUST_Y_OFFSET = 0.003;
export const MARS_DUST_SEGMENTS = 28;
export const MARS_RIM_COLOR = 0x5d3024;
export const MARS_RIM_THICKNESS_PER_BOARD_UNIT = 0.1392;

// Command grid overlay — hidden until a unit is selected.
export const GRID_OVERLAY_COLOR = 0x5d3024;
export const GRID_OVERLAY_OPACITY = 0.5;
export const GRID_OVERLAY_Y_OFFSET = 0.006;
export const CRAFT_VISUAL_ELEVATION = TILE_SIZE * 0.90;
export const ALIEN_DRAKE_VISUAL_ELEVATION = TILE_SIZE * 0.90;
export const CRAFT_ELEVATION_RISE_SECONDS = 0.65;

export const PATH_DIRECTIONS = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
] as const;

export const UNIT_APPROACH_OFFSETS = PATH_DIRECTIONS;

export const HEALTH_BAR_FILL_NAME = "HealthBarFill";
export const HEALTH_BAR_BACKGROUND_COLOR = 0x263845;
export const HEALTH_BAR_HEALTHY_COLOR = 0x22c55e;
export const HEALTH_BAR_WARNING_COLOR = 0xfacc15;
export const HEALTH_BAR_CRITICAL_COLOR = 0xef4444;

export const PROGRESS_BACKGROUND_COLOR = HEALTH_BAR_BACKGROUND_COLOR;
export const PROGRESS_FILL_COLOR = HEALTH_BAR_HEALTHY_COLOR;
export const CONSTRUCTION_FOUNDATION_COLOR = SELECTION_MARKER_COLOR;
export const CONSTRUCTION_FOUNDATION_OPACITY = 0.35;
// An unclaimed (pending) site reads as a dimmer, amber outline so it is
// visually distinct from one an astronaut has already started.
export const CONSTRUCTION_PENDING_FOUNDATION_COLOR = ORDER_MARKER_COLOR;
export const CONSTRUCTION_PENDING_FOUNDATION_OPACITY = 0.22;

// Build-queue badge: the number floating above an unclaimed site showing where
// it sits in the build order. Sized and offset like a health bar.
export const QUEUE_BADGE_SIZE = 0.55; // multiples of TILE_SIZE
export const QUEUE_BADGE_Y_OFFSET = 0.95; // multiples of TILE_SIZE
export const QUEUE_BADGE_BACKGROUND_COLOR = "#1d3442";
export const QUEUE_BADGE_TEXT_COLOR = "#ffbd59";
export const CRAFT_PRODUCTION_FOUNDATION_COLOR = 0x0e7490;
export const CRAFT_PRODUCTION_FOUNDATION_OPACITY = 0.4;

export const ANIMATION_CROSS_FADE_SECONDS = 0.12;
export const PERFORMANCE_SAMPLE_SECONDS = 1;

export const ALIEN_MOVE_CLIPS = ["Walk", "Fly"] as const;
export const ALIEN_ATTACK_CLIPS = ["Energy_Slam", "Attack"] as const;

export const UNIT_IDLE_CLIPS = ["Idle", "Idle_Hover"] as const;
export const UNIT_MOVE_CLIPS = ["Walk", "Move"] as const;
export const UNIT_ATTACK_CLIPS = ["Shoot", "StrafeFire"] as const;
export const UNIT_WALK_CLIP = "Walk";
export const UNIT_SHOOT_CLIP = "Shoot";
export const UNIT_BEACON_PLACEMENT_CLIP = "BeaconPlacement";
export const UNIT_LASER_POINT_ASSIST_CLIP = "LaserPointAssist";

export const MINER_IDLE_CLIP = "Idle_Hover";
export const MINER_MOVE_CLIP = "Move";
export const MINER_MINING_CLIP = "Mining_Loop";

export const COMMAND_CENTER_IDLE_OPERATIONAL_CLIP = "Idle_Operational";
export const COMMAND_CENTER_DOOR_OPEN_CLIP = "Door_Open";
export const COMMAND_CENTER_DOOR_CLOSE_CLIP = "Door_Close";
export const COMMAND_CENTER_DOOR_HOLD_SECONDS = 0.25;

export const CRAFT_SPAWN_CONSTRUCTION_CLIP = "Spawn_Construction";
export const TURRET_FIRE_RECOIL_CLIP = "Fire_Recoil";

// Pooled combat VFX (see combatEffects.ts). Damage stays range/cadence-based;
// these are visual-only. Bolts fly muzzle -> target body and stop there, so
// they never bypass the enemy body.
export const COMBAT_VFX_BOLT_POOL_SIZE = 16;
export const COMBAT_VFX_FLASH_POOL_SIZE = 16;
export const COMBAT_VFX_BOLT_SPEED = 1.6; // world units / second
export const COMBAT_VFX_BOLT_RADIUS = TILE_SIZE * 0.09;
export const COMBAT_VFX_BOLT_ARRIVAL_EPSILON = 0.01;
export const COMBAT_VFX_BOLT_COLOR = 0x4fc3ff;
export const COMBAT_VFX_MUZZLE_COLOR = 0xbfe9ff;
export const COMBAT_VFX_IMPACT_COLOR = 0x9fdcff;
export const COMBAT_VFX_FLASH_RADIUS = TILE_SIZE * 0.14;
export const COMBAT_VFX_MUZZLE_FLASH_SECONDS = 0.09;
export const COMBAT_VFX_IMPACT_FLASH_SECONDS = 0.16;
// Raise the aim point from the target's ground anchor to roughly body centre.
export const COMBAT_VFX_TARGET_BODY_Y = TILE_SIZE * 0.6;
// Fallback muzzle for attackers with no named cannon node (turret, astronaut).
export const COMBAT_VFX_MUZZLE_UP = TILE_SIZE * 0.7;
export const COMBAT_VFX_MUZZLE_FORWARD = TILE_SIZE * 0.45;
// Named cannon-tip nodes inside the CraftRacer GLB (paired plasma cannons).
export const RACER_CANNON_MUZZLE_NODES = [
  "StrafeFire_MuzzleFlash_L",
  "StrafeFire_MuzzleFlash_R",
] as const;

// Per-attacker shot styles. Racer = round blue plasma (paired cannons);
// AstronautA = single thin green laser; turret = twin parallel orange lasers.
// Lasers are a stretched+oriented bolt and travel faster than plasma.
export const COMBAT_VFX_LASER_SPEED = 3.4; // world units / second
export const COMBAT_VFX_LASER_LENGTH = COMBAT_VFX_BOLT_RADIUS * 6;
export const COMBAT_VFX_LASER_THICKNESS = COMBAT_VFX_BOLT_RADIUS * 0.5;
export const COMBAT_VFX_DOUBLE_SPACING = TILE_SIZE * 0.13; // twin-laser gap
export const COMBAT_VFX_ASTRONAUT_BOLT_COLOR = 0x66ff99;
export const COMBAT_VFX_ASTRONAUT_MUZZLE_COLOR = 0xd6ffe6;
export const COMBAT_VFX_TURRET_BOLT_COLOR = 0xff7a3c;
export const COMBAT_VFX_TURRET_MUZZLE_COLOR = 0xffd9b0;

// Alien melee attack bursts (Energy_Slam etc.) — no traveling bolt; a strike
// flash on the attacker + an impact burst on the target, colored per kind.
export const COMBAT_VFX_ALIEN_BURST_COLOR = 0xa855f7; // purple energy
export const COMBAT_VFX_DRAKE_BURST_COLOR = 0xff2d55; // crimson
export const COMBAT_VFX_MECH_BURST_COLOR = 0xffe14d; // electric yellow
export const COMBAT_VFX_MELEE_STRIKE_SECONDS = 0.1;
export const COMBAT_VFX_MELEE_BURST_SECONDS = 0.2;

export const TABLET_STATUS_ERROR_COLOR = "#b42318";
export const TABLET_STATUS_SUCCESS_COLOR = "#176b55";
export const TABLET_STATUS_INFO_COLOR = "#365466";
export const TABLET_TAB_ACTIVE_BACKGROUND = "#93b4c5";
export const TABLET_TAB_INACTIVE_BACKGROUND = "#c8d4dc";
export const TABLET_TAB_ACTIVE_BORDER = "#315d73";
export const TABLET_TAB_INACTIVE_BORDER = "#8497a5";
export const TABLET_SELECTED_BUILD_BORDER = "#38bdf8";
export const TABLET_SELECTED_CRAFT_BORDER = "#0e7490";
export const TABLET_CARD_BORDER = "#9aa8b4";
export const TABLET_SELECTED_UNIT_BACKGROUND = "#d9f1f7";
export const TABLET_UNIT_BACKGROUND = "#f7fafc";
export const TABLET_LOCKED_UNIT_BACKGROUND = "#cbd3d8";
export const TABLET_EMPTY_UNIT_BACKGROUND = "#edf2f5";
export const TABLET_LOCKED_UNIT_BORDER = "#a7b0b6";
export const TABLET_EMPTY_UNIT_BORDER = "#bdc9d0";

export const TABLET_FRAME_SIZE = [0.7, 0.55, 0.026] as const;
export const TABLET_FRAME_COLOR = 0x536a7d;
export const TABLET_FRAME_ROUGHNESS = 0.62;
export const TABLET_FRAME_METALNESS = 0.18;
export const TABLET_FRAME_Z_OFFSET = -0.018;
export const TABLET_HANDLE_SIZE = [0.045, 0.26, 0.045] as const;
export const TABLET_HANDLE_COLOR = 0x1d2b36;
export const TABLET_HANDLE_ROUGHNESS = 0.48;
export const TABLET_HANDLE_METALNESS = 0.25;
export const TABLET_HANDLE_X_OFFSET = 0.382;
export const TABLET_PANEL_MAX_WIDTH = 0.66;
export const TABLET_PANEL_MAX_HEIGHT = 0.51;
export const TABLET_SCREEN_Z_OFFSET = 0.002;
export const TABLET_COMMAND_CENTER_X_OFFSET = 0.72;
export const TABLET_Y_OFFSET = 0.78;
export const TABLET_ROTATION = [-0.16, 0.25, 0] as const;

export const CRAFT_PRODUCTION_BUILDING_KINDS = [
  "command-center",
  "hangar",
  "factory",
] as const;

// ── Under-attack alerting ──────────────────────────────────────────────────
// World-space cues, deliberately NOT on the tablet: the player should never
// have to look down to learn something is being hit.
//
// Three of the original five were removed 2026-08-17: the board shake (cue A),
// the rim beacon (cue B), and the rim/ground flash (half of cue D). What remains
// is the threat badge, the command-center banner, and the alarm audio — so the
// BOARD ITSELF no longer reacts to damage at all; the warning is a floating
// panel and a sound. Consequences to keep in mind: damage to a unit or building
// has no banner and no board-level cue, only the badge turning to crossed swords
// and the sting. All deliberate.

// Cue C: crossed-swords badge above the health bar. Threat-driven, not
// damage-driven — it appears the moment an alien targets a friendly. A fixed
// pool repositioned onto whoever is threatened, never one mesh per unit.
export const UNDER_ATTACK_BADGE_POOL_SIZE = 12;
// Two states, because "an alien is aiming at me" and "an alien is hitting me"
// are different pieces of news: the eye is a warning you can still act on, the
// swords mean damage is already landing.
export const UNDER_ATTACK_BADGE_LOCKED_GLYPH = "⦾";
export const UNDER_ATTACK_BADGE_ATTACK_GLYPH = "⚔️";
// How long the swords stay up after the last hit before falling back to the eye.
export const UNDER_ATTACK_BADGE_ATTACK_SECONDS = 1.5;
export const UNDER_ATTACK_BADGE_TEXTURE_SIZE = 256;
export const UNDER_ATTACK_BADGE_SIZE = TILE_SIZE * 0.62;
export const UNDER_ATTACK_BADGE_Y_OFFSET = 0.03;
// Linger keeps the badge steady while an alien re-acquires its target.
export const UNDER_ATTACK_BADGE_LINGER_SECONDS = 1;
export const UNDER_ATTACK_BADGE_POP_SECONDS = 0.18;
export const UNDER_ATTACK_BADGE_POP_OVERSHOOT = 1.15;
export const UNDER_ATTACK_BADGE_OUT_SECONDS = 0.2;
export const UNDER_ATTACK_BADGE_PUNCH_SECONDS = 0.12;
export const UNDER_ATTACK_BADGE_PUNCH_SCALE = 1.3;
export const UNDER_ATTACK_BADGE_BOB = 0.006;
export const UNDER_ATTACK_BADGE_BOB_HZ = 1.2;

// Command-center banner. Parented to the SCENE, not the board
// root — otherwise cue A shakes the text and makes it unreadable. Its position
// is sampled from the command center each time it is raised (once, not per
// frame, so the shake cannot reach it) and it sits above the health bar and
// threat badge, so the warning and the thing being warned about are in one
// glance. The fixed position is only a fallback if the command center is gone.
export const UNDER_ATTACK_BANNER_POSITION = [0, BOARD_Y + 1.18, 0.3] as const;
// Clearance above the command center's health bar. The whole stack shares one
// vertical line directly over the base, reading bottom-to-top: health bar →
// threat badge → HUD strip → this panel. Leaves ~15 cm of air above the HUD so
// the alert reads as its own thing rather than another readout row.
//
// The panel used to step toward the player as well, to dodge the tablet parked
// beside the base. That is unnecessary now that it draws over the scene, and it
// broke the vertical alignment, so the step was removed 2026-08-17.
export const UNDER_ATTACK_BANNER_ABOVE_BAR = 0.44;
export const UNDER_ATTACK_BANNER_MAX_WIDTH = 0.78;
export const UNDER_ATTACK_BANNER_MAX_HEIGHT = 0.18;
export const UNDER_ATTACK_BANNER_IN_SECONDS = 0.2;
export const UNDER_ATTACK_BANNER_HOLD_SECONDS = 3;
export const UNDER_ATTACK_BANNER_OUT_SECONDS = 0.3;
export const UNDER_ATTACK_BANNER_SLIDE = 0.06;
export const UNDER_ATTACK_BANNER_PULSE_HZ = 1;
// Two styles on the one panel. "critical" is the command center taking real
// damage; "caution" is an alien having merely spotted a friendly, which is a
// warning you can still act on — so it is amber, silent, and never interrupts
// a critical alert.
export const UNDER_ATTACK_BANNER_BORDER_COLOR = "#ef4444";
export const UNDER_ATTACK_BANNER_BORDER_PULSE_COLOR = "#7f1d1d";
export const UNDER_ATTACK_BANNER_BACKGROUND_COLOR = "#14090a";
export const UNDER_ATTACK_BANNER_ICON_BACKGROUND = "#2a0d0d";
export const UNDER_ATTACK_BANNER_CAUTION_BORDER_COLOR = "#f59e0b";
export const UNDER_ATTACK_BANNER_CAUTION_PULSE_COLOR = "#78350f";
export const UNDER_ATTACK_BANNER_CAUTION_BACKGROUND_COLOR = "#161004";
export const UNDER_ATTACK_BANNER_CAUTION_ICON_BACKGROUND = "#2e1f05";

// Cue E: alarm audio. These are URLs, and must stay byte-identical to the
// `alertSting` / `alertAlarm` manifest entries in index.ts: the manifest
// preloads the buffer into the AssetManager cache keyed by URL, so playback
// reuses it instead of fetching again.
//
// A manifest KEY here does NOT work, despite AudioSystem.loadAudio() resolving
// keys via CacheManager.resolveUrl(). Measured 2026-08-09: both sources failed
// with "EncodingError: Unable to decode audio data" every frame, because the
// unresolved key is requested as a path and the dev server answers with
// index.html. `vangogh` passes a key and gets away with it; `space-station` and
// `foosball` pass URLs, which is the form that actually holds.
//
// Both are WAV. The loop was Ogg and the sting MP3 — both decoded fine in
// desktop Chrome but produced no sound on Quest (2026-08-09), so the codec is
// the prime suspect and PCM removes the question. `space-station` also ships
// its alarm/hum loops as .wav. WAV additionally has no encoder padding, which
// is what would otherwise put a gap at the loop point.
export const UNDER_ATTACK_STING_SRC = "/audio/attack-alarm-sting.wav";
export const UNDER_ATTACK_ALARM_SRC = "/audio/attack-alarm-loop.wav";
export const UNDER_ATTACK_ALERT_VOLUME = 0.25;
export const UNDER_ATTACK_STING_VOLUME = 0.45;
export const UNDER_ATTACK_STING_COMMAND_CENTER_VOLUME = 0.7;
export const UNDER_ATTACK_ALARM_VOLUME = 0.5;
export const UNDER_ATTACK_ALARM_FADE_IN_SECONDS = 0.15;
export const UNDER_ATTACK_ALARM_FADE_OUT_SECONDS = 0.6;
// The alarm outlives the banner during a sustained assault: it keeps playing
// until this long passes with no fresh command-center damage.
export const UNDER_ATTACK_ALARM_HOLD_SECONDS = 4;

// "Spotted" alerts fire the instant an alien acquires a friendly, before any
// damage. That is a far more common event than being hit, so it gets its own
// much longer cooldowns — otherwise every wave would be a wall of banners.
export const SPOTTED_ALERT_GLOBAL_GAP_SECONDS = 8;
export const SPOTTED_ALERT_TARGET_COOLDOWN_SECONDS = 20;

// Offset added to every node's existing renderOrder so the command-center
// banner draws over the scene. The tablet sits beside the command center and
// otherwise hides it, and the player can carry the tablet anywhere, so no
// placement alone can solve it.
export const UNDER_ATTACK_BANNER_RENDER_ORDER = 1000;

// ── Command-center HUD strip ───────────────────────────────────────────────
// A thin always-on readout floating over the base: which level you are on, how
// much of that level's wave is still alive, and your crystal balance. It sits
// in the gap between the threat badge and the under-attack banner, so the whole
// stack over the command center reads bottom-to-top as
// health bar -> threat badge -> HUD -> alert banner.
export const COMMAND_CENTER_HUD_Y_OFFSET = 0.15; // above the health bar
export const COMMAND_CENTER_HUD_WIDTH = TILE_SIZE * 3.8;
export const COMMAND_CENTER_HUD_HEIGHT = TILE_SIZE * 0.6;
export const COMMAND_CENTER_HUD_TEXTURE_WIDTH = 768;
export const COMMAND_CENTER_HUD_TEXTURE_HEIGHT = 120;
export const COMMAND_CENTER_HUD_BACKGROUND = "rgba(16, 26, 33, 0.86)";
export const COMMAND_CENTER_HUD_BORDER = "#5f7d8f";
export const COMMAND_CENTER_HUD_LABEL_COLOR = "#9fb6c4";
export const COMMAND_CENTER_HUD_VALUE_COLOR = "#edf4f7";
// Troops left turns amber then red as the wave is worn down — the same
// healthy/warning/critical language the health bars already speak.
export const COMMAND_CENTER_HUD_GEM_COLOR = "#67e8f9";
export const COMMAND_CENTER_HUD_TROOPS_HIGH_COLOR = "#fca5a5";
export const COMMAND_CENTER_HUD_TROOPS_LOW_COLOR = "#86efac";
export const COMMAND_CENTER_HUD_TROOPS_LOW_RATIO = 0.34;

// Threat radius shown when an alien is clicked with nothing of yours selected.
// Purple rather than the friendly rings' red — it is a danger zone, not one of
// your own weapons. Same hue as the alien melee bursts.
export const ENEMY_RANGE_RING_COLOR = 0xa855f7;

// ── Tutorial card ──────────────────────────────────────────────────────────
// A world-space instruction card placed in front of the viewer — deliberately
// not in the stack over the command center, which already carries health bar,
// threat badge, HUD strip and the under-attack banner. Putting the tutorial
// there would make it fight the alert banner for the most important real estate
// at the worst possible moment.
//
// Built like commandCenterHud.ts: one plane, one CanvasTexture, repainted only
// when the text changes — nine repaints for an entire tutorial.
export const TUTORIAL_CARD_WIDTH = TILE_SIZE * 5.2;
export const TUTORIAL_CARD_HEIGHT = TILE_SIZE * 1.45;
// The card is placed RELATIVE TO THE VIEWER, not at a fixed board position.
//
// It has to be, because there is no fixed spot that serves a player who walks.
// `world.player` is never moved, so in XR the origin — and therefore the player
// — starts at world (0,0,0), which is board CENTRE; a card parked at the near
// rim is 2.5 m away across the table, and moves further the moment they step.
//
// So: this far in front of the viewer, this far below eye level, recomputed
// only when the text changes (never per frame — a card that chases your head is
// hard to read and harder to ignore).
export const TUTORIAL_CARD_DISTANCE = 1.35;
export const TUTORIAL_CARD_DROP = 0.58;
// Leash. The card stays put while the viewer is near it and roughly facing it,
// and re-places when either stops being true. Without this it is placed once per
// text change and never again — which breaks the moment the viewpoint jumps, as
// it does on entering XR (desktop camera is outside the board; the XR player is
// at board centre, ~4.9 units away). Cheap: a few vector ops per frame.
export const TUTORIAL_CARD_MAX_DISTANCE = 2.4;
export const TUTORIAL_CARD_MIN_DISTANCE = 0.45;
// Dot product of view-forward against the direction to the card, both flattened.
// ~0.3 is about 70 degrees off-axis — generous, so small head turns do not move it.
export const TUTORIAL_CARD_FACING_MIN = 0.3;
// How far the card may be turned AWAY from the viewer before it is re-placed.
//
// The leash above only asks where the card IS. On Quest that was not enough: a
// player who walks around a tabletop board while keeping the card roughly ahead
// never trips it, and the card stays yawed toward wherever they stood when the
// text last changed. An edge-on plane is a line — the same failure that made the
// under-attack beacon invisible. ~0.6 is about 53 degrees off the card's own
// normal, past which the text starts to foreshorten badly.
export const TUTORIAL_CARD_VIEW_ANGLE_MIN = 0.6;
// Floor on the card's height above the board surface.
//
// Without it the card is placed purely at `cameraY - DROP`, which is BELOW the
// board (BOARD_Y = 0.78) for any head under ~1.36 m — leaning in over a
// table-height board, crouching, or simply being short. On Quest the card sank
// to its mid-line and the body text was under the terrain. Must clear half the
// card's own height plus a visible gap.
export const TUTORIAL_CARD_BOARD_CLEARANCE = TILE_SIZE * 1.6;
export const TUTORIAL_CARD_TEXTURE_WIDTH = 1024;
export const TUTORIAL_CARD_TEXTURE_HEIGHT = 272;
export const TUTORIAL_CARD_BACKGROUND = "rgba(10, 18, 24, 0.9)";
// The tutorial gets a hue of its own, distinct from every gameplay marker, so
// "the tutorial is telling you something" never reads as a game state.
export const TUTORIAL_CARD_BORDER = "#7dd3fc";
export const TUTORIAL_CARD_TITLE_COLOR = "#7dd3fc";
export const TUTORIAL_CARD_BODY_COLOR = "#e8f4f8";
export const TUTORIAL_CARD_STEP_COLOR = "#7c93a1";
// Rules run at 4 Hz — nothing here needs 72 Hz, and the counts are the only
// mildly expensive reads.
export const TUTORIAL_SAMPLE_SECONDS = 0.25;
// Gaze test for the orientation beat: cos of the half-angle between where the
// player is looking and the direction to their command center. ~0.86 is about
// 30 degrees off-axis — the base has to be genuinely in front of them, not just
// somewhere in peripheral vision, but they do not have to aim at it.
export const TUTORIAL_GAZE_DOT_MIN = 0.86;

// ---------------------------------------------------------------------------
// Tutorial arrow — the pointing layer.
//
// A CONE, standing point-down over whatever the card is talking about.
//
// Deliberately NOT a flat billboarded chevron. The under-attack beacon shipped
// as a flat quad and was invisible on Quest: edge-on to a standing player a
// plane is a line, and a desktop camera never reveals it. A cone of revolution
// has no edge-on angle, so it is readable from every direction a player can
// stand — which is why there is no billboard constant here. The spin below is
// for liveliness, not legibility.
export const TUTORIAL_ARROW_RADIUS = TILE_SIZE * 0.36;
export const TUTORIAL_ARROW_HEIGHT = TILE_SIZE * 0.85;
// The card's hue, so "the tutorial is pointing" never reads as a game state —
// selection rings, range rings and threat badges all own their own colours.
export const TUTORIAL_ARROW_COLOR = 0x7dd3fc;
/** Clearance between the cone's tip and the thing it points at. */
export const TUTORIAL_ARROW_TIP_GAP = TILE_SIZE * 0.5;
/**
 * Extra lift for the tablet arrow, so the cone hovers above the panel's top
 * edge instead of landing on its face.
 *
 * `boardState.tablet` is the panel's CENTRE; pointing there put the cone over
 * the title bar, covering part of the UI the arrow exists to send you to.
 * Half the panel height clears the top edge.
 */
export const TUTORIAL_ARROW_TABLET_LIFT = TABLET_PANEL_MAX_HEIGHT / 2;
/**
 * Extra clearance above the LEVEL/TROOPS/GEMS strip, on top of the tip gap every
 * other target already gets.
 *
 * Deliberately small. The command center's entity origin is the building's
 * FOOT, so an arrow placed there sat INSIDE a three-tile-tall building — but
 * over-correcting is its own failure: a cone parked well clear of the strip
 * reads as floating in the sky rather than as pointing at anything.
 */
export const TUTORIAL_ARROW_COMMAND_CENTER_GAP = TILE_SIZE * 0.08;
/**
 * Fallback lift above the command center's foot, for the frames before the HUD
 * strip exists. Roughly the building's own height plus the stack above it.
 */
export const TUTORIAL_ARROW_COMMAND_CENTER_FALLBACK = TILE_SIZE * 3.2;
/** Bob amplitude and rate. Motion is what makes a small object findable. */
export const TUTORIAL_ARROW_BOB = TILE_SIZE * 0.33;
export const TUTORIAL_ARROW_BOB_HZ = 0.9;
/** Slow yaw, radians/second, so it reads as a live cue rather than scenery. */
export const TUTORIAL_ARROW_SPIN = 1.1;
/**
 * How far from the base, in tiles, the `threatTile` arrow stands.
 *
 * Far enough to read as a direction rather than as part of the base; close
 * enough that a turret placed there still covers it.
 */
export const TUTORIAL_THREAT_TILE_STEPS = 3;
// The hinted tablet tab alternates between its normal styling and this, at this
// period. A square wave, not a fade: uikit setProps is a discrete write, and a
// per-frame colour ramp through it would be the tablet's own frame cost times
// the pulse rate for no readability gain.
export const TUTORIAL_TAB_PULSE_SECONDS = 0.55;
export const TUTORIAL_TAB_PULSE_BACKGROUND = "#0e4a5e";
export const TUTORIAL_TAB_PULSE_BORDER = "#7dd3fc";

/**
 * How long the wave countdown parks at while the tutorial holds it.
 *
 * Not a freeze-in-place: when the tutorial lets go, Act 2 has to start promptly
 * rather than waiting out whatever remained of a 30-second countdown. It also
 * must never be 0, or the wave activates on the next tick while still held.
 */
export const TUTORIAL_WAVE_ACTIVATION_LEAD_SECONDS = 2;
