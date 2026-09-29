/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createLocalRateLimit, localRateLimitNames, resetLocalRateLimit } from "../../packages/db/tests/v3/local-rate-limit.mjs";

function fixture({ failRun = 0, ready = true } = {}) {
  const objects = new Map(), calls = [], tag = "graylum-unit-rate-limit";
  let runs = 0;
  const execute = (args, env) => {
    calls.push({ args, env });
    if (args[1] === "inspect") {
      if (!objects.has(args[2])) throw Object.assign(new Error("missing"), { stderr: "No such object" });
      return JSON.stringify([objects.get(args[2])]);
    }
    if (args[0] === "rm" || (args[0] === "network" && args[1] === "rm")) objects.delete(args.at(-1));
    if (args[0] === "run" || (args[0] === "network" && args[1] === "create")) {
      const name = args[0] === "run" ? args[args.indexOf("--name") + 1] : args.at(-1);
      const [key, value] = args[args.indexOf("--label") + 1].split("=");
      objects.set(name, { Labels: { [key]: value } });
      // Model an ambiguous create result: object exists despite a CLI failure.
      if (args[0] === "run" && ++runs === failRun) throw new Error("synthetic launch failure");
    }
    return args[0] === "port" ? "127.0.0.1:32000" : args[0] === "exec" ? "OK" : "ok";
  };
  const request = async (_url, init) => {
    assert.equal(init.body, '["PING"]');
    assert.match(init.headers.authorization, /^Bearer [a-f0-9]{64}$/);
    return { ok: ready, json: async () => ({ result: "PONG" }) };
  };
  const service = createLocalRateLimit({ tag, ownerId: "unit-owner", execute, request, readinessTimeoutMs: 1 });
  return { service, objects, calls, tag, execute };
}

test("real service arguments isolate Redis, bind REST to loopback and keep random tokens out of argv", async () => {
  const f = fixture();
  const env = await f.service.start();
  assert.equal(f.objects.size, 3);
  assert.equal(env.UPSTASH_REDIS_REST_URL, "http://127.0.0.1:32000");
  const runs = f.calls.filter(({ args }) => args[0] === "run");
  assert.equal(runs[0].args.includes("-p"), false);
  assert.ok(runs[1].args.includes("127.0.0.1::80"));
  assert.equal(runs[0].args[runs[0].args.indexOf("--network") + 1],
    runs[1].args[runs[1].args.indexOf("--network") + 1]);
  assert.equal(runs[1].env.SRH_TOKEN, env.UPSTASH_REDIS_REST_TOKEN);
  assert.equal(JSON.stringify(f.calls.map(c => c.args)).includes(env.UPSTASH_REDIS_REST_TOKEN), false);
  assert.equal(f.service.redact(env.UPSTASH_REDIS_REST_TOKEN), "[LOCAL_RATE_LIMIT_TOKEN]");
  f.service.cleanup();
  f.service.cleanup();
  assert.equal(f.objects.size, 0);
  const next = fixture();
  assert.notEqual((await next.service.start()).UPSTASH_REDIS_REST_TOKEN, env.UPSTASH_REDIS_REST_TOKEN);
  next.service.cleanup();
});

for (const failure of [{ failRun: 1 }, { failRun: 2 }, { ready: false }]) {
  test(`partial startup/readiness failure cleans all newly created resources ${JSON.stringify(failure)}`, async () => {
    const f = fixture(failure);
    await assert.rejects(f.service.start(), /LOCAL_RATE_LIMIT_START_FAILED/);
    assert.equal(f.objects.size, 0);
  });
}

test("foreign resources and unavailable Docker fail closed without removal", async () => {
  const f = fixture();
  f.objects.set(localRateLimitNames(f.tag).redis, { Labels: {} });
  await assert.rejects(f.service.start(), /CLEANUP_FAILED/);
  assert.equal(f.calls.some(({ args }) => args[0] === "rm"), false);
  const broken = createLocalRateLimit({ tag: f.tag, execute: () => { throw new Error("daemon offline"); } });
  await assert.rejects(broken.start(), /CLEANUP_FAILED/);
});

test("runner skips local Redis in without-app mode and always cleans it outside persistent database teardown", () => {
  const runner = readFileSync(new URL("../../packages/db/tests/v3/run-workbench.mjs", import.meta.url), "utf8");
  assert.ok(runner.includes("withoutApp ? null : createLocalRateLimit"));
  assert.ok(runner.includes("...(await localRateLimit?.start())"));
  assert.ok(runner.indexOf("localRateLimit?.cleanup()") < runner.indexOf('runPreviewPhase(previewOptions, "destroyBackendsOnFinally"'));
});


test("case boundary reset targets only the fully owned disposable Redis", async () => {
  const f = fixture();
  await f.service.start();
  resetLocalRateLimit(f.tag, "unit-owner", f.execute);
  assert.deepEqual(f.calls.at(-1).args, ["exec", localRateLimitNames(f.tag).redis, "redis-cli", "FLUSHDB"]);
  const count = () => f.calls.filter(({ args }) => args[0] === "exec").length;
  f.objects.get(localRateLimitNames(f.tag).rest).Labels = {};
  assert.throws(() => resetLocalRateLimit(f.tag, "unit-owner", f.execute), /NOT_OWNED/);
  assert.equal(count(), 1);
  f.objects.delete(localRateLimitNames(f.tag).rest);
  assert.throws(() => resetLocalRateLimit(f.tag, "unit-owner", f.execute), /NOT_READY/);
  assert.equal(count(), 1);
});
