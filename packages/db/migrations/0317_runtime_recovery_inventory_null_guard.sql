-- CRON-IDLE-COST: the runtime-recovery cron (every minute) spent ~310 ms per call in
-- runtime_pending_financial_batch although staging had no user-stopped run. The userStop guard
-- `r.paused_reason='user_stop' AND ...` is NULL, not FALSE, when paused_reason is NULL, so the AND
-- did not short-circuit and runtime_history_available (the full billing-permission chain) ran for
-- every ordinary open run. IS NOT DISTINCT FROM makes the guard FALSE there. Both uses are filters
-- (HAVING ... OR ...) or wrapped in coalesce(...,false), where NULL and FALSE behave identically,
-- so the returned rows, their order and the userStop/finishAllowed values are unchanged.
DO $$ DECLARE src text;
  a text:=$x$r.paused_reason='user_stop' AND NOT r.cancel_requested AND e.result IS NULL AND runtime_history_available$x$;
  b text:=$x$r.paused_reason IS NOT DISTINCT FROM 'user_stop' AND NOT r.cancel_requested AND e.result IS NULL AND runtime_history_available$x$;
BEGIN
  src:=pg_get_functiondef('public.runtime_pending_financial_batch(uuid,integer)'::regprocedure);
  IF position(b IN src)=0 THEN
    IF array_length(string_to_array(src,a),1)<>3 THEN RAISE EXCEPTION 'RUNTIME_RECOVERY_INVENTORY_SOURCE_MISMATCH';END IF;
    EXECUTE replace(src,a,b);
  END IF;
END $$;

-- The account-erasure count (account_erasure_body_remaining) and other per-actor research reads filter
-- research_plans by actor_id, which had no index (sequential scan on every erasure attempt).
CREATE INDEX IF NOT EXISTS research_plans_actor_idx ON public.research_plans(actor_id);
