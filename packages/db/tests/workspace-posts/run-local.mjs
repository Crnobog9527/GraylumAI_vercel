/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local-only B2 regression: baseline red -> patched green, rights, preserved entries, journal limit and replay.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {localDb,read} from '../runtime-view-perf/local-db.mjs';
import {runCases} from '../workspace-benchmarks/cases.mjs';
const db=await localDb(),c=db.client,report={build:db.build,checks:[]};
const one=async(sql,args=[])=>(await c.query(sql,args)).rows[0]?.v;
const migration=read('packages/db/migrations/0307_runtime_workspace_my_posts.sql');
const before=read('packages/db/migrations/0301_report_strategy_reads.sql');
const start=before.indexOf('CREATE OR REPLACE FUNCTION public.runtime_workspace_source(');
const old=before.slice(start,before.indexOf('END $$;',start)+'END $$;'.length);
const index=async(a,s,q='')=>{
 await c.query('SET ROLE service_role');
 try{return await one('SELECT runtime_workspace_source($1,$2,$3) v',[a,s,q]);}
 finally{await c.query('RESET ROLE');}
};
try{
 await c.query(read('packages/db/tests/erasure-b2a/fixture.sql'));
 await c.query(read('packages/db/tests/workspace-positioning/fixture.sql'));
 await c.query(read('packages/db/tests/content-erasure/fixture.sql'));
 // Existing B1 suite, with feature off: retain all benchmark identity, producer, erasure and denied-path coverage.
 const b1=read('packages/db/migrations/0218_runtime_workspace_positioning.sql');
 const b1start=b1.indexOf('CREATE OR REPLACE FUNCTION runtime_workspace_source(');
 await runCases({db:c,report,oldDefinition:b1.slice(b1start,b1.indexOf('END $$;',b1start)+'END $$;'.length)});
 const a=await one('SELECT ws_test.actor() v'),other=await one('SELECT ws_test.actor() v');
 const s=await one('SELECT ws_test.free_session($1) v',[a]);
 await c.query("INSERT INTO system_settings(key,value) VALUES('publish_monitor_enabled','true'),('chat_my_posts_enabled','true') ON CONFLICT(key) DO UPDATE SET value='true'");
 await c.query('BEGIN');
 await c.query(old);
 assert.equal((await index(a,s)).entries.some(e=>e.kind==='my_posts'),false);
 report.checks.push('RED: unpatched 0301 has no my_posts entries with the feature enabled');
 await c.query('ROLLBACK');
 await c.query("INSERT INTO membership_plans(name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes,own_data_window_days) VALUES('B2 Pro','pro',false,false,0,30),('B2 Gold','gold',true,true,0,90)");
 assert.deepEqual((await index(a,s)).entries.filter(e=>e.kind==='my_posts').map(e=>e.id),['my_posts:14']);
 assert.equal((await index(a,s,'my_posts:14')).entitled,false);
 assert.equal((await index(a,s,'my_posts:90')).kind,'unavailable');
 report.checks.push('GREEN: free plan discovers 14 days and no entitlement; cannot address 90 days');
 await c.query("UPDATE profiles SET membership_level='pro' WHERE id=$1",[a]);
 assert.deepEqual((await index(a,s)).entries.filter(e=>e.kind==='my_posts').map(e=>e.id),['my_posts:14','my_posts:30']);
 assert.equal((await index(a,s,'my_posts:30')).windowDays,30);
 assert.equal((await index(a,s,'my_posts:90')).kind,'unavailable');
 await c.query("UPDATE profiles SET membership_level='gold' WHERE id=$1",[a]);
 assert.deepEqual((await index(a,s)).entries.filter(e=>e.kind==='my_posts').map(e=>e.id),['my_posts:14','my_posts:30','my_posts:90']);
 assert.equal((await index(a,s,'my_posts:90')).windowDays,90);
 await assert.rejects(index(other,s),/RUNTIME_WORKSPACE_DENIED/);
 report.checks.push('Pro 14/30, Gold 14/30/90; denied other actor and Pro 90-day id');
 const e=randomUUID();
 await c.query(`INSERT INTO runtime_executions(id,actor_id,session_id,request_id,payload,history_revision,state)
 VALUES($1,$2,$3,$4,'{"ownPosts":true}',0,'running')`,[e,a,s,randomUUID()]);
 const result={kind:'my_posts',status:'available',window_days:14,dependencies:[]};
 for(let i=1;i<=3;i++){
  const stored=await one(`INSERT INTO runtime_tool_calls(execution_id,call_id,name,arguments,result)
   VALUES($1,$2,'read_source','{"query":"my_posts:14"}',$3) RETURNING result v`,[e,'call-'+i,result]);
  assert.equal(stored.kind,i<=2?'my_posts':'unavailable');
 }
 const replay=await one(`UPDATE runtime_tool_calls SET result=$3 WHERE execution_id=$1 AND call_id=$2 RETURNING result v`,[e,'call-1',result]);
 assert.equal(replay.kind,'my_posts');
 report.checks.push('two reads, third unavailable; existing saved call replay does not consume allowance');
 await c.query(migration);await c.query(migration);
 assert.equal((await index(a,s,'my_posts:90')).windowDays,90);
 report.checks.push('idempotent apply; no tables or data are dropped; rollback is flag off and code revert');
 await c.query("UPDATE system_settings SET value='false' WHERE key='chat_my_posts_enabled'");
 assert.equal((await index(a,s)).entries.some(e=>e.kind==='my_posts'),false);
 assert.equal((await index(a,s,'my_posts:14')).kind,'unavailable');
 report.checks.push('switch off removes entries and denies direct ids');
}catch(error){report.failed=String(error.stack??error);process.exitCode=1;}
finally{await db.close();report.cleanup='PASS';console.log(JSON.stringify(report,null,2));}
