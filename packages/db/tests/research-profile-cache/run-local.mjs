/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// 0493 (Owner 2026-11-03): research_profile_cache. A profile any search read within 24 hours is served to every user's search; an older one is
// not; a row only moves forward in time; a few week-old rows go on each write; nothing here carries a user. API roles cannot reach it.
import assert from 'node:assert/strict';
import {localDb} from '../runtime-view-perf/local-db.mjs';
const db=await localDb(),c=db.client,report={build:db.build,checks:[]};
const one=async(sql,args=[])=>(await c.query(sql,args)).rows[0]?.v;
const refusal=async promise=>{try{await promise;}catch(e){return e.message;}assert.fail('accepted');};
const read=(accounts,age=86400,platform='tiktok',kind='account_profile')=>one('select research_profile_cache_read($1,$2,$3,$4) v',[platform,kind,accounts,age]);
const write=(rows,platform='tiktok',kind='account_profile')=>one('select research_profile_cache_write($1,$2,$3) v',[platform,kind,JSON.stringify(rows)]);
const profile=(account,followers=50000)=>({fields:{id:account,name:'P '+account,followers},missing:[]});
const ago=seconds=>new Date(Date.now()-seconds*1000).toISOString();
try{
 // 1. Hit, miss, and the 24-hour edge; no user in the key, so every search reads the same row.
 {
  assert.equal(await write([{account:'fresh',profile:profile('fresh'),fetchedAt:ago(60)},{account:'edge',profile:profile('edge'),fetchedAt:ago(86400-30)},
   {account:'stale',profile:profile('stale'),fetchedAt:ago(86400+30)}]),3);
  const hits=await read(['fresh','edge','stale','never']);
  assert.deepEqual(hits.map(h=>h.account).sort(),['edge','fresh'],'under 24 hours hits; older and unknown do not');
  assert.deepEqual(hits.find(h=>h.account==='fresh').profile,profile('fresh'));
  assert.deepEqual(await read(['fresh'],30),[],'the caller\'s own age limit applies, never beyond 24 hours');
  assert.equal((await read(['fresh'],10**9)).length,1);
  assert.deepEqual(await read(['fresh'],86400,'youtube'),[],'platform is part of the key');
  assert.deepEqual(await read(['fresh'],86400,'tiktok','post_detail'),[],'lookup kind is part of the key');
  assert.deepEqual(await read([]),[]);
  const columns=(await c.query("select column_name from information_schema.columns where table_name='research_profile_cache'")).rows.map(r=>r.column_name).sort();
  assert.deepEqual(columns,['account_key','fetched_at','kind','platform','profile'],'no actor, session or turn id');
  report.checks.push('served while under 24 hours (any caller), not after; platform and lookup kind are part of the key; the table holds no user');
 }
 // 2. A row only moves forward; a replayed older answer never refreshes it.
 {
  await write([{account:'move',profile:profile('move',1),fetchedAt:ago(3600)}]);
  await write([{account:'move',profile:profile('move',2),fetchedAt:ago(600)}]);
  assert.equal((await read(['move']))[0].profile.fields.followers,2,'a newer answer replaces it');
  await write([{account:'move',profile:profile('move',3),fetchedAt:ago(7200)}]);
  const row=(await read(['move']))[0];
  assert.equal(row.profile.fields.followers,2,'an older answer (a replayed operation) does not');
  assert.ok(Date.now()-Date.parse(row.fetchedAt)<900*1000,'and does not make the row look fresher than the supplier\'s answer');
  report.checks.push('a row only moves forward in time');
 }
 // 3. Bad input is refused or skipped; bounded batches.
 {
  assert.match(await refusal(write({not:'an array'})),/RESEARCH_PROFILE_CACHE_INVALID/);
  assert.match(await refusal(write(Array.from({length:101},(_,i)=>({account:'x'+i,profile:profile('x'),fetchedAt:ago(1)})))),/RESEARCH_PROFILE_CACHE_INVALID/);
  assert.equal(await write([{account:'',profile:profile('e'),fetchedAt:ago(1)},{account:'no-time',profile:profile('n')},
   {account:'future',profile:profile('f'),fetchedAt:new Date(Date.now()+3600e3).toISOString()},{account:'not-object',profile:'x',fetchedAt:ago(1)}]),0,'bad rows are skipped');
  assert.equal(await one("select count(*)::int v from research_profile_cache where account_key in ('','no-time','future','not-object')"),0);
  assert.deepEqual((await read(Array.from({length:150},(_,i)=>i===0?'fresh':'none'+i))).map(h=>h.account),['fresh'],'a read looks at the first 100 accounts only');
  await assert.rejects(c.query("insert into research_profile_cache(platform,kind,account_key,profile,fetched_at) values('TikTok','k','a','{}',now())"),/check/i);
  await assert.rejects(c.query("insert into research_profile_cache(platform,kind,account_key,profile,fetched_at) values('tiktok','k','a','[]',now())"),/check/i);
  report.checks.push('invalid batches are refused (not an array, over 100), bad rows skipped, platform and profile shape checked');
 }
 // 4. Week-old rows are removed a few at a time on each write.
 {
  await c.query("delete from research_profile_cache");
  for(let i=0;i<60;i++) await c.query("insert into research_profile_cache values('tiktok','account_profile',$1,'{}',now()-interval '8 days')",['old'+i]);
  await write([{account:'live',profile:profile('live'),fetchedAt:ago(1)}]);
  assert.equal(await one("select count(*)::int v from research_profile_cache where account_key like 'old%'"),10,'one write removes at most 50 week-old rows');
  await write([{account:'live',profile:profile('live'),fetchedAt:ago(1)}]);
  await write([{account:'live2',profile:profile('live2'),fetchedAt:ago(1)}]);
  assert.equal(await one("select count(*)::int v from research_profile_cache where account_key like 'old%'"),0);
  assert.equal(await one("select count(*)::int v from research_profile_cache where account_key like 'live%'"),2,'fresh rows stay');
  report.checks.push('week-old rows go 50 at a time on each write; fresh rows stay');
 }
 // 5. Service role only; RLS on, no policies; the table is not reachable directly.
 {
  for(const fn of ['research_profile_cache_read(text,text,text[],integer)','research_profile_cache_write(text,text,jsonb)'])
   for(const [role,want] of [['anon',false],['authenticated',false],['service_role',true]])
    assert.equal(await one("select has_function_privilege($1,$2,'EXECUTE') v",[role,'public.'+fn]),want,`${fn} ${role}`);
  assert.equal(await one("select relrowsecurity v from pg_class where relname='research_profile_cache'"),true);
  for(const role of ['anon','authenticated','service_role'])
   assert.equal(await one("select has_table_privilege($1,'public.research_profile_cache','SELECT') v",[role]),false,role);
  report.checks.push('functions: service role only; table: RLS on, no direct access for any API role');
 }
}catch(error){report.failed=String(error.stack??error);process.exitCode=1;}
finally{await db.close();report.cleanup='PASS';console.log(JSON.stringify(report,null,2));}
