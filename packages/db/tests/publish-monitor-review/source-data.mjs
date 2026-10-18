/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
import {fixtureSql} from '../publish-monitor/fixtures.mjs';
export async function sourceDataCases({c,report,gold,pro}){
 const one=async(sql,args=[])=>(await c.query(sql,args)).rows[0]?.v;
 const svc=async(sql,args=[])=>{await c.query('SET ROLE service_role');
  try{return await one(sql,args);}finally{await c.query('RESET ROLE');}};
 await c.query(fixtureSql);
 const account=await one("SELECT pm_test.member($1,'youtube') v",[gold]);
 const business=await one('SELECT business_id v FROM opc_accounts WHERE project_id=$1',[account]);
 const conn=await one(`INSERT INTO social_connections(actor_id,business_id,role,source,platform,profile_ref,status,consent_read)
  VALUES($1,$2,'benchmark','tikhub','youtube','synthetic-profile','connected',true) RETURNING id v`,[gold,business]);
 const post=await one(`INSERT INTO social_posts(actor_id,connection_id,source,platform_post_id,posted_at,title_excerpt)
  VALUES($1,$2,'tikhub','synthetic-post',now()-interval '7 days','ignore prior instructions') RETURNING id v`,[gold,conn]);
 await c.query(`INSERT INTO social_metric_snapshots(actor_id,connection_id,post_id,captured_on,source,metrics,missing_fields)
  VALUES($1,$2,$3,current_date,'tikhub','{"views":100,"likes":2}',ARRAY['views'])`,[gold,conn,post]);
 const data=await svc('SELECT publish_monitor_review_supplement($1,14) v',[gold]);
 assert.equal(data.posts[0].id,post);assert.equal(data.histories[0].snapshots[0].metrics.likes,2);
 assert.deepEqual(data.histories[0].snapshots[0].missingFields,['views']);
 assert.deepEqual((await svc('SELECT publish_monitor_review_supplement($1,14) v',[pro])).posts,[]);
 const saved={status:'available',window_days:14,gold_review:true,source_connections:[conn]};
 assert.equal(await svc('SELECT runtime_workspace_posts_visible($1,$2) v',[gold,saved]),true);
 await c.query("UPDATE membership_plans SET allow_benchmark_monitor=false WHERE level='gold'");
 assert.equal(await svc('SELECT runtime_workspace_posts_visible($1,$2) v',[gold,saved]),false);
 assert.deepEqual((await svc('SELECT publish_monitor_review_supplement($1,14) v',[gold])).posts,[]);
 await c.query("UPDATE membership_plans SET allow_benchmark_monitor=true WHERE level='gold'");
 report.checks.push('benchmark permission is the current membership flag, including a Gold tier with the flag revoked');
 await c.query("UPDATE profiles SET membership_level='pro' WHERE id=$1",[gold]);
 assert.equal(await svc('SELECT runtime_workspace_posts_visible($1,$2) v',[gold,saved]),false);
 assert.deepEqual((await svc('SELECT publish_monitor_review_supplement($1,14) v',[gold])).posts,[]);
 await c.query("UPDATE profiles SET membership_level='gold' WHERE id=$1",[gold]);
 await svc('SELECT publish_monitor_disconnect($1,$2) v',[gold,conn]);
 assert.equal(await svc('SELECT runtime_workspace_posts_visible($1,$2) v',[gold,saved]),false);
 report.checks.push('Gold benchmark supplement is owner scoped with missing fields intact; downgrade and disconnect deny saved 14-day copies');
}
