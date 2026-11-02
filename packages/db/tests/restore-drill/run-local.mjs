/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Launch audit (2026-11-02), REL-1 section 7 E2 "backup restore drill", local part: build the database from the repository
// files, fill it with core-path data (turns, receipts, response bodies, messages, credit ledger, balances), dump it with
// pg_dump, restore the dump into a new empty database with pg_restore (--exit-on-error: any restore error fails the drill) and check that
//   - every public table has the same rows (count and a checksum of every row),
//   - the schema is the same (functions, indexes, constraints, triggers, policies, table grants, sequences),
//   - every account's turns, receipts, credit ledger and balance are identical, and
//   - the restored database still works: a new round continues the identity sequence, charges and writes one ledger row, a
//     conversation deletion runs, and a deliberately changed row IS detected by the same comparison (the drill can fail).
// This proves the dump/restore mechanics and that nothing core-path is lost on the way. It does NOT replace the runbook drill on a
// real Supabase backup (docs/runbooks/DATA_ERASURE_BACKUP_RESTORE_REPLAY.md): that needs the platform's backup, Storage and Auth.
// Disposable local PostgreSQL only; no remote host, secret or paid service.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {localDb,root} from '../runtime-view-perf/local-db.mjs';
import {rounds} from '../erasure-volume/rounds.mjs';

const PLAN=[12,15,8],DUMP='/tmp/restore-drill.dump',RESTORED='restored_drill';
const db=await localDb(),c=db.client,report={build:db.build,checks:[],samples:{}};
const {one,account,newSession,round,content,raws,money}=rounds(c);
const {Client}=createRequire(resolve(root,'package.json'))('pg');
const connect=async database=>{const x=new Client({host:c.host,port:c.port,user:'postgres',database});await x.connect();return x;};
// A comparable picture of one database: per-table row count and checksum, the schema objects, the sequence positions.
async function picture(client){
 const tables=(await client.query(`select table_name t from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1`)).rows;
 const rows={};
 for(const {t} of tables){
  const r=(await client.query(`select count(*)::int n,coalesce(md5(string_agg(x::text,'|' order by x::text)),'') h from public.${JSON.stringify(t)} x`)).rows[0];
  rows[t]=[r.n,r.h];
 }
 const q=async sql=>(await client.query(sql)).rows[0].v;
 return {rows,schema:{
  functions:await q(`select md5(string_agg(pg_get_functiondef(p.oid),'|' order by p.oid::regprocedure::text)) v from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind in ('f','p')`),
  indexes:await q(`select md5(string_agg(indexdef,'|' order by indexname)) v from pg_indexes where schemaname='public'`),
  // pg_restore re-parses CHECK expressions, so the printed text differs only in redundant parentheses and spacing; compare without them.
  constraints:await q(`select md5(string_agg(conrelid::regclass||conname||contype::text||regexp_replace(pg_get_constraintdef(oid),'[()\\s]','','g'),'|' order by conrelid::regclass||conname)) v from pg_constraint where connamespace='public'::regnamespace`),
  triggers:await q(`select md5(string_agg(pg_get_triggerdef(t.oid),'|' order by t.tgrelid::regclass::text||t.tgname)) v from pg_trigger t join pg_class k on k.oid=t.tgrelid where k.relnamespace='public'::regnamespace and not t.tgisinternal`),
  policies:await q(`select coalesce(md5(string_agg(tablename||policyname||cmd||coalesce(qual,'')||coalesce(with_check,''),'|' order by tablename,policyname)),'') v from pg_policies where schemaname='public'`),
  grants:await q(`select md5(string_agg(table_name||grantee||privilege_type,'|' order by table_name,grantee,privilege_type)) v from information_schema.role_table_grants where table_schema='public'`),
  sequences:await q(`select md5(string_agg(sequencename||coalesce(last_value::text,'-'),'|' order by sequencename)) v from pg_sequences where schemaname='public'`)}};
}
let restored;
try{
 // 1. Data: three accounts, every table the money and the conversation touch.
 const accounts=[];
 for(const [i,n] of PLAN.entries()){
  const a=await account(i===1?250:100000);   // one account with a small balance: its balance is the one most likely to be off
  accounts.push(a);
  for(let k=1;k<=n;k++)await round(a,a.session,k);
 }
 const second=await newSession(accounts[0]);await round(accounts[0],second,1);
 const rowsCount=PLAN.reduce((x,y)=>x+y,0)+1;
 const before={pic:await picture(c),money:[],
  messages:await content([...accounts.map(a=>a.session),second]),bodies:await raws([...accounts.map(a=>a.session),second])};
 for(const a of accounts)before.money.push(await money(a));
 assert.equal(before.pic.rows.turns[0],rowsCount);assert.equal(before.pic.rows.turn_calls[0],rowsCount*3);
 assert.equal(before.messages.total,rowsCount*2);assert.equal(before.bodies,rowsCount*3);
 const maxTurn=Number(await one('select max(id) v from turns'));
 // 2. Dump, then restore into a new empty database.
 let start=performance.now();
 db.exec(['pg_dump','-U','postgres','-Fc','-d','perf','-f',DUMP]);
 report.samples.dumpMs=Math.round(performance.now()-start);
 report.samples.dumpBytes=Number(db.exec(['stat','-c','%s',DUMP]));
 db.exec(['createdb','-U','postgres','-T','template0',RESTORED]);
 start=performance.now();
 db.exec(['pg_restore','-U','postgres','--exit-on-error','-d',RESTORED,DUMP]);
 report.samples.restoreMs=Math.round(performance.now()-start);
 restored=await connect(RESTORED);
 // 3. Same rows, same schema, same money.
 const after=await picture(restored);
 assert.deepEqual(after.rows,before.pic.rows,'every public table has the same rows after the restore');
 assert.deepEqual(after.schema,before.pic.schema,'functions, indexes, constraints, triggers, policies, grants and sequences are the same');
 const r=rounds(restored);
 for(const [i,a] of accounts.entries())assert.deepEqual(await r.money(a),before.money[i],`account ${i}: credits, ledger, turns and receipts match`);
 assert.deepEqual(await r.content([...accounts.map(a=>a.session),second]),before.messages);
 assert.equal(await r.raws([...accounts.map(a=>a.session),second]),before.bodies);
 for(const [i,a] of accounts.entries()){
  const row=(await restored.query('select credits from profiles where id=$1',[a.actor])).rows[0];
  assert.equal(row.credits,before.money[i].credits);
 }
 report.checks.push(`dump ${report.samples.dumpBytes} bytes in ${report.samples.dumpMs} ms, restore in ${report.samples.restoreMs} ms with --exit-on-error: ${Object.keys(after.rows).length} public tables identical (row count and row checksum), schema identical; ${accounts.length} accounts: turns (${rowsCount}), receipts (${rowsCount*3}), bodies (${rowsCount*3}), messages (${rowsCount*2}), credit ledger and balances equal`);
 // 4. The restored database works.
 const live=accounts[1];
 const creditsBefore=before.money[1].credits,rowsBefore=before.money[1].rows;
 const turnId=await r.round(live,live.session,99);
 assert.ok(turnId>maxTurn,`identity sequence continues after the restore (${turnId} > ${maxTurn})`);
 const next=await r.money(live);
 assert.ok(next.credits<creditsBefore,'the new round charged the restored balance');
 assert.ok(next.rows>rowsBefore,'and wrote a ledger row');
 assert.equal(next.credits-creditsBefore,next.ledger-before.money[1].ledger,'balance and ledger moved by the same amount');
 const marked=(await restored.query('select content_erasure_mark_session($1,$2) v',[live.actor,live.session])).rows[0].v;
 assert.equal(marked.status,'deleted');
 assert.equal((await r.content([live.session])).visible,0);
 report.checks.push('restored database works: a new round continues the identity sequence, charges the restored balance by the same amount as its ledger row, and a conversation deletion runs');
 // 5. The comparison can fail: one changed receipt in the restored copy is found (rolled back afterwards).
 await restored.query('begin');
 await restored.query(`update turn_calls set nominal_usd=nominal_usd+0.000001 where turn_id=(select min(id) from turns)`);
 const tampered=await picture(restored);await restored.query('rollback');
 assert.notDeepEqual(tampered.rows.turn_calls,before.pic.rows.turn_calls,'a changed receipt changes the table checksum');
 report.checks.push('negative control: a one-micro-dollar change to one receipt makes the same comparison fail');
}catch(error){report.failed=String(error.stack??error);process.exitCode=1;}
finally{
 await restored?.end().catch(()=>{});
 await db.close();console.log(JSON.stringify(report,null,2));
}
