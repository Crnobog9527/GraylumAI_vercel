-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PUBLISH-MONITOR RC-3 (0496): the review list also returns each review's cadence (weekly / monthly / quarterly / chat) and the
-- brand's name, and its notices name the period ("本月复盘已生成" for a monthly one) instead of always saying "本周". Without them the
-- page could not tell a brand's monthly review from another brand's weekly one. Weekly reviews read exactly as before (cadence
-- 'weekly', same notices); a review without a brand has businessName null.
-- Compatibility: two more keys per review (the app's schema passes unknown keys through); notices of weekly reviews unchanged.
-- Repeatable: CREATE OR REPLACE only. Recovery: re-apply the previous publish_monitor_reviews (packages/db/functions history).
BEGIN;
SET LOCAL lock_timeout='5s';

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
   'createdAt',r.created_at,'sessionId',r.runtime_session_id,'executionId',r.turn_id::text,
   'cadence',r.cadence,'businessName',b.name,
   -- The body is the turn's saved assistant message; a deleted conversation or an erasing account shows nothing.
   'body',CASE WHEN r.status='completed' AND r.turn_id IS NOT NULL AND s.id IS NOT NULL AND s.content_deleted_at IS NULL AND s.erased_at IS NULL
      AND r.pack IS NOT NULL AND publish_monitor_pack_visible(a,r.pack) THEN
     (SELECT m.content FROM session_messages m WHERE m.session_id=s.id AND m.turn_id=r.turn_id AND m.role='assistant'
       AND m.deleted_at IS NULL ORDER BY m.seq DESC LIMIT 1)
    END,
   -- The numeric table comes only from the host's code-computed result saved with the review. Model text is never parsed into it.
   'tables',CASE WHEN r.status='completed' AND r.turn_id IS NOT NULL AND r.pack IS NOT NULL AND s.content_deleted_at IS NULL AND s.erased_at IS NULL
      AND publish_monitor_pack_visible(a,r.pack) THEN r.pack->'review'
 END,
   'notice',CASE WHEN r.status='completed' THEN pfx.v||'复盘已生成'
    WHEN r.status='claimed' AND t.close_kind='completed' AND t.delivered AND t.settlement='pending' THEN pfx.v||'复盘已生成，费用正在核对。'
    WHEN r.skip_reason='BALANCE_LOW' THEN '余额不足，未复盘'
    WHEN r.skip_reason='RUNTIME_INTERRUPTED' THEN CASE
     WHEN t.id IS NULL OR t.settlement='done' THEN pfx.v||'复盘生成中断，已用积分按实际结算，未用部分已退回。'
     ELSE pfx.v||'复盘生成中断，费用正在核对；核对后退回未用部分。' END
    WHEN r.skip_reason='RUNTIME_ENDED' THEN CASE WHEN r.cadence='weekly' THEN '本周复盘生成未完成，这一周已结束，下周会正常安排。'
     ELSE pfx.v||'复盘生成未完成，这一期已结束，下一期会正常安排。' END END) v
  FROM social_review_runs r LEFT JOIN runtime_sessions s ON s.id=r.runtime_session_id AND s.actor_id=a
  LEFT JOIN opc_businesses b ON b.id=r.business_id AND b.actor_id=a
  CROSS JOIN LATERAL (SELECT CASE r.cadence WHEN 'monthly' THEN '本月' WHEN 'quarterly' THEN '本季度' WHEN 'chat' THEN '这次' ELSE '本周' END v) pfx
  LEFT JOIN turns t ON t.id=r.turn_id AND t.actor_id=a
  WHERE r.actor_id=a AND NOT (r.status='completed' AND r.turn_id IS NULL) ORDER BY r.created_at DESC LIMIT 52) q),'[]'::jsonb);
END $function$;
COMMIT;
