/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeRateLimitCases } from "../../packages/db/tests/v3/local-rate-limit-case-report.mjs";

test("case reports separate request count, rolling-minute pressure and actual denied responses", () => {
  const boundaries = [
    { event: "begin", id: "a", name: "first", time: 1000 },
    { event: "end", id: "a", time: 65000 },
    { event: "begin", id: "b", name: "second", time: 66000 },
    { event: "end", id: "b", time: 70000 },
  ];
  const events = [2000, 64000, 67000].flatMap((time, id) => [
    { event: "request", id, time, path: "/api/trpc/example" },
    { event: "response", id, time: time + 1, status: id === 2 ? 429 : 200 },
  ]);
  const [first, second] = summarizeRateLimitCases(boundaries, events);
  assert.equal(first.requests, 2);
  assert.equal(first.peakMinute, 1);
  assert.equal(first.limited, 0);
  assert.equal(second.requests, 1);
  assert.equal(second.priorMinute, 1);
  assert.equal(second.limited, 1);
  assert.deepEqual(second.paths["/api/trpc/example"], { requests: 1, limited: 1, http503: 0 });
});

test("legacy execution keeps its Vitest config and dependency context with candidate reset code", async () => {
  const { mkdtempSync, mkdirSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { resolve } = await import("node:path");
  const { installLocalRateLimitCases } = await import("../../packages/db/tests/v3/local-rate-limit-cases.mjs");
  const legacy = mkdtempSync(resolve(tmpdir(), "rate-limit-legacy-test-"));
  try {
    mkdirSync(resolve(legacy, "packages/api"), { recursive: true });
    const candidate = new URL("../../", import.meta.url).pathname;
    const installed = installLocalRateLimitCases(candidate, legacy);
    assert.ok(installed.config.startsWith(legacy));
    assert.match(readFileSync(installed.config, "utf8"), /import original from '.\/vitest.integration.config.ts'/);
    const setup = readFileSync(resolve(legacy, "packages/api/local-rate-limit-test-setup.mjs"), "utf8");
    assert.ok(setup.includes(new URL("../../packages/db/tests/v3/local-rate-limit.mjs", import.meta.url).href));
    assert.match(setup, /from "vitest"/);
  } finally { rmSync(legacy, { recursive: true, force: true }); }
});
