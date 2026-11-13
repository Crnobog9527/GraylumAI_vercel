/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// CORE-PATH-V2 V2-12 B7 (kind=voice): "学习我的文风" on the turn core. No conversation, metered by usage, paid only when a usable profile
// was saved, void when its version is deleted, refunded in full on every other end.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function voiceCases(t){
 const {c,one,open,begin,identity,record,balance,account,policy,refusal,report}=t;
 const q=100,m=6;
 const profile={tone:'口语',sentenceLength:'短',openings:'吐槽',stance:'温和',phrases:[],avoid:[],platforms:'样文不足以判断各平台差异',samples:['a','b']};
 const version=async(a,{corpus='[]'}={})=>{
  const id=randomUUID();
  await c.query("insert into voice_profile_versions(id,actor_id,request_id,version,status,corpus) values($1,$2,$3,1,'generating',$4::jsonb)",
   [id,a.actor,randomUUID(),corpus]);
  return id;
 };
 const voicePolicy=(id,over={})=>policy({gCredits:30,minCredits:10,uModelCredits:30,historyItems:0,
  limits:{model:1,paidTools:0,freeTools:0},voice:{versionId:id},...over});
 const openVoice=(a,id,{request=randomUUID(),over={},client=c,session=null}={})=>
  open(a,{kind:'voice',session,request,pol:voicePolicy(id,over),client});
 const closeVoice=(a,turn,kind,{result,delivered=kind==='completed',refundAll=false}={})=>
  one("select turn_close($1,$2,$3,'[]',$4,$5,null,$6) v",[a.actor,turn,kind,delivered,refundAll,result===undefined?null:JSON.stringify(result)]);
 const call=async(a,turn,seq=1)=>{await begin(a,turn,seq,{upper:0.05});await identity(a,turn,seq);await record(a,turn,seq,{n:0.01,actual:0.01});};
 const status=id=>one('select status v from voice_profile_versions where id=$1',[id]);
 const raws=turn=>one('select count(*)::int v from turn_call_raw where turn_id=$1',[turn]);

 // 1. Opens without a conversation, freezes like any metered turn, answers whether the version is still generating.
 {
  const a=await account(1000),id=await version(a),o=await openVoice(a,id);
  assert.equal(o.state,'running');
  assert.equal(o.kindContext.generating,true);
  assert.deepEqual(o.history,[]);
  assert.equal(await balance(a),970,'H = min(G, available)');
  assert.equal(await one('select session_id v from turns where id=$1',[o.turnId]),null);
  assert.equal(await one('select active_turn_id v from runtime_sessions where id=$1',[a.session]),null,'no conversation is occupied');
  // A conversation open at the same time is no obstacle, and a voice turn is no obstacle to it.
  const chat=await open(a);
  assert.equal(chat.state,'running');
  await closeVoice(a,o.turnId,'failed',{refundAll:true});
  report.checks.push('voice: opens without a conversation, freezes once, blocks no conversation');
 }
 // 2. Refused: nothing is frozen.
 {
  const a=await account(1000),id=await version(a);
  const refused=async(promise,pattern)=>{assert.match(await refusal(promise),pattern);assert.equal(await balance(a),1000,'a refused voice turn freezes nothing');};
  await refused(openVoice(a,id,{session:a.session}),/TURN_SESSION_DENIED/);
  await refused(openVoice(a,id,{over:{voice:{versionId:id,extra:1}}}),/TURN_POLICY_INVALID/);
  await refused(openVoice(a,id,{over:{voice:{versionId:'not-a-uuid'}}}),/TURN_POLICY_INVALID/);
  await refused(openVoice(a,id,{over:{limits:{model:2,paidTools:0,freeTools:1}}}),/TURN_POLICY_INVALID/);
  await refused(openVoice(a,id,{over:{fixedCredits:30}}),/TURN_POLICY_INVALID/);
  await refused(openVoice(a,id,{over:{minCredits:2000}}),/TURN_INSUFFICIENT_CREDITS/);
  const {voice:_v,...plain}=voicePolicy(id);
  assert.match(await refusal(open(a,{kind:'voice',session:null,pol:plain})),/TURN_POLICY_INVALID/);
  // Another account's version, or none: the turn may open (nothing to write), but is told nothing is generating.
  const other=await account(1000),mine=await openVoice(other,id);
  assert.equal(mine.kindContext.generating,false);
  await closeVoice(other,mine.turnId,'failed',{refundAll:true});
  report.checks.push('voice: every refusal (session, shape, limits, fixed price, threshold) freezes nothing');
 }
 // 3. Delivered: the profile is saved with the close, charged by usage, the receipt kept.
 {
  const a=await account(1000),id=await version(a),o=await openVoice(a,id);
  await call(a,o.turnId);
  assert.equal(await raws(o.turnId),1,'the receipt is kept (no conversation to tombstone)');
  const closed=await closeVoice(a,o.turnId,'completed',{result:{versionId:id,profile}});
  assert.equal(closed.closeKind,'completed');
  assert.equal(closed.chargedCredits,Math.ceil(q*0.01*m),'by usage: N = ceil(q x n x m)');
  assert.equal(await balance(a),1000-Math.ceil(q*0.01*m));
  assert.equal(await status(id),'draft');
  assert.deepEqual(await one('select profile v from voice_profile_versions where id=$1',[id]),profile);
  assert.equal(await one('select billing_settled v from voice_profile_versions where id=$1',[id]),true);
  assert.equal((await closeVoice(a,o.turnId,'completed',{result:{versionId:id,profile}})).replay,true);
  assert.equal(await balance(a),1000-Math.ceil(q*0.01*m),'a second close charges nothing more');
  report.checks.push('voice: a saved profile is charged by usage, once; the version becomes a draft');
 }
 // 4. A corpus that changed meanwhile makes the saved version stale; the profile is still kept for the user to see.
 {
  const a=await account(1000),id=await version(a,{corpus:'["changed"]'}),o=await openVoice(a,id);
  await call(a,o.turnId);
  await closeVoice(a,o.turnId,'completed',{result:{versionId:id,profile}});
  assert.equal(await status(id),'stale');
  report.checks.push('voice: a changed corpus saves the version as stale');
 }
 // 5. No usable profile pays nothing, whatever the call cost: unusable answer, unknown end, recovery.
 {
  const a=await account(1000),id=await version(a),o=await openVoice(a,id);
  await call(a,o.turnId);
  const failed=await closeVoice(a,o.turnId,'failed',{refundAll:true});
  assert.equal(failed.chargedCredits,0);
  assert.equal(await balance(a),1000);
  assert.equal(await status(id),'generating','the caller marks the version failed (voice_generation_finish)');
  const b=await account(1000),idb=await version(b),ob=await openVoice(b,idb);
  await call(b,ob.turnId);
  const notDelivered=await closeVoice(b,ob.turnId,'completed',{delivered:false});
  assert.equal(notDelivered.chargedCredits,0,'a completed close without a delivered profile pays nothing');
  assert.equal(await balance(b),1000);
  // A crash: the recovery's interrupt refunds, even though a call was receipted.
  const r=await account(1000),idr=await version(r),or=await openVoice(r,idr);
  await call(r,or.turnId);
  await c.query("update turns set updated_at=now()-interval '20 minutes' where id=$1",[or.turnId]);
  const recovered=await one("select turn_recover($1,$2,'interrupt') v",[r.actor,or.turnId]);
  assert.equal(recovered.closeKind,'interrupted');
  assert.equal(recovered.chargedCredits,0);
  assert.equal(await balance(r),1000);
  report.checks.push('voice: no saved profile, no charge (failed, undelivered, interrupted by recovery)');
 }
 // 6. The version deleted while it generates: the work is void (erased), nothing is saved or charged, the receipts go.
 {
  const a=await account(1000),id=await version(a),o=await openVoice(a,id);
  await call(a,o.turnId);
  assert.equal(await raws(o.turnId),1);
  await c.query('select voice_delete_versions($1,$2)',[a.actor,[id]]);
  assert.equal(await raws(o.turnId),0,'the receipts of a deleted version go with it');
  // The limit is one call: asking for it again is a replay, and a replay carries the tombstones too.
  const next=await begin(a,o.turnId,1,{upper:0.05});
  assert.equal(next.voiceSourceRevoked,true,'the next call sees the deletion and the caller stops');
  assert.equal(next.sessionTombstoned,false,'a voice turn has no conversation to be tombstoned');
  const closed=await closeVoice(a,o.turnId,'completed',{result:{versionId:id,profile}});
  assert.equal(closed.closeKind,'erased');
  assert.equal(closed.chargedCredits,0);
  assert.equal(await balance(a),1000);
  assert.equal(await one('select count(*)::int v from voice_profile_versions where id=$1',[id]),0);
  // A receipt that arrives after the deletion stores nothing (the answer quotes the user's documents).
  const late=await account(1000),lateId=await version(late),lateTurn=await openVoice(late,lateId);
  await begin(late,lateTurn.turnId,1,{upper:0.05});
  await identity(late,lateTurn.turnId,1);
  await c.query('select voice_delete_versions($1,$2)',[late.actor,[lateId]]);
  const receipt=await record(late,lateTurn.turnId,1);
  assert.equal(receipt.voiceSourceRevoked,true);
  assert.equal(await raws(lateTurn.turnId),0,'a receipt after the deletion keeps no answer');
  await closeVoice(late,lateTurn.turnId,'completed',{result:{versionId:lateId,profile}});
  report.checks.push('voice: a version deleted mid-generation voids the turn: erased, nothing saved or charged, receipts removed');
 }
 // 7. A kind result that does not name this turn's version is refused; the same request is the same turn and one freeze.
 {
  const a=await account(1000),id=await version(a),req=randomUUID(),o=await openVoice(a,id,{request:req});
  const again=await openVoice(a,id,{request:req});
  assert.equal(again.replay,true);
  assert.equal(again.turnId,o.turnId);
  assert.equal(await balance(a),970,'one freeze');
  assert.match(await refusal(closeVoice(a,o.turnId,'completed',{result:{versionId:randomUUID(),profile}})),/TURN_KIND_RESULT_INVALID/);
  assert.match(await refusal(closeVoice(a,o.turnId,'completed',{result:{versionId:id}})),/TURN_KIND_RESULT_INVALID/);
  assert.match(await refusal(open(a,{kind:'chat',session:a.session,request:req})),/TURN_REQUEST_CONFLICT/);
  await call(a,o.turnId);
  await closeVoice(a,o.turnId,'completed',{result:{versionId:id,profile}});
  const settled=await balance(a);
  const replay=await openVoice(a,id,{request:req});
  assert.equal(replay.replay,true);
  assert.equal(replay.kindContext.generating,false,'a finished request is told nothing is generating');
  assert.equal(await balance(a),settled);
  report.checks.push('voice: a repeated request is one turn and one charge; a result for another version is refused');
 }
 // 8. VOICE-2 PR-1 (0543): the code-computed stats and the documents' labels are saved with the profile, only for documents the
 // version read; a malformed label set or an unknown key is refused; an edit of the confirmed profile copies them; the user can
 // correct one document's label on their own version only.
 {
  const read=randomUUID(),stranger=randomUUID();
  const sources=JSON.stringify([{documentId:read,contentVersion:1}]);
  const a=await account(1000),id=randomUUID();
  await c.query("insert into voice_profile_versions(id,actor_id,request_id,version,status,sources) values($1,$2,$3,1,'generating',$4::jsonb)",
   [id,a.actor,randomUUID(),sources]);
  const o=await openVoice(a,id);await call(a,o.turnId);
  const stats={documents:1,sentences:3,avgSentenceChars:12};
  const bad=async(extra,why)=>assert.match(await refusal(closeVoice(a,o.turnId,'completed',{result:{versionId:id,profile,...extra}})),
   /TURN_KIND_RESULT_INVALID/,why);
  await bad({stats:[1]},'stats must be an object');
  await bad({documents:[{documentId:read,type:'tweet',topics:[]}]},'unknown type');
  await bad({documents:[{documentId:read,type:'post',topics:['1','2','3','4','5','6']}]},'at most five topics');
  await bad({documents:[{documentId:read,type:'post',topics:['话'.repeat(21)]}]},'a topic of at most twenty characters');
  await bad({documents:[{documentId:read,type:'post',topics:[],secret:'x'}]},'no other key in a label');
  await bad({extra:1},'no other key in the result');
  const labels=[{documentId:read,type:'post',topics:['做饭']},{documentId:stranger,type:'article',topics:[]}];
  await closeVoice(a,o.turnId,'completed',{result:{versionId:id,profile,stats,documents:labels}});
  const row=(await c.query('select stats,documents,status from voice_profile_versions where id=$1',[id])).rows[0];
  assert.deepEqual(row.stats,stats);
  assert.deepEqual(row.documents,[labels[0]],'a label for a document the version did not read is dropped');
  assert.equal(row.status,'draft');
  // Correcting a label: the owner's own version and a document it labelled; anything else is refused.
  // As the app calls them: service_role (library_actor refuses any other role).
  const svc=async(sql,args)=>{await c.query('begin');try{await c.query('set local role service_role');const v=await one(sql,args);
   await c.query('commit');return v;}catch(e){await c.query('rollback');throw e;}};
  const label=(actor,vid,did,type,topics,client)=>client
   ?one('select voice_document_label_set($1,$2,$3,$4,$5) v',[actor,vid,did,type,JSON.stringify(topics)],client)
   :svc('select voice_document_label_set($1,$2,$3,$4,$5) v',[actor,vid,did,type,JSON.stringify(topics)]);
  await label(a.actor,id,read,'script',['下班','做饭']);
  assert.deepEqual(await one('select documents v from voice_profile_versions where id=$1',[id]),
   [{documentId:read,type:'script',topics:['下班','做饭'],edited:true}]);
  const other=await account(1000);
  assert.match(await refusal(label(other.actor,id,read,'post',[])),/VOICE_VERSION_GONE/,'another account');
  assert.match(await refusal(label(a.actor,id,stranger,'post',[])),/VOICE_VERSION_GONE/,'a document the version did not read');
  assert.match(await refusal(label(a.actor,id,read,'tweet',[])),/VOICE_INVALID/,'an unknown type');
  const anon=await t.peer();
  try{await anon.query('set role authenticated');
   assert.match(await refusal(label(a.actor,id,read,'post',[],anon)),/permission denied/,'only the service role');}finally{await anon.end();}
  // An edit of the confirmed profile is a new version: stats and labels go with it.
  await svc('select voice_profile_confirm($1,$2,1,$3) v',[a.actor,id,JSON.stringify(profile)]);
  await svc('select voice_profile_confirm($1,$2,2,$3) v',[a.actor,id,JSON.stringify({...profile,tone:'更口语'})]);
  const copy=(await c.query("select stats,documents from voice_profile_versions where actor_id=$1 and version=2",[a.actor])).rows[0];
  assert.deepEqual(copy,{stats,documents:[{documentId:read,type:'script',topics:['下班','做饭'],edited:true}]});
  report.checks.push('voice 2.0: stats and labels saved with the profile (only for documents read), malformed ones refused, a label corrected only by its owner on a document the version read, an edited profile keeps them');
 }
}
