/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

// E1 moved production onto www.graylum.com: the staging-only readiness scripts must refuse it, the bare domain
// and the old app host even when EXPECTED_APP_HOST names that host, before any database or Stripe call.
// The text both scripts print (JSON report or refusal message), whichever they produce.
function run(script, appUrl) {
  const host = new URL(appUrl).hostname;
  const result = spawnSync(process.execPath, [`scripts/${script}`, '--confirm-staging', '--json'], {
    cwd: new URL('../../', import.meta.url), encoding: 'utf8', timeout: 10000,
    env: { ...process.env, EXPECTED_APP_HOST: host, NEXT_PUBLIC_APP_URL: appUrl,
      NEXT_PUBLIC_SUPABASE_URL: 'https://synthetic.supabase.co', EXPECTED_SUPABASE_PROJECT_REF: 'synthetic',
      DATABASE_URL: 'postgresql://db.synthetic.supabase.co/postgres', STRIPE_SECRET_KEY: '' },
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

for (const appUrl of ['https://www.graylum.com', 'https://graylum.com', 'https://app.graylum.com']) {
  for (const script of ['check-staging-db-readiness.mjs', 'check-stripe-readiness.mjs']) {
    test(`${script} refuses ${appUrl} as a production host`, () => {
      const { status, output } = run(script, appUrl);
      assert.notEqual(status, 0, output);
      assert.match(output, /production-like host/);
    });
  }
}

test('the staging host itself carries no production-host signal', () => {
  for (const script of ['check-staging-db-readiness.mjs', 'check-stripe-readiness.mjs']) {
    assert.doesNotMatch(run(script, 'https://auth-staging.graylum.com').output, /production-like host/, script);
  }
});
