/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createStallWatch } from '../e2e-sim/dev-server-stalls.mjs';

test('local fetch diagnostics preserve failures without printing sensitive error details', () => {
  const source = `global.fetch=()=>Promise.reject(Object.assign(new Error('secret-canary'),{name:'TimeoutError'}));
    require('./scripts/e2e-sim/redis-diagnostics.cjs');
    fetch('http://127.0.0.1:1234').then(()=>process.exit(2), e=>{if(e.message!=='secret-canary') process.exit(3)});`;
  const result = spawnSync(process.execPath, ['-e', source], { encoding: 'utf8', env: { SIM_REDIS_ORIGIN: 'http://127.0.0.1:1234' } });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /local Redis fetch rejected: TimeoutError/);
  assert.doesNotMatch(result.stderr, /secret-canary/);
  const watch = createStallWatch(() => []);
  watch.feed(result.stderr, 'err');
  assert.deepEqual(watch.summary().redisFetchFailures, { TimeoutError: 1 });
});
