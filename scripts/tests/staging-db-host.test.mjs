/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { isSupabaseLikeHost } from '../staging-db-host.mjs';

for (const host of ['synthetic.supabase.co', 'db.synthetic.supabase.co',
  'aws-0-region.pooler.supabase.com']) {
  test(`accepts recognized hostname ${host}`, () => assert.equal(isSupabaseLikeHost(host), true));
}
for (const host of ['evil.pooler.supabase.com.attacker.test', 'supabase.attacker.test',
  'notsupabase.co', 'evil.test/supabase.co', '.supabase.co', 'synthetic.supabase.co\nevil.test']) {
  test(`rejects misleading hostname ${JSON.stringify(host)}`, () => {
    assert.equal(isSupabaseLikeHost(host), false);
  });
}

test('readiness refuses a staging hostname lookalike before attempting a DB connection', () => {
  const result = spawnSync(process.execPath, ['scripts/check-staging-db-readiness.mjs',
    '--confirm-staging', '--json'], {
    cwd: new URL('../../', import.meta.url), encoding: 'utf8', timeout: 5000,
    env: { ...process.env, EXPECTED_APP_HOST: 'staging.example.test',
      NEXT_PUBLIC_APP_URL: 'https://staging.example.test.attacker.test',
      NEXT_PUBLIC_SUPABASE_URL: 'https://synthetic.supabase.co',
      EXPECTED_SUPABASE_PROJECT_REF: 'synthetic',
      DATABASE_URL: 'postgresql://db.synthetic.supabase.co/postgres' },
  });
  assert.equal(result.status, 2);
  const report = JSON.parse(result.stdout);
  assert.equal(report.drift.productionSafetyViolation, true);
  assert.ok(report.environment.productionSignals.some(signal => signal.includes('does not match')));
});
