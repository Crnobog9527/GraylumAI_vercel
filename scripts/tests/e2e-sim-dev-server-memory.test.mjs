/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createMemoryWatch, DEV_SERVER_HEAP_MB, devServerNodeOptions } from "../e2e-sim/dev-server-memory.mjs";

test("the dev server gets the preload and a heap limit above Node's default, as one NODE_OPTIONS string without spaces in the path", () => {
  const options = devServerNodeOptions("/tmp/run/preload.cjs");
  assert.equal(options, `--require=/tmp/run/preload.cjs --max-old-space-size=${DEV_SERVER_HEAP_MB}`);
  // Node's default limit is a quarter of the machine's memory up to about 4 GB (4096 MB on a 16 GB CI runner).
  assert.ok(DEV_SERVER_HEAP_MB > 4096);
  // The CI runner has 16 GB: the heap must leave room for the database, the browser and the simulators.
  assert.ok(DEV_SERVER_HEAP_MB <= 8192);
});

test("restarts, starts and the heap limit are counted from the server's output however it is chunked, and a passing run reports them too", () => {
  const watch = createMemoryWatch();
  const lines = [
    "▲ Next.js 16.4.4 (webpack)", "[sim-preload] heap_size_limit_mb=6192", " ✓ Ready in 5.1s",
    " GET /login 200 in 4.1s", " ⚠ Server is approaching the used memory threshold, restarting...",
    "[sim-preload] heap_size_limit_mb=6192", "[sim-preload] heap_size_limit_mb=6192", " ✓ Ready in 296ms", " GET /app 200 in 3.9s",
  ].join("\n");
  // Split in the middle of the warning line, and again inside "Ready".
  for (const part of [lines.slice(0, 120), lines.slice(120, 210), lines.slice(210)]) watch.feed(part);
  assert.deepEqual(watch.summary(), { starts: 2, restarts: 1, heapLimitMb: 6192 });
});

test("a run with no restart says zero, not nothing", () => {
  const watch = createMemoryWatch();
  watch.feed(" ✓ Ready in 5s\n");
  assert.deepEqual(watch.summary(), { starts: 1, restarts: 0, heapLimitMb: null });
});

test("run.mjs uses the helpers: the heap option and the report line are in the runner", () => {
  const runner = readFileSync(new URL("../e2e-sim/run.mjs", import.meta.url), "utf8");
  assert.match(runner, /NODE_OPTIONS: devServerNodeOptions\(preload\)/);
  assert.match(runner, /memory\.feed\(text\)/);
  assert.match(runner, /dev server memory: \$\{JSON\.stringify\(memory\.summary\(\)\)\}/);
  // The report is printed whether the tests passed or not (before the failure-only block).
  assert.ok(runner.indexOf("dev server memory:") < runner.indexOf("if (code !== 0) console.log"));
});
