-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Owner 2026-10-12: a round that fails for a Graylum system reason ends automatically and the
-- credits already charged in it are restored; Graylum bears the model cost. Adds runtime_execution
-- action fail_platform, reusing bill2 confirmed_failure + bill2_finalize compensation (once per call).
-- No remote database use.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $migration$
DECLARE definition text; source_md5 text; patched text;
BEGIN
 definition:=pg_get_functiondef('public.runtime_execution(uuid,uuid,text,jsonb)'::regprocedure);source_md5:=md5(definition);
 IF source_md5='d27a86a1790e2acc7fb7aedf09373236' THEN RETURN;END IF;
 IF source_md5<>'0aff2bcc606bee432509e1eebfcfca43' THEN RAISE EXCEPTION 'PLATFORM_FAILURE_SOURCE_MISMATCH: runtime_execution(uuid,uuid,text,jsonb)';END IF;
 IF (length(definition)-length(replace(definition,$a1$ IF b.paused_reason='user_stop' AND p_action IN ('payg_wait','payg_resume','checkpoint_primary','checkpoint_match','check_latest',
  'fail_before_dispatch','interrupt','owner_cancel','owner_session','owner_tool') THEN$a1$,'')))<>length($a1$ IF b.paused_reason='user_stop' AND p_action IN ('payg_wait','payg_resume','checkpoint_primary','checkpoint_match','check_latest',
  'fail_before_dispatch','interrupt','owner_cancel','owner_session','owner_tool') THEN$a1$) THEN RAISE EXCEPTION 'PLATFORM_FAILURE_ANCHOR_1';END IF;
 definition:=replace(definition,$a1$ IF b.paused_reason='user_stop' AND p_action IN ('payg_wait','payg_resume','checkpoint_primary','checkpoint_match','check_latest',
  'fail_before_dispatch','interrupt','owner_cancel','owner_session','owner_tool') THEN$a1$,$b1$ IF b.paused_reason='user_stop' AND p_action IN ('payg_wait','payg_resume','checkpoint_primary','checkpoint_match','check_latest',
  'fail_before_dispatch','fail_platform','interrupt','owner_cancel','owner_session','owner_tool') THEN$b1$);
 IF (length(definition)-length(replace(definition,$a2$ IF p_action IN ('fail_before_dispatch','interrupt','checkpoint_match','checkpoint_primary','check_latest','complete',
  'owner_cancel','owner_session','owner_tool') AND b.contract_version='bill2.v2' THEN$a2$,'')))<>length($a2$ IF p_action IN ('fail_before_dispatch','interrupt','checkpoint_match','checkpoint_primary','check_latest','complete',
  'owner_cancel','owner_session','owner_tool') AND b.contract_version='bill2.v2' THEN$a2$) THEN RAISE EXCEPTION 'PLATFORM_FAILURE_ANCHOR_2';END IF;
 definition:=replace(definition,$a2$ IF p_action IN ('fail_before_dispatch','interrupt','checkpoint_match','checkpoint_primary','check_latest','complete',
  'owner_cancel','owner_session','owner_tool') AND b.contract_version='bill2.v2' THEN$a2$,$b2$ IF p_action IN ('fail_before_dispatch','fail_platform','interrupt','checkpoint_match','checkpoint_primary','check_latest','complete',
  'owner_cancel','owner_session','owner_tool') AND b.contract_version='bill2.v2' THEN$b2$);
 IF (length(definition)-length(replace(definition,$a3$ ELSIF p_action='interrupt' THEN
$a3$,'')))<>length($a3$ ELSIF p_action='interrupt' THEN
$a3$) THEN RAISE EXCEPTION 'PLATFORM_FAILURE_ANCHOR_3';END IF;
 definition:=replace(definition,$a3$ ELSIF p_action='interrupt' THEN
$a3$,$b3$ ELSIF p_action='fail_platform' THEN
  -- A Graylum-side failure after a dispatch (history/tool compatibility or request preflight)
  -- ends the round without another call. Once no dispatched call is unknown, close it as a
  -- confirmed failure: bill2_finalize then compensates each settled debit once (compensated_at).
  -- Unknown calls keep the original recovery path; a stopped or cancelled round is untouched.
  IF b.contract_version<>'bill2.v2' OR jsonb_typeof(p_result) IS DISTINCT FROM 'object'
   OR coalesce(p_result->>'unavailable_reason','') NOT IN ('provider_history','preflight')
   OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_result) k WHERE k<>'unavailable_reason')
  THEN RAISE EXCEPTION 'RUNTIME_FAILURE_REASON_DENIED';END IF;
  IF e.state IN ('running','interrupted') AND s.active_execution IS NOT DISTINCT FROM e.id AND NOT b.closed AND NOT b.cancel_requested
   AND NOT EXISTS(SELECT 1 FROM bill2_calls c WHERE c.run_id=b.id AND c.dispatched_at IS NOT NULL AND c.settled_at IS NULL
    AND NOT c.provider_rejected AND NOT EXISTS(SELECT 1 FROM bill2_receipts rec WHERE rec.call_id=c.id AND NOT rec.conflict
     AND rec.payload->>'coverage'='request_total' AND rec.payload->>'final'='true')) THEN
   v:=bill2_close(p_actor_id,b.id,'confirmed_failure',jsonb_build_object('kind','confirmed_delivery_failure',
    'evidenceRef','runtime:'||e.id||':'||(p_result->>'unavailable_reason'),
    'evidenceHash',encode(sha256(convert_to('runtime:'||e.id||':'||(p_result->>'unavailable_reason'),'UTF8')),'hex')));
   v:=bill2_finalize(p_actor_id,b.id);
   UPDATE runtime_executions SET state=CASE WHEN v->>'state' IN ('settled','refunded') THEN 'cancelled' ELSE 'cost_pending' END,
    unavailable_reason=coalesce(e.unavailable_reason,p_result->>'unavailable_reason')
   WHERE id=e.id RETURNING * INTO e;
   IF e.state='cancelled' THEN UPDATE runtime_sessions SET active_execution=NULL WHERE id=s.id AND active_execution=e.id;END IF;
  END IF;
 ELSIF p_action='interrupt' THEN
$b3$);
 EXECUTE definition;
 patched:=md5(pg_get_functiondef('public.runtime_execution(uuid,uuid,text,jsonb)'::regprocedure));
 IF patched<>'d27a86a1790e2acc7fb7aedf09373236' THEN RAISE EXCEPTION 'PLATFORM_FAILURE_TARGET_MISMATCH: %',patched;END IF;
END $migration$;
COMMIT;
