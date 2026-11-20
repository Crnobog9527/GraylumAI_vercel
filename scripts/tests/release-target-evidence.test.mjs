/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkEvidence } from '../release-target-evidence.mjs';
const fixture = () => ({
  deployment: { projectId: 'prj_N9BO48YSAYBQ5Nrvzd3WA9wrQEpC', hostname: 'auth-staging.graylum.com', branch: 'staging',
    state: 'READY', id: 'dpl_123', commit: 'a'.repeat(40) },
  runtime: { deploymentId: 'dpl_123', commit: 'a'.repeat(40), supabaseUrl: 'https://gvcpmcunmfrbxuwimxfa.supabase.co',
    turnDatabaseHost: 'gvcpmcunmfrbxuwimxfa.supabase.co', source: 'synthetic' },
  database: { projectRef: 'gvcpmcunmfrbxuwimxfa', maintenance: false, source: 'synthetic' },
});
test('matching synthetic fields are consistent, without asserting evidence authenticity', () => assert.equal(checkEvidence(fixture()), null));
test('missing fields, wrong targets and maintenance fail', () => {
  for (const mutate of [x => delete x.runtime, x => { x.deployment.projectId = 'other'; },
    x => { x.runtime.deploymentId = 'dpl_other'; }, x => { x.runtime.turnDatabaseHost = 'wrong'; },
    x => { x.database.maintenance = true; }, x => { x.database.projectRef = 'wrong'; }]) {
    const data = fixture(); mutate(data); assert.ok(checkEvidence(data));
  }
});
