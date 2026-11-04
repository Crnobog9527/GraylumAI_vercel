/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// PUBLISH-MONITOR (9999): the numbers a coach reads from screenshots in a free chat are written by turn_close for a delivered completed
// chat turn (turn_chat_screenshots_apply), and the close itself is unchanged: the same money, the same settlement, the same messages.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function screenshotCases(t){
 const {c,one,open,begin,identity,record,balance,account,refusal,report}=t;
 // An own account of a brand (the chain publish-monitor's pm_test.member builds), a connection and one post of it.
 await c.query(`create schema if not exists turn_test;
 create or replace function turn_test.shot_member(a uuid,plat text,out bus uuid,out ac uuid) language plpgsql as $$
 declare sk uuid:=gen_random_uuid();m uuid:=gen_random_uuid();rev uuid:=gen_random_uuid();p uuid:=gen_random_uuid();
  r uuid:=gen_random_uuid();v uuid:=gen_random_uuid();
 begin
  ac:=gen_random_uuid();bus:=gen_random_uuid();
  insert into skills(id,skill_key,content_kind) values(sk,'shot-'||sk,'directory');
  insert into modules(id,title,skill_id,active) values(m,'shot fixture',sk,true);
  insert into skill_revisions(id,skill_id,version,content,content_hash,published_by) values(rev,sk,1,'fixture',repeat('a',64),a);
  insert into skill_packages(revision_id,skill_id,request_id,manifest,package_hash,entry_hash,expected_version,actor_id)
   values(rev,sk,gen_random_uuid(),'{}',repeat('b',64),repeat('a',64),0,a);
  insert into artifact_projects(id,actor_id,module_id,skill_id,account,work_title,current_version)
   values(p,a,m,sk,'source-'||p,'source title',1),(ac,a,m,sk,'account-'||ac,'account title',0);
  insert into artifact_rounds(id,project_id,revision_id,package_hash,workflow,workflow_hash,template_hash,state,steps)
   values(r,p,rev,repeat('b',64),'{}',repeat('c',64),repeat('d',64),'published','{}');
  insert into artifact_versions(id,project_id,round_id,version,report,report_hash,evidence_ids) values(v,p,r,1,'{}',repeat('e',64),'[]');
  insert into opc_businesses(id,actor_id,name,current_source_version_id) values(bus,a,'business',v);
  insert into opc_accounts(project_id,actor_id,platform,account_key,source_version_id,business_id) values(ac,a,plat,'shot-'||ac,v,bus);
 end $$;`);
 const post=async(a,{platform='tiktok'}={})=>{
  const {bus,ac}=(await c.query('select * from turn_test.shot_member($1,$2)',[a.actor,platform])).rows[0];
  const conn=await one(`insert into social_connections(actor_id,business_id,account_project_id,role,source,platform,provider_account_id,display_hint,status,
   consent_read,consent_auto_track,last_success_at) values($1,$2,$3,'own','postforme',$4,$5,'shot','connected',true,false,now()) returning id v`,
   [a.actor,bus,ac,platform,'shot_'+randomUUID()]);
  return one(`insert into social_posts(actor_id,connection_id,source,platform_post_id,posted_at,posted_at_source,title_excerpt)
   values($1,$2,'postforme',$3,now()-interval '9 days','provider','我花三个月才想明白的事') returning id v`,[a.actor,conn,randomUUID()]);
 };
 const closeChat=(a,turn,{result=null,kind='completed',delivered=true}={})=>one(
  "select turn_close($1,$2,$3,$4,$5,false,null,$6) v",[a.actor,turn,kind,JSON.stringify([{role:'user',content:'帮我看截图'},{role:'assistant',content:'数字如下'}]),
   delivered,result===null?null:JSON.stringify(result)]);
 const rows=postId=>c.query('select * from social_post_diagnostics where post_id=$1 order by captured_on',[postId]).then(r=>r.rows);
 const oneCall=async(a)=>{const o=await open(a);await begin(a,o.turnId,1,{upper:0.05});await identity(a,o.turnId,1);await record(a,o.turnId,1,{n:0.01,actual:0.01});return o;};
 const item=(postId,rates,extra={})=>({postId,rates,raw:{'2秒跳出率':{value:'35%',image:1}},...extra});

 // 1. The close is the same with and without the screenshot numbers: charge, settlement and balance, and both messages are saved.
 {
  const plain=await account(),withShots=await account(),pid=await post(withShots);
  const o1=await oneCall(plain),o2=await oneCall(withShots);
  const closed1=await closeChat(plain,o1.turnId),closed2=await closeChat(withShots,o2.turnId,{result:{coachScreenshots:[item(pid,{bounce_2s:0.35})]}});
  for(const key of ['closeKind','chargedCredits','settlement','absorbedCredits','replay']) assert.deepEqual(closed2[key],closed1[key],key);
  assert.equal(await balance(withShots),await balance(plain));
  assert.equal(await one('select count(*)::int v from session_messages where session_id=$1',[withShots.session]),
   await one('select count(*)::int v from session_messages where session_id=$1',[plain.session]));
  const [row]=await rows(pid);
  assert.equal(row.source,'screenshot');assert.deepEqual(row.rates,{bounce_2s:0.35});assert.equal(row.screenshot_asset,null);
  assert.deepEqual(row.rates_raw,{'2秒跳出率':{value:'35%',image:1}});
  assert.equal(row.platform,'tiktok');assert.equal(await one("select captured_on=(now() at time zone 'utc')::date v from social_post_diagnostics where id=$1",[row.id]),true,'dated by the UTC day');
  report.checks.push('chat close with screenshot numbers: charge, settlement, balance and saved messages equal a plain chat close; one screenshot diagnosis row, no image kept');
 }
 // 2. A correction the same day merges by metric, the newest value wins, and the correction time moves (created_at stays).
 {
  const a=await account(),pid=await post(a);
  await closeChat(a,(await oneCall(a)).turnId,{result:{coachScreenshots:[item(pid,{complete_rate:0.12,retain_3s:0.5},{videoSeconds:30})]}});
  const [first]=await rows(pid);
  await closeChat(a,(await oneCall(a)).turnId,{result:{coachScreenshots:[item(pid,{complete_rate:0.15},{raw:{'完播率':{value:'15%',image:2}}})]}});
  const after=await rows(pid);
  assert.equal(after.length,1);
  assert.deepEqual(after[0].rates,{complete_rate:0.15,retain_3s:0.5});
  assert.deepEqual(after[0].rates_raw['2秒跳出率'],{value:'35%',image:1});
  assert.equal(after[0].rates_raw['完播率'].value,'15%');assert.equal(after[0].video_seconds,30,'a later reply without a length keeps it');
  assert.ok(after[0].confirmed_at>first.confirmed_at);assert.deepEqual(after[0].created_at,first.created_at);
  assert.equal(after[0].id,first.id);
  report.checks.push('a same-day correction merges by metric with the newest value, keeps the row and moves confirmed_at');
 }
 // 2b. A correction on a later day carries the earlier screenshot's other numbers forward instead of leaving a row with one number;
 // an older screenshot (over 7 days) is not carried.
 {
  const a=await account(),pid=await post(a);
  await closeChat(a,(await oneCall(a)).turnId,{result:{coachScreenshots:[item(pid,{complete_rate:0.12,retain_3s:0.5},{videoSeconds:30})]}});
  await c.query("update social_post_diagnostics set captured_on=captured_on-1 where post_id=$1",[pid]);
  await closeChat(a,(await oneCall(a)).turnId,{result:{coachScreenshots:[item(pid,{complete_rate:0.15},{raw:{'完播率':{value:'15%',image:2}}})]}});
  const two=await rows(pid);
  assert.equal(two.length,2);
  assert.deepEqual(two[1].rates,{complete_rate:0.15,retain_3s:0.5},'the new row keeps the other numbers');
  assert.equal(two[1].video_seconds,30);assert.deepEqual(two[0].rates,{complete_rate:0.12,retain_3s:0.5},'the earlier row is untouched');
  const b=await account(),old=await post(b);
  await closeChat(b,(await oneCall(b)).turnId,{result:{coachScreenshots:[item(old,{complete_rate:0.12,retain_3s:0.5})]}});
  await c.query("update social_post_diagnostics set captured_on=captured_on-8 where post_id=$1",[old]);
  await closeChat(b,(await oneCall(b)).turnId,{result:{coachScreenshots:[item(old,{complete_rate:0.15})]}});
  assert.deepEqual((await rows(old))[1].rates,{complete_rate:0.15},'a screenshot older than 7 days is not carried');
  report.checks.push('a correction on a later day carries the earlier screenshot numbers forward (within 7 days) and leaves the earlier row untouched');
 }
 // 3. Nothing is saved for a close that is not a delivered completion; a post that is not the account\'s, or a bad item, is skipped alone.
 {
  const a=await account(),other=await account(),mine=await post(a),theirs=await post(other);
  const result=n=>({coachScreenshots:[item(theirs,{retain_3s:0.5}),{postId:'nope',rates:{retain_3s:0.5}},item(mine,{retain_3s:0.5,bad:'x'}),
   {postId:mine,rates:{}},item(mine,{retain_5s:'0.4'})].slice(0,n)});
  await closeChat(a,(await oneCall(a)).turnId,{result:result(5),delivered:false});
  assert.equal((await rows(mine)).length,0,'not delivered: nothing saved');
  const failed=await oneCall(a);
  await closeChat(a,failed.turnId,{kind:'failed',delivered:false,result:result(5)});
  assert.equal((await rows(mine)).length,0,'a failed turn saves nothing');
  const ok=await closeChat(a,(await oneCall(a)).turnId,{result:result(5)});
  assert.equal(ok.closeKind,'completed','a bad item never fails the close');
  assert.equal((await rows(theirs)).length,0,'another account\'s post is skipped');
  assert.equal((await rows(mine)).length,0,'items with non-numeric values are skipped');
  const good=await closeChat(a,(await oneCall(a)).turnId,{result:{coachScreenshots:[item(theirs,{retain_3s:0.5}),item(mine,{retain_3s:0.5})]}});
  assert.equal(good.closeKind,'completed');
  assert.equal((await rows(mine)).length,1);assert.equal((await rows(theirs)).length,0);
  // Garbage under the key changes nothing and does not fail the close; another result is refused as before.
  const open1=await oneCall(a);
  const refused=await refusal(closeChat(a,open1.turnId,{result:{draft:1}}));
  assert.match(refused,/TURN_KIND_RESULT_UNSUPPORTED/,'any other chat result is still refused');
  await closeChat(a,open1.turnId);
  for(const result of [{coachScreenshots:'x'},{coachScreenshots:Array.from({length:7},()=>item(mine,{retain_5s:0.4}))}]){
   assert.equal((await closeChat(a,(await oneCall(a)).turnId,{result})).closeKind,'completed');
  }
  assert.deepEqual((await rows(mine))[0].rates,{retain_3s:0.5});
  report.checks.push('screenshot numbers are saved only by a delivered completed chat close; foreign posts and bad items are skipped alone; a malformed result never fails a close');
 }
}
