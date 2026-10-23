/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Migration 0345: a writing run is bound to the voice version it used; a deletion stops it immediately.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc,call,evidence,outcome} from '../erasure-b2a/cases.mjs';
import {runtimeFixture} from '../content-erasure/cases.mjs';
const one=async(db,text,args=[])=>(await db.query(text,args)).rows[0]?.v;
const denied=async(promise,code)=>{await assert.rejects(promise,error=>{if(!String(error.message).includes(code))throw error;return true;},code);};
const PROFILE={tone:'像跟朋友聊天',samples:['VOICE_CANARY sample one','VOICE_CANARY sample two']};

export async function runReferences({db,report}) {
 const svc=async(name,...args)=>{await db.query('SET ROLE service_role');try{return await rpc(db,name,...args);}finally{await db.query('RESET ROLE');}};
 const doc=(a,name)=>one(db,'SELECT voice_test.doc($1,$2) v',[a,name]);
 // A confirmed version for actor a, learned from a fresh authored document; returns {version,document}.
 async function confirmed(a,name='ref.md'){
  const document=await doc(a,name);
  const begun=await svc('voice_generation_begin',a,randomUUID(),[]);
  await svc('voice_generation_finish',a,begun.version.id,JSON.stringify(PROFILE),null,true);
  const state=await svc('voice_state',a);
  await svc('voice_profile_confirm',a,begun.version.id,state.revision,JSON.stringify(PROFILE));
  return {version:begun.version.id,document};
 }
 const bind=(execution,actor,version)=>db.query(`UPDATE runtime_executions SET payload=payload||jsonb_build_object('voiceProfile',
  jsonb_build_object('guide','voice-v1','versionId',$3::text,'version',1,'modules',jsonb_build_array(gen_random_uuid()::text))) WHERE id=$1 AND actor_id=$2`,[execution,actor,version]);
 // An execution row as admission inserts it: the AFTER INSERT trigger sees the frozen payload.
 async function admit(a,version){
  const session=await one(db,'SELECT ws_test.free_session($1) v',[a]),id=randomUUID();
  const payload={role:'skill',input:'q',...(version?{voiceProfile:{guide:'voice-v1',versionId:version,version:1,modules:[randomUUID()]}}:{})};
  await db.query(`INSERT INTO runtime_executions(id,actor_id,session_id,request_id,payload,history_revision,state)
   VALUES($1,$2,$3,gen_random_uuid(),$4,0,'running')`,[id,a,session,JSON.stringify(payload)]);
  return id;
 }

 // The reference is frozen with the admission; a stale or unconfirmed version refuses it.
 const a=await one(db,'SELECT voice_test.actor() v');
 const mine=await confirmed(a);
 const bound=await admit(a,mine.version),plain=await admit(a,null);
 assert.equal(await one(db,'SELECT version_id v FROM runtime_voice_references WHERE execution_id=$1',[bound]),mine.version);
 assert.equal(await one(db,'SELECT count(*)::int v FROM runtime_voice_references WHERE execution_id=$1',[plain]),0);
 await denied(admit(a,randomUUID()),'VOICE_REFERENCE_STALE');
 const draft=await svc('voice_generation_begin',a,randomUUID(),[]);
 await db.query("UPDATE voice_profile_versions SET status='draft',profile=$2 WHERE id=$1",[draft.version.id,JSON.stringify(PROFILE)]).catch(()=>undefined);
 await denied(admit(a,draft.version.id),'VOICE_REFERENCE_STALE');
 const other=await one(db,'SELECT voice_test.actor() v');
 await denied(admit(other,mine.version),'VOICE_REFERENCE_STALE');
 report.checks.push('a run binds the voice version it carries; a missing, unconfirmed or another account\'s version refuses the admission');

 // Deleting the version: the bound running execution is source-deleted at once, for read and for every other action.
 const gone=await svc('voice_profile_delete',a,mine.version);
 assert.equal(gone.confirmed,null);
 assert.equal(await one(db,'SELECT runtime_voice_source_gone($1) v',[bound]),true);
 assert.equal(await one(db,'SELECT runtime_voice_source_gone($1) v',[plain]),false);
 const view=await rpc(db,'runtime_execution',a,bound,'read',null);
 assert.equal(view.unavailableReason,'source_deleted');
 assert.equal(await one(db,'SELECT unavailable_reason v FROM runtime_executions WHERE id=$1',[bound]),'source_deleted');
 assert.equal(await one(db,'SELECT unavailable_reason v FROM runtime_executions WHERE id=$1',[plain]),null);
 report.checks.push('deleting a version marks every running execution bound to it source_deleted immediately; unbound runs are untouched');

 // Deleting the source document does the same (it deletes the version first).
 const b=await one(db,'SELECT voice_test.actor() v');
 const viaDoc=await confirmed(b,'via-doc.md');
 const boundDoc=await admit(b,viaDoc.version);
 await svc('library_delete',b,viaDoc.document,false,false,false);
 assert.equal(await one(db,'SELECT runtime_voice_source_gone($1) v',[boundDoc]),true);
 assert.equal((await rpc(db,'runtime_execution',b,boundDoc,'read',null)).unavailableReason,'source_deleted');
 report.checks.push('deleting the authored source document stops the runs bound to its version');

 // A late completion never persists an answer (the answer that used the deleted voice is not shown).
 const pending=await runtimeFixture(db,{dispatched:true});
 const owned=await confirmed(pending.actor,'late.md');
 await db.query('INSERT INTO runtime_voice_references(execution_id,actor_id,version_id) VALUES($1,$2,$3)',[pending.execution,pending.actor,owned.version]);
 await svc('voice_profile_delete',pending.actor,owned.version);
 const result=await rpc(db,'runtime_execution',pending.actor,pending.execution,'complete',outcome);
 assert.equal(result.state,'cost_pending','unknown provider cost remains pending, not refunded');
 assert.equal(await one(db,'SELECT result IS NULL v FROM runtime_executions WHERE id=$1',[pending.execution]),true);
 const read=await rpc(db,'runtime_execution',pending.actor,pending.execution,'read',null);
 assert.equal(read.unavailableReason,'source_deleted');assert.equal(read.result,null);
 await rpc(db,'bill2_record',pending.actor,pending.run,pending.call.id,evidence(pending.call));
 await rpc(db,'runtime_financial_recovery',pending.actor,pending.execution,true);
 assert.equal(await one(db,'SELECT state v FROM runtime_executions WHERE id=$1',[pending.execution]),'cancelled');
 assert.equal(await one(db,'SELECT result IS NULL v FROM runtime_executions WHERE id=$1',[pending.execution]),true);
 assert.equal(await one(db,'SELECT active_execution IS NULL v FROM runtime_sessions WHERE id=$1',[pending.session]),true);
 report.checks.push('a run in flight when the voice is deleted saves and shows no answer; unknown cost waits then settles by the existing deletion-abort rule and releases the session');

 // No NEW provider request is granted once the version is gone.
 const fresh=await runtimeFixture(db,{});
 const held=await confirmed(fresh.actor,'fence.md');
 await db.query('INSERT INTO runtime_voice_references(execution_id,actor_id,version_id) VALUES($1,$2,$3)',[fresh.execution,fresh.actor,held.version]);
 const claim=await call(db,fresh,1,false);
 await svc('voice_profile_delete',fresh.actor,held.version);
 await denied(rpc(db,'bill2_dispatch',fresh.actor,fresh.run,claim.id,claim.dispatchToken),'RUNTIME_CONTEXT_REVOKED');
 const ok=await runtimeFixture(db,{});
 const okClaim=await call(db,ok,1,false);
 assert.equal((await rpc(db,'bill2_dispatch',ok.actor,ok.run,okClaim.id,okClaim.dispatchToken)).dispatch,true);
 report.checks.push('bill2_dispatch refuses a new provider request for a run whose voice is gone; others dispatch as before');

 // Account erasure: the references go with their executions.
 for(const table of ['runtime_voice_references'])
  assert.equal(await one(db,'SELECT erasure_business_owner($1,$2) v',[table,JSON.stringify({actor_id:a})]),a);
 await db.query("UPDATE profiles SET status='deleted',is_deleted='true' WHERE id=$1",[a]);
 await db.query(`INSERT INTO account_erasure_requests(profile_id,request_id,executor_token,confirmed_at)
  VALUES($1,$2,$3,clock_timestamp()-interval '1 minute')`,[a,randomUUID(),randomUUID()]);
 await db.query('SELECT account_erasure_prune_business($1)',[a]);
 assert.equal(await one(db,'SELECT count(*)::int v FROM runtime_voice_references WHERE actor_id=$1',[a]),0);
 report.checks.push('account erasure prunes the voice references before their executions');
}
