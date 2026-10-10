/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,rpc} from '../erasure-b2a/cases.mjs';
import {erase} from './cases.mjs';
export async function runResearch({db,Client,connectionString,report}){
 const f=await fixture(db),g=(await db.query('SELECT d7_test.artifacts($1) v',[f.actor])).rows[0].v;
 const plan=randomUUID(),operation=randomUUID(),other=randomUUID(),evidence=randomUUID();
 const cost={unit:'agentkey-credit',quoted:1,actual:0.2,status:'reported'};
 await db.query(`INSERT INTO research_plans(id,actor_id,budget_units,max_operations,operations)
  VALUES($1,$2,2000000,2,$3)`,[plan,f.actor,JSON.stringify([operation,other].map(operationId=>({operationId,identityHash:'a'.repeat(64),maxQuoteUnits:1000000})))]);
 await db.query(`INSERT INTO research_operations(id,plan_id,identity_hash,quote_units,dispatch_token,state,result,user_quote_credits,charged_credits,charged_at)
  VALUES($1,$3,$4,1000000,$5,'succeeded',$6,4,4,now()),($2,$3,$4,1000000,$7,'succeeded',$8,4,4,now())`,
  [operation,other,plan,'a'.repeat(64),randomUUID(),{cost,objects:[{fields:{text:'DELETE_RESEARCH_BODY'},sourceUrl:'https://example.invalid/private'}]},randomUUID(),{cost,objects:['KEEP_UNRELATED_RESEARCH']}]);
 await db.query(`INSERT INTO artifact_evidence(id,project_id,kind,operation_id,payload,content_hash)
  VALUES($1,$2,'supplier',$3,'{"result":{"objects":["DELETE_RESEARCH_BODY"]}}',$4)`,[evidence,g.project,operation,'b'.repeat(64)]);
 const before=(await db.query('SELECT identity_hash,quote_units,dispatch_token,user_quote_credits,charged_credits,charged_at FROM research_operations WHERE id=$1',[operation])).rows[0];
 const locker=new Client({connectionString});await locker.connect();
 try{
  await locker.query('BEGIN');await locker.query('SELECT id FROM research_plans WHERE id=$1 FOR UPDATE',[plan]);
  await assert.rejects(erase(db,g,'artifact',g.project),/CONTENT_ERASURE_BUSY/);
  await locker.query('ROLLBACK');
  for(const state of ['prepared','dispatched','unknown']){
   await db.query('UPDATE research_operations SET state=$2 WHERE id=$1',[operation,state]);
   await assert.rejects(erase(db,g,'artifact',g.project),/CONTENT_ERASURE_BUSY/);
   assert.equal((await db.query('SELECT content_deleted_at FROM artifact_projects WHERE id=$1',[g.project])).rows[0].content_deleted_at,null);
  }
  await db.query('UPDATE research_operations SET state=\'succeeded\',pre_deduct_id=$2,charged_credits=NULL WHERE id=$1',[operation,randomUUID()]);
  await assert.rejects(erase(db,g,'artifact',g.project),/CONTENT_ERASURE_BUSY/);
  await db.query('UPDATE research_operations SET pre_deduct_id=NULL,charged_credits=4 WHERE id=$1',[operation]);
  await db.query('BEGIN');await erase(db,g,'artifact',g.project);
  await locker.query("SET statement_timeout='5s'");
  const pid=(await locker.query('SELECT pg_backend_pid() id')).rows[0].id;
  const late=rpc(locker,'research_transition','get',plan,f.actor,operation,{}).then(()=>null,error=>error);
  let waiting=false;
  for(let i=0;i<100&&!waiting;i++){
   waiting=(await db.query("SELECT wait_event_type='Lock' waiting FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.waiting;
   if(!waiting)await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.ok(waiting);await db.query('COMMIT');assert.match(String(await late),/CONTENT_ERASED/);
  assert.equal((await erase(db,g,'artifact',g.project)).alreadyDeleted,true);
  assert.deepEqual((await db.query('SELECT result FROM research_operations WHERE id=$1',[operation])).rows[0].result,{cost});
  assert.deepEqual((await db.query('SELECT identity_hash,quote_units,dispatch_token,user_quote_credits,charged_credits,charged_at FROM research_operations WHERE id=$1',[operation])).rows[0],before);
  assert.match(JSON.stringify(await rpc(db,'research_lookup',f.actor,plan,other)),/KEEP_UNRELATED_RESEARCH/);
  await assert.rejects(rpc(db,'research_lookup',f.actor,plan,operation),/CONTENT_ERASED/);
  for(const action of ['get','reserve','dispatch','finish'])
   await assert.rejects(rpc(db,'research_transition',action,plan,f.actor,operation,{}),/CONTENT_ERASED/);
  await assert.rejects(db.query('UPDATE research_operations SET result=$2 WHERE id=$1',[operation,{objects:['LATE_BODY']}]),/immutable/);
  // Delete the other bound result: the plan can now lose its identity-only snapshot too.
  await db.query(`INSERT INTO artifact_evidence(id,project_id,kind,operation_id,payload,content_hash)
   VALUES($1,$2,'supplier',$3,'{}',$4)`,[randomUUID(),g.workItem,other,'c'.repeat(64)]);
  await erase(db,g,'artifact',g.workItem);
  const cleared=(await db.query('SELECT operations,erased_at FROM research_plans WHERE id=$1',[plan])).rows[0];
  assert.equal(cleared.operations,null);assert.ok(cleared.erased_at);
  report.checks.push('linked research bodies scrubbed to original cost; mixed-plan unrelated result/financial facts preserved; unresolved/settlement/plan locks busy; late read/replay/write denied');
 }finally{await db.query('ROLLBACK');await locker.query('ROLLBACK');await locker.end();}
}
