/**
 * Tutorial script data — the whole tutorial expressed as configuration.
 *
 * Design: `RTSVR_repos/devlog/plan/2026-08-09-Tutorial-System-Plan.md`.
 *
 * Nothing here imports IWSDK, ECS or Three. This file is data plus the master
 * switch, so the rules module and its tests can consume it without a world.
 */

import type { EnemyKind, WaveEdge } from "./waveCatalog.ts";

// Default for the whole tutorial. This seeds `DebugSettings.tutorialEnabled`,
// which is what the runtime actually reads — the same relationship
// ALIEN_MOVE_SPEED has with DebugSettings.alienMoveSpeed. Change this to change
// the default; use the tablet's Settings tab to change it live.
//
// Off means TutorialSystem returns immediately: no card, no arrow, no wave hold,
// no wave-0 level — the game behaves exactly as it does today.
//
// There is still no first-run detection and no Skip button.
export const TUTORIAL_ENABLED = true;

/**
 * Where the bobbing arrow points. Resolved to a world position by the system,
 * so the catalog stays pure data.
 *
 * `commandCenter` and `threatTile` are derived from the base, which can be
 * destroyed (`boardState.commandCenter` is nulled at `combat.ts:300`). Both
 * must resolve to "no target" in that case rather than falling back to the
 * origin — see `arrowNeedsCommandCenter`.
 */
export type ArrowTarget =
  | { kind: "commandCenter" }
  | { kind: "nearestUnit"; unit: string }
  | { kind: "nearestCrystal" }
  | { kind: "tile"; x: number; y: number }
  | { kind: "tabletTab"; tab: "build" | "crafts" }
  | { kind: "nearestEnemy" }
  /** Base tile stepped toward the incoming spawn edge. */
  | { kind: "threatTile" }
  /** Between a threatened unit and whatever threatens it. */
  | { kind: "interceptTile" };

/**
 * One drill is the whole "meet a unit, make one, use it" loop:
 *
 *   introduce → player creates it → place it → an opponent arrives → beat it
 *
 * Adding a unit to the tutorial is one entry in TUTORIAL_DRILLS. Wave 0's
 * roster is derived from these, so the script and the enemies cannot drift
 * apart the way two hand-maintained lists would.
 */
export interface TutorialDrill {
  id: string;
  /** null for pure-instruction drills (orientation, the sign-off). */
  create: {
    /** buildingCatalog vs craftCatalog. */
    via: "build" | "produce";
    kind: string;
  } | null;
  /** Where the card and arrow steer the player. Advisory, never enforced. */
  placement: "towardThreat" | "anywhere" | null;
  /**
   * Floor on how long this card is shown, in seconds, regardless of the
   * trigger. A step whose condition is *already* true when it begins would
   * otherwise flash past unread — which is exactly what happened to the
   * orientation beat: the desktop camera already faces the base, so the gaze
   * passed on the first 4 Hz sample and the player never saw the card.
   *
   * The trigger still decides *whether* a drill completes; this only decides
   * that it cannot complete instantly.
   */
  minSeconds?: number;
  /** Units this drill leaves the player depending on; a death pushes recovery. */
  keepAlive?: readonly string[];
  /** What releases this drill's opponent. Timers are a last resort. */
  trigger:
    | { kind: "minerTrips"; count: number }
    | { kind: "crystalsAtLeast"; amount: number }
    /** Completes when the player actually looks at the thing being named. */
    | { kind: "lookedAt"; target: "commandCenter" }
    /** Last resort for beats with genuinely nothing to react to. */
    | { kind: "dwellSeconds"; seconds: number }
    | { kind: "immediate" };
  /** Released on `trigger`. null for non-combat drills (the miner). */
  opponent: {
    enemy: EnemyKind;
    count: number;
    /** "farFromMiner" resolves at release time to the mine's far corner. */
    spawn: WaveEdge | "farFromMiner";
    /** What it should head for, so the drill's lesson is reliable. */
    hunts?: "miner" | "commandCenter";
  } | null;
  /**
   * All tutorial copy lives here — nowhere else in src/ has tutorial strings.
   * `title` is a 2-4 word heading; the sentences go in the body lines. Reading
   * is expensive in a headset, so the heading has to be glanceable on its own.
   */
  cards: { title: string; intro: string; doing: string; cleared: string };
  /**
   * Where to point, per card phase — mirroring `cards`, because the script
   * genuinely needs two: "Build tab, THEN the tile you should place on".
   * `hasDrillStarted()` picks which. null means point at nothing.
   */
  arrows: { intro: ArrowTarget | null; doing: ArrowTarget | null };
}

/**
 * The default script: miner → astronaut → racer → turret.
 *
 * The order is forced, not chosen. STARTING_CRYSTALS is 0, so mining is the only
 * action available at t=0; and astronaut production is the one path exempt from
 * requiring a builder, so it must precede the racer and the turret, which both
 * need one. Each drill is what unlocks the next.
 */
export const TUTORIAL_DRILLS: readonly TutorialDrill[] = [
  {
    // Orientation. Before anything else the player has to know which thing on
    // the board is theirs and what losing it costs — every later drill is in
    // service of defending it.
    id: "orient",
    create: null,
    placement: null,
    // Event, not a timer. A dwell expires whether or not the player ever found
    // their base — and from the default XR position the base is BEHIND them, so
    // a timer would routinely elapse while they stare at empty terrain. This
    // completes only once they have actually turned and looked at it.
    trigger: { kind: "lookedAt", target: "commandCenter" },
    // Long enough to read two lines. Without it, anyone already facing their
    // base skips the only step that explains what it is.
    minSeconds: 4,
    opponent: null,
    arrows: {
      intro: { kind: "commandCenter" },
      doing: { kind: "commandCenter" },
    },
    cards: {
      title: "This is your command center",
      intro: "Lose it and the match ends. Everything else you build is there to protect it.",
      doing: "Lose it and the match ends. Everything else you build is there to protect it.",
      cleared: "",
    },
  },
  {
    id: "mine",
    // The player already owns a miner — this drill is about commanding it.
    create: null,
    placement: null,
    keepAlive: ["miner"],
    // Four trips = 40 crystals, which is what an astronaut (35) costs plus
    // change. Completing this releases the first alien.
    trigger: { kind: "minerTrips", count: 4 },
    // The miner cannot attack, so this drill must have no opponent.
    opponent: null,
    // Point at the crystals while asking; at the miner once it is working, so
    // the arrow follows the thing the player should be watching.
    arrows: {
      intro: { kind: "nearestCrystal" },
      doing: { kind: "nearestUnit", unit: "miner" },
    },
    cards: {
      title: "Mine your first crystals",
      intro: "Those blue crystals are your income. Click your mining craft, then click the nearest crystals.",
      doing: "It mines and carries it back on its own. Watch the gem count climb.",
      cleared: "That is your economy. It keeps running while you fight.",
    },
  },
  {
    id: "astronaut",
    create: { via: "produce", kind: "astronaut" },
    placement: "anywhere",
    keepAlive: ["miner", "astronaut"],
    trigger: { kind: "crystalsAtLeast", amount: 35 },
    // Hunts the miner on purpose: being threatened is the most teachable moment
    // in the tutorial, and it spawns far enough away to leave ~35s to react.
    opponent: { enemy: "alien", count: 1, spawn: "farFromMiner", hunts: "miner" },
    arrows: {
      intro: { kind: "nearestEnemy" },
      doing: { kind: "interceptTile" },
    },
    cards: {
      title: "Defend your miner",
      intro: "An alien has landed. It is heading for your mining craft.",
      doing: "Amber means spotted. Make an astronaut and put it in the way.",
      cleared: "Astronauts fight, and they build. You will need one for what is next.",
    },
  },
  {
    id: "racer",
    create: { via: "produce", kind: "racer" },
    placement: "anywhere",
    keepAlive: ["miner"],
    trigger: { kind: "crystalsAtLeast", amount: 80 },
    opponent: { enemy: "alienDrake", count: 1, spawn: "south", hunts: "commandCenter" },
    arrows: {
      intro: { kind: "tabletTab", tab: "crafts" },
      doing: { kind: "nearestEnemy" },
    },
    cards: {
      title: "Meet the flyer",
      intro: "Something is flying in.",
      doing: "Racing craft are fast. Produce one and send it at the flyer.",
      cleared: "Different enemies want different answers.",
    },
  },
  {
    id: "turret",
    create: { via: "build", kind: "turret" },
    // The one drill where direction matters — a turret behind the base never
    // fires. Advisory: the step completes on placement anywhere.
    placement: "towardThreat",
    keepAlive: ["miner"],
    trigger: { kind: "crystalsAtLeast", amount: 30 },
    opponent: {
      enemy: "strongAlienMech",
      count: 1,
      spawn: "south",
      hunts: "commandCenter",
    },
    arrows: {
      intro: { kind: "tabletTab", tab: "build" },
      doing: { kind: "threatTile" },
    },
    cards: {
      title: "Build a turret",
      intro: "Turrets fight on their own. Build one on the side the aliens come from.",
      doing: "It fires by itself. Here comes the big one — help it out.",
      cleared: "Wave cleared. Crystals keep coming, the waves get bigger. Good luck.",
    },
  },
  {
    // Sign-off. Not a lesson — it closes the tutorial and hands the player to
    // the real ladder, so they know the training wheels are off.
    id: "done",
    create: null,
    placement: null,
    trigger: { kind: "dwellSeconds", seconds: 8 },
    opponent: null,
    // Nothing left to point at — the tutorial is handing over.
    arrows: { intro: null, doing: null },
    cards: {
      title: "Wave cleared",
      intro: "Crystals keep coming and the waves get bigger. Good luck.",
      doing: "Crystals keep coming and the waves get bigger. Good luck.",
      cleared: "",
    },
  },
];
