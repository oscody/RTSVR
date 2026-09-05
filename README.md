# RTSVR

A real-time-strategy game for Meta Quest, built on the Immersive Web SDK
(IWSDK 0.4.2 / EliCS / three.js r181). You command a base on a 24×24 Martian
board from a tabletop viewpoint: mine crystals, build turrets and craft, and
hold off waves of aliens.

**Live:** https://oscody.github.io/RTSVR/ — deployed from `master` on every push.

## Requirements

Node **22.12.0** (pinned in `.nvmrc`). Node ≥20.19 or ≥24 also work; every npm
script routes through `scripts/with-supported-node.sh`, which finds a supported
install and refuses to run on anything older.

## Running it

```bash
npm install
npm run dev          # IWSDK dev server + emulator, opens a browser
```

Serves on **https://localhost:8081** and on your LAN address. To open it in a
headset, use the **network** URL from `npm run dev:status` — `localhost` will
not resolve from the Quest, and both devices must be on the same network with
AP isolation off.

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server with the IWSDK runtime manager attached |
| `npm run dev:runtime` | Bare Vite, no runtime manager |
| `npm run dev:status` | Session state and the network URLs |
| `npm run dev:down` | Stop the dev server |
| `npm run dev:logs` | Tail the dev-server log |

**If the browser cannot reach the server**, or `dev:status` reports no session
on a port that is clearly listening: Vite restarted and left a stale session
file. `npm run dev:down && npm run dev` clears it.

## Checks

```bash
npm test             # typecheck + unit tests — the gate CI runs
npm run typecheck    # tsc --noEmit
npm run test:unit    # 519 assertions across 38 files
npm run build        # production bundle into dist/
```

Tests are plain `node --test` with `--experimental-strip-types`, so a module a
test imports must not reach `@iwsdk/core` — that fails at load with
`document is not defined`. Where a system needs testing, the logic lives in a
pure module beside it (`*Rules.ts`, `objectTransitions.ts`) and the thin
`createSystem` wrapper stays untested.

Three tests compare the shipped alien GLBs against uncompressed originals in the
sibling `RTSVR_repos` checkout. They **skip** when it is absent, which is why
CI reports 3 skipped and a full local run reports none.

## Deploying

`.github/workflows/deploy.yml` builds and publishes to GitHub Pages on every
push to `master`. It typechecks and tests first, because Pages serves whatever
is uploaded.

Pages serves a project site from a subpath, so **no asset may be fetched by a
root-absolute path**. `src/app/assetUrl.ts` resolves them against
`import.meta.env.BASE_URL`; `vite.config.ts` keeps `base: "./"` so one build
works at any URL. `tests/asset-url.test.ts` fails the suite if a new
`"/gltf/…"` literal appears.

## Diagnostics

The trace, profiler and action log are **on in development and off in a
production build** — one switch, `DIAGNOSTICS_ENABLED` in
`src/systems/traceFlags.ts`. Override either way:

```bash
VITE_DIAGNOSTICS=on npm run build    # production build that still logs
VITE_DIAGNOSTICS=off npm run dev     # dev server with no logging, for a fair speed comparison
```

That matters for measurement: diagnostics cost roughly **1.2 ms/frame**, and
every timing figure in the devlog was recorded with them on. A clean run is not
the same app.

Console warnings and errors are deliberately never gated — a headset has no
console, and a broken deploy must not look identical to a working one.

## Layout

| Path | |
| --- | --- |
| `src/index.ts` | Asset manifest and system registration order |
| `src/systems/` | 93 ECS systems and the pure `*Rules` modules they read |
| `src/app/` | Landing page, loading screen, asset-URL resolution |
| `ui/` | 4 UIKitML documents, compiled into `public/ui/` at build time |
| `public/` | GLB, audio, images — served as-is |
| `tests/` | Node test suite |
| `scripts/` | Asset optimizers, trace capture, report generators |

UIKitML panel text is **ASCII-only**: the MSDF atlas has no em-dash and no
emoji, and either renders as nothing.

## Branches

`master` is the deploy source — pushing it publishes. `integration` is where
work happens. Design notes, plans and captured device logs live in the sibling
`RTSVR_repos/devlog` repository.
