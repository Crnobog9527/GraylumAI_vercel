-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PUBLISH-MONITOR: finish scheduler-owned reviews after 15 minutes without a live Runtime dispatch.
-- Compatibility: existing review/status/Runtime/BILL2 identities and the old response fields are unchanged;
-- old code ignores the additive expired field, new code cancels through the existing idempotent Runtime RPC.
-- No new table, queue, charging rule or timeout setting. Unknown costs remain with native BILL2 recovery.
-- Repeatability: both complete CREATE OR REPLACE definitions can be applied repeatedly.
-- Recovery: restore the two prior complete functions from tests/publish-monitor-interruption/rollback.sql;
-- retain all review rows and original BILL2 journals, including any pending financial recovery.
BEGIN;
-- publish_monitor_review_step(uuid,uuid,text,text)
CREATE OR REPLACE FUNCTION public.publish_monitor_review_step(p_id uuid, p_token uuid, p_action text, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r social_review_runs;x runtime_executions;allowed boolean;
BEGIN
 SELECT * INTO r FROM social_review_runs WHERE id=p_id FOR UPDATE;
 IF r.id IS NULL OR r.lease_token IS DISTINCT FROM p_token OR r.status<>'claimed'
  OR r.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'PUBLISH_MONITOR_REVIEW_LEASE_LOST';END IF;
 allowed:=publish_monitor_review_allowed(r.actor_id) AND r.created_at>=(SELECT auto_review_enabled_at
  FROM social_monitor_settings WHERE actor_id=r.actor_id);
 IF p_action='skip' THEN
  -- Serialize the terminal decision with a result commit. Native admission locks session -> review,
  -- so never wait for its execution row while owning the review: a busy owner makes this RPC retry.
  SELECT * INTO x FROM runtime_executions WHERE actor_id=r.actor_id AND request_id=r.runtime_request_id FOR UPDATE NOWAIT;
 ELSE
  SELECT * INTO x FROM runtime_executions WHERE actor_id=r.actor_id AND request_id=r.runtime_request_id;
 END IF;
 IF x.id IS NOT NULL THEN
  UPDATE social_review_runs SET runtime_execution_id=x.id,bill2_run_id=x.billing_run_id WHERE id=r.id;
 END IF;
 IF p_action IN ('observe','skip') AND x.state='completed' THEN
  UPDATE social_review_runs SET status='completed',finished_at=clock_timestamp(),lease_expires_at=NULL WHERE id=r.id;
 ELSIF p_action='skip' AND x.result IS NOT NULL THEN
  -- The owner completed after expiry was observed, but billing can still be cost_pending.
  -- Keep the original claim so native financial recovery and the next observe can publish it.
  RETURN jsonb_build_object('allowed',false,'actorId',r.actor_id,'executionId',x.id,'state',x.state,'expired',false);
 ELSIF p_action='skip' OR p_action='observe' AND x.state IN ('cancelled','failed') THEN
  -- An unknown financial outcome keeps the claim: existing Runtime recovery owns the held credits.
  IF x.id IS NOT NULL AND NOT coalesce((SELECT closed FROM bill2_runs WHERE id=x.billing_run_id),false) THEN
   RETURN jsonb_build_object('allowed',false,'actorId',r.actor_id,'executionId',x.id,'state','cost_pending');END IF;
  UPDATE social_review_runs SET status='skipped',skip_reason=coalesce(p_reason,'RUNTIME_ENDED'),
   finished_at=clock_timestamp(),lease_expires_at=NULL WHERE id=r.id;
 ELSIF p_action NOT IN ('authorize','observe') THEN RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID';END IF;
 RETURN jsonb_build_object('allowed',allowed,'actorId',r.actor_id,'executionId',x.id,'state',x.state,
  'sessionId',r.runtime_session_id,'requestId',r.runtime_request_id,'modelId',r.model_id,'maxCostUsd',r.max_cost_usd::text,
  -- A scheduler-owned review has no user present to resume it. A live dispatch still owns its lease.
  -- Return only a deadline decision here: cancellation takes the native session/run locks in a separate RPC,
  -- never while holding this review row (admission uses session -> review).
  'expired',r.created_at<=clock_timestamp()-interval '15 minutes' AND x.result IS NULL
   AND NOT EXISTS(SELECT 1 FROM bill2_runs b WHERE b.id=x.billing_run_id AND NOT b.closed
    AND b.runtime_dispatch_deadline>clock_timestamp()));
END $function$;

-- publish_monitor_reviews(uuid)
CREATE OR REPLACE FUNCTION public.publish_monitor_reviews(a uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 PERFORM publish_monitor_actor(a);
 RETURN coalesce((SELECT jsonb_agg(v ORDER BY v->>'createdAt' DESC) FROM (
  SELECT jsonb_build_object('id',r.id,'periodStart',r.period_start,'status',r.status,'skipReason',r.skip_reason,
   'createdAt',r.created_at,'sessionId',r.runtime_session_id,'executionId',r.runtime_execution_id,
   'body',CASE WHEN r.status='completed' AND x.content_deleted_at IS NULL AND x.erased_at IS NULL THEN x.result->>'body' END,
   -- The numeric table comes only from the host's tool journal. Model text is never parsed into these columns.
   'tables',CASE WHEN r.status='completed' AND x.content_deleted_at IS NULL AND x.erased_at IS NULL THEN
    (SELECT t.result->'review' FROM runtime_tool_calls t WHERE t.execution_id=x.id AND t.result->>'kind'='my_posts'
     AND t.result->>'window_days'='90' AND runtime_workspace_posts_visible(a,t.result) ORDER BY (t.result->>'window_days')::int DESC,t.call_id DESC LIMIT 1) END,
   'notice',CASE WHEN r.status='completed' THEN '本周复盘已生成'
    WHEN r.status='claimed' AND x.result IS NOT NULL AND x.state='cost_pending' THEN '本周复盘已生成，费用正在核对。'
    WHEN r.skip_reason='BALANCE_LOW' THEN '余额不足，未复盘'
    WHEN r.skip_reason='RUNTIME_INTERRUPTED' THEN CASE
     WHEN b.id IS NULL OR b.state IN ('settled','refunded')
      THEN '本周复盘生成中断，已用积分按实际结算，未用部分已退回。'
     ELSE '本周复盘生成中断，费用正在核对；核对后退回未用部分。' END
    WHEN r.skip_reason='RUNTIME_ENDED' THEN '本周复盘生成未完成，这一周已结束，下周会正常安排。' END) v
  FROM social_review_runs r LEFT JOIN runtime_executions x ON x.id=r.runtime_execution_id AND x.actor_id=a
  LEFT JOIN bill2_runs b ON b.id=r.bill2_run_id AND b.actor_id=a
  WHERE r.actor_id=a ORDER BY r.created_at DESC LIMIT 52) q),'[]'::jsonb);
END $function$;
COMMIT;
