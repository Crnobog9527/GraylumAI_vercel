/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

export async function thresholdMigrationCases(db,report,createFixture,claim,receipt) {
  const read=name=>readFileSync(new URL('../../migrations/'+name,import.meta.url),'utf8');
  const signature='public.bill2_payg_claim(uuid,uuid,integer,jsonb)';
  const source=read('0171_runtime_native_stop.sql');
  const start=source.indexOf('CREATE OR REPLACE FUNCTION public.bill2_payg_claim');
  const reportSource=read('0174_report_generation.sql');
  const patchStart=reportSource.indexOf('  replacement:=$sql$ IF r.payload');
  const patch=reportSource.slice(patchStart+'  replacement:=$sql$'.length,reportSource.indexOf('$sql$||original;',patchStart));
  const anchor=" IF r.session_ref IS NOT NULL AND (coalesce(p->>'runtimeEpoch','')";
  const old=source.slice(start,source.indexOf('$definition$;',start)).replace(anchor,patch+anchor);
  const migration=read('0180_payg_threshold_auto.sql');
  const definition=async()=>(await db.query('SELECT pg_get_functiondef($1::regprocedure) value',[signature])).rows[0].value;
  const acl=async()=>(await db.query(`SELECT proacl::text,prosecdef,proconfig FROM pg_proc WHERE oid=$1::regprocedure`,[signature])).rows[0];
  const current=await definition(),permissions=await acl();
  try {
    await db.query(old);
    const f=await createFixture(db,{q:'100',multiplier:'3',threshold:14});
    const c=await claim(db,f,1,true);
    const snapshot=async()=>(await db.query('SELECT * FROM bill2_calls WHERE id=$1',[c.id])).rows[0];
    const frozen=await snapshot();
    const config=(await db.query("SELECT value FROM system_settings WHERE key='billing_payg_start_thresholds'")).rows[0].value;
    await db.query(migration);
    await db.query(migration);
    // 0234/0235 (FUSION-REVIEW), 0255 and 0268 (RESEARCH-TOOLS), 0285 (refund hold) and 0290 (FUSION-COMPARE, replaces 0235's group admission)
    // patch on top of 0180; re-apply them in order to reach the latest source and grants.
    await db.query(read('0234_fusion_billing_group.sql'));
    await db.query(read('0235_fusion_sessionless_storage.sql'));
    await db.query(read('0255_research_tool_billing.sql'));
    await db.query(read('0268_research_benchmarks.sql'));
    await db.query(read('0285_pay_refunded_pack_hold.sql'));
    await db.query(read('0290_fusion_compare.sql'));
    // D1 also patches claim quarantine. Historical threshold replay must restore
    // that current behavior before comparing the complete function and its ACL.
    await db.query(read('0308_pay_dispute_guard.sql'));
    await db.query(read('0310_fusion_compare_context.sql')); // replaces 0290's fusion_compare_view
    assert.equal(await definition(),current);
    assert.deepEqual(await acl(),permissions);
    assert.deepEqual(await snapshot(),frozen);
    assert.deepEqual((await db.query("SELECT value FROM system_settings WHERE key='billing_payg_start_thresholds'")).rows[0].value,config);
    // Configuration switch affects only the next new claim.
    await db.query(`UPDATE system_settings SET value=$1 WHERE key='billing_payg_start_thresholds'`,[
      {version:'nominal-p50-v2',thresholds:[{model:f.claimPayload.model,purpose:'question',typicalUsd:'0.01'}]},
    ]);
    assert.equal((await claim(db,f,1,false)).id,c.id);
    assert.deepEqual(await snapshot(),frozen);
    await receipt(db,f,c,'0.001',{inputTokens:1000,outputTokens:0});
    assert.equal((await snapshot()).start_threshold,14);
    const next=await claim(db,f,2,false);
    const row=(await db.query('SELECT start_threshold,threshold_version FROM bill2_calls WHERE id=$1',[next.id])).rows[0];
    assert.deepEqual(row,{start_threshold:3,threshold_version:'nominal-p50-v2'});
    report.checks.push('legacy dispatched call survives migration twice and config switch unchanged, settles once; next claim uses new L/version; ACL unchanged');

    await db.query(old);
    await assert.rejects(db.query(migration.replace(/COMMIT;\s*$/,()=>
      "DO $$ BEGIN RAISE EXCEPTION 'THRESHOLD_TEST_ROLLBACK'; END $$; COMMIT;")),/THRESHOLD_TEST_ROLLBACK/);
    await db.query('ROLLBACK');
    assert.equal(await definition(),old);
    const drift=old.replace('AS $function$','AS $function$\n-- local drift fixture');
    await db.query(drift);
    await assert.rejects(db.query(migration),/PAYG_THRESHOLD_SOURCE_MISMATCH/);
    await db.query('ROLLBACK');
    assert.equal(await definition(),drift);
    report.checks.push('migration failure rolls back function; unknown predecessor drift rejected without overwrite');
  } finally {
    await db.query('ROLLBACK');
    await db.query(current);
  }
}
