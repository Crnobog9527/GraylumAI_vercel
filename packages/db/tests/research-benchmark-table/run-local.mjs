/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// The benchmark table of a session on the core path (0465, 0483, 0492): what research_benchmark_qualified / _table / _rows / _report_current /
// _required and the fallback card (research_benchmark_shortfall_offer / _choose / _accepted) do with the rows a turn wrote (turn_id set by
// research_turn_apply). It replaces what the retired suite research-benchmarks (0268, 0320, 0343) tested through the old claim/finish path and
// old executions, for the parts that are SQL: ordering, only turn-made rows are visible, missing stays missing, the hash the report freezes, the
// number of benchmarks a report needs, and the choice card. The numbers themselves (qualification, metrics) are computed in Node and tested there
// (benchmarkStore.test.ts and the research host tests). Rows are written as research_turn_apply stores them.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {localDb} from '../runtime-view-perf/local-db.mjs';
const db=await localDb(),c=db.client,report={build:db.build,checks:[]};
const one=async(sql,args=[])=>(await c.query(sql,args)).rows[0]?.v;
const refusal=async promise=>{try{await promise;}catch(e){return e.message;}assert.fail('accepted');};
let turn=5000;
async function session(kind='positioning_draft'){
 const actor=randomUUID(),id=randomUUID();
 await c.query('insert into profiles(id,credits) values($1,0)',[actor]);
 await c.query("insert into runtime_sessions(id,actor_id,scope,start_request_id,start_payload) values($1,$2,$3,$4,'{}')",
  [id,actor,JSON.stringify({kind,probe:randomUUID()}),randomUUID()]);
 return {actor,id};
}
/** One account's benchmark row. turnId null is a row the old path wrote (no turn): nothing reads it any more. */
async function bench(s,{account='a'+randomUUID().slice(0,8),qualified=true,followers=50000,missing=[],turnId=++turn}={}){
 const fetch=await one(`insert into research_account_fetches(actor_id,session_id,platform,account,account_key,state,turn_actor_id,turn_id,last_success_turn_id)
  values($1,$2,'tiktok',$3,encode(sha256(convert_to($3,'UTF8')),'hex'),'succeeded',$4,$5,$5) returning id v`,
  [s.actor,s.id,account,turnId===null?null:s.actor,turnId]);
 const row=qualified
  ?{category:'imitable',excluded:null,posts:25,whole:true,last:'now()'}
  :{category:null,excluded:'FOLLOWERS_BELOW_MIN',posts:25,whole:true,last:'now()'};
 await c.query(`insert into research_benchmarks(fetch_id,actor_id,session_id,turn_actor_id,turn_id,platform,account,followers,median_views,posts_analyzed,
  category,qualified,excluded,whole_history,refs,operation_ids,missing,fetched_at,last_published_at)
  values($1,$2,$3,$4,$5,'tiktok',$6,$7,1000,$8,$9,$10,$11,$12,'{}','{}',$13,now(),now())`,
  [fetch,s.actor,s.id,turnId===null?null:s.actor,turnId,account,followers,row.posts,row.category,qualified,row.excluded,row.whole,missing]);
 return account;
}
/** A completed keyword discovery of one turn: a round. */
async function round(s){
 await c.query(`insert into research_discoveries(id,actor_id,session_id,turn_actor_id,turn_id,keyword_confirmation_id,platforms,keywords,cursor,state)
  values($1,$2,$3,$2,$4,$5,array['tiktok'],'["k"]'::jsonb,'{"accounts":[],"attempted":3}','completed')`,[randomUUID(),s.actor,s.id,++turn,randomUUID()]);
}
const table=s=>one('select research_benchmark_table($1,$2) v',[s.actor,s.id]);
const accounts=async s=>(await table(s)).rows.map(r=>r.account);
try{
 // 1. The table: only rows a turn wrote, qualified first then by followers, missing stays missing, at most 30 rows.
 {
  const s=await session();
  const small=await bench(s,{followers:20000}),big=await bench(s,{followers:90000}),weak=await bench(s,{qualified:false,followers:500});
  await bench(s,{turnId:null,followers:150000});
  assert.deepEqual(await accounts(s),[big,small,weak],'qualified first, then the more followers; the old path\'s row is not there');
  assert.equal(await one('select research_benchmark_qualified($1,$2) v',[s.actor,s.id]),2,'only qualified rows a turn wrote are counted');
  const rows=(await table(s)).rows;
  assert.equal(rows.find(r=>r.account===weak).excluded,'FOLLOWERS_BELOW_MIN');
  const lacking=await session();
  const hole=await bench(lacking,{qualified:false,missing:['followers']});
  await c.query('update research_benchmarks set followers=null where session_id=$1',[lacking.id]);
  const gap=(await table(lacking)).rows.find(r=>r.account===hole);
  assert.deepEqual([gap.followers,gap.missing],[null,['followers']],'a number the evidence did not have stays missing, never 0');
  const many=await session();
  for(let i=0;i<32;i++)await bench(many,{followers:20000+i});
  assert.equal((await table(many)).rows.length,30,'at most 30 rows');
  report.checks.push('table: only turn-made rows, qualified first then followers, missing stays null and named, at most 30 rows; qualified counts only turn-made qualified rows');
 }
 // 2. rows() is for the owner; the hash the report freezes follows the rows, and a stale one is refused.
 {
  const s=await session(),other=await session();
  const a1=await bench(s,{followers:30000});
  const before=await table(s);
  assert.deepEqual((await one('select research_benchmark_rows($1,$2) v',[s.actor,s.id])).rows.map(r=>r.account),[a1]);
  assert.match(await refusal(c.query('select research_benchmark_rows($1,$2)',[other.actor,s.id])),/RESEARCH_SCOPE_DENIED/,'another account never reads it');
  assert.equal((await table(s)).hash,before.hash,'the same rows, the same hash');
  await c.query('select research_benchmark_report_current($1,$2,$3)',[s.actor,s.id,JSON.stringify({benchmarkHash:before.hash})]);
  await c.query('select research_benchmark_report_current($1,$2,null)',[s.actor,s.id]);
  await c.query('select research_benchmark_report_current($1,$2,$3)',[s.actor,s.id,JSON.stringify({other:1})]);
  await c.query('update research_benchmarks set followers=40000 where session_id=$1',[s.id]);
  assert.notEqual((await table(s)).hash,before.hash,'a refreshed row changes the hash');
  assert.match(await refusal(c.query('select research_benchmark_report_current($1,$2,$3)',[s.actor,s.id,JSON.stringify({benchmarkHash:before.hash})])),
   /REPORT_SOURCE_CONFLICT/,'a report that froze the old table is refused');
  await bench(s,{followers:25000});
  assert.notEqual((await table(s)).hash,before.hash);
  report.checks.push('rows(): owner only; the table hash is stable, follows any row change, and a report that froze an older hash is refused (REPORT_SOURCE_CONFLICT); no frozen hash is no check');
 }
 // 3. How many benchmarks a report needs.
 {
  const required=(scope,spec)=>one('select research_benchmark_required($1::jsonb,$2::jsonb) v',[JSON.stringify(scope),JSON.stringify(spec)]);
  const draft={kind:'positioning_draft'},other={kind:'work_item'};
  assert.equal(await required(draft,{}),3,'a positioning draft needs 3');
  assert.equal(await required(other,{}),0,'another scope needs none');
  assert.equal(await required(other,{minQualifiedBenchmarks:'x'}),3,'a stated but malformed minimum is the floor');
  for(const [asked,want] of [[1,3],[3,3],[5,5],[12,12],[40,12]])assert.equal(await required(other,{minQualifiedBenchmarks:asked}),want,'minimum '+asked);
  report.checks.push('required: 3 for a positioning draft, none elsewhere, a stated minimum is kept between 3 and 12');
 }
 // 4. The fallback card: due only with 1 to (required-1) qualified benchmarks and 2 rounds; the choice is frozen; accepted only on its own terms.
 {
  const offer=(s,card=randomUUID())=>c.query('select research_benchmark_shortfall_offer($1,$2,null,$3) v',[s.actor,s.id,card]).then(r=>({card,view:r.rows[0].v}));
  const choose=(actor,card,choice)=>c.query('select research_benchmark_shortfall_choose($1,$2,$3) v',[actor,card,choice]).then(r=>r.rows[0].v);
  const accepted=(s,req)=>one('select research_benchmark_shortfall_accepted($1,$2,$3) v',[s.actor,s.id,req]);
  const s=await session();
  assert.match(await refusal(offer(s)),/RESEARCH_SHORTFALL_NOT_DUE/,'no qualified benchmark: no card');
  await bench(s);await round(s);
  assert.match(await refusal(offer(s)),/RESEARCH_SHORTFALL_NOT_DUE/,'one round is not enough');
  await round(s);
  const {card,view}=await offer(s);
  assert.deepEqual([view.required,view.offeredQualified,view.offeredRounds],[3,1,2]);
  // As research_turn_apply does after the offer: the card belongs to its turn.
  await c.query('update research_benchmark_shortfalls set turn_actor_id=$2,turn_id=$3 where id=$1',[card,s.actor,++turn]);
  assert.equal(await accepted(s,3),false,'not accepted before the user chose');
  assert.match(await refusal(choose(s.actor,card,'maybe')),/RESEARCH_CARD_INVALID/);
  assert.match(await refusal(choose((await session()).actor,card,'generate')),/RESEARCH_SCOPE_DENIED/,'only the owner chooses');
  const chosen=await choose(s.actor,card,'generate');
  assert.match(JSON.stringify(chosen),/generate/);
  assert.deepEqual(await choose(s.actor,card,'generate'),chosen,'the same choice again is the same answer');
  assert.match(await refusal(choose(s.actor,card,'continue')),/RESEARCH_CARD_ALREADY_CONFIRMED/,'the choice is frozen');
  assert.equal(await accepted(s,3),true,'generate with 1 qualified and 2 rounds is accepted for 3');
  assert.equal(await accepted(s,4),false,'not for a report that needs more than the card was offered for');
  // Too few qualified benchmarks after the card (the row went away): "generate" is refused until there is one.
  const lost=await session();
  await bench(lost);await round(lost);await round(lost);
  const second=await offer(lost);
  await c.query('delete from research_benchmarks where session_id=$1',[lost.id]);
  assert.match(await refusal(choose(lost.actor,second.card,'generate')),/RESEARCH_SHORTFALL_NOT_DUE/,'generate needs one qualified benchmark and two rounds');
  assert.equal((await choose(lost.actor,second.card,'continue')).required,3,'continue is always possible');
  // At the required count the card is not due.
  const enough=await session();
  for(let i=0;i<3;i++)await bench(enough);
  await round(enough);await round(enough);
  assert.match(await refusal(offer(enough)),/RESEARCH_SHORTFALL_NOT_DUE/,'with 3 qualified benchmarks there is nothing to offer');
  report.checks.push('fallback card: due with 1-2 qualified and 2 rounds; owner-only; the choice is frozen and repeatable; generate needs 1 qualified and 2 rounds and is accepted only for the required count it was offered for');
 }
 // 5. Deletion: the benchmark table, its fetches, the fallback card and the discoveries go with a deleted conversation, and with an erased account;
 // nothing of another conversation or account is touched. (content_erasure_confirm / account_erasure_scrub_content delete them; no other suite asserts it.)
 {
  const rich=async()=>{const s=await session();await bench(s);await bench(s,{qualified:false,followers:300});await round(s);await round(s);
   await c.query('select research_benchmark_shortfall_offer($1,$2,null,$3)',[s.actor,s.id,randomUUID()]);return s;};
  const counts=async s=>({benchmarks:Number(await one('select count(*) v from research_benchmarks where session_id=$1',[s.id])),
   fetches:Number(await one('select count(*) v from research_account_fetches where session_id=$1',[s.id])),
   cards:Number(await one('select count(*) v from research_benchmark_shortfalls where session_id=$1',[s.id])),
   discoveries:Number(await one('select count(*) v from research_discoveries where session_id=$1',[s.id]))});
  const gone={benchmarks:0,fetches:0,cards:0,discoveries:0};
  // The conversation: marked (hidden at once), then cleaned by the sweep.
  const doomed=await rich(),keeper=await rich(),kept=await counts(keeper);
  assert.deepEqual(kept,{benchmarks:2,fetches:2,cards:1,discoveries:2},'the fixture holds what a research conversation holds');
  assert.equal((await one('select content_erasure_mark_session($1,$2) v',[doomed.actor,doomed.id])).status,'deleted');
  assert.match(await refusal(c.query('select research_benchmark_rows($1,$2)',[doomed.actor,doomed.id])),/RESEARCH_SCOPE_DENIED/,'a deleted conversation\'s table cannot be read any more');
  await one('select content_erasure_sweep_sessions(200,null,null) v');
  assert.deepEqual(await counts(doomed),gone,'the cleanup removed the table, its fetches, the card and the discoveries of the deleted conversation');
  assert.deepEqual(await counts(keeper),kept,'another conversation is untouched');
  // The account: closed, then its content scrubbed.
  const erased=await rich(),bystander=await rich(),bystanderCounts=await counts(bystander);
  await c.query("update profiles set status='deleted',is_deleted='true',deleted_at=now() where id=$1",[erased.actor]);
  await c.query("insert into account_erasure_requests(profile_id,request_id,confirmed_at) values($1,$2,now()-interval '1 minute')",[erased.actor,randomUUID()]);
  const scrub=await one('select account_erasure_scrub_content($1) v',[erased.actor]);
  assert.ok(!scrub.retry,'the scrub ran (not asked to retry)');
  assert.equal(scrub.research_benchmarks_deleted,2,'the scrub says how many benchmark rows it deleted');
  assert.deepEqual(await counts(erased),gone,'an erased account keeps no benchmark row, fetch, card or discovery');
  assert.deepEqual(await counts(bystander),bystanderCounts,'another account is untouched');
  report.checks.push('deletion: a deleted conversation hides its table at once and its cleanup removes benchmarks, fetches, card and discoveries; an erased account keeps none; others untouched');
 }
 // 6. The operation ids Node chooses (stableResearchId, research/runtime/toolContext.ts) and the ones the benchmark table recomputes in SQL
 // (research_benchmark_operation_id, research_benchmark_post_operations) are the same: if they drift, benchmark evidence no longer binds to its fetch
 // attempt. The TS unit test (benchmarkIds.test.ts) pins the same literal on the Node side.
 {
  const fetch='00000000-0000-4000-8000-000000000001',attempt='00000000-0000-4000-8000-000000000002';
  const stableId=(...parts)=>{const h=createHash('sha256').update(JSON.stringify(parts)).digest('hex');
   return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
  assert.equal(await one('select research_benchmark_operation_id($1,$2,$3) v',[fetch,attempt,'account_profile']),'3f40c5bf-153d-4715-afd9-a006774ffa94','the literal the Node unit test pins');
  assert.equal(await one('select research_benchmark_operation_id($1,$2,$3) v',[fetch,attempt,'account_posts']),stableId(fetch,attempt,'account_posts'));
  assert.deepEqual(await one('select research_benchmark_post_operations($1,$2) v',[fetch,attempt]),
   [stableId(fetch,attempt,'account_posts'),stableId(fetch,attempt,'account_posts','2'),stableId(fetch,attempt,'account_posts','3')],'pages 1 to 3, as Node names them');
  assert.equal(await one("select research_benchmark_operation_id($1,$2,'Bad Kind') v",[fetch,attempt]),null,'a kind outside the fixed spelling has no id');
  report.checks.push('operation ids: the SQL ids equal the Node ones (pinned literal, posts page 1 to 3), the same layout benchmarkIds.test.ts pins');
 }
}catch(error){report.failed=String(error.stack??error);process.exitCode=1;}
finally{await db.close();report.cleanup='PASS';console.log(JSON.stringify(report,null,2));}
