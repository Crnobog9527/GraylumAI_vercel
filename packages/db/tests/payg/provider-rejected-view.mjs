/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {rpc} from '../erasure-b2a/cases.mjs';
import {claim,receipt} from './fixture.mjs';
import {fixture,proof} from './provider-rejection.mjs';

const read=name=>readFileSync(new URL('../../migrations/'+name,import.meta.url),'utf8');
const migration=read('0169_runtime_provider_rejected_view.sql');
const predecessor=read('0166_payg_runtime.sql');
const original=predecessor.slice(predecessor.indexOf('CREATE OR REPLACE FUNCTION public.runtime_view('),
 predecessor.indexOf('\n;\nCOMMIT;'));
const definition=async db=>(await db.query("SELECT pg_get_functiondef('public.runtime_view(uuid,uuid)'::regprocedure) v")).rows[0].v;
const acl=async db=>(await db.query("SELECT proacl,proowner,prosecdef,proconfig FROM pg_proc WHERE oid='public.runtime_view(uuid,uuid)'::regprocedure")).rows[0];
async function bind(db,f){
 f.execution=(await db.query('SELECT b2a_test.bind($1) id',[f])).rows[0].id;
 f.session=(await db.query('SELECT session_id FROM runtime_executions WHERE id=$1',[f.execution])).rows[0].session_id;
 return f;
}
const view=(db,f,actor=f.actor)=>rpc(db,'runtime_view',actor,f.session);
const turn=async(db,f)=>(await view(db,f)).executions.find(e=>e.executionId===f.execution);
const cancel=(db,f)=>rpc(db,'runtime_cancel',f.actor,f.execution);
const reject=async(db,f,n=1)=>{
 const c=await claim(db,f,n);
 await rpc(db,'bill2_record',f.actor,f.run,c.id,proof(f));
 return c;
};

export async function providerRejectedViewCases(db){
 const finalDefinition=await definition(db),beforeAcl=await acl(db);
 try{
  // A real pre-migration v1/v2 cancellation must acquire the diagnosis without backfill.
  await db.query(original);
  const historical=[];
  for(const version of ['v1','v2']){
   const f=await bind(db,await fixture(db,version));
   await reject(db,f);assert.equal((await cancel(db,f)).state,'cancelled');
   assert.equal((await turn(db,f)).unavailableReason,null);
   historical.push(f);
  }
  const facts=async()=> (await db.query(`SELECT to_jsonb(e) execution,to_jsonb(b) run,
   (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM bill2_calls c WHERE c.run_id=b.id) calls
   FROM runtime_executions e JOIN bill2_runs b ON b.id=e.billing_run_id
   WHERE e.id=ANY($1::uuid[]) ORDER BY e.id`,[historical.map(f=>f.execution)])).rows;
  const priorFacts=await facts();
  // Failure anywhere in this transactional migration restores the source definition and ACL.
  await assert.rejects(db.query(migration.replace(/COMMIT;\s*$/,()=>
   "DO $$ BEGIN RAISE EXCEPTION 'VIEW_TEST_ROLLBACK'; END $$; COMMIT;")),/VIEW_TEST_ROLLBACK/);
  await db.query('ROLLBACK');assert.equal(await definition(db),original);
  assert.deepEqual(await acl(db),beforeAcl);
  await db.query(migration);assert.equal(await definition(db),finalDefinition);
  await db.query(migration);assert.equal(await definition(db),finalDefinition);
  assert.deepEqual(await facts(),priorFacts,'migration never writes execution or billing facts');
  assert.deepEqual(await acl(db),beforeAcl,'security definer, owner, search path and ACL stay identical');
  for(const f of historical){
   const projected=await turn(db,f);
   assert.equal(projected.unavailableReason,'provider_rejected');
   assert.equal(projected.billing.chargedCredits,0);assert.equal(projected.contentAvailable,true);
   assert.ok('cursor' in projected&&'epoch' in projected&&'remainingCalls' in projected);
   assert.deepEqual(await turn(db,f),projected,'fresh read retains the same reason');
   assert.equal((await db.query('SELECT unavailable_reason FROM runtime_executions WHERE id=$1',[f.execution])).rows[0].unavailable_reason,null);
  }
  // Actual role checks: backend may read its actor's session; clients cannot execute the definer.
  const f=historical[0],other=historical[1];
  await db.query('SET ROLE service_role');
  assert.equal((await turn(db,f)).unavailableReason,'provider_rejected');
  await assert.rejects(view(db,f,other.actor),/RUNTIME_SCOPE_DENIED/);
  await assert.rejects(view(db,{...f,session:randomUUID()}),/RUNTIME_SCOPE_DENIED/);
  await db.query('RESET ROLE');
  for(const role of ['anon','authenticated']){
   await db.query('SET ROLE '+role);
   await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[f.actor]);
   await assert.rejects(view(db,f),/permission denied/);
   await assert.rejects(db.query('SELECT provider_rejected FROM bill2_calls LIMIT 1'),/permission denied/);
   await db.query('RESET ROLE');
  }
  await db.query("SELECT set_config('request.jwt.claim.sub','',false)");
  // Preserve explicit reasons and suppress derived reasons after content permission revocation.
  await db.query("UPDATE runtime_executions SET unavailable_reason='provider_history' WHERE id=$1",[f.execution]);
  assert.equal((await turn(db,f)).unavailableReason,'provider_history');
  await db.query('UPDATE runtime_executions SET unavailable_reason=NULL WHERE id=$1',[f.execution]);
  await rpc(db,'bill2_revoke_draft',f.actor,f.draft);
  await assert.rejects(view(db,f),/RUNTIME_SCOPE_DENIED/);

  for(const version of ['v1','v2']){
   for(const scenario of ['rejected','ordinary_cancel','gate_cancel','completed','paid_prefix','zero_prefix','unknown_prefix']){
    if(version==='v2'&&scenario==='unknown_prefix')continue; // v2 denies admitting past an unresolved call.
    const f=await bind(db,await fixture(db,version));
    let expected=null;
    if(scenario==='rejected'){
     await reject(db,f);await cancel(db,f);expected='provider_rejected';
    }else if(scenario==='ordinary_cancel'){
     await cancel(db,f);
    }else if(scenario==='gate_cancel'){
     await claim(db,f,1,false);await cancel(db,f);
    }else if(scenario==='completed'){
     const c=await claim(db,f);await receipt(db,f,c);
     await db.query('UPDATE runtime_executions SET result=$2 WHERE id=$1',[f.execution,{body:'Synthetic complete'}]);
     await cancel(db,f);assert.equal((await turn(db,f)).state,'completed');
    }else{
     const c=await claim(db,f);
     if(scenario!=='unknown_prefix')await receipt(db,f,c,scenario==='paid_prefix'?'0.001':'0');
     await reject(db,f,2);await cancel(db,f);
    }
    const projected=await turn(db,f);
    assert.equal(projected.unavailableReason,expected,version+': '+scenario);
    if(scenario==='paid_prefix')assert.ok(projected.billing.chargedCredits>0);
    if(scenario==='unknown_prefix')assert.equal(projected.state,'cost_pending');
    if(scenario==='rejected'){
     // Synthetic inconsistent financial states must never manufacture a no-charge promise.
     for(const patch of ["conflict=true","charged=1","closed=false","state='cost_pending'"]){
      await db.query('BEGIN');
      await db.query('UPDATE bill2_runs SET '+patch+' WHERE id=$1',[f.run]);
      assert.equal((await turn(db,f)).unavailableReason,null,patch);
      await db.query('ROLLBACK');
     }
     await db.query("UPDATE runtime_executions SET state='completed' WHERE id=$1",[f.execution]);
     assert.equal((await turn(db,f)).unavailableReason,null,'completed cannot be labelled refused');
    }
   }
  }
  // A cross-actor revoked dependency must not expose even the derived notice.
  const dependent=await bind(db,await fixture(db,'v2'));
  await reject(db,dependent);await cancel(db,dependent);
  await db.query('INSERT INTO runtime_history_dependencies(execution_id,dependency_id) VALUES($1,$2)',
   [dependent.execution,historical[0].execution]);
  assert.equal((await turn(db,dependent)).contentAvailable,false);
  assert.equal((await turn(db,dependent)).unavailableReason,null);

  // Source and already-applied target drift both fail before replacing any definition.
  for(const source of [original,finalDefinition]){
   const drift=source.replace('AS $function$','AS $function$\n-- deliberate local test drift');
   await db.query(drift);
   await assert.rejects(db.query(migration),/PROVIDER_REJECTED_VIEW_SOURCE_MISMATCH/);
   await db.query('ROLLBACK');assert.equal(await definition(db),drift);
   assert.deepEqual(await acl(db),beforeAcl);
  }
 }finally{
  await db.query('ROLLBACK');await db.query('RESET ROLE');
  await db.query("SELECT set_config('request.jwt.claim.sub','',false)");
  await db.query(finalDefinition);
 }
}
