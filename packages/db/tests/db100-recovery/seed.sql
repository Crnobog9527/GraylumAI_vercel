-- DB-100 line W: synthetic history (40000 settled rounds) plus 160 open rounds in every state the recovery jobs read.
-- The test client sets session_replication_role=replica around it, so triggers and foreign keys stay out of the way.
INSERT INTO profiles(id) SELECT ('00000000-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid FROM generate_series(1,200) g;
CREATE TEMP TABLE ids AS SELECT g n, gen_random_uuid() sid, gen_random_uuid() rid, gen_random_uuid() eid,
  ('00000000-0000-4000-8000-'||lpad((1+g%200)::text,12,'0'))::uuid actor, now()-interval '30 days'+g*interval '40 seconds' ts FROM generate_series(1,40000) g;
INSERT INTO runtime_sessions(id,actor_id,scope,start_request_id,start_payload,revision,created_at)
 SELECT sid,actor,jsonb_build_object('n',n),gen_random_uuid(),'{}',1,ts FROM ids;
INSERT INTO bill2_runs(id,actor_id,request_id,contract_version,scope,session_ref,payload,reserved,budget_usd,credits_per_usd,multiplier,max_calls,deadline,state,closed,cancel_requested,outcome,conflict,charged,created_at,nominal_cost_usd,weighted_nominal_usd,theoretical_credits,platform_absorbed_credits,compensation_credits,runtime_epoch,runtime_cursor)
 SELECT rid,actor,gen_random_uuid(),'bill2.v2','{}',sid,'{"callPolicy":[]}',0,1,100,1,8,ts+interval '1 hour','settled',true,false,'delivered',false,10,ts,0.1,0.1,10,0,0,1,1 FROM ids;
INSERT INTO runtime_executions(id,actor_id,session_id,request_id,payload,billing_run_id,history_revision,state,result,created_at,candidate_history,history_omitted)
 SELECT eid,actor,sid,gen_random_uuid(),'{"model":"x"}',rid,1,'completed','{"body":"ok"}',ts,'{}',false FROM ids;
INSERT INTO bill2_calls(run_id,sequence,payload,provider,account_namespace,model,upper_usd,state,dispatched_at,provider_id,selected_cost_usd,created_at,settled_at,charged_delta,call_kind)
 SELECT rid,s,'{"lookupSupported":"true"}','openrouter','a','m',0.1,'responded',ts,'p'||n,0.01,ts,ts+interval '5 seconds',5,'model' FROM ids,generate_series(1,3) s;
INSERT INTO runtime_tool_calls(execution_id,call_id,name,arguments,result,created_at)
 SELECT eid,'c'||s,CASE WHEN s=1 THEN 'search' ELSE 'read_source' END,'{}',CASE WHEN n%50=0 AND s=2 THEN '{"kind":"my_posts"}' ELSE '{"kind":"x"}' END::jsonb,ts FROM ids,generate_series(1,2) s;
-- in-flight scenarios: 40 each, taking the latest sessions
CREATE TEMP TABLE infl AS SELECT n, (n-40000+160) k FROM ids WHERE n>40000-160;
-- A stale charged (k 1..40): running 2 days ago, charged calls settled 2 days ago
UPDATE runtime_executions e SET state='running',result=NULL,created_at=now()-interval '2 days' FROM ids i JOIN infl f ON f.n=i.n WHERE e.id=i.eid AND f.k<=40;
UPDATE bill2_runs r SET state='dispatched',closed=false,outcome=NULL,created_at=now()-interval '2 days',runtime_dispatch_deadline=now()-interval '1 day' FROM ids i JOIN infl f ON f.n=i.n WHERE r.id=i.rid AND f.k<=40;
UPDATE bill2_calls c SET created_at=now()-interval '2 days',dispatched_at=now()-interval '2 days',settled_at=now()-interval '2 days' FROM ids i JOIN infl f ON f.n=i.n WHERE c.run_id=i.rid AND f.k<=40;
-- negative stale: k 31..40 had recent activity
UPDATE bill2_calls c SET settled_at=now()-interval '1 hour' FROM ids i JOIN infl f ON f.n=i.n WHERE c.run_id=i.rid AND f.k BETWEEN 31 AND 40 AND c.sequence=3;
-- paused waiting_resume (k 36..40 also paused rounds without reply) 
UPDATE runtime_executions e SET state='waiting_resume' FROM ids i JOIN infl f ON f.n=i.n WHERE e.id=i.eid AND f.k BETWEEN 21 AND 25;
UPDATE bill2_runs r SET paused_reason='http_budget' FROM ids i JOIN infl f ON f.n=i.n WHERE r.id=i.rid AND f.k BETWEEN 21 AND 25;
-- B interrupted (k 41..80): active session, epoch 1, created 1h ago
UPDATE runtime_executions e SET state=CASE WHEN f.k<=60 THEN 'interrupted' ELSE 'running' END,result=NULL,created_at=now()-interval '1 hour' FROM ids i JOIN infl f ON f.n=i.n WHERE e.id=i.eid AND f.k BETWEEN 41 AND 80;
UPDATE bill2_runs r SET state='dispatched',closed=false,outcome=NULL,created_at=now()-interval '1 hour',runtime_dispatch_deadline=now()-interval '30 minutes' FROM ids i JOIN infl f ON f.n=i.n WHERE r.id=i.rid AND f.k BETWEEN 41 AND 80;
UPDATE bill2_calls c SET created_at=now()-interval '1 hour',dispatched_at=now()-interval '1 hour',settled_at=now()-interval '1 hour' FROM ids i JOIN infl f ON f.n=i.n WHERE c.run_id=i.rid AND f.k BETWEEN 41 AND 80;
UPDATE runtime_sessions s SET active_execution=i.eid FROM ids i JOIN infl f ON f.n=i.n WHERE s.id=i.sid AND f.k BETWEEN 41 AND 100;
-- D never begun (k 81..100): prepared, epoch 0, no calls, 20 min ago
UPDATE runtime_executions e SET state='prepared',result=NULL,created_at=now()-interval '20 minutes' FROM ids i JOIN infl f ON f.n=i.n WHERE e.id=i.eid AND f.k BETWEEN 81 AND 100;
UPDATE bill2_runs r SET state='prepared',closed=false,outcome=NULL,runtime_epoch=0,runtime_cursor=0,created_at=now()-interval '20 minutes',charged=0 FROM ids i JOIN infl f ON f.n=i.n WHERE r.id=i.rid AND f.k BETWEEN 81 AND 100;
DELETE FROM bill2_calls c USING ids i JOIN infl f ON f.n=i.n WHERE c.run_id=i.rid AND f.k BETWEEN 81 AND 100;
-- C pending financial (k 101..160): closed cost_pending, one dispatched call with unknown cost
UPDATE runtime_executions e SET state='cost_pending' FROM ids i JOIN infl f ON f.n=i.n WHERE e.id=i.eid AND f.k BETWEEN 101 AND 160;
UPDATE bill2_runs r SET state=CASE WHEN f.k<=140 THEN 'cost_pending' ELSE 'unknown' END FROM ids i JOIN infl f ON f.n=i.n WHERE r.id=i.rid AND f.k BETWEEN 101 AND 160;
UPDATE bill2_calls c SET selected_cost_usd=NULL,settled_at=NULL,state='dispatched',rejection_recovery_at=CASE WHEN f.k%2=0 THEN now()-interval '5 minutes' END FROM ids i JOIN infl f ON f.n=i.n WHERE c.run_id=i.rid AND f.k BETWEEN 101 AND 160 AND c.sequence=3;
-- the pending-lookup calls were sent an hour ago, so their 24-hour recovery window is open
UPDATE bill2_calls SET created_at=now()-interval '1 hour',dispatched_at=now()-interval '1 hour'
 WHERE state='dispatched' AND selected_cost_usd IS NULL AND run_id IN (SELECT id FROM bill2_runs WHERE state IN ('cost_pending','unknown'));
