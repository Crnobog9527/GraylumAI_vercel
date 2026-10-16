-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- RESEARCH-TOOLS RT-3b PR-2 (docs/launch/implementation/RESEARCH_TOOLS_PLAN.md §2.1, §6.1 RT-2/RT-3):
--   * PAYG tool ceiling: a PAYG call may carry up to nine tool definitions (question card, Skill file, history read
--     and the six positioning research tools). Only the absolute ceiling in the quote check moves from 3 to 9; each
--     frozen run still applies its own profile maxTools, so runs frozen with 2 or 3 keep refusing more. The frozen
--     upper bound already counts the request bytes (tool definitions included); maxSchemaBytes (16384) is unchanged.
--   * research_runtime_close_unsent: an operation left dispatched with no result and no BILL2 link was provably
--     never sent (the supplier is contacted only after the link and BILL2 dispatch). It is closed as cancelled so a
--     stable discovery cursor moves to its successor instead of staying stuck (#1005 P2).
--   * research_runtime_call_charge: the user credits of one settled tool call of the current answer, for the
--     research_call stream event (same frozen multiplier and run conversion as research_user_tool_charges).
--   * research_user_tool_charges / research_user_evidence also return each subcall's own query, platform and
--     dataKind (saved by the host in the evidence result); older rows return null.
-- Compatibility: new functions and additive output fields; old code ignores them. Repeatable: marker-skipped
-- patch, CREATE OR REPLACE. Recovery: restore the 0263 definitions of the two user reads, drop the two new
-- functions, and replace the 0267 ceiling text back to 3 (runs frozen with more tools then refuse new claims).
BEGIN;
SET LOCAL lock_timeout='5s';

DO $$ DECLARE definition text;needle text;
BEGIN
 definition:=pg_get_functiondef('public.bill2_payg_validate_quote(bill2_runs,jsonb)'::regprocedure);
 IF position('-- 0267 nine tools' IN definition)=0 THEN
  needle:=$n$ OR (v->>'tools')::int>least((q->>'maxTools')::int,3)$n$;
  IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN
   RAISE EXCEPTION 'BILL2_PAYG_QUOTE_SOURCE_MISMATCH: 0267'; END IF;
  EXECUTE replace(definition,needle,$r$ -- 0267 nine tools
 OR (v->>'tools')::int>least((q->>'maxTools')::int,9)$r$);
 END IF;
END $$;

CREATE OR REPLACE FUNCTION public.research_runtime_close_unsent(a uuid, s uuid, p_operation uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p research_plans; o research_operations;
BEGIN
  PERFORM research_session_owned(a,s,NULL);
  SELECT pl.* INTO p FROM research_plans pl JOIN research_operations x ON x.plan_id=pl.id
   WHERE x.id=p_operation AND pl.actor_id=a AND pl.session_id=s AND pl.erased_at IS NULL FOR UPDATE OF pl;
  IF p.id IS NULL THEN RETURN false;END IF;
  SELECT * INTO o FROM research_operations WHERE id=p_operation FOR UPDATE;
  -- Linked or finished operations may have reached the supplier: never closed here.
  IF o.state<>'dispatched' OR o.result IS NOT NULL OR o.bill2_call_id IS NOT NULL OR o.erased_at IS NOT NULL THEN RETURN false;END IF;
  UPDATE research_operations SET state='cancelled' WHERE id=o.id;
  UPDATE research_plans SET cancelled=true WHERE id=p.id;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.research_runtime_call_charge(a uuid, s uuid, e uuid, p_call uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v jsonb;
BEGIN
  PERFORM research_session_owned(a,s,e);
  SELECT jsonb_build_object(
    'source',CASE WHEN c.nominal_source IN ('tool_usage','tool_no_usage','tool_failed','tool_failed_charged','tool_unknown')
      THEN c.nominal_source END,
    -- Same frozen call multiplier and run conversion as settlement, before its cumulative ceil.
    'credits',CASE WHEN c.settled_at IS NOT NULL AND c.nominal_source LIKE 'tool_%'
      THEN (c.nominal_cost_usd*bill2_unit_multiplier(c.payload->'billingUnit'->'multiplier')*r.credits_per_usd)::text END)
  INTO v FROM bill2_calls c JOIN bill2_runs r ON r.id=c.run_id
  JOIN runtime_executions x ON x.billing_run_id=r.id AND x.id=e AND x.actor_id=a AND x.session_id=s
  WHERE c.id=p_call AND r.actor_id=a AND c.call_kind='tool';
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION public.research_user_tool_charges(a uuid,p_transaction uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE tx credit_transactions; output jsonb;
BEGIN
 PERFORM bill2_actor(a);
 SELECT * INTO tx FROM credit_transactions WHERE id=p_transaction AND user_id=a;
 IF tx.id IS NULL THEN RAISE EXCEPTION 'RESEARCH_SCOPE_DENIED' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('callId',c.id,'toolName',o.result->>'toolName','args',o.result->'args',
  'query',o.result->'call'->>'query','platform',o.result->'call'->>'platform','dataKind',o.result->'call'->>'dataKind',
  'source',CASE WHEN c.nominal_source IN ('tool_usage','tool_no_usage','tool_failed','tool_failed_charged','tool_unknown')
    THEN c.nominal_source END,
  -- Same frozen call multiplier and run conversion as settlement, before its cumulative ceil.
  'credits',CASE WHEN c.settled_at IS NOT NULL AND c.nominal_source LIKE 'tool_%'
    THEN (c.nominal_cost_usd*bill2_unit_multiplier(c.payload->'billingUnit'->'multiplier')*r.credits_per_usd)::text END
 ) ORDER BY c.sequence,c.id),'[]'::jsonb) INTO output
 FROM bill2_calls c JOIN bill2_runs r ON r.id=c.run_id
 JOIN runtime_executions x ON x.billing_run_id=r.id AND x.actor_id=a
 JOIN runtime_sessions s ON s.id=x.session_id AND s.actor_id=a
 LEFT JOIN LATERAL (SELECT evidence.result FROM research_operations evidence
  JOIN research_plans p ON p.id=evidence.plan_id AND p.execution_id=x.id AND p.actor_id=a AND p.erased_at IS NULL
  WHERE evidence.bill2_call_id=c.id AND evidence.erased_at IS NULL) o ON true
 WHERE r.id=tx.bill2_run_id AND r.actor_id=a AND c.call_kind='tool'
 AND x.content_deleted_at IS NULL AND x.erased_at IS NULL AND s.content_deleted_at IS NULL AND s.erased_at IS NULL;
 RETURN output;
END $$;

CREATE OR REPLACE FUNCTION public.research_user_evidence(a uuid,p_limit integer,p_cursor_time timestamptz,p_cursor_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE output jsonb;
BEGIN
 PERFORM bill2_actor(a);
 IF p_limit NOT BETWEEN 1 AND 101 OR (p_cursor_time IS NULL)<>(p_cursor_id IS NULL)
 THEN RAISE EXCEPTION 'RESEARCH_SCOPE_DENIED' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(row ORDER BY stamp DESC,oid DESC),'[]'::jsonb) INTO output FROM (
  SELECT o.created_at stamp,o.id oid,jsonb_build_object(
   'operationId',o.id,'toolName',o.result->>'toolName','args',o.result->'args','state',o.state,
   'query',o.result->'call'->>'query','platform',o.result->'call'->>'platform','dataKind',o.result->'call'->>'dataKind',
   'fetchedAt',o.result->>'fetchedAt',
   'itemCount',CASE WHEN jsonb_typeof(o.result->'items')='array' THEN jsonb_array_length(o.result->'items') END,
   'truncated',o.result->'truncated',
   'sources',coalesce((SELECT jsonb_agg(item->>'url') FROM jsonb_array_elements(
     CASE WHEN jsonb_typeof(o.result->'items')='array' THEN o.result->'items' ELSE '[]'::jsonb END) item
     WHERE jsonb_typeof(item->'url')='string'),'[]'::jsonb),
   'sessionId',s.id,'sessionTitle',coalesce(n.name,(SELECT left(nullif(btrim(t.payload->>'input'),''),80)
     FROM runtime_executions t WHERE t.session_id=s.id AND t.actor_id=a
     AND t.content_deleted_at IS NULL AND t.erased_at IS NULL ORDER BY t.created_at,t.id LIMIT 1)),
   'createdAt',o.created_at) row
  FROM research_operations o JOIN research_plans p ON p.id=o.plan_id AND p.actor_id=a
  JOIN runtime_sessions s ON s.id=p.session_id AND s.actor_id=a
  JOIN runtime_executions x ON x.id=p.execution_id AND x.actor_id=a AND x.session_id=s.id
  LEFT JOIN runtime_session_names n ON n.session_id=s.id AND n.actor_id=a
  WHERE o.erased_at IS NULL AND p.erased_at IS NULL AND x.content_deleted_at IS NULL AND x.erased_at IS NULL
   AND s.content_deleted_at IS NULL AND s.erased_at IS NULL AND o.state IN ('succeeded','failed','unknown')
   AND (p_cursor_time IS NULL OR (o.created_at,o.id)<(p_cursor_time,p_cursor_id))
  ORDER BY o.created_at DESC,o.id DESC LIMIT p_limit
 ) records;
 RETURN output;
END $$;

REVOKE ALL ON FUNCTION public.research_runtime_close_unsent(uuid,uuid,uuid),public.research_runtime_call_charge(uuid,uuid,uuid,uuid),
 public.research_user_tool_charges(uuid,uuid),public.research_user_evidence(uuid,integer,timestamptz,uuid)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.research_runtime_close_unsent(uuid,uuid,uuid),public.research_runtime_call_charge(uuid,uuid,uuid,uuid),
 public.research_user_tool_charges(uuid,uuid),public.research_user_evidence(uuid,integer,timestamptz,uuid)
 TO service_role;

COMMIT;
