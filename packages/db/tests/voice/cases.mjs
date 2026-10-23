/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc,fixture,call,evidence,outcome} from '../erasure-b2a/cases.mjs';
const one=async(db,text,args=[])=>(await db.query(text,args)).rows[0]?.v;
const denied=async(promise,code)=>{await assert.rejects(promise,error=>{if(!String(error.message).includes(code))throw error;return true;},code);};
const PROFILE={tone:'像跟朋友聊天',sentenceLength:'短句多',samples:['VOICE_CANARY sample']};

export async function runCases({db,report}) {
 // Entry points require the service role, as every library function does.
 const svc=async(name,...args)=>{await db.query('SET ROLE service_role');try{return await rpc(db,name,...args);}finally{await db.query('RESET ROLE');}};
 const actor=()=>one(db,'SELECT voice_test.actor() v');
 const doc=(a,name,purpose='authored',n=2,bytes=40)=>one(db,'SELECT voice_test.doc($1,$2,$3,$4,$5) v',[a,name,purpose,n,bytes]);
 const begin=(a,preferred=[],r=randomUUID())=>svc('voice_generation_begin',a,r,preferred);
 const finish=(a,v,result=PROFILE,failure=null)=>svc('voice_generation_finish',a,v,result===null?null:JSON.stringify(result),failure,true);
 const state=a=>svc('voice_state',a);
 const del=(a,d)=>svc('library_delete',a,d,false,false,false);
 const rows=async(table,a)=>Number(await one(db,`SELECT count(*) v FROM ${table} WHERE actor_id=$1`,[a]));

 for(const role of ['anon','authenticated','service_role']){
  await db.query('SET ROLE '+role);
  await denied(rpc(db,'voice_delete_versions',randomUUID(),[]),'permission denied');
  if(role!=='service_role')await denied(rpc(db,'voice_state',randomUUID()),'permission denied');
  await db.query('RESET ROLE');
 }
 report.checks.push('client roles cannot call voice functions; service cannot call private helpers');

 // Corpus: only authored ready documents; preferred ("最像我") first, then newest; capped at 60000 bytes.
 const a=await actor();
 await denied(begin(a),'VOICE_NO_CORPUS');
 await doc(a,'ref.md','reference');
 await denied(begin(a),'VOICE_NO_CORPUS');
 const old=await doc(a,'old.md'),mid=await doc(a,'mid.md',undefined,10,4000),fresh=await doc(a,'new.md',undefined,10,4000);
 const big=await doc(a,'big.md',undefined,20,4000);
 const first=await begin(a,[old]);
 assert.equal(first.replayed,false);
 assert.deepEqual(first.material.map(m=>m.documentId),[old,big],'stops before a segment that would pass the cap');
 const text=first.material.map(m=>m.text).join('');
 assert.ok(Buffer.byteLength(text)<=60000&&!text.includes('ref.md'));
 assert.deepEqual(first.version.sources.map(s=>s.filename),['old.md','big.md']);
 assert.equal((await begin(a,[],randomUUID()).catch(e=>e.message)),'VOICE_GENERATION_BUSY');
 const replay=await svc('voice_generation_begin',a,(await one(db,'SELECT request_id v FROM voice_profile_versions WHERE id=$1',[first.version.id])),[]);
 assert.equal(replay.replayed,true);assert.equal(replay.material,undefined);
 report.checks.push('corpus is authored-only, preferred first, newest next, capped at 60000 bytes; one generation at a time; replay has no text');

 // Unchanged corpus: draft. Confirm makes it current; editing the confirmed one makes a new version.
 let v=await finish(a,first.version.id);
 assert.equal(v.status,'draft');
 let s=await state(a);
 assert.equal(s.latest.id,first.version.id);assert.equal(s.confirmed,null);assert.equal(s.needsUpdate,false);
 s=await svc('voice_profile_confirm',a,first.version.id,s.revision,JSON.stringify({...PROFILE,tone:'改过的'}));
 assert.equal(s.confirmed.id,first.version.id);assert.equal(s.confirmed.profile.tone,'改过的');assert.equal(s.latest,null);
 assert.deepEqual(await svc('voice_profile_current',a),{enabled:true,versionId:first.version.id,version:1});
 await denied(svc('voice_profile_confirm',a,first.version.id,s.revision-1,JSON.stringify(PROFILE)),'VOICE_REVISION_CONFLICT');
 s=await svc('voice_profile_confirm',a,first.version.id,s.revision,JSON.stringify({...PROFILE,tone:'第二版'}));
 const second=s.confirmed.id;
 assert.notEqual(second,first.version.id);assert.equal(s.confirmed.version,2);
 assert.equal(await one(db,'SELECT status v FROM voice_profile_versions WHERE id=$1',[first.version.id]),'superseded');
 assert.equal((await svc('voice_profile_read',a,first.version.id)).profile.tone,'改过的','replays keep their version');
 assert.equal(await svc('voice_profile_read',randomUUID(),second),null,'another account reads nothing');
 report.checks.push('draft -> confirmed; editing confirmed creates a new version; superseded stays readable for replays');

 // The switch.
 s=await svc('voice_profile_set_enabled',a,s.revision,false);
 assert.equal(s.enabled,false);assert.deepEqual(await svc('voice_profile_current',a),{enabled:false,versionId:null,version:null});
 s=await svc('voice_profile_set_enabled',a,s.revision,true);
 assert.equal((await svc('voice_profile_current',a)).versionId,second);
 report.checks.push('"使用我的文风" off: no version is offered for writing');

 // Corpus changes mark the confirmed profile as needing an update; nothing is spent automatically.
 const added=await doc(a,'added.md');
 assert.equal((await state(a)).needsUpdate,true);
 await del(a,added);
 assert.equal((await state(a)).needsUpdate,false);
 await db.query("UPDATE library_documents SET purpose='reference' WHERE id=$1",[mid]);
 assert.equal((await state(a)).needsUpdate,true);
 await db.query("UPDATE library_documents SET purpose='authored' WHERE id=$1",[mid]);
 report.checks.push('adding, deleting or re-purposing an authored document marks the profile "needs update"');

 // Corpus changes during generation: the result never takes effect (LIBRARY-VOICE 必测项 1).
 const g=await begin(a);
 const during=await doc(a,'during.md');
 v=await finish(a,g.version.id);
 assert.equal(v.status,'stale');
 await denied(svc('voice_profile_confirm',a,g.version.id,(await state(a)).revision,JSON.stringify(PROFILE)),'VOICE_STALE');
 await svc('voice_profile_delete',a,g.version.id);
 assert.equal(await one(db,'SELECT count(*)::int v FROM voice_profile_versions WHERE id=$1',[g.version.id]),0);
 await del(a,during);
 report.checks.push('a corpus change during generation leaves the new version stale; it cannot be confirmed');

 // A corpus change after the draft is produced but before it is confirmed: shown stale, refused (review P2).
 const g3=await begin(a);
 v=await finish(a,g3.version.id);assert.equal(v.status,'draft');
 const after=await doc(a,'after.md');
 s=await state(a);assert.equal(s.latest.status,'stale');
 await denied(svc('voice_profile_confirm',a,g3.version.id,s.revision,JSON.stringify(PROFILE)),'VOICE_STALE');
 await del(a,after);
 assert.equal((await state(a)).latest.status,'draft','back to the generated corpus: confirmable again');
 await svc('voice_profile_delete',a,g3.version.id);
 report.checks.push('a corpus change between draft and confirmation is shown stale and refused at confirmation');

 // Failure.
 const f1=await begin(a);
 v=await finish(a,f1.version.id,null,'FORMAT_INVALID');
 assert.equal(v.status,'failed');assert.equal(v.failure,'FORMAT_INVALID');
 await svc('voice_profile_delete',a,f1.version.id);
 report.checks.push('a failed generation is recorded without a profile');

 // Deleting a source document during generation: the version is gone and the late result is dropped.
 const g2=await begin(a,[old]);
 await del(a,old);
 assert.deepEqual(await finish(a,g2.version.id),{status:'deleted'});
 assert.equal(await one(db,'SELECT count(*)::int v FROM voice_profile_versions WHERE id=$1',[g2.version.id]),0);
 // ... and every earlier version that read it, confirmed and superseded alike (必测项 2).
 assert.equal(await svc('voice_profile_read',a,first.version.id),null);
 assert.equal(await svc('voice_profile_read',a,second),null);
 assert.deepEqual(await svc('voice_profile_current',a),{enabled:true,versionId:null,version:null});
 s=await state(a);assert.equal(s.confirmed,null);
 assert.doesNotMatch(JSON.stringify(await one(db,'SELECT jsonb_agg(to_jsonb(x)) v FROM voice_profile_versions x WHERE actor_id=$1',[a])??[]),/old\.md|VOICE_CANARY old/);
 report.checks.push('deleting a source document deletes every version that read it, including one still generating');

 // A closed account can no longer read or change anything.
 const closed=await actor();await doc(closed,'c.md');
 await db.query("UPDATE profiles SET status='deleted',is_deleted='true' WHERE id=$1",[closed]);
 await denied(state(closed),'LIBRARY_ACCOUNT_CLOSED');await denied(begin(closed),'LIBRARY_ACCOUNT_CLOSED');
 assert.deepEqual(await svc('voice_profile_current',randomUUID()),{enabled:true,versionId:null,version:null},'no profile row');
 report.checks.push('closed accounts are refused');

 // Billing receipts of a version whose source was deleted are scrubbed once the run is closed.
 const f=await fixture(db);
 const d=await doc(f.actor,'billed.md');
 const b=await begin(f.actor);
 await svc('voice_generation_bind',f.actor,b.version.id,f.run);
 await finish(f.actor,b.version.id);
 const c=await call(db,f);
 await db.query('SET ROLE service_role');
 await rpc(db,'bill2_record',f.actor,f.run,c.id,evidence(c));
 await db.query('RESET ROLE');
 await del(f.actor,d);
 assert.equal(await one(db,'SELECT count(*)::int v FROM voice_billing_scrubs WHERE run_id=$1',[f.run]),1);
 assert.equal(await svc('voice_billing_scrub',f.run),'waiting','an open run waits');
 await db.query('SET ROLE service_role');
 await rpc(db,'bill2_close',f.actor,f.run,'delivered',outcome);await rpc(db,'bill2_finalize',f.actor,f.run);
 await db.query('RESET ROLE');
 assert.equal(await svc('voice_billing_scrub',f.run),'done');
 assert.equal(await one(db,'SELECT count(*)::int v FROM voice_billing_scrubs WHERE run_id=$1',[f.run]),0);
 assert.ok(await one(db,'SELECT content_deleted_at IS NOT NULL v FROM bill2_runs WHERE id=$1',[f.run]));
 const candidates=await svc('voice_recovery_candidates',50);
 assert.ok(Array.isArray(candidates.generations)&&Array.isArray(candidates.scrubs));
 assert.equal(await svc('voice_run_recovery',f.run).catch(e=>e.message),'permission denied for function voice_run_recovery','binding helper is private');
 report.checks.push('receipts of a deleted source wait for the run to close, then are scrubbed once');

 // Account erasure removes every voice row.
 const e=await actor();const ed=await doc(e,'erase.md');
 const eb=await begin(e);await finish(e,eb.version.id);
 let es=await state(e);await svc('voice_profile_confirm',e,eb.version.id,es.revision,JSON.stringify(PROFILE));
 await db.query("INSERT INTO voice_billing_scrubs(run_id,actor_id) VALUES(gen_random_uuid(),$1)",[e]);
 for(const table of ['voice_profiles','voice_profile_versions','voice_billing_scrubs'])
  assert.equal(await one(db,'SELECT erasure_business_owner($1,$2) v',[table,JSON.stringify({actor_id:e})]),e);
 await db.query("UPDATE profiles SET status='deleted',is_deleted='true' WHERE id=$1",[e]);
 await db.query(`INSERT INTO account_erasure_requests(profile_id,request_id,executor_token,confirmed_at)
  VALUES($1,$2,$3,clock_timestamp()-interval '1 minute')`,[e,randomUUID(),randomUUID()]);
 const before=Number(await one(db,'SELECT account_erasure_business_remaining($1) v',[e]));
 assert.ok(before>=3);
 await svc('library_delete',e,ed,true,false,false);
 assert.equal(await rows('voice_profile_versions',e),0,'closing the library deletes the versions it fed');
 await db.query('SELECT account_erasure_prune_business($1)',[e]);
 for(const table of ['voice_profiles','voice_profile_versions','voice_billing_scrubs'])assert.equal(await rows(table,e),0,table);
 assert.ok(Number(await one(db,'SELECT account_erasure_business_remaining($1) v',[e]))<before);
 report.checks.push('account erasure: library closure deletes versions; prune removes every voice row; remaining counts them');
}
