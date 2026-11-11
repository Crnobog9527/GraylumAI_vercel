/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createStallWatch } from "../e2e-sim/dev-server-stalls.mjs";

const source = path => readFileSync(new URL(path, import.meta.url), "utf8");

test("every limiter's refusal is counted, under its own log name: the per-minute and supplier ones do not say `backend`", () => {
  const watch = createStallWatch(() => []);
  watch.feed([
    '{"level":"error","event":"minute_rate_limit_unavailable_denying_request","prefix":"runtime-start"}',
    '{"level":"error","event":"minute_rate_limit_unavailable_denying_request","prefix":"turn"}',
    '{"level":"error","event":"vendor_rate_limit_unavailable_denying_request"}',
    '{"level":"error","event":"rate_limit_backend_unavailable_denying_request"}',
    '{"level":"error","event":"runtime_rate_limit_backend_unavailable_denying_request"}',
    '{"level":"error","event":"runtime_rate_limit_invalid_configuration_denying_request"}',
    '{"level":"error","event":"web_rate_limit_backend_unavailable_denying_request","failureKind":"timeout"}',
    " GET /app 200 in 31ms",
  ].join("\n") + "\n");
  const summary = watch.summary();
  assert.equal(summary.appRateLimitDenials, 7);
  assert.deepEqual(summary.rateLimitDenialsByName, {
    minute_rate_limit_unavailable_denying_request: 2,
    vendor_rate_limit_unavailable_denying_request: 1,
    rate_limit_backend_unavailable_denying_request: 1,
    runtime_rate_limit_backend_unavailable_denying_request: 1,
    runtime_rate_limit_invalid_configuration_denying_request: 1,
    web_rate_limit_backend_unavailable_denying_request: 1,
  });
});

test("the names the app really logs are all of the counted shape: a limiter added later under another spelling fails here, not silently in a run", () => {
  const logged = [
    ...source("../../packages/api/src/services/redisRateLimiter.ts").matchAll(/'(\w+_denying_request)'/g),
    ...source("../../apps/web/src/lib/rateLimit.ts").matchAll(/'(\w+_denying_request)'/g),
  ].map(match => match[1]);
  assert.ok(logged.includes("minute_rate_limit_unavailable_denying_request"));
  assert.ok(logged.length >= 6, `found ${logged.join(", ")}`);
  for (const name of logged) {
    const watch = createStallWatch(() => []);
    watch.feed(`{"event":"${name}"}\n`);
    assert.deepEqual(watch.summary().rateLimitDenialsByName, { [name]: 1 }, name);
  }
});

test("a refusal is tied to the test it fell in (a test starts with a reset of the simulator), and a line split across chunks is one line", () => {
  const resets = [];
  const watch = createStallWatch(() => resets);
  resets.push(Date.now() - 1000);
  watch.feed('{"event":"minute_rate_limit_unavail');
  watch.feed('able_denying_request"}\n');
  resets.push(Date.now() + 60_000);
  const summary = watch.summary();
  assert.equal(summary.appRateLimitDenials, 1);
  assert.deepEqual(summary.rateLimitDenialsByTest, { 1: 1 });
});

test("no refusal says zero and empty tallies, and the stall figures are still there", () => {
  const watch = createStallWatch(() => [Date.now() - 5000]);
  watch.feed(`[sim-preload] loop_stall_ms=900 cpu_ms=880 at=${Date.now()}\n`, "err");
  const summary = watch.summary();
  assert.equal(summary.appRateLimitDenials, 0);
  assert.deepEqual(summary.rateLimitDenialsByName, {});
  assert.deepEqual(summary.rateLimitDenialsByTest, {});
  assert.equal(summary.loopStalls.count, 1);
  assert.equal(summary.loopStalls.maxMs, 900);
});
