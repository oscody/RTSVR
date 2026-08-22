#!/usr/bin/env node
// Capture a DevTools Performance trace straight to a .json.gz file, without
// ever opening the Performance panel.
//
// The panel is a web page that holds the whole trace in JavaScript memory, and a
// Quest session large enough to be interesting kills it: the 569 s capture on
// 2026-08-21 was 2.7 M events / 543 MB of JSON, and Chrome's renderer heap is
// capped at ~4 GB with no way to raise it (`--js-flags=--max-old-space-size`
// is honoured downwards and clamped upwards — measured, don't retry it).
//
// This drives the same tracing backend over the DevTools Protocol and streams
// the result to disk gzipped, so nothing but the browser's own ring buffer ever
// holds it. The output file loads in Perfetto (ui.perfetto.dev) and in the
// Performance panel if it is small enough.
//
// Usage:
//   node scripts/capture-trace.mjs                      # Ctrl+C to stop
//   node scripts/capture-trace.mjs --seconds 60
//   node scripts/capture-trace.mjs --host 192.168.5.3:9222 --label level4
//   node scripts/capture-trace.mjs --screenshots        # opt in, they are big
//
// Connecting to a Quest first:
//   adb forward tcp:9222 localabstract:chrome_devtools_remote
// then leave --host at its default.

import { createWriteStream, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";

const WebSocket = createRequire(import.meta.url)("ws");

/**
 * The app's own tab, matched by the <title> in index.html. Title rather than URL
 * because the dev server's IP and port move with the network and the title does
 * not. Recording this one target instead of the whole browser drops six other
 * renderers — other tabs, and the Quest browser's own chrome:// UI, which
 * contributed 776 stray FunctionCall events to the 2026-08-22 capture. The
 * Browser and GPU processes are still included, so GPUTask and frame data are
 * unaffected; measured side by side, RTSVR's own event counts are identical.
 */
const DEFAULT_TARGET = "RTSVR";

// Matches what the Performance panel records, minus two categories that are
// pure weight for this project:
//   disabled-by-default-v8.inspector  - async-task bookkeeping, 19% of the
//     2026-08-21 trace (500,158 of 2,687,202 events) and used by nothing.
//   disabled-by-default-devtools.screenshot - opt in with --screenshots. In an
//     immersive XR session they stop the moment the headset takes over anyway.
const CATEGORIES = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "disabled-by-default-v8.cpu_profiler", // ProfileChunk: the JS samples
  "v8",
  "v8.execute",
  "disabled-by-default-v8.gc",
  "cppgc",
  "blink.user_timing", // performance.mark(), e.g. gpu-warmup:*
  "blink.console",
  "latencyInfo",
  "loading",
];
// Deliberately absent: "cc", "benchmark", "toplevel", "rail". Enabling those as
// standalone categories drags in the whole compositor/viz firehose — in a 6 s
// self-test they were 94,000 of 136,000 events — and the Performance panel does
// not record them. Frame events still arrive, because they are also tagged
// disabled-by-default-devtools.timeline.frame, which is enabled above.

function parseArgs(argv) {
  const out = { host: "localhost:9222", seconds: 0, label: "", screenshots: false, outDir: null, page: DEFAULT_TARGET };
  // Takes the value after a flag, refusing to swallow the next flag. `--seconds
  // --label x` should say the number is missing, not complain about `x`.
  const value = (flag, i) => {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) fail(`${flag} needs a value`);
    return next;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--host") out.host = value(arg, i++);
    else if (arg === "--page") out.page = value(arg, i++);
    else if (arg === "--all-tabs") out.page = null;
    else if (arg === "--label") out.label = value(arg, i++);
    else if (arg === "--out-dir") out.outDir = value(arg, i++);
    else if (arg === "--seconds") {
      const raw = value(arg, i++);
      out.seconds = Number(raw);
      if (!Number.isFinite(out.seconds) || out.seconds <= 0) fail(`--seconds wants a positive number, got "${raw}"`);
    } else if (arg === "--screenshots") out.screenshots = true;
    else if (arg === "--help" || arg === "-h") { console.log(HELP); process.exit(0); }
    // A bare word is the label. `npm run trace:capture --label x` (no `--`)
    // loses the flag to npm and delivers just the word, so accept that shape.
    else if (!arg.startsWith("-") && !out.label) out.label = arg;
    else fail(`unknown argument: ${arg}`);
  }
  return out;
}
function fail(message) {
  console.error(`${message}\n\n${HELP}`);
  process.exit(2);
}
const HELP = `Usage:
  npm run trace:capture -- [--page match] [--seconds N] [--label name]
                          [--host host:port] [--screenshots]

  By default this records ONLY the "RTSVR" tab, plus the Browser and GPU
  processes it depends on. Other tabs and the headset's own browser UI are left
  out. Nothing of the app's is lost — measured side by side, its event counts
  are identical either way.

  --page <text>  Record a different tab instead (matches title or URL).
  --all-tabs     Record the whole browser. Use this when you suspect something
                 OUTSIDE the app is stealing CPU from it.

  The "--" after the script name is required, or npm keeps the flags for itself.
  Omit --seconds to record until you press ENTER (not Ctrl+C — that kills
  npm and the save with it).

Examples:
  npm run trace:capture -- --label level4
  npm run trace:capture -- --seconds 180 --label level4
  npm run trace:capture -- --all-tabs --label level4-wholebrowser`;

async function getJson(url) {
  const response = await fetch(url, { headers: { Host: "localhost" } });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.json();
}

/**
 * Tracing is a browser-level domain, so the browser endpoint captures every
 * process — renderer, GPU and browser. Some Android/Quest builds do not expose
 * it; a page target still traces, it just sees less.
 */
async function findEndpoint(host, pageMatch) {
  if (pageMatch) {
    const targets = await getJson(`http://${host}/json`);
    const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
    // Exact title first, so a stray tab merely mentioning the app cannot win.
    const page =
      pages.find((t) => t.title === pageMatch) ??
      pages.find((t) => (t.url ?? "").includes(pageMatch) || (t.title ?? "").includes(pageMatch));
    if (!page) {
      const list = pages.map((t) => `    ${t.title} — ${t.url}`).join("\n");
      throw new Error(
        `no tab matching "${pageMatch}". Open the app on the headset, or pass ` +
        `--page <text> / --all-tabs.\n\n  Open tabs:\n${list}`,
      );
    }
    return { url: page.webSocketDebuggerUrl, scope: `${page.title} — ${page.url}`, pageUrl: page.url };
  }
  try {
    const version = await getJson(`http://${host}/json/version`);
    if (version.webSocketDebuggerUrl) {
      return { url: version.webSocketDebuggerUrl, scope: "browser (all tabs)", browser: version.Browser };
    }
  } catch { /* fall through to a page target */ }
  const targets = await getJson(`http://${host}/json`);
  const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) throw new Error(`no debuggable target at ${host}`);
  return { url: page.webSocketDebuggerUrl, scope: `page — ${page.url}`, pageUrl: page.url };
}

function connect(url) {
  return new Promise((ok, fail) => {
    // Chrome rejects websocket upgrades whose Origin it does not recognise; not
    // sending one at all is what the protocol clients do.
    const socket = new WebSocket(url, { perMessageDeflate: false, origin: undefined, maxPayload: 512 * 1024 * 1024 });
    socket.once("open", () => ok(socket));
    socket.once("error", fail);
  });
}

function rpc(socket) {
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.id !== undefined) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.fail(new Error(`${message.error.message} (${message.error.code})`));
      else entry.ok(message.result);
      return;
    }
    for (const handler of listeners.get(message.method) ?? []) handler(message.params);
  });
  return {
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((ok, fail) => {
        pending.set(id, { ok, fail });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    on(method, handler) {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(handler);
    },
  };
}

/** Progress output must never throw: if Ctrl+C killed npm, stdout is a dead pipe. */
function write(text) {
  try { process.stdout.write(text); } catch { /* parent is gone; keep saving */ }
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(args.outDir ?? "../RTSVR_repos/devlog/chrome-performance");
  mkdirSync(outDir, { recursive: true });
  const name = `${stamp()}${args.label ? `-${args.label}` : ""}.json.gz`;
  const outPath = resolve(outDir, name);

  const endpoint = await findEndpoint(args.host, args.page);
  console.log(`target   ${endpoint.scope}${endpoint.browser ? ` — ${endpoint.browser}` : ""}`);
  const socket = await connect(endpoint.url);
  const cdp = rpc(socket);

  const categories = args.screenshots
    ? [...CATEGORIES, "disabled-by-default-devtools.screenshot"]
    : CATEGORIES;

  const complete = new Promise((ok) => cdp.on("Tracing.tracingComplete", ok));
  cdp.on("Tracing.bufferUsage", ({ percentFull, eventCount }) => {
    const pct = percentFull === undefined ? "?" : `${(percentFull * 100).toFixed(0)}%`;
    write(`\r  recording — buffer ${pct}, ${eventCount ?? "?"} events   `);
  });

  await cdp.send("Tracing.start", {
    traceConfig: { recordMode: "recordAsMuchAsPossible", includedCategories: categories },
    transferMode: "ReturnAsStream",
    streamFormat: "json",
    streamCompression: "gzip",
    bufferUsageReportingInterval: 2000,
  });
  console.log(`recording ${categories.length} categories${args.screenshots ? " (with screenshots)" : ""}`);
  console.log(args.seconds ? `stopping after ${args.seconds}s` : "press ENTER to stop and save");

  await new Promise((stop) => {
    let stopped = false;
    const once = () => { if (!stopped) { stopped = true; stop(); } };
    if (args.seconds > 0) setTimeout(once, args.seconds * 1000);
    // ENTER, not Ctrl+C. Ctrl+C signals the whole foreground process group, so
    // running through `npm run` -> `bash` -> node kills the parents first and
    // this process dies mid-save with nothing written. Reading a line uses no
    // signals, so the save always completes.
    if (process.stdin.isTTY) {
      process.stdin.setEncoding("utf8");
      process.stdin.resume();
      process.stdin.once("data", once);
    }
    // Still honour a signal if one arrives, and try to save rather than drop
    // everything recorded so far.
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, once);
  });
  if (process.stdin.isTTY) process.stdin.pause();

  write("\n");
  console.log("stopping…");
  await cdp.send("Tracing.end");
  const { stream } = await complete;
  if (!stream) throw new Error("tracing finished without a stream handle");

  const file = createWriteStream(outPath);
  let bytes = 0;
  for (;;) {
    const chunk = await cdp.send("IO.read", { handle: stream, size: 1 << 20 });
    if (chunk.data) {
      const buffer = Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8");
      bytes += buffer.length;
      if (!file.write(buffer)) await new Promise((r) => file.once("drain", r));
      write(`\r  writing — ${(bytes / 1048576).toFixed(1)} MB   `);
    }
    if (chunk.eof) break;
  }
  await cdp.send("IO.close", { handle: stream });
  await new Promise((r) => file.end(r));
  socket.close();
  write("\n");
  console.log(`saved ${outPath} (${(bytes / 1048576).toFixed(1)} MB gzipped)`);
}

main().catch((error) => {
  console.error(`capture failed: ${error.message}`);
  process.exit(1);
});
