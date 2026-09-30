/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Called only by the disposable, complete-file-built erasure-e local runner.
import assert from 'node:assert/strict';

export function checkVersionPlan(sql) {
  const definition = sql("SELECT pg_get_functiondef('public.opening_grant_remember(uuid,jsonb,boolean)'::regprocedure)");
  const section = definition.slice(definition.indexOf('-- Forgetting a retained version'));
  const match = section.match(/IF EXISTS \(([\s\S]*?)\) THEN/);
  assert.ok(match, 'extract the actual installed version check, not a test-only rewrite');
  const oldQuery = `SELECT 1 FROM public.opening_grant_identity_digests d WHERE d.purpose = 'opening_grant'
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_digests) i WHERE i->>'key_version' = d.key_version)`;
  const versions = ['test-v1', 'test-v2', 'test-v3'];
  const input = selected => JSON.stringify(selected.map(key_version => ({
    kind: 'email', key_version, digest: 'a'.repeat(64),
  })));
  const query = (source, selected = versions) => `SELECT EXISTS (${source.replaceAll(
    'p_digests', `'${input(selected)}'::jsonb`,
  )})`;
  assert.equal(sql(query(match[1], [])), 'f', 'empty retained set');
  sql(`INSERT INTO public.opening_grant_identity_digests(kind,key_version,digest,first_granted_at)
    SELECT 'email','test-v'||(1+n%3),lpad(to_hex(n),64,'0'),'2025-01-01T00:00:00Z'
    FROM generate_series(1,100000) n; VACUUM (ANALYZE) public.opening_grant_identity_digests;`);
  const explain = (source, before = false) => {
    const statement = query(source);
    const prefix = before ? 'BEGIN; DROP INDEX public.opening_grant_identity_versions_idx;' : '';
    const suffix = before ? 'ROLLBACK;' : '';
    const result = JSON.parse(sql(`${prefix} EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}; ${suffix}`))[0];
    console.log(`VERSION PLAN ${before ? 'BEFORE' : 'AFTER'} (100000 synthetic rows, 3 versions)`);
    console.log(sql(`${prefix} EXPLAIN (ANALYZE, BUFFERS) ${statement}; ${suffix}`));
    return result;
  };
  const before = explain(oldQuery, true), after = explain(match[1]);
  const nodes = plan => [plan, ...(plan.Plans ?? []).flatMap(nodes)];
  const oldScans = nodes(before.Plan).filter(p => p['Relation Name'] === 'opening_grant_identity_digests');
  const newScans = nodes(after.Plan).filter(p => p['Relation Name'] === 'opening_grant_identity_digests');
  assert.ok(oldScans.some(p => p['Actual Rows'] * p['Actual Loops'] >= 100000));
  assert.equal(newScans.length, 2, 'initial seek and subsequent distinct-version seek');
  for (const scan of newScans) {
    assert.match(scan['Node Type'], /^Index (Only )?Scan$/);
    assert.equal(scan['Index Name'], 'opening_grant_identity_versions_idx');
    assert.ok(scan['Actual Rows'] <= 1 && scan['Actual Loops'] <= versions.length);
  }
  assert.equal(sql(query(match[1])), 'f', 'all retained versions are present');
  for (const missing of versions) {
    const selected = versions.filter(v => v !== missing);
    assert.equal(sql(query(match[1], selected)), 't', 'missing any version is detected');
    // Exercise both actual entry points as service_role, including a missing non-first version.
    sql(`BEGIN; INSERT INTO public.profiles(id) VALUES ('00000000-0000-4000-8000-000000000151');
      SET LOCAL ROLE service_role;
      DO $$ BEGIN
        BEGIN
          PERFORM opening_grant_claim('00000000-0000-4000-8000-000000000151','${input(selected)}');
          RAISE EXCEPTION 'TEST_EXPECTED_VERSION_FAILURE';
        EXCEPTION WHEN invalid_parameter_value THEN
          IF SQLERRM <> 'OPENING_GRANT_KEY_VERSION_MISSING' THEN RAISE; END IF;
        END;
        BEGIN
          PERFORM account_erasure_confirm_with_digests('00000000-0000-4000-8000-000000000151',
            '00000000-0000-4000-8000-000000000152','${input(selected)}');
          RAISE EXCEPTION 'TEST_EXPECTED_VERSION_FAILURE';
        EXCEPTION WHEN invalid_parameter_value THEN
          IF SQLERRM <> 'OPENING_GRANT_KEY_VERSION_MISSING' THEN RAISE; END IF;
        END;
      END $$; ROLLBACK;`);
  }
  console.log(`VERSION PLAN summary: before ${before['Execution Time']} ms / ${before.Plan['Shared Hit Blocks']} shared hits;`
    + ` after ${after['Execution Time']} ms / ${after.Plan['Shared Hit Blocks']} shared hits`);
  // Only this disposable fixture is removed; restore an empty version set for the Auth tests.
  sql('TRUNCATE public.opening_grant_identity_digests;');
  console.log('PASS version seeks, empty/all/missing sets and both service-only entry points');
}
