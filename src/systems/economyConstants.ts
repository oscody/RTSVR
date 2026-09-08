export const STARTING_CRYSTALS = 0;

export const DEFAULT_RESOURCE_CAPACITY = 50;
export const DEFAULT_RESOURCE_AMOUNT_PER_TRIP = 10;
export const MINING_GATHER_TIME_SECONDS = 5;
/**
 * How long a miner stands at the command center before its cargo is credited.
 *
 * Was zero until 2026-09-08 — the deposit branch had no timer, so a miner
 * arrived and left inside one frame (~11 ms) and read as bouncing off the base
 * rather than delivering to it. Against a ~13 s round trip this is ~11% of the
 * loop, so it is an economy number as much as a visual one: raising it lowers
 * crystals per minute proportionally.
 */
export const MINING_DEPOSIT_TIME_SECONDS = 1.5;

export const LARGE_CRYSTAL_NODE_CAPACITY = 1000;
export const SMALL_CRYSTAL_NODE_CAPACITY = 100;
