import { assetUrl } from "../app/assetUrl.ts";

export const GRID_SIZE = 24;
export const TILE_SIZE = 0.18;
export const BOARD_Y = 0.78;

// ── Viewpoint ───────────────────────────────────────────────────────────────
//
// Where the player stands, and where the 2D preview camera sits. Both live here
// because they are COUPLED: `world.camera` is a child of `world.player`, so the
// desktop pose has to be expressed relative to the rig. Applied together by
// `placeViewpoint()` in `viewpoint.ts` — see that file for why `render.camera`
// in `index.ts` cannot own the camera any more.
//
/**
 * Where the player stands, in world space.
 *
 * The board's south rim is z = +2.16 and the base fronts +Z, so this parks the
 * player a normal table-standing gap off the near edge, looking north across
 * the board at their own command center.
 *
 * **Before this existed the rig sat at the origin, which is board CENTRE** — the
 * player stood *inside* their own base with a 4.32 m table at waist height all
 * around them. That single defect is what forced the tutorial card's distance
 * leash, facing leash and ground clamp into existence, and it is why step 1's
 * gaze cone was measuring "are you facing roughly south-west" rather than "have
 * you found your base".
 *
 * No rotation is needed: three.js forward is -Z, and a player at +Z looking
 * toward the origin is already facing the board.
 */
export const PLAYER_SPAWN = [0, 0, 0.83] as const;
/**
 * The 2D preview camera, in WORLD space. `placeViewpoint()` converts it to
 * rig-local, because authoring it relative to a rig that moves is how the two
 * drift apart.
 *
 * Derived rather than guessed, so it can be retuned the same way:
 * - The board silhouette at a 30 degrees azimuth is ~5.6 m wide.
 * - hFOV = 2*atan(tan(25 degrees) * 16/9) = 79.6 degrees.
 * - To fill ~80% of that: slant range = 2.8 / tan(39.8 degrees) ~= 4.2 m.
 * - At 37 degrees elevation: horizontal 4.2*cos37 = 3.36, rise 4.2*sin37 = 2.53.
 * - Azimuth 30 degrees off +Z: x = 3.36*sin30 = 1.68, z = 3.36*cos30 = 2.91.
 *
 * **The tablet used to sit in this sight line; it no longer does.** Parked at the
 * player's right hand it drifted into the middle of the preview as PLAYER_SPAWN
 * moved in, and by z = 0.83 it covered the command center outright. Mirroring
 * this azimuth would have cleared it, and was rejected — the preview camera was
 * not what the owner asked to change. Fixed on the tablet's side instead: it now
 * carries a second, preview-only pose (`TABLET_DESKTOP_POSITION`) that is clear
 * of the base and square-on to this camera. **That pose is derived from the
 * values here**, so retuning this camera means re-deriving that position.
 *
 * **37 degrees is a deliberate choice, not a default.** It is the classic RTS
 * three-quarter angle: steep enough that the far rim reads, shallow enough that
 * the board still looks like an object on a table rather than a map. The
 * inherited pose was 16.4 degrees, which foreshortened a 4.32 m board to ~1.2 m
 * of apparent depth and rendered the far rim 2.5x smaller than the near one —
 * worst exactly where the pressure comes from in a four-sided defense game.
 *
 * If the diorama feel turns out to matter more than rim legibility, the same
 * derivation at 25 degrees gives `[1.85, 2.75, 3.20]`.
 */
export const DESKTOP_CAMERA = [1.7, 3.5, 2.9] as const;
/**
 * Aim at the command center's MASS, not at the ground plane it stands on.
 *
 * The inherited target was y = 0.8 — the board surface — which sat the subject
 * low in frame. `BOARD_Y + 0.17` is roughly the middle of the base.
 */
export const DESKTOP_CAMERA_TARGET = [0, 0.95, 0] as const;

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

// Entry and exit transitions, so a batch never pops into or out of existence.
//
// These animate the HOLDER's scale and Y. The rock model inside is scaled once
// at pool build (`METEOR_SIZE_TILES`) and the holder's own scale is otherwise
// always 1 — so it is free for this, and `clearMeteors()` restores it to 1.
//
// Deliberately NOT a material fade: the meteor models come from AssetManager
// and their materials are shared across every clone. Making one transparent
// would change them all, and would recreate the shader churn already fixed.
export const METEOR_MATERIALIZE_SECONDS = 0.32;
export const METEOR_DEPART_SECONDS = 0.45;
// Where a rock starts: nearly invisible, and a little below its hover height so
// it rises into place rather than inflating on the spot.
export const METEOR_MATERIALIZE_START_SCALE = 0.05;
export const METEOR_MATERIALIZE_RISE = TILE_SIZE * 1.2;
// Landed rocks sink slightly as they shrink, so they read as sinking into the
// terrain rather than evaporating.
export const METEOR_DEPART_SINK = TILE_SIZE * 0.45;
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
/**
 * How high a hovering unit's MODEL floats above its ground anchor.
 *
 * Applied to the model inside the holder (`structures.ts`, `craftFactory.ts`),
 * never to the entity itself — so the entity stays on the board and combat
 * distance, which is a 3D `distanceTo` between entity positions, is unaffected
 * by these. That separation is why `entityVisualElevation()` exists in
 * `combatEffects.ts`: bolts have to add the offset back to aim at the body
 * rather than the feet.
 *
 * Two constants with the same value, deliberately, so a flier can be moved
 * without moving the other.
 *
 * Raised 0.90 -> 1.10 -> 1.50 -> 1.75 tiles on 2026-09-04. Everything downstream
 * measures rather than restates it: health bars from the holder's bounds, the
 * under-attack badge from the health bar, the interaction proxy from the offset
 * passed to it, and the tutorial spotlight from the model's own box.
 */
export const CRAFT_VISUAL_ELEVATION = TILE_SIZE * 1.75;
export const ALIEN_DRAKE_VISUAL_ELEVATION = TILE_SIZE * 1.75;
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
// ── Gameplay effects (economy, death, completion) ───────────────────────────
//
// Separate from the COMBAT_VFX_* block above on purpose: `combatEffects.ts`
// stays focused on weapon fire, and these punctuate events that currently
// happen with sound but no picture. Same pooled, non-interactive, reset-safe
// shape — see `gameplayEffects.ts`.
//
// Pool sizes are the cap on SIMULTANEOUS effects, not a budget for a match. A
// full pool drops the extra visual rather than allocating mid-frame, so these
// are sized for the worst realistic burst: several aliens dying at once.
export const GAMEPLAY_VFX_FLASH_POOL_SIZE = 12;
export const GAMEPLAY_VFX_PULSE_POOL_SIZE = 8;

// A flash is a small bright sphere that expands and fades. A pulse is a flat
// ring that expands faster and fades — it reads as "something happened here"
// from the tabletop viewpoint without hiding what is underneath.
export const GAMEPLAY_VFX_FLASH_RADIUS = TILE_SIZE * 0.16;
export const GAMEPLAY_VFX_PULSE_INNER_RADIUS = TILE_SIZE * 0.30;
export const GAMEPLAY_VFX_PULSE_OUTER_RADIUS = TILE_SIZE * 0.38;

// Lifetimes. All well under half a second: these punctuate an event that has
// already resolved in the rules, so a long effect would trail the truth.
export const GAMEPLAY_VFX_MINING_SECONDS = 0.25;
export const GAMEPLAY_VFX_DEPOSIT_SECONDS = 0.3;
export const GAMEPLAY_VFX_DEATH_SECONDS = 0.36;
export const GAMEPLAY_VFX_COMPLETION_SECONDS = 0.4;

// Colours carry the meaning, so the event reads without text.
export const GAMEPLAY_VFX_MINING_COLOR = 0x8fe8ff; // crystal cyan
export const GAMEPLAY_VFX_DEPOSIT_COLOR = 0xffd479; // cyan -> gold at the base
export const GAMEPLAY_VFX_DEATH_ALIEN_COLOR = 0xc65cff; // purple/red
export const GAMEPLAY_VFX_DEATH_UNIT_COLOR = 0x9fd0ff; // friendly blue/white
export const GAMEPLAY_VFX_DEATH_BUILDING_COLOR = 0xffb066; // orange/white
export const GAMEPLAY_VFX_COMPLETION_COLOR = 0xffe6a8; // warm gold

// A building death reads as a bigger event than a unit death.
export const GAMEPLAY_VFX_BUILDING_DEATH_SCALE = 1.8;

// Raise an effect from a ground anchor to roughly body centre, the same reason
// COMBAT_VFX_TARGET_BODY_Y exists.
export const GAMEPLAY_VFX_BODY_Y = TILE_SIZE * 0.5;

// Object transitions (phase 3): short scale/position moves on ONE existing
// object, as opposed to the pooled overlay effects above. These replace a
// `visible = true/false` flip, so they must be short enough that nobody waits
// on them — the rule they follow has already resolved.
//
// The pool caps SIMULTANEOUS transitions. A full pool snaps to the end state,
// which is exactly the old one-frame behaviour: graceful degradation back to
// what shipped before, never an allocation inside a system update.
export const OBJECT_TRANSITION_POOL_SIZE = 16;

// Miner cargo appearing on load and leaving on deposit. Faster than the
// meteors: a round trip has two of these in it, and the miner is already
// moving away by the time the second one plays.
export const CARGO_REVEAL_SECONDS = 0.16;
export const CARGO_RETREAT_SECONDS = 0.14;
export const CARGO_TRANSITION_START_SCALE = 0.15;

// An exhausted resource node shrinking and sinking into the terrain. Longer
// than the cargo, because this one is a board-state change the player should
// notice: that tile is now walkable.
export const NODE_DEPLETION_SECONDS = 0.35;
export const NODE_DEPLETION_END_SCALE = 0.05;
export const NODE_DEPLETION_SINK = TILE_SIZE * 0.35;

// Named cannon-tip nodes inside the CraftFighter GLB (paired plasma cannons).
export const FIGHTER_CANNON_MUZZLE_NODES = [
  "StrafeFire_MuzzleFlash_L",
  "StrafeFire_MuzzleFlash_R",
] as const;

// Per-attacker shot styles. Fighter = round blue plasma (paired cannons);
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
/**
 * Where the tablet parks, as an offset from the PLAYER — not from the base.
 *
 * It used to be authored against the command center (`x + 0.72`, board centre
 * z), which worked only because the player also stood at board centre. Moving
 * the rig to the south rim put the tablet **2.72 m away** — visible, rayable,
 * and completely out of grab reach for a `OneHandGrabbable` panel.
 *
 * These numbers preserve the pose the tablet has always had *relative to the
 * viewer* — 0.63 m to the right, 0.14 m below eyeline, 0.09 m forward — so it
 * lands at the same 0.65 m it was always at, just beside the new standing
 * position. Anchoring to the player is also the honest statement: this is a
 * thing you hold, so what matters is where your hands are.
 *
 * Eye height is assumed, not measured, because the pose is applied once at
 * startup before any headset pose exists. A grabbable panel forgives a few
 * centimetres; a fixed one would not.
 */
export const TABLET_PLAYER_X_OFFSET = 0.63;
export const TABLET_PLAYER_Z_OFFSET = -0.09;
export const TABLET_ASSUMED_EYE_HEIGHT = 1.7;
export const TABLET_EYE_DROP = 0.14;
export const TABLET_Y_OFFSET = 0.78;
/**
 * Where the tablet parks in the 2D preview, in BOARD-LOCAL space.
 *
 * The VR pose above is authored for a player standing at `PLAYER_SPAWN` with the
 * panel at their right hand. The preview camera looks at the board from outside
 * and above, so that same pose shows the tablet edge-on and — since the spawn
 * moved in close to the base — squarely on top of the command center.
 *
 * This is a second pose for the browser: turned to face the camera (computed,
 * not authored — see `applyTabletPose`) and moved clear of the base. Derived
 * from the camera basis rather than eyeballed, so it can be re-derived if
 * `DESKTOP_CAMERA` changes — it is the point **2.3 m** from the camera, **22
 * degrees** off the direction to the base, rotated 18 degrees from "right"
 * toward "down".
 *
 * Those three numbers are the whole trade:
 * - **2.3 m** rather than the 3.40 m first tried. Apparent width 17.3 degrees
 *   against 11.8 — about half again as large, and legible in a browser window.
 * - **22 degrees off-axis** clears the base by 7.7 degrees once the tablet's own
 *   width is counted. It cannot go much lower without the two touching, and it
 *   is worth keeping low: how sheared the panel looks is set by this angle, NOT
 *   by the distance. A square-on panel far off the optical axis still projects
 *   as a trapezoid, and the wider the browser window, the stronger that is.
 * - Distance affects size; the angle affects skew. Moving it closer does not
 *   straighten it.
 *
 * Preview only. Entering XR always restores the VR pose.
 */
export const TABLET_DESKTOP_POSITION = [1.63, 1.22, 1.16] as const;
// REMOVED 2026-08-20 — the tablet's facing is derived, not authored.
//
// This tilt left the panel 95.7 degrees off the direction to the viewer in VR:
// all but edge-on, the one orientation a flat panel cannot be read from. It
// survived a long time because the number looked innocuous and nothing ever
// measured it against where the player actually stands. Both poses now aim at a
// point — the player's head in VR, `DESKTOP_CAMERA` in the browser — so neither
// can drift out of true when the viewpoint moves. See `applyTabletPose`.

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
export const UNDER_ATTACK_STING_SRC = assetUrl("/audio/attack-alarm-sting.wav");
export const UNDER_ATTACK_ALARM_SRC = assetUrl("/audio/attack-alarm-loop.wav");
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
// Retuned 2026-08-20, when PLAYER_SPAWN moved in to z = 1.75.
//
// The card is SMALLER and NEARER than it was, which leaves its apparent size
// unchanged — 39.2 degrees wide and 13.3 degrees tall, against 39.3 x 13.2
// before. Same texture, same pixel budget, same legibility.
//
// What changed is where it sits in the view, and that is the whole point. With
// the player 2.64 m from the base the card spanned 16.0-27.3 degrees below eye
// while the base spanned 4.3-23.9, and the two barely cleared. Standing 0.8 m
// closer swings the base's foot down to 23.9 degrees and the card covered its
// lower half — the card was hiding the thing it was naming. Nearer and lower
// puts the card's top edge at 27.0 degrees, below the base's foot with about
// 3 degrees to spare, and still 10.8 cm clear of the board surface.
export const TUTORIAL_CARD_WIDTH = TILE_SIZE * 3.49;
export const TUTORIAL_CARD_HEIGHT = TILE_SIZE * 1.14;
// The card is placed RELATIVE TO THE VIEWER, not at a fixed board position.
//
// It has to be, because there is no fixed spot that serves a player who walks.
//
// **Amended 2026-08-20.** This used to read "`world.player` is never moved, so
// the player starts at board CENTRE". That is no longer true — `PLAYER_SPAWN`
// puts them at the south rim looking in, which is what the leash below was
// really compensating for. The viewer-relative placement stays: a player who
// steps sideways still needs the card to come with them, and the desktop and XR
// viewpoints still differ (by ~2.5 m now rather than ~4.9 m).
//
// So: this far in front of the viewer, this far below eye level, recomputed
// only when the text changes (never per frame — a card that chases your head is
// hard to read and harder to ignore).
export const TUTORIAL_CARD_DISTANCE = 0.88;
export const TUTORIAL_CARD_DROP = 0.0;
// Leash. The card stays put while the viewer is near it and roughly facing it,
// and re-places when either stops being true. Without this it is placed once per
// text change and never again — which breaks the moment the viewpoint jumps, as
// it does on entering XR (the desktop camera and the XR head are ~2.5 m apart
// since PLAYER_SPAWN landed; it was ~4.9 m before). Cheap: a few vector ops per
// frame.
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
//
// Retuned with the card 2026-08-20: this is HALF THE CARD'S HEIGHT plus the
// same ~0.135 m gap it always had, so a smaller card gets a proportionally
// smaller floor. It matters more than it looks — the clamp, not `_DROP`, is
// what actually decides the card's height in practice, so leaving it at the old
// value silently pinned the card 5 cm too high and ate most of the clearance
// over the base that the retune was for.
export const TUTORIAL_CARD_BOARD_CLEARANCE = TILE_SIZE * 1.32;
// Gap between the card's lower edge and the top of the command center.
//
// The board clamp above is a floor against the *ground*; this is a floor
// against the *base*, and it exists because PLAYER_SPAWN now stands the player
// 0.92 m away, where the command center fills 8-42 degrees below eyeline and
// there is no room left underneath it. The card sits above the base instead.
//
// A fixed drop cannot hold that on its own, because it tracks the EYE while the
// base does not move: at a 1.6 m eye the card cleared by 1.7 degrees, and at
// 1.5 m it landed under the base's top edge and covered the very thing the
// opening card names. Measuring the subject is what makes it height-proof.
export const TUTORIAL_CARD_SUBJECT_CLEARANCE = TILE_SIZE * 0.33;

/**
 * How far sideways the card steps to clear the tablet, in metres.
 *
 * Half the card plus half the tablet frame plus a 40 mm gap, so the two cannot
 * touch: 0.628/2 + 0.700/2 + 0.04. Derived from the two widths rather than
 * typed as a number, so resizing either moves this with it.
 *
 * The tablet rides at the player's right hand and the card is placed dead
 * ahead, so they share view space whenever the tablet is raised to be read —
 * finding B of `plan/2026-08-20-Quest-Tutorial-Run-Fixes-Plan.md`.
 */
export const TUTORIAL_CARD_TABLET_CLEARANCE =
  TUTORIAL_CARD_WIDTH / 2 + TABLET_FRAME_SIZE[0] / 2 + 0.04;

/**
 * Only a tablet nearer than this can hide the card, so a tablet parked across
 * the board never pushes it aside. A little beyond the card's own distance.
 */
export const TUTORIAL_CARD_TABLET_DEPTH_LIMIT = TUTORIAL_CARD_DISTANCE + 0.5;
export const TUTORIAL_CARD_TEXTURE_WIDTH = 1024;
export const TUTORIAL_CARD_TEXTURE_HEIGHT = 320;
/** Colour of the card's "saving toward" progress line. */
export const TUTORIAL_CARD_PROGRESS_COLOR = "#8fe3b0";
/**
 * Card panel fills. **All four are near-opaque on purpose** — see finding B of
 * `plan/2026-08-20-Quest-Tutorial-Run-Fixes-Plan.md`.
 *
 * At 0.90 the tablet's text rendered straight through the card: a Quest capture
 * at t=192s shows profiler rows and the Build tab's "astronaut will come"
 * bleeding through the closing card mid-sentence. The card's material carries no
 * `opacity` of its own, so these alphas were the only source of translucency —
 * which makes this the whole of that fix.
 *
 * Not a flat 1.0: a hairline of the scene at the rounded corners keeps the card
 * looking seated in the world rather than pasted onto the lens.
 */
export const TUTORIAL_CARD_BACKGROUND = "rgba(10, 18, 24, 0.98)";
// The tutorial gets a hue of its own, distinct from every gameplay marker, so
// "the tutorial is telling you something" never reads as a game state.
export const TUTORIAL_CARD_BORDER = "#7dd3fc";
export const TUTORIAL_CARD_TITLE_COLOR = "#7dd3fc";
// A LOSS must not be dressed as a lesson.
//
// Every tutorial card looked identical, so "you have lost your miner and must
// act" arrived in the same calm blue as "here is the next thing to learn". The
// words changed and nothing else did, which is exactly how a player reads past
// them. Amber for a setback you can still recover from, red for a run that
// cannot continue — the same vocabulary the rest of the game already uses for
// caution and danger.
export const TUTORIAL_CARD_RECOVERY_BACKGROUND = "rgba(38, 26, 8, 0.98)";
export const TUTORIAL_CARD_RECOVERY_BORDER = "#f59e0b";
export const TUTORIAL_CARD_RECOVERY_TITLE_COLOR = "#fcd34d";
export const TUTORIAL_CARD_DEAD_END_BACKGROUND = "rgba(42, 12, 12, 0.98)";
export const TUTORIAL_CARD_DEAD_END_BORDER = "#ef4444";
export const TUTORIAL_CARD_DEAD_END_TITLE_COLOR = "#fca5a5";
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

// ---------------------------------------------------------------------------
// Tutorial gaze ring — the fill-while-you-look marker.
//
// It does not add a cue so much as draw one that already exists: the `orient`
// drill has two invisible gates (are you facing the base, and have you had time
// to read), and a player who looks away at 3.5 s has no idea why nothing
// happened. The ring IS both gates.
//
// Built as N pooled wedges toggled by visibility, NOT as one ring whose
// geometry is rebuilt per frame — that would allocate a geometry inside
// update(), against the standing no-allocation rule.
export const TUTORIAL_RING_WEDGES = 24; // 15 degrees each
// Must CLEAR the thing it surrounds. The command center is 3 tiles wide and its
// skirt flares wider still, so a 2.2-tile ring was drawn half-buried under the
// building it was pointing at.
export const TUTORIAL_RING_RADIUS = TILE_SIZE * 3.4;
export const TUTORIAL_RING_THICKNESS = TILE_SIZE * 0.34;
export const TUTORIAL_RING_Y_OFFSET = 0.028; // just above the range rings
/** Fraction of each wedge left empty, so the ring reads as segmented. */
export const TUTORIAL_RING_WEDGE_GAP = 0.18;
export const TUTORIAL_RING_COLOR = 0x7dd3fc; // the tutorial's own hue
export const TUTORIAL_RING_OPACITY = 0.92;
/**
 * How fast the ring empties when the player looks away, as a multiple of the
 * fill rate.
 *
 * Draining is the whole point. A ring that merely PAUSES tells the player
 * nothing about why it stopped; one that visibly retreats says "come back".
 * Faster than the fill so the feedback is unmistakable, but not instant —
 * a glance away should not wipe four seconds of progress.
 */
export const TUTORIAL_RING_DRAIN_RATE = 1.6;

/**
 * How far the world dims while the tutorial is holding the player's attention.
 *
 * Tuned to the concept art (`plan/tutorial/TimeFreeze.png`), whose dark ground
 * measures a mean red of ~21. Reaching that took a far lower factor than it
 * sounds: tone mapping lifts shadows hard, so 0.34 only moved the ground to 62%
 * of normal. At 0.012 it lands on 20.
 *
 * The number is meaningless on its own — it is one of three terms, and the other
 * two exist because this one is so low:
 *   - `setBoardDim` scales the unlit ground and scenery (they ignore lights).
 *   - `TUTORIAL_SPOTLIGHT_LIGHT_INTENSITY` relights the subject, because at ~1%
 *     sun there is no light left for a colour scale to work with.
 */
export const TUTORIAL_DIM_FACTOR = 0.012;
/**
 * Seconds to ease in and out of the dim.
 *
 * A hard cut to a third of the light is unpleasant in a headset, and an
 * instant restore reads as a glitch. Long enough to feel deliberate, short
 * enough not to lag the beat it belongs to.
 */
export const TUTORIAL_DIM_RAMP_SECONDS = 0.6;

/**
 * How strongly the command center self-illuminates while the world is dimmed.
 *
 * A multiplier on the base's own material colours — the same mechanism
 * `setBoardDim` uses, in the opposite direction. Three.js colours are floats and
 * may exceed 1, so this has headroom.
 *
 * Emissive was tried first, twice, and moved the measured brightness by about
 * one point (63 -> 65). Whatever these materials are, emissive does not reach
 * the renderer for them.
 *
 * On its own this is NOT enough at concept-art darkness — a colour scale
 * multiplies reflected light, and at ~1% sun there is almost none. It works
 * alongside the spotlight below, which supplies the light to scale.
 */
export const TUTORIAL_SPOTLIGHT_BOOST = 3.0;
/**
 * Card palette while the world is dimmed.
 *
 * The card is unlit, so it never darkens with the scene — but its panel is
 * near-black by design, which means against a dimmed board it recedes rather
 * than standing out. Brightening the panel and the border is what makes the
 * "floating sign" read as lit.
 */
export const TUTORIAL_CARD_DIM_BACKGROUND = "rgba(22, 44, 58, 0.98)";
export const TUTORIAL_CARD_DIM_BORDER = "#bde9ff";

// The tutorial spotlight's own light. See tutorialSpotlight.ts for why a real
// light is needed here when colour scaling was enough elsewhere: at concept-art
// darkness the sun contributes almost nothing, and a colour scale has no light
// to multiply.
export const TUTORIAL_SPOTLIGHT_LIGHT_COLOR = 0xdff3ff;
export const TUTORIAL_SPOTLIGHT_LIGHT_INTENSITY = 11.0;
/** Falloff radius — tight, so it lights the base and not the whole board. */
export const TUTORIAL_SPOTLIGHT_LIGHT_DISTANCE = 1.6;
/** Above the base, so the light reads as coming down onto it. */
export const TUTORIAL_SPOTLIGHT_LIGHT_HEIGHT = 0.55;

/**
 * Gap between a focused subject's own footprint and the ring around it.
 *
 * The radius is DERIVED from the subject's bounds rather than configured per
 * drill, so a 3-tile command center and a 1-tile alien each get a ring that
 * fits without anyone tuning a number. This is the clearance on top.
 */
export const TUTORIAL_RING_SUBJECT_MARGIN = TILE_SIZE * 0.9;

/** Ring stroke as a fraction of its radius, so small subjects are not all stroke. */
export const TUTORIAL_RING_THICKNESS_RATIO = 0.1;

/**
 * How many tutorial cones can be up at once.
 *
 * Two is what the script actually needs — "send this craft to those crystals"
 * is a relationship, and one cone can only name one end of it. Sized as a pool
 * rather than a pair so a later drill can point at three things without
 * touching the module.
 */
export const TUTORIAL_ARROW_POOL = 3;
/**
 * Bob phase offset between cones, in radians.
 *
 * Without it two cones rise and fall in lockstep, which reads as one mechanism
 * blinking rather than as two separate things being pointed at.
 */
export const TUTORIAL_ARROW_BOB_PHASE = 1.15;
/**
 * Render order for the cones and the gaze ring — **above the card**.
 *
 * The card is lifted over the scene (`liftAboveScene`) so terrain and buildings
 * cannot bury it. That fix had a cost: the card then drew over the cones and the
 * subjects they point at, so the label hid its own pointer. The cues therefore
 * sit one layer higher again.
 *
 * `UNDER_ATTACK_BANNER_RENDER_ORDER` is 1000 and the card rides on it; +10 keeps
 * headroom for anything else that needs to sit between them later.
 */
export const TUTORIAL_CUE_RENDER_ORDER = UNDER_ATTACK_BANNER_RENDER_ORDER + 10;

// ---------------------------------------------------------------------------
// Living Path — flowing chevrons from a unit to where it is going.
//
// A STRAIGHT segment, deliberately. `MovementSystem` interpolates friendly units
// directly toward their order tile (`movement.ts`: "Travel is intentionally
// direct and collision-free … until pathfinding is introduced"), so a curved
// path would be a drawing of a route the unit will not take — worse than no path
// at all. Aliens DO run a real pathfinder; their path can curve, and that is a
// separate future item.
export const TUTORIAL_PATH_POOL = 16;
/**
 * World spacing between chevrons. Constant, so the path does not compress.
 *
 * One tile apart. Widened deliberately as the glyph shrank: a dense trail of
 * tiny marks reads as noise, where a few well-separated ones read as a route.
 * Fewer glyphs is also less to draw and less to look at during a lesson.
 */
export const TUTORIAL_PATH_SPACING = TILE_SIZE * 1.0;
/** How fast the chevrons flow toward the destination, world units per second. */
export const TUTORIAL_PATH_SPEED = 0.22;
/**
 * Half-width of a chevron. Every other dimension of the glyph derives from it.
 *
 * The concept art draws an OPEN chevron — a `>` with the middle cut out — not a
 * filled triangle. That matters more than the size does: a solid triangle at
 * this scale reads as a blob, and a row of blobs reads as debris rather than as
 * direction.
 */
export const TUTORIAL_PATH_SIZE = TILE_SIZE * 0.17;
export const TUTORIAL_PATH_Y_OFFSET = 0.03;
/** Blue is yours. */
export const TUTORIAL_PATH_COLOR = 0x7dd3fc;
/**
 * Red is theirs.
 *
 * The whole colour language of the tutorial's ground cues: a player can read
 * "something is coming HERE, put something THERE" without any text at all.
 */
export const TUTORIAL_PATH_HOSTILE_COLOR = 0xff5a4a;
export const TUTORIAL_PATH_OPACITY = 0.85;
/**
 * Do not draw a path shorter than this.
 *
 * A unit all but arrived would otherwise get one or two chevrons jittering on
 * top of it, which reads as a glitch rather than as direction.
 */
export const TUTORIAL_PATH_MIN_LENGTH = TILE_SIZE * 1.2;

// ---------------------------------------------------------------------------
// Turn cue — "it is behind you".
//
// The meet beat rings whatever just arrived, but an alien can land anywhere on
// a 24x24 board, and a ring you cannot see teaches nothing. This is a chevron
// at the edge of view saying which way to turn, and it disappears the moment the
// subject is in front of you — so it answers a question and then gets out of the
// way rather than becoming furniture.
export const TUTORIAL_TURN_CUE_DISTANCE = 1.1;
export const TUTORIAL_TURN_CUE_OFFSET = 0.44;
export const TUTORIAL_TURN_CUE_DROP = 0.22;
export const TUTORIAL_TURN_CUE_SIZE = TILE_SIZE * 0.42;
/** Red, because it points at theirs. Same language as the hostile path. */
export const TUTORIAL_TURN_CUE_COLOR = 0xff5a4a;
/**
 * Hide the cue once the subject is within this much of view-forward.
 *
 * ~0.72 is about 44 degrees — comfortably wider than the gaze cone that fills
 * the ring, so the cue is gone before the ring starts filling and the player is
 * never chasing two things at once.
 */
export const TUTORIAL_TURN_CUE_HIDE_DOT = 0.72;
/** Gentle pulse so it reads as live rather than as a static edge decoration. */
export const TUTORIAL_TURN_CUE_PULSE_HZ = 1.4;
export const TUTORIAL_TURN_CUE_PULSE = 0.16;

/**
 * How faded a tablet card looks while the tutorial is asking for something else.
 *
 * Faded, not hidden. Removing the card would teach the player the game has fewer
 * options than it does, and they would have to re-learn the tablet once the
 * tutorial let go. This says "not now", not "not available".
 */
export const TABLET_TUTORIAL_LOCKED_OPACITY = 0.3;

/**
 * How far below the tablet the playtesting-settings panel sits, in metres.
 *
 * Below rather than beside: the tablet is authored for a right hand, and a
 * panel to its side lands where the player's forearm already is.
 *
 * The number is geometry, not taste. The frame is `TABLET_FRAME_SIZE` = 0.55 m
 * tall, so its lower edge is 0.275 m down; the settings document is 600x360 px
 * into a 0.6 x 0.36 m box (same aspect, so it fills it) and its half-height is
 * 0.18 m. 0.275 + 0.18 = 0.455 is where they touch, and this adds a 25 mm gap.
 * Anything smaller intersects the tablet — 0.34 put the panel *inside* it.
 */
export const SETTINGS_PANEL_DROP = 0.48;

/**
 * Tablet thumbnail slots, in the UIKitML document's pixel space.
 *
 * These must match `.unit-image` / `.craft-image` in `ui/rts-tablet.uikitml`.
 * They live here because `fitThumbnail` computes the rendered size from them —
 * UIKit's `keepAspectRatio` ignores the CSS height, so the box is enforced in
 * code rather than by the stylesheet. `tests/tablet-ui.test.ts` asserts the two
 * stay in step.
 */
export const TABLET_UNIT_THUMB_WIDTH = 76;
export const TABLET_UNIT_THUMB_HEIGHT = 70;
export const TABLET_BUILD_THUMB_WIDTH = 72;
/**
 * 42px until 2026-09-01, when the stat line was added to build tiles.
 *
 * The build card is a fixed 94px with 12px of padding: 82px of content for an
 * image, a 19px name, a 17px cost and now a 15px stat line. That leaves 31px,
 * so the thumbnail had to shrink. Growing the card was the alternative and was
 * rejected — `.card-row` has 4px of slack inside a 274px `.view`, and UIKit
 * drops overflowing children silently rather than clipping, so pushing on that
 * budget fails invisibly.
 */
export const TABLET_BUILD_THUMB_HEIGHT = 26;
export const TABLET_CRAFT_THUMB_WIDTH = 78;
export const TABLET_CRAFT_THUMB_HEIGHT = 70;
