/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, closeAccount, rpc } from '../erasure-b2a/cases.mjs';

export async function runPruneSelection(db, report) {
  const foreign = await fixture(db);
  const execution = (await db.query('SELECT b2a_test.bind($1) v', [foreign])).rows[0].v;
  const target = { actor: randomUUID() };
  await db.query('INSERT INTO profiles(id,credits) VALUES($1,0)', [target.actor]);
  await closeAccount(db, target);
  const notices = [];
  const notice = value => { if (value.message.startsWith('ERASURE_PRUNE_TABLE ')) notices.push(value.message); };
  db.on('notice', notice);
  await db.query('BEGIN');
  try {
    await db.query("SET LOCAL client_min_messages='log'");
    const original = (await db.query(`SELECT pg_get_functiondef(
      'public.erasure_business_owner(text,jsonb)'::regprocedure) v`)).rows[0].v;
    await db.query(original.replace('public.erasure_business_owner(', 'public.erasure_test_original_owner('));
    // A deterministic witness for the old all-subject JSON scan, independent of machine speed.
    // The unchanged DELETE guards may still inspect owned rows; unrelated rows must never enter this resolver.
    await db.query(`CREATE OR REPLACE FUNCTION public.erasure_business_owner(t text,j jsonb)
      RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
      DECLARE owner uuid; BEGIN
        owner:=public.erasure_test_original_owner(t,j);
        IF owner IS DISTINCT FROM '${target.actor}'::uuid AND owner IS NOT NULL THEN
          RAISE EXCEPTION 'ERASURE_TEST_FOREIGN_ROW_READ';
        END IF;
        RETURN owner;
      END $$`);
    assert.equal(await rpc(db, 'account_erasure_prune_business', target.actor, 100), 0);
    assert.equal((await db.query('SELECT count(*)::int n FROM runtime_executions WHERE id=$1',
      [execution])).rows[0].n, 1, 'unrelated execution remains');
    assert.ok(notices.some(message => /^ERASURE_PRUNE_TABLE table=runtime_executions phase=done elapsed_ms=/.test(message)));
    for (const message of notices) {
      assert.match(message, /^ERASURE_PRUNE_TABLE table=[a-z_]+ phase=(begin|done) elapsed_ms=[0-9.]+ rows=[0-9]+$/);
      assert.ok(!message.includes(target.actor) && !message.includes(foreign.actor));
      assert.doesNotMatch(message, /PRIVATE|payload|input|filename|token/i);
    }
    report.checks.push('prune selects only its subject before owner/body access; unrelated Runtime survives; per-table logs contain labels and metrics only');
  } finally {
    await db.query('ROLLBACK');
    db.off('notice', notice);
  }
}
