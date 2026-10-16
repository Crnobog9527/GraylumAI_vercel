/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// RESEARCH-TOOLS RT-4b (0268): benchmark table from fetched evidence only, its erasure, and the report gate.
// Synthetic fixtures only; metrics come from the real accountMetrics/classifyAccount.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
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
async function operation(db,f,e,items) {
  const plan = randomUUID(), op = randomUUID(), identityHash = 'e'.repeat(64);
  await rpc(db,'research_runtime_plan_create',f.actor,plan,f.session,e,null,{budgetUnits:1000,maxOperations:1,
    operations:[{operationId:op,identityHash,maxQuoteUnits:100}]});
  const reserved = await rpc(db,'research_transition','reserve',plan,f.actor,op,{identityHash,quoteUnits:10});
  assert.equal((await rpc(db,'research_transition','dispatch',plan,f.actor,op,{token:reserved.token})).dispatch,true);
  await rpc(db,'research_transition','finish',plan,f.actor,op,{token:reserved.token,state:'succeeded',
    result:{items:items.map(fields=>({fields,missing:[]})),cost:{actual:0}}});
  return op;
}
const post = (days,views,extra={}) => ({publishedAt:new Date(Date.now()-days*DAY).toISOString(),views,likes:10,comments:5,shares:1,...extra});

export async function runCases({db,Client,connectionString,report}) {
  const {accountMetrics,classifyAccount} = await benchmarkCode();
  /** Supplier evidence → benchmark_fetch's own computation → the fetch cache, exactly as the tool does it. */
  async function fetchAccount(f,e,account,{followers,posts,tamper,refresh,profileOp,deferFinish}) {
    const profile = profileOp ?? await operation(db,f,e,[followers===null?{}:{followers}]);
    const postOp = await operation(db,f,e,posts);
    const now = new Date();
    const metrics = accountMetrics({profile:{ref:profile+'#1',fields:followers===null?{}:{followers},missing:[]},
      posts:posts.map((fields,i)=>({ref:`${postOp}#${i+1}`,fields,missing:[]})),complete:true},now);
    let evidence = {platform:'tiktok',account,metrics,classification:classifyAccount(metrics,growth,now),fetchedAt:now.toISOString()};
    if (tamper) evidence = tamper(structuredClone(evidence));
    const claim = await rpc(db,'research_account_fetch_claim',f.actor,f.session,e,'tiktok',account,refresh??null);
    assert.equal(claim.claimed,true);
    assert.equal(await rpc(db,'research_account_fetch_dispatch',f.actor,claim.fetchId,claim.attempt),true);
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
      posts:[{publishedAt:new Date(Date.now()-DAY).toISOString(),likes:3}]});
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
      category: x => {x.classification={category:'imitable',qualified:true,excluded:null};x.metrics.followers.value=5000;return x;},
    };
    for (const [name,tamper] of Object.entries(forged)) {
      const followers = name==='category'?5000:50000;
      const got = await fetchAccount(f,e,'forged'+name.toLowerCase(),{...imitable,followers,tamper});
      const [row] = await rows(db,'fetch_id=$1',[got.fetchId]);
      assert.deepEqual([row.excluded,row.qualified,row.category,row.followers,row.median_views,row.last_published_at],
        ['EVIDENCE_UNVERIFIED',false,null,null,null,null],name);
    }
    // Evidence of another user's session cannot back this session's numbers.
    const got = await fetchAccount(f,e,'foreign',{...imitable,profileOp:foreign});
    assert.equal((await rows(db,'fetch_id=$1',[got.fetchId]))[0].excluded,'EVIDENCE_UNVERIFIED');
    assert.equal(await qualified(db,f),0);
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
      assert.equal((await db.query('SELECT research_benchmark_rows($1,$2) v',[f.actor,f.session])).rows[0].v.rows.length,12);
    } finally {await db.query('ROLLBACK');}
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
    const current = async frozen => db.query('SELECT research_benchmark_report_current($1,$2,$3)',[f.actor,f.session,frozen]);
    const now = (await rpc(db,'research_benchmark_rows',f.actor,f.session)).hash;
    await current({benchmarkHash:now});
    await current({});
    await assert.rejects(current({benchmarkHash:frozen}),/REPORT_SOURCE_CONFLICT/);
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
    const project = randomUUID();
    await db.query('INSERT INTO artifact_projects(id,actor_id,module_id,skill_id,account) VALUES($1,$2,$3,$4,$5)',
      [project,g.actor,g.module,g.skill,'rt4b-'+project]);
    await db.query(`INSERT INTO artifact_evidence(id,project_id,kind,operation_id,payload,content_hash)
      VALUES(gen_random_uuid(),$1,'supplier',$2,'{}',repeat('a',64))`,[project,linked.postOp]);
    await erase(db,g,'artifact',project);
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
    await erase(db,f,'answer',e2);
    assert.equal((await rows(db,'session_id=$1',[f.session])).length,0);
    // The rows the report reads exclude deleted answers and carry no supplier cost.
    await fetchAccount(f,e,'again',imitable);
    const facts = (await rpc(db,'research_benchmark_rows',f.actor,f.session)).rows;
    assert.deepEqual(facts.map(x=>[x.account,x.qualified]),[['again',true]]);
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
