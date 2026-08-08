import { BoxGeometry } from "@iwsdk/core";

/**
 * One unit cube reused by every interaction proxy. Proxies differ only in
 * footprint and height, so they scale this instead of allocating a fresh
 * BoxGeometry per unit — one geometry for the whole game rather than one per
 * alien, craft, and building.
 */
export const UNIT_BOX_GEOMETRY = new BoxGeometry(1, 1, 1);
