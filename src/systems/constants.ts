export const GRID_SIZE = 24;
export const TILE_SIZE = 0.18;
export const BOARD_Y = 0.78;

export const UNIT_MOVE_SPEED = 0.35;
export const UNIT_ARRIVAL_EPSILON = 0.005;

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
