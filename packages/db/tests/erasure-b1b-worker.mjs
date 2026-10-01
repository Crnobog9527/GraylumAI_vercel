/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Confirmation uses a synthetic prehashed identity fixture; never a real identity or key.
// Real C background worker; all installation and markers live only in the disposable container.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { actorFixture } from './erasure-b1b-barrier-fixtures.mjs';

export async function backgroundWorker({ q, exec }) {
  exec(['apk', 'add', '--no-cache', 'gcc', 'musl-dev']);
  exec(['sh', '-c', 'cat > /tmp/b1b-worker.c'], readFileSync(new URL('./erasure-b1b-worker.c', import.meta.url)));
  exec(['cc', '-shared', '-fPIC', '-I/usr/local/include/postgresql/server',
    '-I/usr/local/include/postgresql/internal', '-o', '/usr/local/lib/postgresql/b1b_worker_proof.so', '/tmp/b1b-worker.c']);
  q(`CREATE TABLE b1b_worker_fixture(actor uuid NOT NULL REFERENCES profiles(id));
    CREATE FUNCTION b1b_proof_launch(boolean) RETURNS integer
      AS '$libdir/b1b_worker_proof', 'b1b_proof_launch' LANGUAGE C`);
  const wait = async (read, expected) => {
    const until = Date.now() + 10000;
    while (read() !== expected) {
      assert.ok(Date.now() < until, 'Real background worker synchronization timeout');
      await new Promise(done => setTimeout(done, 20));
    }
  };
  const marker = name => wait(() => exec(['sh', '-c',
    `test -f /tmp/b1b-proof-${name} && echo ready || true`]), 'ready');
  const observe = () => JSON.parse(q(`SELECT json_build_object(
    'state',a.state,'xact_start_null',a.xact_start IS NULL,
    'xid_null',a.backend_xid IS NULL,'xmin_null',a.backend_xmin IS NULL,
    'row_candidate',public.account_erasure_activity_safe(a.backend_type,a.state,
      a.xact_start,a.backend_xid,a.backend_xmin,clock_timestamp()),
    'has_virtual_xact',EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=a.pid
      AND l.locktype='virtualxid' AND l.mode='ExclusiveLock' AND l.granted))
    FROM pg_stat_activity a WHERE a.backend_type='b1b proof worker'`));
  try {
    for (const disabled of [false, true]) {
      exec(['sh', '-c', 'rm -f /tmp/b1b-proof-ready /tmp/b1b-proof-resume /tmp/b1b-proof-finished /tmp/b1b-proof-exit']);
      const actor = actorFixture(q);
      q(`TRUNCATE b1b_worker_fixture; INSERT INTO b1b_worker_fixture VALUES('${actor}')`);
      q(`SELECT b1b_proof_launch(${disabled})`);
      await marker('ready');
      const before = observe();
      assert.deepEqual(before, { state: null, xact_start_null: disabled, xid_null: true,
        xmin_null: true, row_candidate: disabled, has_virtual_xact: true });
      q(`SET ROLE service_role; SELECT account_erasure_confirm_with_digests('${actor}',gen_random_uuid(),
      jsonb_build_array(jsonb_build_object('kind','email','key_version','test-v1','digest',repeat('b',64))))`);
      for (const name of ['account_erasure_scrub_content', 'account_erasure_scrub_runtime']) {
        const result = JSON.parse(q(`SET ROLE service_role; SELECT ${name}('${actor}')`));
        assert.deepEqual(result, { retry: true, reason: 'transactions_pending' });
      }
      assert.equal(q(`SELECT (SELECT count(*) FROM agent_confirmed_preferences WHERE actor_id='${actor}')
        + (SELECT count(*) FROM runtime_sessions WHERE actor_id='${actor}')`), '0');
      exec(['touch', '/tmp/b1b-proof-resume']);
      await marker('finished');
      assert.deepEqual(observe(), { state: null, xact_start_null: true, xid_null: true,
        xmin_null: true, row_candidate: true, has_virtual_xact: false });
      assert.equal(q(`SELECT (SELECT count(*) FROM agent_confirmed_preferences WHERE actor_id='${actor}')
        + (SELECT count(*) FROM runtime_sessions WHERE actor_id='${actor}' AND start_payload IS NOT NULL)`), '2');
      for (const name of ['account_erasure_scrub_content', 'account_erasure_scrub_runtime']) {
        const result = JSON.parse(q(`SET ROLE service_role; SELECT ${name}('${actor}')`));
        assert.equal(result.retry, undefined);
      }
      assert.equal(q(`SELECT (SELECT count(*) FROM agent_confirmed_preferences WHERE actor_id='${actor}')
        + (SELECT count(*) FROM runtime_sessions WHERE actor_id='${actor}' AND erased_at IS NULL)`), '0');
      assert.equal(q(`SELECT count(*) FROM runtime_sessions WHERE actor_id='${actor}'
        AND erased_at IS NOT NULL AND scope IS NULL AND start_payload IS NULL`), '1');
      exec(['touch', '/tmp/b1b-proof-exit']);
      await wait(() => q("SELECT count(*) FROM pg_stat_activity WHERE backend_type='b1b proof worker'"), '0');
      console.log(`PASS real NULL-state worker (tracking ${disabled ? 'off' : 'on'}): double-NULL transaction blocks;
        committed idle worker passes and both scrub channels clear late content`);
    }
  } finally {
    exec(['touch', '/tmp/b1b-proof-resume', '/tmp/b1b-proof-exit']);
    await wait(() => q("SELECT count(*) FROM pg_stat_activity WHERE backend_type='b1b proof worker'"), '0');
    q('DROP FUNCTION b1b_proof_launch(boolean); DROP TABLE b1b_worker_fixture');
  }
}
