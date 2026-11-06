/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// The simulated-model browser tests run on `next dev`, and the app's rate limiter refuses a request when Redis has not answered within its own
// 500 ms (packages/api/src/services/redisRateLimiter.ts) or the settings read has failed: both come back as `limit_unavailable`, a 503 on a
// tRPC read or a failed turn. The deadline is measured inside the Next process, so the Redis bridge (redis-shim.mjs) can report nothing slow while
// the app saw a stall of its own: a route compiling on first use, or a garbage collection. This reads what the preload says about stalls
// (preload.cjs) and the "Compiling <route>" lines of the server, and ties them to the test that was running (a test starts with /__sim/reset).
// It measures and reports; it changes nothing about how the tests run.

/** @param {() => number[]} resetTimes epoch ms of every /__sim/reset so far: the first is the warm-up, the n-th the start of test n */
export function createStallWatch(resetTimes) {
  const pending = new Map();
  const loop = [], gc = [], compiles = [];
  let denials = 0;
  const read = (line, receivedAt) => {
    const stall = /\[sim-preload\] loop_stall_ms=(\d+) at=(\d+)/.exec(line);
    if (stall) loop.push({ ms: Number(stall[1]), at: Number(stall[2]) });
    const pause = /\[sim-preload\] gc_pause_ms=(\d+) at=(\d+)/.exec(line);
    if (pause) gc.push({ ms: Number(pause[1]), at: Number(pause[2]) });
    const compile = /Compiling (\S+)/.exec(line);
    if (compile) compiles.push({ route: compile[1], at: receivedAt });
    if (line.includes('rate_limit_backend_unavailable_denying_request')) denials += 1;
  };
  const testAt = at => resetTimes().filter(time => time <= at).length;
  return {
    feed(text, stream = 'out') {
      const lines = ((pending.get(stream) ?? '') + text).split('\n');
      pending.set(stream, lines.pop() ?? '');
      const receivedAt = Date.now();
      for (const line of lines) read(line, receivedAt);
    },
    summary() {
      for (const [stream, rest] of pending) { if (rest) read(rest, Date.now()); pending.set(stream, ''); }
      const byTest = {};
      for (const [kind, list] of [['loop', loop], ['gc', gc]])
        for (const { ms, at } of list) {
          const test = testAt(at), slot = (byTest[test] ??= { loop: 0, gc: 0, maxMs: 0 });
          slot[kind] += 1; slot.maxMs = Math.max(slot.maxMs, ms);
        }
      return {
        loopStalls: { count: loop.length, maxMs: Math.max(0, ...loop.map(item => item.ms)) },
        gcPauses: { count: gc.length, maxMs: Math.max(0, ...gc.map(item => item.ms)) },
        appRateLimitDenials: denials,
        stallsByTest: byTest,
        // The first test is the warm-up: whatever compiles after it was not warmed.
        compiledAfterWarmup: compiles.map(item => ({ test: testAt(item.at), route: item.route })).filter(item => item.test >= 2),
      };
    },
  };
}
