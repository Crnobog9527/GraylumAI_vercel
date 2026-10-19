/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// RESEARCH-TOOLS RT-4b (0268): benchmark table from fetched evidence only, its erasure, and the report gate.
// Synthetic fixtures only; metrics come from the real accountMetrics/classifyAccount.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {rpc,closeAccount} from '../erasure-b2a/cases.mjs';
import {seed} from '../report-finalization/cases.mjs';
import {benchmarkCode} from '../payg/research-runtime-host-cache.mjs';

const DAY = 86400000;
const growth = {maxFirstPostAgeDays:3,minViewsToFollowers:'1.5'};
const rows = async (db,where,args) => (await db.query(`SELECT * FROM research_benchmarks WHERE ${where} ORDER BY account`,args)).rows;
const qualified = async (db,f) => (await db.query('SELECT research_benchmark_qualified($1,$2) n',[f.actor,f.session])).rows[0].n;

async function answer(db,f) {
  const id = randomUUID();
  await db.query(`INSERT INTO runtime_executions(id,actor_id,session_id,request_id,payload,history_revision,state)
    VALUES($1,$2,$3,gen_random_uuid(),'{}',0,'completed')`,[id,f.actor,f.session]);
  return id;
}
async function erase(db,f,kind,id) {
  const scope = await rpc(db,'content_erasure_scope',f.actor,kind,id);
  const hash = (await db.query("SELECT encode(sha256(convert_to($1::jsonb::text,'utf8')),'hex') h",[scope])).rows[0].h;
  return rpc(db,'content_erasure_confirm',f.actor,kind,id,hash);
}
/** A succeeded research operation of this answer holding `items` (what a supplier subcall stores). */
async function operation(db,f,e,items,op=randomUUID()) {
  const plan = randomUUID(), identityHash = 'e'.repeat(64);
  await rpc(db,'research_runtime_plan_create',f.actor,plan,f.session,e,null,{budgetUnits:1000,maxOperations:1,
    operations:[{operationId:op,identityHash,maxQuoteUnits:100}]});
  const reserved = await rpc(db,'research_transition','reserve',plan,f.actor,op,{identityHash,quoteUnits:10});
  assert.equal((await rpc(db,'research_transition','dispatch',plan,f.actor,op,{token:reserved.token})).dispatch,true);
  await rpc(db,'research_transition','finish',plan,f.actor,op,{token:reserved.token,state:'succeeded',
    result:{items:items.map(fields=>({fields,missing:[]})),cost:{actual:0}}});
  return op;
}
/** stableResearchId (research/runtime/toolContext.ts); pinned to the same sample value as its unit test. */
const stableId = (...parts) => {
  const h = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
};
const post = (days,views,extra={}) => ({id:randomUUID(),publishedAt:new Date(Date.now()-days*DAY).toISOString(),views,likes:10,comments:5,shares:1,...extra});

export async function runCases({db,Client,connectionString,report}) {
  const {accountMetrics,classifyAccount,qualifyFetchedAccount,suppliedWholeHistory} = await benchmarkCode();
  /** Supplier evidence → benchmark_fetch's own computation → the fetch cache, exactly as the tool does it. */
  async function fetchAccount(f,e,account,{followers,posts,tamper,refresh,profileOp,deferFinish,complete=true,pages,pageId}) {
    // As benchmark_fetch: claim and mark sent, then one subcall per kind under its stable operation id.
    if (pages) posts = pages.flat();
    const claim = await rpc(db,'research_account_fetch_claim',f.actor,f.session,e,'tiktok',account,refresh??null);
    assert.equal(claim.claimed,true);
    assert.equal(await rpc(db,'research_account_fetch_dispatch',f.actor,claim.fetchId,claim.attempt),true);
    // The profile's own post count decides "whole history", as in production (complete: it reports exactly these).
    const fields = {...(followers===null?{}:{followers}),postsCount:complete?posts.length:posts.length+50};
    const profile = profileOp ?? await operation(db,f,e,[fields],stableId(claim.fetchId,claim.attempt,'account_profile'));
    // `pages`: the posts list split over supplier pages, each its own subcall (0315; benchmark_fetch drops a later
    // page's repeats of earlier posts). `pageId` overrides a later page's operation id.
    const lists = pages ?? [posts];
    const postOp = await operation(db,f,e,lists[0],stableId(claim.fetchId,claim.attempt,'account_posts'));
    let items = lists[0].map((fields,i)=>({ref:`${postOp}#${i+1}`,fields,missing:[]}));
    for (let n = 2; n <= lists.length; n++) {
      const op = await operation(db,f,e,lists[n-1],pageId?.(claim,n) ?? stableId(claim.fetchId,claim.attempt,'account_posts',String(n)));
      const known = new Set(items.map(item=>item.fields.id));
      items = [...items,...lists[n-1].map((fields,i)=>({ref:`${op}#${i+1}`,fields,missing:[]})).filter(item=>!known.has(item.fields.id))];
    }
    posts = items.map(item=>item.fields);
    const now = new Date();
    const profileItem = {ref:profile+'#1',fields,missing:[]};
    const metrics = accountMetrics({profile:profileItem,posts:items,complete:suppliedWholeHistory(profileItem,items)},now);
    let evidence = {platform:'tiktok',account,metrics,fetchedAt:now.toISOString(),
      classification:qualifyFetchedAccount(metrics,classifyAccount(metrics,growth,now))};
    if (tamper) evidence = tamper(structuredClone(evidence));
    const finish = (client=db) => rpc(client,'research_account_fetch_finish',f.actor,claim.fetchId,claim.attempt,'succeeded',evidence);
    if (!deferFinish) await finish();
    return {fetchId:claim.fetchId,evidence,postOp,profile,finish};
  }
  const imitable = {followers:50000,posts:[post(2,9000),post(5,11000),post(9,10000)]};
  const failures = [];
  const check = async (name,run) => {try {await run();report.checks.push(name);} catch (error) {failures.push(name+': '+(error.stack??error));}};

  await check('RT-4b numbers copied from verified evidence; missing stays missing (must-test 3)', async () => {
    const f = await seed(db), e = await answer(db,f);
    const good = await fetchAccount(f,e,'alpha',imitable);
    const [row] = await rows(db,'fetch_id=$1',[good.fetchId]);
    assert.deepEqual([Number(row.followers),Number(row.median_views),row.category,row.qualified,row.excluded,row.execution_id],
      [50000,10000,'imitable',true,null,e]);
    assert.equal(Number(row.engagement_rate),good.evidence.metrics.engagementRate.value);
    assert.deepEqual(row.refs.followers,[good.profile+'#1']);
    assert.deepEqual([...row.operation_ids].sort(),[good.profile,good.postOp].sort());
    // Xiaohongshu-like posts without views: no median, no rate, never 0.
    const noViews = await fetchAccount(f,e,'noviews',{followers:30000,
      posts:[{id:randomUUID(),publishedAt:new Date(Date.now()-DAY).toISOString(),likes:3}]});
    const [blank] = await rows(db,'fetch_id=$1',[noViews.fetchId]);
    assert.deepEqual([blank.median_views,blank.engagement_rate,blank.qualified],[null,null,true]);
    assert.ok(blank.missing.includes('medianViews')&&blank.missing.includes('engagementRate'));
    const head = await fetchAccount(f,e,'bigstar',{followers:250000,posts:[post(1,90000)]});
    const small = await fetchAccount(f,e,'tiny',{followers:9999,posts:[post(1,900)]});
    const stale = await fetchAccount(f,e,'stale',{followers:20000,posts:[post(31,900)]});
    const [h] = await rows(db,'fetch_id=$1',[head.fetchId]), [s] = await rows(db,'fetch_id=$1',[small.fetchId]);
    const [o] = await rows(db,'fetch_id=$1',[stale.fetchId]);
    assert.deepEqual([h.category,h.qualified],['head_reference',false]);
    assert.deepEqual([s.excluded,s.qualified,o.excluded,o.qualified],['FOLLOWERS_BELOW_MIN',false,'INACTIVE_30_DAYS',false]);
    assert.equal(await qualified(db,f),2);
    // Reuse from the cache adds no row and pays nothing.
    const reused = await rpc(db,'research_account_fetch_claim',f.actor,f.session,await answer(db,f),'tiktok','alpha',null);
    assert.equal(reused.claimed,false);
    assert.equal((await rows(db,'session_id=$1',[f.session])).length,5);
  });

  await check('0315 a posts list paged over several subcalls of the same fetch attempt verifies and qualifies', async () => {
    const f = await seed(db), e = await answer(db,f);
    const twenty = Array.from({length:20},(_,i)=>post(i+1,10000+i));
    const get = async x => (await rows(db,'fetch_id=$1',[x.fetchId]))[0];
    // Production shape (#1159): 10 posts on page 1, the next 10 on page 2.
    const two = await fetchAccount(f,e,'twopages',{followers:50000,pages:[twenty.slice(0,10),twenty.slice(10)],complete:false});
    const row = await get(two);
    assert.deepEqual([row.excluded,row.qualified,row.posts_analyzed,Number(row.followers)],[null,true,20,50000]);
    assert.equal(Number(row.median_views),two.evidence.metrics.medianViews.value);
    assert.equal(row.operation_ids.length,3,'profile, page 1 and page 2 subcalls');
    // Three pages (Xiaohongshu), with page 2 repeating a page-1 post the fetch dropped.
    const three = await fetchAccount(f,e,'threepages',{followers:50000,complete:false,
      pages:[twenty.slice(0,8),[twenty[0],...twenty.slice(8,15)],twenty.slice(15)]});
    assert.deepEqual([(await get(three)).qualified,(await get(three)).posts_analyzed],[true,20]);
    // A page that is not a subcall of this attempt (another attempt's id) is still refused.
    const foreign = await fetchAccount(f,e,'foreignpage',{followers:50000,pages:[twenty.slice(0,10),twenty.slice(10)],complete:false,
      pageId:(claim,n)=>stableId(claim.fetchId,randomUUID(),'account_posts',String(n))});
    assert.deepEqual([(await get(foreign)).excluded,(await get(foreign)).qualified],['EVIDENCE_UNVERIFIED',false]);
    // Page 4 is beyond the largest supported paging (1 + BENCHMARK_EXTRA_POST_PAGES).
    const four = await fetchAccount(f,e,'fourpages',{followers:50000,complete:false,
      pages:[twenty.slice(0,5),twenty.slice(5,10),twenty.slice(10,15),twenty.slice(15)]});
    assert.deepEqual([(await get(four)).excluded,(await get(four)).qualified],['EVIDENCE_UNVERIFIED',false]);
    assert.equal(await qualified(db,f),2);
  });

  await check('RT-4b fewer than 20 analyzed posts qualify only as the whole history (Owner 2026-10-16, A)', async () => {
    const f = await seed(db), e = await answer(db,f);
    const few = [post(1,9000),post(2,10000),post(3,11000)];
    const twenty = Array.from({length:20},(_,i)=>post(i+1,10000+i));
    const short = await fetchAccount(f,e,'short',{followers:50000,posts:few,complete:false});
    const whole = await fetchAccount(f,e,'newaccount',{followers:50000,posts:few,complete:true});
    const full = await fetchAccount(f,e,'twenty',{followers:50000,posts:twenty,complete:false});
    const forged = await fetchAccount(f,e,'forgedshort',{followers:50000,posts:few,complete:false,
      tamper:x=>{x.classification={category:'imitable',qualified:true,excluded:null};return x;}});
    // Claiming the whole history while the profile reports more posts is refused too.
    const claimed = await fetchAccount(f,e,'claimedwhole',{followers:50000,posts:few,complete:false,
      tamper:x=>{x.metrics.wholeHistory=true;x.classification={category:'imitable',qualified:true,excluded:null};return x;}});
    const get = async x => (await rows(db,'fetch_id=$1',[x.fetchId]))[0];
    assert.deepEqual([(await get(short)).excluded,(await get(short)).qualified],['TOO_FEW_POSTS',false]);
    assert.deepEqual([(await get(whole)).qualified,(await get(whole)).whole_history],[true,true]);
    assert.deepEqual([(await get(full)).qualified,(await get(full)).posts_analyzed],[true,20]);
    assert.deepEqual([(await get(forged)).excluded,(await get(forged)).qualified],['EVIDENCE_UNVERIFIED',false]);
    assert.deepEqual([(await get(claimed)).excluded,(await get(claimed)).qualified],['EVIDENCE_UNVERIFIED',false]);
    // Repeated entries are not more posts: 3 copies of one post never make a 3-post "whole history".
    const one = post(1,9000);
    const repeated = await fetchAccount(f,e,'repeated',{followers:50000,posts:[one,one,one],complete:true});
    assert.equal(repeated.evidence.metrics.wholeHistory,false);
    assert.deepEqual([(await get(repeated)).excluded,(await get(repeated)).qualified],['TOO_FEW_POSTS',false]);
    // 20 entries of 3 posts are 3 analyzed posts: below the minimum, and a cache claiming 20 is refused.
    const three = [post(1,9000),post(2,10000),post(3,11000)];
    const twentyOfThree = Array.from({length:20},(_,i)=>three[i%3]);
    const dup = await fetchAccount(f,e,'dupentries',{followers:50000,posts:twentyOfThree,complete:false});
    assert.deepEqual([(await get(dup)).posts_analyzed,(await get(dup)).excluded],[3,'TOO_FEW_POSTS']);
    const dupForged = await fetchAccount(f,e,'dupforged',{followers:50000,posts:twentyOfThree,complete:false,
      tamper:x=>{x.metrics.postsAnalyzed=20;x.classification={category:'imitable',qualified:true,excluded:null};return x;}});
    assert.deepEqual([(await get(dupForged)).excluded,(await get(dupForged)).qualified],['EVIDENCE_UNVERIFIED',false]);
    const forcedWhole = await fetchAccount(f,e,'forcedwhole',{followers:50000,posts:[one,one,one],complete:true,
      tamper:x=>{x.metrics.wholeHistory=true;x.classification={category:'imitable',qualified:true,excluded:null};return x;}});
    assert.deepEqual([(await get(forcedWhole)).excluded,(await get(forcedWhole)).qualified],['EVIDENCE_UNVERIFIED',false]);
    // A whole-history claim whose profile item is missing altogether is a failed check, not an error on the paid fetch.
    // (No number cites anything, so only the whole-history check can fail: the profile operation does not exist.)
    const orphan = await fetchAccount(f,e,'orphan',{followers:null,posts:[],complete:true,profileOp:randomUUID()});
    assert.equal(orphan.evidence.metrics.wholeHistory,true);
    assert.deepEqual([(await get(orphan)).excluded,(await get(orphan)).whole_history],['EVIDENCE_UNVERIFIED',false]);
    assert.equal(await qualified(db,f),2);
    await assert.rejects(db.query(`UPDATE research_benchmarks SET whole_history=false WHERE fetch_id=$1`,[whole.fetchId]),/check constraint/);
  });

  await check('RT-4b numbers not backed by the evidence items never enter the table (must-test 5)', async () => {
    const f = await seed(db), e = await answer(db,f), other = await seed(db);
    const foreign = await operation(db,other,await answer(db,other),[{followers:50000}]);
    const forged = {
      followers: x => {x.metrics.followers.value=150000;return x;},
      medianViews: x => {x.metrics.medianViews.value=999999;return x;},
      engagementRate: x => {x.metrics.engagementRate.value=0.9;return x;},
      lastPublishedAt: x => {x.metrics.lastPublishedAt.value=new Date().toISOString();return x;},
      unknownRef: x => {x.metrics.followers.refs=[randomUUID()+'#1'];return x;},
      itemOutOfRange: x => {x.metrics.medianViews.refs=[x.metrics.medianViews.refs[0].replace(/#\d+$/,'#9')];return x;},
      textRef: x => {x.metrics.followers.refs=['model-said-so'];return x;},
      postsPerWeek: x => {x.metrics.postsPerWeek.value=7;return x;},
      postsAnalyzed: x => {x.metrics.postsAnalyzed=30;return x;},
      postsAnalyzedLow: x => {x.metrics.postsAnalyzed=1;x.metrics.postsPerWeek={value:null,refs:[]};return x;},
      // No frequency to cross-check: the count must still equal this attempt's own posts operation.
      postsAnalyzedHigh: x => {x.metrics.postsAnalyzed=20;x.metrics.postsPerWeek={value:null,refs:[]};return x;},
      cappedFrequency: x => {x.metrics.wholeHistory=false;return x;},
      // A chosen subset (one strong post) with its honestly computed median is still not the fetch's median.
      // One recent post cited 20 times "proves" a weekly frequency the 20 analyzed posts do not have.
      repeatedFrequencyRef: x => {const ref=x.metrics.postsPerWeek.refs[0];x.metrics.postsPerWeek={value:20*7/30,refs:Array(20).fill(ref)};return x;},
      medianSubset: x => {const ref=x.metrics.medianViews.refs[1];x.metrics.medianViews={value:11000,refs:[ref]};return x;},
      category: x => {x.classification={category:'imitable',qualified:true,excluded:null};x.metrics.followers.value=5000;return x;},
    };
    for (const [name,tamper] of Object.entries(forged)) {
      const followers = name==='category'?5000:50000;
      // A full page of 30 posts all inside the window: only the whole history makes its frequency known.
      const posts = name==='cappedFrequency' ? Array.from({length:30},(_,i)=>post(i*0.5+0.1,10000))
        : name==='repeatedFrequencyRef' ? Array.from({length:20},(_,i)=>post(i<10?i+1:40+i,10000)) : imitable.posts;
      const got = await fetchAccount(f,e,'forged'+name.toLowerCase(),{...imitable,posts,followers,tamper});
      const [row] = await rows(db,'fetch_id=$1',[got.fetchId]);
      assert.deepEqual([row.excluded,row.qualified,row.category,row.followers,row.median_views,row.last_published_at],
        ['EVIDENCE_UNVERIFIED',false,null,null,null,null],name);
    }
    // Another account fetched in this same session cannot lend its evidence either.
    const neighbour = await fetchAccount(f,e,'neighbour',imitable);
    const crossed = await fetchAccount(f,e,'crossed',{...imitable,profileOp:neighbour.profile});
    assert.equal((await rows(db,'fetch_id=$1',[crossed.fetchId]))[0].excluded,'EVIDENCE_UNVERIFIED');
    assert.equal((await rows(db,'fetch_id=$1',[neighbour.fetchId]))[0].qualified,true);
    assert.equal((await db.query("SELECT research_benchmark_operation_id('00000000-0000-4000-8000-000000000001',"
      +"'00000000-0000-4000-8000-000000000002','account_profile') v")).rows[0].v,'3f40c5bf-153d-4715-afd9-a006774ffa94');
    // Evidence of another user's session cannot back this session's numbers.
    const got = await fetchAccount(f,e,'foreign',{...imitable,profileOp:foreign});
    assert.equal((await rows(db,'fetch_id=$1',[got.fetchId]))[0].excluded,'EVIDENCE_UNVERIFIED');
    assert.equal(await qualified(db,f),1,'only the honest neighbour');
    // No role but the owner writes the table or calls its writers; the qualified CHECK is the last line.
    for (const role of ['anon','authenticated','service_role']) {
      for (const statement of ['SELECT 1 FROM research_benchmarks LIMIT 1',
        "UPDATE research_benchmarks SET followers=1",
        `INSERT INTO research_benchmarks(fetch_id,actor_id,session_id,execution_id,platform,account,posts_analyzed,qualified,refs,operation_ids,missing,fetched_at,category)
          VALUES('${got.fetchId}','${f.actor}','${f.session}','${e}','tiktok','x',1,false,'{}','{}','{}',now(),'imitable')`,
        `SELECT research_benchmark_qualified('${f.actor}','${f.session}')`,
        `SELECT research_benchmark_item('${f.actor}','${f.session}','x')`]) {
        await db.query('BEGIN');
        try {
          await db.query(`SET LOCAL ROLE ${role}`);
          await assert.rejects(db.query(statement),/permission denied/,role+': '+statement);
        } finally {await db.query('ROLLBACK');}
      }
    }
    await db.query('BEGIN');
    try {
      await db.query('SET LOCAL ROLE service_role');
      assert.equal((await db.query('SELECT research_benchmark_rows($1,$2) v',[f.actor,f.session])).rows[0].v.rows.length,18);
    } finally {await db.query('ROLLBACK');}
    // RT-5 research.benchmarks reads through research_benchmark_rows: the owner only. Another user, or the owner
    // naming another user's session, is refused; client roles cannot call it at all.
    await assert.rejects(rpc(db,'research_benchmark_rows',other.actor,f.session),/RESEARCH_SCOPE_DENIED/);
    await assert.rejects(rpc(db,'research_benchmark_rows',f.actor,other.session),/RESEARCH_SCOPE_DENIED/);
    for (const role of ['anon','authenticated']) {
      await db.query('BEGIN');
      try {
        await db.query(`SET LOCAL ROLE ${role}`);
        await assert.rejects(db.query('SELECT research_benchmark_rows($1,$2)',[f.actor,f.session]),/permission denied/,role);
      } finally {await db.query('ROLLBACK');}
    }
    // 0282 research_user_benchmarks: the same rows for the owner, now with the refs of every displayed number.
    const mine = await rpc(db,'research_user_benchmarks',f.actor,f.session);
    assert.equal(mine.length,18);
    const stored = await rows(db,'session_id=$1',[f.session]);
    assert.ok(stored.some(x=>x.excluded==='EVIDENCE_UNVERIFIED'&&JSON.stringify(x.refs).includes('model-said-so')),'the textRef case is in the table');
    for (const row of mine) {
      const source = stored.find(x=>x.platform===row.platform&&x.account===row.account);
      for (const key of ['followers','medianViews','engagementRate','postsPerWeek','lastPublishedAt']) {
        // A quarantined row (EVIDENCE_UNVERIFIED) keeps its unverified raw refs in the table (the textRef case stores
        // 'model-said-so'); the user never gets them, nor refs of a number that is null.
        const none = source.excluded==='EVIDENCE_UNVERIFIED' || row[key]===null;
        assert.deepEqual(row.refs[key],none?[]:(source.refs[key]??[]),row.account+' '+key);
        for (const ref of row.refs[key]) assert.match(ref,/^[0-9a-f-]{36}#\d{1,3}$/,row.account+' '+key);
      }
      assert.ok(!JSON.stringify(row).match(/cost|operation_ids|execution_id|fetch_id/));
    }
    await assert.rejects(rpc(db,'research_user_benchmarks',other.actor,f.session),/RESEARCH_SCOPE_DENIED/);
    await assert.rejects(rpc(db,'research_user_benchmarks',f.actor,other.session),/RESEARCH_SCOPE_DENIED/);
    for (const role of ['anon','authenticated']) {
      await db.query('BEGIN');
      try {
        await db.query(`SET LOCAL ROLE ${role}`);
        await assert.rejects(db.query('SELECT research_user_benchmarks($1,$2)',[f.actor,f.session]),/permission denied/,role);
      } finally {await db.query('ROLLBACK');}
    }
    await assert.rejects(db.query(`UPDATE research_benchmarks SET qualified=true,category='imitable',excluded=NULL,followers=5000,
      last_published_at=now(),posts_analyzed=1 WHERE fetch_id=$1`,[got.fetchId]),/check constraint/);
  });

  // Report gate: same admission checkpoint as every other report refusal (report_admission_check).
  const gate = (f,benchmarkHash) => gateOn(db,f,benchmarkHash);
  async function gateOn(client,f,benchmarkHash) {
    const source = await rpc(db,'report_source',f.actor,f.session,f.project,f.round);
    if (benchmarkHash===undefined) benchmarkHash = (await rpc(db,'research_benchmark_rows',f.actor,f.session)).hash;
    const context = {reportGeneration:{snapshotHash:source.snapshotHash,projectId:f.project,roundId:f.round,
      sections:['One','Two'],maxCharacters:12000,...(benchmarkHash?{benchmarkHash}:{})},role:'skill',maxTurns:1,historyItems:0,network:'deny',tools:[],sources:[],
      purposeBudget:{purpose:'report'},revisionId:f.revision,moduleId:f.module};
    return client.query('SELECT report_admission_check($1,$2,$3,$4)',[f.actor,f.session,context,{contractVersion:'bill2.v2'}]);
  }
  await db.query(`INSERT INTO system_settings(key,value) VALUES('runtime_report_generation','{"enabled":true}')
    ON CONFLICT (key) DO UPDATE SET value=excluded.value`);
  await check('RT-4b positioning report refused below 3 qualified of this session (must-test 6)', async () => {
    const f = await seed(db), e = await answer(db,f);
    await assert.rejects(gate(f),/REPORT_BENCHMARKS_REQUIRED/);
    // Three qualified accounts in another, completed session do not count here.
    const other = await seed(db), oe = await answer(db,other);
    for (const account of ['o1','o2','o3']) await fetchAccount(other,oe,account,imitable);
    await gate(other);
    await assert.rejects(gate(f),/REPORT_BENCHMARKS_REQUIRED/);
    await fetchAccount(f,e,'a1',imitable);
    await fetchAccount(f,e,'a2',imitable);
    await fetchAccount(f,e,'head',{followers:300000,posts:[post(1,5)]});
    await assert.rejects(gate(f),/REPORT_BENCHMARKS_REQUIRED/,'a head reference never counts');
    const e2 = await answer(db,f);
    await fetchAccount(f,e2,'a3',imitable);
    await gate(f);
    // The rows frozen into the report must still be current at admission: a fourth row deleted after they were read
    // (the gate count still passes) is a source conflict, never a report that carries erased data.
    const e3 = await answer(db,f);
    await fetchAccount(f,e3,'a4',imitable);
    const frozen = (await rpc(db,'research_benchmark_rows',f.actor,f.session)).hash;
    await gate(f,frozen);
    await erase(db,f,'answer',e3);
    await assert.rejects(gate(f,frozen),/REPORT_SOURCE_CONFLICT/);
    // A report frozen by code before 0268 carries no rows and no hash: only the count gate applies (rollout order).
    await gate(f,null);
    await gate(f);
    // Every report model-call claim re-checks the same frozen rows (a report may wait for credits or resume).
    const claimDefinition = (await db.query(
      "SELECT pg_get_functiondef('public.bill2_payg_claim(uuid,uuid,integer,jsonb)'::regprocedure) d")).rows[0].d;
    const branch = claimDefinition.slice(claimDefinition.indexOf("IF r.payload#>'{input,reportGeneration}' IS NOT NULL THEN"));
    assert.match(branch.slice(0,branch.indexOf(' END IF;\n')+1200),
      /research_benchmark_report_current\(a,r\.session_ref,r\.payload#>'\{input,reportGeneration\}'\)/);
    // ...and so does the final dispatch checkpoint: a stale hash there is "not dispatched", never an HTTP grant.
    const dispatchDefinition = (await db.query(
      "SELECT pg_get_functiondef('public.bill2_dispatch(uuid,uuid,uuid,uuid,boolean,jsonb)'::regprocedure) d")).rows[0].d;
    const grant = dispatchDefinition.indexOf(" UPDATE bill2_calls SET state='dispatched'");
    const guard = dispatchDefinition.indexOf("research_benchmark_report_current(p_actor_id,r.session_ref,r.payload#>'{input,reportGeneration}')");
    assert.ok(guard>0 && guard<grant && dispatchDefinition.indexOf("profiles WHERE id=p_actor_id")<guard,'dispatch re-check before the grant');
    assert.match(dispatchDefinition.slice(guard,grant),/EXCEPTION WHEN raise_exception THEN RETURN jsonb_build_object\('dispatch',false\)/);
    const current = async frozen => db.query('SELECT research_benchmark_report_current($1,$2,$3)',[f.actor,f.session,frozen]);
    const now = (await rpc(db,'research_benchmark_rows',f.actor,f.session)).hash;
    await current({benchmarkHash:now});
    await current({});
    await assert.rejects(current({benchmarkHash:frozen}),error=>error.code==='P0001'&&/REPORT_SOURCE_CONFLICT/.test(error.message));
    // Deleting the answer that produced one qualified row drops it below 3: refused again.
    await erase(db,f,'answer',e2);
    assert.equal((await rows(db,'execution_id=$1',[e2])).length,0);
    assert.equal(await qualified(db,f),2);
    await assert.rejects(gate(f),/REPORT_BENCHMARKS_REQUIRED/);
    // A Skill declaring fewer than 3 (or nothing) is still held to 3; a higher declaration raises it.
    const required = async (scope,spec) => (await db.query('SELECT research_benchmark_required($1,$2) n',[scope,spec])).rows[0].n;
    const positioning = {kind:'positioning_draft',draftId:randomUUID()}, work = {kind:'work_item',workItemId:randomUUID()};
    assert.deepEqual([await required(positioning,{}),await required(positioning,{minQualifiedBenchmarks:1}),
      await required(positioning,{minQualifiedBenchmarks:5}),await required(work,{}),await required(work,{minQualifiedBenchmarks:2}),
      await required(work,{minQualifiedBenchmarks:40}),await required(work,{minQualifiedBenchmarks:'x'})],[3,3,5,0,3,12,3]);
    const higher = await seed(db,'complete',0,{minQualifiedBenchmarks:5}), he = await answer(db,higher);
    for (const account of ['h1','h2','h3']) await fetchAccount(higher,he,account,imitable);
    await assert.rejects(gate(higher),/REPORT_BENCHMARKS_REQUIRED/);
    const lower = await seed(db,'complete',0,{minQualifiedBenchmarks:1}), le = await answer(db,lower);
    await fetchAccount(lower,le,'l1',imitable);
    await assert.rejects(gate(lower),/REPORT_BENCHMARKS_REQUIRED/);
  });

  await check('RT-4b deleting the conversation, an evidence artifact, or the account clears the table (must-test 10)', async () => {
    const f = await seed(db), e = await answer(db,f);
    await fetchAccount(f,e,'s1',imitable);
    await erase(db,f,'session',f.session);
    assert.equal((await rows(db,'session_id=$1',[f.session])).length,0);
    // An artifact whose evidence row names the research operation: the derived numbers go with it.
    const g = await seed(db), ge = await answer(db,g);
    const linked = await fetchAccount(g,ge,'linked',imitable), kept = await fetchAccount(g,ge,'kept',imitable);
    // No number cites this account's posts request (no dates, no views), yet it gave the analyzed count.
    const uncited = await fetchAccount(g,ge,'uncited',{followers:50000,posts:[{likes:1}]});
    assert.equal((await rows(db,'fetch_id=$1',[uncited.fetchId]))[0].excluded,'NO_PUBLISH_TIME');
    const project = randomUUID();
    await db.query('INSERT INTO artifact_projects(id,actor_id,module_id,skill_id,account) VALUES($1,$2,$3,$4,$5)',
      [project,g.actor,g.module,g.skill,'rt4b-'+project]);
    await db.query(`INSERT INTO artifact_evidence(id,project_id,kind,operation_id,payload,content_hash)
      VALUES(gen_random_uuid(),$1,'supplier',$2,'{}',repeat('a',64))`,[project,linked.postOp]);
    await db.query(`INSERT INTO artifact_evidence(id,project_id,kind,operation_id,payload,content_hash)
      VALUES(gen_random_uuid(),$1,'supplier',$2,'{}',repeat('a',64))`,[project,uncited.postOp]);
    await erase(db,g,'artifact',project);
    assert.deepEqual((await rows(db,'session_id=$1',[g.session])).map(r=>r.fetch_id),[kept.fetchId]);
    // Running 0268 again (its backfill re-projects every cache) never brings back the row of erased evidence.
    await db.query(readFileSync(new URL('../../migrations/0268_research_benchmarks.sql',import.meta.url),'utf8'));
    assert.deepEqual((await rows(db,'session_id=$1',[g.session])).map(r=>r.fetch_id),[kept.fetchId]);
    // Account erasure removes every row and reports the count.
    await fetchAccount(g,ge,'more',imitable);
    await closeAccount(db,g);
    const counts = (await db.query('SELECT account_erasure_scrub_content($1) v',[g.actor])).rows[0].v;
    assert.equal(counts.research_benchmarks_deleted,2);
    assert.equal((await rows(db,'actor_id=$1',[g.actor])).length,0);
  });

  await check('RT-4b a paid refresh replaces the row; deleting the refreshing answer removes it', async () => {
    const f = await seed(db), e = await answer(db,f);
    await fetchAccount(f,e,'fresh',imitable);
    const grant = await rpc(db,'research_refresh_create',f.actor,f.session,'tiktok','fresh');
    const e2 = await answer(db,f);
    const refreshed = await fetchAccount(f,e2,'fresh',{followers:60000,posts:[post(1,7000)],refresh:grant});
    const [row] = await rows(db,'fetch_id=$1',[refreshed.fetchId]);
    assert.deepEqual([Number(row.followers),Number(row.median_views),row.execution_id],[60000,7000,e2]);
    // A later refresh that fails or ends unknown keeps the row of the retained success, verified as before.
    for (const outcome of ['failed','unknown']) {
      const keepGrant = await rpc(db,'research_refresh_create',f.actor,f.session,'tiktok','fresh');
      const retry = await rpc(db,'research_account_fetch_claim',f.actor,f.session,await answer(db,f),'tiktok','fresh',keepGrant);
      assert.equal(await rpc(db,'research_account_fetch_dispatch',f.actor,retry.fetchId,retry.attempt),true);
      await rpc(db,'research_account_fetch_finish',f.actor,retry.fetchId,retry.attempt,outcome,null);
      const [kept] = await rows(db,'fetch_id=$1',[refreshed.fetchId]);
      assert.deepEqual([kept.qualified,kept.excluded,Number(kept.followers),kept.execution_id],[true,null,60000,e2],outcome);
    }
    // Re-running 0268 (its backfill) after those failed refreshes keeps the verified row: projection uses the attempt
    // that produced the success, not the failed refresh's attempt.
    const migration = readFileSync(new URL('../../migrations/0268_research_benchmarks.sql',import.meta.url),'utf8');
    await db.query(migration);
    const [again0] = await rows(db,'fetch_id=$1',[refreshed.fetchId]);
    assert.deepEqual([again0.qualified,again0.excluded,Number(again0.followers)],[true,null,60000]);
    // A cache from before 0268 (no recorded success attempt) whose last refresh failed: its attempt is unknowable, so
    // the backfill gives it no row rather than a misleading unverified one.
    await db.query('UPDATE research_account_fetches SET last_success_attempt=NULL WHERE id=$1',[refreshed.fetchId]);
    await db.query('DELETE FROM research_benchmarks WHERE fetch_id=$1',[refreshed.fetchId]);
    await db.query(migration);
    assert.equal((await rows(db,'fetch_id=$1',[refreshed.fetchId])).length,0);
    // ...while one still ending in its success gets its verified row back, and the inferred attempt is kept.
    const legacy = await fetchAccount(f,await answer(db,f),'legacy',imitable);
    await db.query('UPDATE research_account_fetches SET last_success_attempt=NULL WHERE id=$1',[legacy.fetchId]);
    await db.query('DELETE FROM research_benchmarks WHERE fetch_id=$1',[legacy.fetchId]);
    await db.query(migration);
    assert.deepEqual((await rows(db,'fetch_id=$1',[legacy.fetchId])).map(r=>[r.qualified,r.excluded]),[[true,null]]);
    assert.equal((await db.query('SELECT last_success_attempt=attempt v FROM research_account_fetches WHERE id=$1',[legacy.fetchId])).rows[0].v,true);
    await erase(db,f,'answer',e2);
    assert.equal((await rows(db,'session_id=$1 AND account=$2',[f.session,'fresh'])).length,0);
    // The rows the report reads exclude deleted answers and carry no supplier cost.
    await fetchAccount(f,e,'again',imitable);
    const facts = (await rpc(db,'research_benchmark_rows',f.actor,f.session)).rows;
    assert.deepEqual(facts.map(x=>[x.account,x.qualified]).sort(),[['again',true],['legacy',true]]);
    assert.ok(!JSON.stringify(facts).includes('cost'));
  });
  await check('RT-4b a fetch finishing during report admission is serialized with it (no stale report)', async () => {
    const f = await seed(db), e = await answer(db,f);
    for (const account of ['c1','c2','c3']) await fetchAccount(f,e,account,imitable);
    const late = await fetchAccount(f,e,'late',{...imitable,deferFinish:true});
    const admit = new Client({connectionString}), finisher = new Client({connectionString});
    await admit.connect();await finisher.connect();
    const blocked = async promise => Promise.race([promise.then(()=>false,()=>false),new Promise(r=>setTimeout(()=>r(true),700))]);
    try {
      // Admission first: the finish waits until the admitted report (built on the rows it saw) commits.
      const before = (await rpc(db,'research_benchmark_rows',f.actor,f.session)).hash;
      await admit.query('BEGIN');
      await admit.query('SELECT 1 FROM runtime_sessions WHERE id=$1 FOR UPDATE',[f.session]);
      await gateOn(admit,f,before);
      const finishing = late.finish(finisher);
      assert.equal(await blocked(finishing),true,'finish waits for the admission');
      await admit.query('COMMIT');
      await finishing;
      assert.equal((await rows(db,'fetch_id=$1',[late.fetchId])).length,1);
      // Finish first (uncommitted): admission waits for it, then sees the new rows and refuses the stale hash.
      const grant = await rpc(db,'research_refresh_create',f.actor,f.session,'tiktok','late');
      const stale = (await rpc(db,'research_benchmark_rows',f.actor,f.session)).hash;
      const again = await fetchAccount(f,await answer(db,f),'late',{followers:70000,posts:[post(1,8000)],refresh:grant,deferFinish:true});
      await finisher.query('BEGIN');
      await again.finish(finisher);
      await admit.query('BEGIN');
      await admit.query('SELECT 1 FROM runtime_sessions WHERE id=$1 FOR UPDATE',[f.session]);
      const admitting = gateOn(admit,f,stale);
      assert.equal(await blocked(admitting),true,'admission waits for the finish');
      await finisher.query('COMMIT');
      await assert.rejects(admitting,/REPORT_SOURCE_CONFLICT/);
      await admit.query('ROLLBACK');
    } finally {await admit.end();await finisher.end();}
  });
  assert.deepEqual(failures,[],failures.join('\n'));
}
