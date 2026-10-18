/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// PR-6: local PostgreSQL only, all monetary/provider paths are fixtures. No model requests or keys.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {billingCases} from './billing.mjs';
import {sourceDataCases} from './source-data.mjs';
import {localDb,read} from '../runtime-view-perf/local-db.mjs';
const db=await localDb(),c=db.client,report={build:db.build,checks:[]};
const one=async(sql,args=[])=>(await c.query(sql,args)).rows[0]?.v;
const svc=async(sql,args=[])=>{
 await c.query('SET ROLE service_role');
 try{return await one(sql,args);}finally{await c.query('RESET ROLE');}
};
const migration=read('packages/db/migrations/0307_publish_monitor_reviews.sql');
const transactionalMigration=migration.replace(/^BEGIN;$/m,'').replace(/^COMMIT;$/m,'');
const claim=()=>svc('SELECT publish_monitor_review_claim(20) v');
const step=(r,action,reason=null)=>svc('SELECT publish_monitor_review_step($1,$2,$3,$4) v',[r.id,r.token,action,reason]);
try{
 await c.query(read('packages/db/tests/erasure-b2a/fixture.sql'));
 await c.query(read('packages/db/tests/workspace-positioning/fixture.sql'));
 await c.query(`INSERT INTO membership_plans(name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes,
  own_data_window_days,allow_weekly_auto_review,allow_benchmark_monitor) VALUES('PR6 Gold','gold',true,true,0,90,true,true),('PR6 Pro','pro',false,false,0,30,false,false)`);
 const gold=await one('SELECT ws_test.actor() v'),pro=await one('SELECT ws_test.actor() v');
 await c.query("UPDATE profiles SET membership_level='gold',credits=100 WHERE id=$1",[gold]);
 await c.query("UPDATE profiles SET membership_level='pro',credits=100 WHERE id=$1",[pro]);
 // Exact old settings projection demonstrates the default-on behavior the current Owner request changes.
 await c.query('BEGIN');
 const old=read('packages/db/migrations/0240_publish_monitor_foundation.sql');
 const at=old.indexOf('CREATE OR REPLACE FUNCTION public.publish_monitor_settings(');
 await c.query(old.slice(at,old.indexOf('$$;',at)+3));
 assert.equal((await svc('SELECT publish_monitor_settings($1) v',[gold])).autoReviewEnabled,true);
 report.checks.push('RED: PR-1 with no settings record defaults paid auto review ON');
 await c.query('ROLLBACK');
 assert.equal((await svc('SELECT publish_monitor_settings($1) v',[gold])).autoReviewEnabled,false);
 assert.deepEqual(await claim(),[]);
 report.checks.push('GREEN: default OFF, absent settings never opt Gold in or create a paid run');
 await c.query('BEGIN');
 await c.query('ALTER TABLE social_review_runs DROP COLUMN lease_token');
 await c.query("INSERT INTO social_monitor_settings(actor_id,auto_review_enabled,auto_review_enabled_at) VALUES($1,true,now()-interval '8 days')",[gold]);
 await c.query('ALTER TABLE social_monitor_settings ALTER COLUMN auto_review_enabled SET DEFAULT false');
 assert.equal((await svc('SELECT publish_monitor_settings($1) v',[gold])).autoReviewEnabled,true);
 report.checks.push('RED: changing the default leaves a legacy implicit opt-in enabled');
 await c.query(transactionalMigration);
 assert.equal((await svc('SELECT publish_monitor_settings($1) v',[gold])).autoReviewEnabled,false);
 await svc('SELECT publish_monitor_set_auto_review($1,true) v',[gold]);
 const explicit=await svc('SELECT publish_monitor_settings($1) v',[gold]);
 await c.query(transactionalMigration);
 assert.deepEqual(await svc('SELECT publish_monitor_settings($1) v',[gold]),explicit);
 report.checks.push('GREEN: first upgrade resets old opt-ins; reapply preserves a new explicit opt-in and its start time');
 await c.query('ROLLBACK');

 await c.query(`INSERT INTO system_settings(key,value) VALUES('publish_monitor_enabled','true'),
  ('publish_monitor_review_enabled','true'),('chat_my_posts_enabled','true') ON CONFLICT(key) DO UPDATE SET value='true'`);
 await svc('SELECT publish_monitor_set_auto_review($1,true) v',[gold]);
 assert.deepEqual(await claim(),[]);
 report.checks.push('explicit opt-in starts a seven-day wait; no same-day charge');
 await c.query("UPDATE social_monitor_settings SET auto_review_enabled_at=now()-interval '8 days' WHERE actor_id=$1",[gold]);
 await svc('SELECT publish_monitor_set_auto_review($1,true) v',[pro]);
 await c.query("UPDATE social_monitor_settings SET auto_review_enabled_at=now()-interval '8 days' WHERE actor_id=$1",[pro]);
 const [r]=await claim();assert.equal(r.actorId,gold);assert.ok(r.sessionId);assert.ok(r.requestId);
 assert.deepEqual(await claim(),[]);
 report.checks.push('only Gold is eligible; an active lease and period uniqueness prevent duplicate claims');
 assert.equal((await step(r,'authorize')).allowed,true);
 await assert.rejects(step({...r,token:randomUUID()},'authorize'),/PUBLISH_MONITOR_REVIEW_LEASE_LOST/);
 await c.query("UPDATE social_review_runs SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[r.id]);
 const [resumed]=await claim();
 assert.equal(resumed.id,r.id);assert.equal(resumed.requestId,r.requestId);assert.equal(resumed.sessionId,r.sessionId);
 assert.notEqual(resumed.token,r.token);
 report.checks.push('expired lease resumes the exact original period/session/request with a new lease token');
 await svc('SELECT publish_monitor_set_auto_review($1,false) v',[gold]);
 assert.equal((await step(resumed,'authorize')).allowed,false);
 await svc('SELECT publish_monitor_set_auto_review($1,true) v',[gold]);
 assert.equal((await step(resumed,'authorize')).allowed,false);
 report.checks.push('off/on invalidates the old claimed period; it cannot bypass the new seven-day wait');
 await svc('SELECT publish_monitor_set_auto_review($1,false) v',[gold]);
 await step(resumed,'skip','DISABLED');
 assert.equal(await one('SELECT count(*)::int v FROM bill2_calls'),0);
 report.checks.push('turning off refuses paid work, skips a pre-admission claim and creates zero billing calls');
 await svc('SELECT publish_monitor_set_auto_review($1,true) v',[gold]);
 assert.deepEqual(await claim(),[]);
 report.checks.push('off/on resets the seven-day start time');
 const rows=await svc('SELECT publish_monitor_reviews($1) v',[gold]);
 assert.equal(rows.length,1);assert.equal(rows[0].body,null);assert.equal(rows[0].tables,null);
 assert.deepEqual(await svc('SELECT publish_monitor_reviews($1) v',[pro]),[]);
 report.checks.push('history is owner scoped and skipped runs expose no invented body/table');
 await billingCases({c,report});
 await sourceDataCases({c,report,gold,pro});
 const fingerprint=read('packages/db/tests/baseline/fingerprint.sql');
 const catalog=fingerprint.slice(0,fingerprint.indexOf('-- FINAL'))+'SELECT jsonb_object_agg(k,d ORDER BY k) v FROM grouped;';
 const before=await one(catalog);await c.query(migration);assert.deepEqual(await one(catalog),before);
 report.checks.push('reapply changes no schema; no destructive down migration or new queue/table');
 const privileges=await c.query(`SELECT r,has_function_privilege(r,'publish_monitor_review_claim(integer)','EXECUTE') ok
  FROM unnest(ARRAY['anon','authenticated','service_role']) r ORDER BY r`);
 assert.deepEqual(privileges.rows.map(r=>[r.r,r.ok]),[['anon',false],['authenticated',false],['service_role',true]]);
 report.checks.push('claims and lease authorization are service-role-only');
}catch(error){report.failed=String(error.stack??error);process.exitCode=1;}
finally{await db.close();report.cleanup='PASS';console.log(JSON.stringify(report,null,2));}
