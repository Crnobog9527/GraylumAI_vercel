/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// REPORT-VISUAL 0301: the AI coach reads the finalized report's strategy data (free conversations, new content material).
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {rpc} from '../erasure-b2a/cases.mjs';
import {erase} from '../content-erasure/cases.mjs';
const one=async(db,text,args=[])=>(await db.query(text,args)).rows[0].v;
const index=(db,a,sid)=>rpc(db,'runtime_workspace_source',a,sid,'');
const read=(db,a,sid,id)=>rpc(db,'runtime_workspace_source',a,sid,id);
const kinds=async(db,a,sid)=>(await index(db,a,sid)).entries.map(e=>e.kind);

const content={summary:'STRATEGY_SUMMARY_CANARY',thisWeek:[{action:'注册账号',why:'占名字',done:'三件套填好'}],
 plan30:{weeks:[{week:1,purpose:'立起作品集',posts:'3 条',topics:'成品',watch:'收藏数',passIf:'发满 3 条',reviewQuestion:'哪条最好'}],
  day30Questions:[]}};
const business={funnel:[{layer:'免费内容',role:'认识你',forWhom:'同城',buyPoint:'好看',offer:'作品',price:'免费',filter:'外地',
 whyFilter:'标同城',howToSell:'私信',watch:'收藏',basis:'inferred'}],goal:{primary:'BUSINESS_GOAL_CANARY',outcome:'订单',
 feasibility:'conditional',pros:[],cons:[],unknowns:[]}};
const stored=(data={...content,...business},extra={})=>({dataVersion:1,validatedAt:'2026-10-20T00:00:00Z',dropped:[],
 textEdited:['funnel'],data,...extra});
/** Give a positioning version a finalized report with strategy data (what 0300 stores). Fixture only: versions are
 * immutable, so the test superuser writes it with triggers off, as if it had been finalized that way. */
async function finalize(db,version,data=stored()) {
 await db.query('SET session_replication_role=replica');
 try {
  await db.query(`UPDATE artifact_versions SET report=jsonb_build_object('generatedReport',
   jsonb_build_object('body','## 一句话结论\n正文','data',$2::jsonb)) WHERE id=$1`,[version,data]);
 } finally {await db.query('SET session_replication_role=origin');}
}

export async function runCases({db,report,before0301}) {
 const a=await one(db,'SELECT ws_test.actor() v');
 const sid=await one(db,'SELECT ws_test.free_session($1) v',[a]);
 const main=await one(db,'SELECT ws_test.positioning($1,$2,$3) v',[a,'Tea studio','POSITIONING_CANARY_A']);
 const plain=(await index(db,a,sid)).entries[0];
 assert.equal(Object.hasOwn(plain,'strategyReport'),false,'a positioning without strategy data is listed as before');
 await finalize(db,main.version);

 await db.query('BEGIN');
 try {
  await db.query(before0301);
  const old=await index(db,a,sid);
  assert.equal(Object.hasOwn(old.entries[0],'strategyReport'),false);
  assert.equal((await read(db,a,sid,'strategy_report:'+main.business)).kind,'unavailable');
  report.checks.push('before fix (0299): the finalized strategy data is not listed or readable');
 } finally {await db.query('ROLLBACK');}

 const listed=await index(db,a,sid);
 assert.deepEqual(listed.entries[0].strategyReport.id,'strategy_report:'+main.business);
 assert.deepEqual(listed.entries.map(e=>e.kind),['positioning'],'no index place is taken');
 const got=await read(db,a,sid,'strategy_report:'+main.business);
 assert.equal(got.kind,'workspace_source');assert.equal(got.identity.kind,'strategy_report');
 assert.equal(got.identity.sourceVersionId,main.version);assert.deepEqual(got.dependencies,[main.version]);
 assert.ok(JSON.stringify(got.body.profile).includes('POSITIONING_CANARY_A'),'the confirmed fields come with it');
 assert.equal(got.body.strategy.summary,'STRATEGY_SUMMARY_CANARY');
 assert.equal(got.body.strategy.goal.primary,'BUSINESS_GOAL_CANARY','both groups in one read');
 assert.deepEqual(got.body.strategyTextEdited,['funnel']);assert.equal(got.truncated,false);
 assert.ok(got.body.use.includes('confirmed fields (profile) win'));
 assert.deepEqual(await read(db,a,sid,main.business).then(r=>r.identity.kind),'positioning','the positioning read is unchanged');
 report.checks.push('index + one read: confirmed fields and both strategy groups, with edit marks and reading rules');

 // The 0299 benchmarks entry stays as it is (rank 1, after the positionings).
 const execution=randomUUID();
 await db.query(`INSERT INTO runtime_executions(id,actor_id,session_id,request_id,payload,history_revision,state)
  VALUES($1,$2,$3,$4,'{}',0,'completed')`,[execution,a,main.draftSession,randomUUID()]);
 const fetch=await one(db,`INSERT INTO research_account_fetches(actor_id,session_id,platform,account,state,account_key)
  VALUES($1,$2,'tiktok','bench_a','failed',encode(sha256(convert_to('bench_a','utf8')),'hex')) RETURNING id v`,[a,main.draftSession]);
 await db.query(`INSERT INTO research_benchmarks(fetch_id,actor_id,session_id,execution_id,platform,account,followers,posts_analyzed,
  qualified,excluded,refs,operation_ids,missing,fetched_at) VALUES($1,$2,$3,$4,'tiktok','bench_a',null,0,false,'NO_POSTS','{}','{}','{}',now())`,
 [fetch,a,main.draftSession,execution]);
 assert.deepEqual(await kinds(db,a,sid),['positioning','benchmarks']);
 assert.ok((await read(db,a,sid,main.draftSession)).body.includes('bench_a'));
 // Review P1 (#1129): 0301 rebuilt the function and must keep 0299's producer provenance (content erasure matches on it).
 const benchEntry=(await index(db,a,sid)).entries.find(e=>e.kind==="benchmarks");
 assert.deepEqual(benchEntry.producedBy,[{executionId:execution}],'the index entry names the answers it copied');
 const readBack=await read(db,a,sid,main.draftSession);
 assert.deepEqual(readBack.producedBy,[{executionId:execution}],'a read names the answers its rows came from');
 assert.equal(readBack.identity.producedBy,undefined,'the stored identity keeps only the stable keys');
 report.checks.push('the benchmarks entry of 0299 is still listed after the positioning and readable');

 // 40 places: many positionings with reports still list only 40 entries, each report readable by id.
 const many=[];
 for(let i=0;i<41;i++){const p=await one(db,'SELECT ws_test.positioning($1,$2,$3) v',[a,'Shop '+i,'C'+i]);await finalize(db,p.version);many.push(p);}
 const full=await index(db,a,sid);
 assert.equal(full.entries.length,40);assert.ok(full.entries.every(e=>e.kind==='positioning'&&e.strategyReport));
 report.checks.push('strategy reports take none of the 40 index places');

 // Oversized data: whole fields are dropped in the fixed order, the confirmed fields stay, the JSON is whole.
 // Its own user: the 41 positionings above fill the first user's 40 places.
 const b=await one(db,'SELECT ws_test.actor() v');
 const bSid=await one(db,'SELECT ws_test.free_session($1) v',[b]);
 const big=await one(db,'SELECT ws_test.positioning($1,$2,$3) v',[b,'Big','BIG_CANARY']);
 const filler=Array.from({length:10},()=>({signal:'字'.repeat(120),meaning:'字'.repeat(120),action:'字'.repeat(120)}));
 await finalize(db,big.version,stored({...content,...business,adjustments:filler,routine:filler.map(()=>({when:'周日',task:'字'.repeat(120),minutes:30})),
  topics:Array.from({length:12},()=>({title:'字'.repeat(120),forWhom:'字'.repeat(120),pain:'字'.repeat(120),howToShoot:'字'.repeat(120),
   tests:'字'.repeat(120),watch:'字'.repeat(120)})),assumptions:Array.from({length:10},()=>({assumption:'字'.repeat(120),
   why:'字'.repeat(120),howToTest:'字'.repeat(120),signal:'字'.repeat(120),passIf:'字'.repeat(120),when:'第 2 周',ifNot:'字'.repeat(120)}))}));
 const bigRead=await read(db,b,bSid,'strategy_report:'+big.business);
 assert.equal(bigRead.kind,'workspace_source');
 assert.ok(Buffer.byteLength(JSON.stringify(bigRead.body))<=50000);
 assert.ok(bigRead.body.strategyDropped.length>0);assert.equal(bigRead.truncated,true);
 assert.equal(bigRead.body.strategyDropped[0],'adjustments');
 assert.equal(bigRead.body.strategy.summary,'STRATEGY_SUMMARY_CANARY');
 assert.ok(JSON.stringify(bigRead.body.profile).includes('BIG_CANARY'));
 report.checks.push('an oversized report drops whole strategy fields in the fixed order; confirmed fields and summary stay');

 // Another user, and deletion.
 const other=await one(db,'SELECT ws_test.actor() v');
 const otherSid=await one(db,'SELECT ws_test.free_session($1) v',[other]);
 assert.equal((await read(db,other,otherSid,'strategy_report:'+main.business)).kind,'unavailable');
 await erase(db,{actor:a},'artifact',main.project);
 assert.equal((await read(db,a,sid,'strategy_report:'+main.business)).kind,'unavailable');
 report.checks.push('another user cannot read it; deleting the positioning removes it');

 // Content material: today's text without data; profile + content group with data, within 24000 bytes.
 const legacy=await one(db,'SELECT ws_test.positioning($1,$2,$3) v',[a,'Legacy','LEGACY_CANARY']);
 assert.equal(await one(db,`SELECT opc_source_material($1,'topic:first-week') v`,[legacy.version]),
  await one(db,`SELECT coalesce(opc_profile($1)::text,'') v`,[legacy.version]),'no data: byte-identical material');
 const withData=await one(db,'SELECT ws_test.positioning($1,$2,$3) v',[a,'Data','DATA_CANARY']);
 await finalize(db,withData.version);
 const material=JSON.parse(await one(db,`SELECT opc_source_material($1,'topic:first-week') v`,[withData.version]));
 assert.ok(JSON.stringify(material.profile).includes('DATA_CANARY'));
 assert.equal(material.strategy.summary,'STRATEGY_SUMMARY_CANARY');
 assert.equal(Object.hasOwn(material.strategy,'funnel'),false,'content sessions get the content group only');
 const longBrief='字'.repeat(6000);
 await finalize(db,withData.version,stored({...content,topics:Array.from({length:12},()=>({title:'字'.repeat(120),forWhom:'字'.repeat(120),
  pain:'字'.repeat(120),howToShoot:'字'.repeat(120),tests:'字'.repeat(120),watch:'字'.repeat(120)}))}));
 const fitted=await one(db,`SELECT opc_source_material($1,$2) v`,[withData.version,longBrief]);
 const trimmed=JSON.parse(fitted);
 assert.ok(trimmed.strategy.topics.length>=1&&trimmed.strategy.topics.length<12,'topics lose items from the end, not the whole list');
 assert.ok(trimmed.strategyDropped.includes('topics[11]'));assert.equal(trimmed.strategyDropped.includes('topics'),false);
 assert.ok(Buffer.byteLength(JSON.stringify({brief:longBrief,material:fitted,roundId:null}))<=24000);
 report.checks.push('content material: unchanged without data; profile + content group with data; always within 24000 bytes');

 // Positioning drafts of a business stay v1 (0159 pins the check of their frozen material); topic and edit paths patched.
 const ctx=async p=>one(db,'SELECT opc_business_context($1,$2,(SELECT round_id FROM opc_drafts WHERE draft_id=$3)) v',[a,p.draftSession,p.draft]);
 assert.equal((await ctx(withData)).version,'opc-business-context.v1');
 for(const [fn,text] of [['opc_topic_bind(uuid,uuid,uuid,uuid)','opc_source_material(v.id'],
  ['opc_library_edit(uuid,uuid,text,uuid,bigint,jsonb)','opc_work_material_payload(i.work_item_id)']])
  assert.ok((await one(db,`SELECT pg_get_functiondef('public.${fn}'::regprocedure) v`)).includes(text),fn);
 report.checks.push('topic and work-item edit paths use the new material; positioning-draft context unchanged (v1)');
}
