/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMemoryWatch, devServerNodeOptions, withoutMeasurements } from "../e2e-sim/dev-server-memory.mjs";

const preload = fileURLToPath(new URL("../e2e-sim/preload.cjs", import.meta.url));

test("the dev server gets the preload and no heap option: Next's launcher already gives it half of the machine's memory, and an option here would only lower that", () => {
  assert.equal(devServerNodeOptions("/tmp/run/preload.cjs"), "--require=/tmp/run/preload.cjs");
  assert.doesNotMatch(readFileSync(new URL("../e2e-sim/run.mjs", import.meta.url), "utf8"), /max-old-space-size/);
});

test("restarts, starts, the heap limit and the peak used heap are counted from the server's output however it is chunked", () => {
  const watch = createMemoryWatch();
  const out = [" ✓ Ready in 5.1s", " GET /login 200 in 4.1s", " ⚠ Server is approaching the used memory threshold, restarting...", " ✓ Ready in 296ms"].join("\n");
  const err = ["[sim-preload] heap_size_limit_mb=8192", "[sim-preload] heap_used_mb=2100", "[sim-preload] heap_used_mb=6600", "[sim-preload] heap_used_mb=900"].join("\n");
  // Split in the middle of a line, with the two streams interleaved: a half line of one stream never joins a half line of the other.
  watch.feed(out.slice(0, 70), "out"); watch.feed(err.slice(0, 40), "err");
  watch.feed(out.slice(70), "out"); watch.feed(err.slice(40), "err");
  assert.deepEqual(watch.summary(), { starts: 2, restarts: 1, heapLimitMb: 8192, peakHeapUsedMb: 6600 });
});

test("a run with no restart says zero and no measurement says null, not nothing", () => {
  const watch = createMemoryWatch();
  watch.feed(" ✓ Ready in 5s\n");
  assert.deepEqual(watch.summary(), { starts: 1, restarts: 0, heapLimitMb: null, peakHeapUsedMb: null });
});

test("measurement lines are kept out of the log tail the runner prints on a failure", () => {
  assert.equal(withoutMeasurements("a\n[sim-preload] heap_used_mb=12\nb\n[sim-preload] heap_size_limit_mb=1"), "a\nb\n");
});

test("only the Next server process measures, on stderr: tsc --showConfig, whose stdout Next parses as JSON, gets nothing", () => {
  const env = { ...process.env, SIM_ORIGIN: "http://127.0.0.1:1" };
  const other = spawnSync(process.execPath, ["--require", preload, "-e", "console.log('{}')"], { env, encoding: "utf8" });
  assert.equal(other.stdout, "{}\n");
  assert.equal(other.stderr, "");
  const directory = mkdtempSync(join(tmpdir(), "sim-preload-"));
  const server = join(directory, "start-server.js");
  writeFileSync(server, "0");
  const started = spawnSync(process.execPath, ["--require", preload, server], { env, encoding: "utf8" });
  assert.equal(started.stdout, "");
  assert.match(started.stderr, /^\[sim-preload\] heap_size_limit_mb=\d+\n/);
});

test("run.mjs feeds both streams to the watch and prints the report whether the tests passed or not", () => {
  const runner = readFileSync(new URL("../e2e-sim/run.mjs", import.meta.url), "utf8");
  assert.match(runner, /NODE_OPTIONS: devServerNodeOptions\(preload\)/);
  assert.match(runner, /memory\.feed\(raw, out === app\.stdout \? 'out' : 'err'\)/);
  assert.match(runner, /dev server memory: \$\{JSON\.stringify\(memory\.summary\(\)\)\}/);
  assert.ok(runner.indexOf("dev server memory:") < runner.indexOf("if (code !== 0) console.log"));
});
