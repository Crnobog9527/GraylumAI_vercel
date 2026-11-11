/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// The simulated-model browser tests run on `next dev`, and the app's rate limiter refuses a request when Redis has not answered within its own
// 500 ms (packages/api/src/services/redisRateLimiter.ts) or the settings read has failed: both come back as `limit_unavailable`, a 503 on a
// tRPC read or a failed turn. The deadline is measured inside the Next process, so the Redis bridge (redis-shim.mjs) can report nothing slow while
// the app saw a stall of its own: a route compiling on first use, or a garbage collection. This reads what the preload says about stalls
// (preload.cjs) and the "Compiling <route>" lines of the server, and ties them to the test that was running (a test starts with /__sim/reset).
// It measures and reports; it changes nothing about how the tests run.

// One log line per refusal, under a name per limiter (redisRateLimiter.ts, and the web proxy's lib/rateLimit.ts): the per-minute limiter
// says `minute_rate_limit_unavailable_denying_request`, the supplier one `vendor_rate_limit_unavailable_denying_request`, the others
// `…rate_limit_backend_unavailable_denying_request`. Counting only the last spelling left the per-minute refusals out, which are the ones a
// stalled turn start meets (2026-11-11: a run whose journey failed on them reported none of them). Any name of this shape is counted.
const DENIAL = /(\w*rate_limit\w*_denying_request)/;

/** @param {() => number[]} resetTimes epoch ms of every /__sim/reset so far: the first is the warm-up, the n-th the start of test n */
export function createStallWatch(resetTimes) {
  const pending = new Map();
  const loop = [], gc = [], compiles = [];
  const denials = [];
  const read = (line, receivedAt) => {
    const stall = /\[sim-preload\] loop_stall_ms=(\d+) cpu_ms=(\d+) at=(\d+)/.exec(line);
    if (stall) loop.push({ ms: Number(stall[1]), cpu: Number(stall[2]), at: Number(stall[3]) });
    const pause = /\[sim-preload\] gc_pause_ms=(\d+) at=(\d+)/.exec(line);
    if (pause) gc.push({ ms: Number(pause[1]), at: Number(pause[2]) });
    const compile = /Compiling (\S+)/.exec(line);
    if (compile) compiles.push({ route: compile[1], at: receivedAt });
    const denial = DENIAL.exec(line);
    if (denial) denials.push({ name: denial[1], at: receivedAt });
  };
  const testAt = at => resetTimes().filter(time => time <= at).length;
  const tally = keys => { const counts = {}; for (const key of keys) counts[key] = (counts[key] ?? 0) + 1; return counts; };
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
        // busy: stalls in which the process used at least 70% of the stalled time as CPU; idle: the rest (not scheduled, or waiting).
        loopStalls: { count: loop.length, maxMs: Math.max(0, ...loop.map(item => item.ms)),
          busy: loop.filter(item => item.cpu >= 0.7 * item.ms).length, idle: loop.filter(item => item.cpu < 0.7 * item.ms).length,
          longest: [...loop].sort((a, b) => b.ms - a.ms).slice(0, 5).map(item => ({ test: testAt(item.at), ms: item.ms, cpuMs: item.cpu })) },
        gcPauses: { count: gc.length, maxMs: Math.max(0, ...gc.map(item => item.ms)) },
        // Every refusal, the web proxy's included (run.mjs also counts those by their kind); by log name, and by the test it fell in.
        appRateLimitDenials: denials.length,
        rateLimitDenialsByName: tally(denials.map(item => item.name)),
        rateLimitDenialsByTest: tally(denials.map(item => testAt(item.at))),
        stallsByTest: byTest,
        // The first test is the warm-up: whatever compiles after it was not warmed.
        compiledAfterWarmup: compiles.map(item => ({ test: testAt(item.at), route: item.route })).filter(item => item.test >= 2),
      };
    },
  };
}
