/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Launch audit (2026-11-02): erasure at volume on the core-path tables (turns, turn_calls, turn_call_raw, session_messages).
// 1. A conversation of 24+ rounds (model call + paid tool + free tool per round, large response bodies, two messages each)
//    is deleted inside the existing limits: statement timeout 8 s, mark < 1 s, cleanup < 1 s (turn-erasure, plan 6.1 V2-9).
// 2. A whole account (several conversations of 22+ rounds, ticket attachments in storage) is erased through the real
//    executor (production composition, external HTTP replaced by the synthetic SDK) inside the executor's 10 s per-subject
//    budget with the same 8 s statement ceiling, and leaves no content row; billing records are unchanged.
// Disposable local PostgreSQL only; nothing here reads an environment secret, a remote host or a paid service.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdirSync,mkdtempSync,readFileSync,existsSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,relative,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {localDb,root} from '../runtime-view-perf/local-db.mjs';
import {transport} from '../monthly-refund/adapter.mjs';
import {syntheticSdk} from '../pay-erasure-integration/sdk.mjs';
import {startRedisDouble} from '../erasure-completion/redis-double.mjs';
import {rounds} from './rounds.mjs';

const ROUNDS=24,ACCOUNT_ROUNDS=[22,22,26],ATTACHMENTS=30;
const MARK_LIMIT_MS=1000,CLEANUP_LIMIT_MS=1000,STATEMENT_LIMIT='8s',EXECUTOR_LIMIT_MS=10_000;
const db=await localDb(),c=db.client,report={build:db.build,checks:[],samples:{}};
const {one,account,newSession,round,content,raws,money}=rounds(c);
let compiled,redis,service;
try{
 // 1. One conversation of ROUNDS rounds, deleted within the existing limits, leaves no content and no response body.
 {
  const a=await account();
  const started=performance.now();
  for(let n=1;n<=ROUNDS;n++)await round(a,a.session,n);
  report.samples.buildConversationMs=Math.round(performance.now()-started);
  assert.deepEqual(await content([a.session]),{visible:ROUNDS*2,text:ROUNDS*2,total:ROUNDS*2});
  assert.equal(await raws([a.session]),ROUNDS*3);
  assert.equal(await one("select count(*)::int v from turn_calls where actor_id=$1 and call_kind='tool'",[a.actor]),ROUNDS*2);
  const before=await money(a);
  await c.query('begin');await c.query(`set local statement_timeout='${STATEMENT_LIMIT}'`);
  let start=performance.now();
  const marked=await one('select content_erasure_mark_session($1,$2) v',[a.actor,a.session]);
  report.samples.markMs=Math.round(performance.now()-start);await c.query('commit');
  assert.equal(marked.status,'deleted');assert.ok(report.samples.markMs<MARK_LIMIT_MS,`mark ${report.samples.markMs} ms`);
  assert.equal((await content([a.session])).visible,0,'out of the history at once');
  start=performance.now();
  const swept=await one('select content_erasure_sweep_sessions(200,null,null) v');
  report.samples.cleanupMs=Math.round(performance.now()-start);
  assert.ok(swept.cleaned>=1&&swept.failed===0&&swept.pending===0,JSON.stringify(swept));
  assert.ok(report.samples.cleanupMs<CLEANUP_LIMIT_MS,`cleanup ${report.samples.cleanupMs} ms`);
  assert.deepEqual(await content([a.session]),{visible:0,text:0,total:ROUNDS*2});
  assert.equal(await raws([a.session]),0,'no response body of any round, model or tool, is left');
  assert.equal(await one("select count(*)::int v from session_messages where session_id=$1 and content_hash<>encode(sha256(''::bytea),'hex')",[a.session]),0);
  assert.deepEqual(await money(a),before,'turns, receipts (tool rows included) and the ledger are billing records: unchanged');
  assert.equal(await one('select count(*)::int v from turn_calls where actor_id=$1',[a.actor]),ROUNDS*3);
  report.checks.push(`conversation of ${ROUNDS} rounds (${ROUNDS*3} receipts incl. ${ROUNDS*2} tool rows, ${ROUNDS*3} response bodies): mark ${report.samples.markMs} ms (< ${MARK_LIMIT_MS}), cleanup ${report.samples.cleanupMs} ms (< ${CLEANUP_LIMIT_MS}) under statement_timeout ${STATEMENT_LIMIT}; no text or body left, billing unchanged`);
 }
 // 2. A whole account through the real executor.
 {
  const require=createRequire(resolve(root,'packages/api/package.json'));
  const ts=require('typescript');
  compiled=mkdtempSync(resolve(root,'packages/api/.erasure-volume-test-'));
  const src=resolve(root,'packages/api/src'),done=new Set();
  const emit=file=>{
   if(done.has(file))return;done.add(file);
   const code=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText
    .replace(/from '(\.{1,2}\/[^']+)'/g,(_,spec)=>{
     const base=resolve(dirname(file),spec);const found=[base+'.ts',base+'/index.ts'].find(existsSync);
     assert.ok(found,'unresolved import '+spec);emit(found);
     return `from '${spec}${found.endsWith('/index.ts')?'/index':''}.mjs'`;
    });
   const target=resolve(compiled,relative(src,file)).replace(/\.ts$/,'.mjs');
   mkdirSync(dirname(target),{recursive:true});writeFileSync(target,code);
  };
  emit(resolve(src,'services/accountErasure/executor.ts'));
  redis=await startRedisDouble();Object.assign(process.env,redis.env);
  const {runAccountErasureExecutor}=await import(pathToFileURL(resolve(compiled,'services/accountErasure/executor.mjs')).href);
  const {Client}=require('pg');
  service=new Client({host:c.host,port:c.port,user:'postgres',database:c.database});await service.connect();
  await service.query(`SET statement_timeout='${STATEMENT_LIMIT}'`);
  await service.query('SET ROLE service_role');

  const a=await account(),sessions=[a.session];
  for(let i=1;i<ACCOUNT_ROUNDS.length;i++)sessions.push(await newSession(a));
  for(const [i,rounds] of ACCOUNT_ROUNDS.entries())for(let n=1;n<=rounds;n++)await round(a,sessions[i],n);
  const total=ACCOUNT_ROUNDS.reduce((x,y)=>x+y,0);
  // Ticket attachments: each is a storage object of the account plus a path on its ticket and reply.
  const sdk=syntheticSdk(require('@supabase/supabase-js').createClient,a.actor);
  sdk.objects.clear();
  const paths=Array.from({length:ATTACHMENTS},(_,i)=>`${a.actor}/attachment-${i}.png`);
  for(const p of paths)sdk.objects.add(p);
  const perTicket=ATTACHMENTS/3;
  for(let t=0;t<3;t++){
   const ticket=randomUUID();
   await c.query("insert into tickets(id,user_id,title,description,attachments) values($1,$2,'synthetic','PRIVATE_TICKET',$3)",
    [ticket,a.actor,JSON.stringify(paths.slice(t*perTicket,(t+1)*perTicket))]);
  }
  assert.equal(sdk.objects.size,ATTACHMENTS);
  const base=transport(service);
  const client={...base,storage:sdk.client.storage,auth:sdk.client.auth,rpc(name,args){
   const result=base.rpc(name,args);result.abortSignal=()=>result;return result;
  }};
  const sessionsBefore=await content(sessions);
  assert.deepEqual(sessionsBefore,{visible:total*2,text:total*2,total:total*2});
  assert.equal(await raws(sessions),total*3);
  const before=await money(a);
  await c.query('select account_erasure_confirm($1,$2)',[a.actor,randomUUID()]);
  const start=performance.now();
  const result=await runAccountErasureExecutor(client);
  report.samples.executorMs=Math.round(performance.now()-start);
  assert.equal(result.completed,1,JSON.stringify(result));assert.equal(result.failed,0,JSON.stringify(result));
  assert.ok(report.samples.executorMs<EXECUTOR_LIMIT_MS,`executor ${report.samples.executorMs} ms`);
  const request=(await c.query('select * from account_erasure_requests where profile_id=$1',[a.actor])).rows[0];
  assert.equal(request.stage,'completed');
  // Leaves no row: content, bodies, tickets, attachments, identity.
  assert.equal((await content(sessions)).text,0,'no message text');
  assert.equal(await raws(sessions),0,'no response body');
  assert.equal(await one('select count(*)::int v from tickets where user_id=$1',[a.actor]),0);
  assert.equal(sdk.objects.size,0,'every attachment object deleted');
  assert.equal(sdk.authDeletes(),1);
  assert.equal(await one("select count(*)::int v from session_messages where session_id=any($1) and content_hash<>encode(sha256(''::bytea),'hex')",[sessions]),0);
  assert.deepEqual(await money(a),before,'turns, receipts, ledger and balance unchanged by erasure');
  // Every public table that carries this account: report what is left, and require it to be billing/proof records only.
  const carriers=(await c.query(`select table_name t,column_name col from information_schema.columns
   where table_schema='public' and column_name in ('actor_id','user_id','profile_id','owner_id') and data_type='uuid'
   and table_name in (select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE') order by 1,2`)).rows;
  const left={};
  for(const {t,col} of carriers){
   const n=await one(`select count(*)::int v from public.${JSON.stringify(t)} where ${JSON.stringify(col)}=$1`,[a.actor],c);
   if(n>0)left[`${t}.${col}`]=n;
  }
  report.samples.remainingRows=left;
  // What may stay: the billing records (turns, receipts, ledger, credit sources, billing history: three years, plan 4.6) and the
  // erasure's own proof rows. Any other table carrying the account is a leftover.
  const allowed=new Set(['account_erasure_requests.profile_id','erasure_manifest_outbox.profile_id','billing_history.user_id',
   'credit_source_entries.user_id','credit_transactions.user_id','turn_calls.actor_id','turns.actor_id']);
  assert.deepEqual(Object.keys(left).filter(key=>!allowed.has(key)),[],'rows left outside billing records and erasure proof');
  report.samples.accountRounds=total;
  report.checks.push(`account erasure on turns data: ${ACCOUNT_ROUNDS.length} conversations / ${total} rounds / ${total*3} receipts / ${total*3} bodies / ${ATTACHMENTS} attachment objects erased by the real executor in ${report.samples.executorMs} ms (< ${EXECUTOR_LIMIT_MS}) under statement_timeout ${STATEMENT_LIMIT}; no text, body, ticket or attachment left, identity deleted once, billing unchanged`);
 }
}catch(error){report.failed=String(error.stack??error);process.exitCode=1;}
finally{
 await service?.end().catch(()=>{});await redis?.close();
 if(compiled)rmSync(compiled,{recursive:true});
 await db.close();console.log(JSON.stringify(report,null,2));
}
