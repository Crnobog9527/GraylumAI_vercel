-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Read-only projection from immutable response receipts. Do not write
-- unavailable_reason: that column revokes content/history availability.
-- No new state, table, grants or RPC signature. Missing cost is not a missing
-- response; financial finality remains exclusively owned by BILL2.
BEGIN;
CREATE OR REPLACE FUNCTION public.runtime_view(p_actor_id uuid,p_session_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s runtime_sessions;items jsonb;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO s FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id;
 IF s.id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,s.scope),false) THEN RAISE EXCEPTION 'RUNTIME_SCOPE_DENIED';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('executionId',e.id,'createdAt',e.created_at,'state',e.state,
  'input',CASE WHEN runtime_history_available(e.id) THEN e.payload->>'input' ELSE NULL END,
  'body',CASE WHEN runtime_history_available(e.id) THEN e.result->>'body' ELSE NULL END,
  'primaryBody',CASE WHEN runtime_history_available(e.id) THEN e.primary_result->>'body' ELSE NULL END,
  'organizerComplete',e.result ? 'summary',
  'summary',CASE WHEN runtime_history_available(e.id) THEN e.result->>'summary' ELSE NULL END,
  'skillExecution',coalesce(e.payload->>'revisionId',(SELECT c->>'revisionId' FROM jsonb_array_elements(coalesce(e.payload->'matching'->'candidates','[]'::jsonb)) c WHERE c->>'key'=e.match_result->>'key' LIMIT 1)) IS NOT NULL,
  'needsTask',coalesce((SELECT (c->>'requiresTask')::boolean FROM jsonb_array_elements(e.payload->'matching'->'candidates') c WHERE c->>'key'=e.match_result->>'key'),false),
  'unavailableReason',CASE WHEN e.unavailable_reason IS NOT NULL THEN e.unavailable_reason
   WHEN runtime_history_available(e.id) AND NOT b.conflict
    AND (e.state='cancelled' OR (e.state='cost_pending' AND b.cancel_requested))
    AND EXISTS(
     SELECT 1 FROM bill2_calls c JOIN bill2_receipts r ON r.call_id=c.id
     WHERE c.run_id=b.id AND NOT r.conflict AND r.payload->>'source'='response'
      AND r.payload->>'evidenceKind' IS DISTINCT FROM 'transport_observation'
      AND r.payload->>'rejectedReason' IS NULL
      AND r.payload->>'model'=c.model AND r.payload->>'providerId'=c.provider_id
      AND r.payload#>>'{usage,sdkResponse,model}'=c.model
      AND CASE WHEN jsonb_typeof(r.payload#>'{usage,sdkResponse,choices}')='array'
       THEN jsonb_array_length(r.payload#>'{usage,sdkResponse,choices}') ELSE 0 END=1
      AND r.payload#>>'{usage,sdkResponse,choices,0,finish_reason}'='length'
      AND r.payload#>>'{usage,sdkResponse,choices,0,message,role}'='assistant'
      AND (r.payload#>'{usage,sdkResponse,choices,0,message,content}' IS NULL
       OR r.payload#>'{usage,sdkResponse,choices,0,message,content}'='null'::jsonb
       OR (jsonb_typeof(r.payload#>'{usage,sdkResponse,choices,0,message,content}')='string'
        AND (r.payload#>>'{usage,sdkResponse,choices,0,message,content}') !~ '[^[:space:]]'))
      AND (r.payload#>'{usage,sdkResponse,choices,0,message,tool_calls}' IS NULL
       OR r.payload#>'{usage,sdkResponse,choices,0,message,tool_calls}' IN ('null'::jsonb,'[]'::jsonb))
    ) THEN 'output_truncated' ELSE NULL END,
  'contentAvailable',runtime_history_available(e.id),'billing',bill2_public(b)) ORDER BY e.created_at,e.id),'[]') INTO items
 FROM runtime_executions e JOIN bill2_runs b ON b.id=e.billing_run_id WHERE e.session_id=s.id;
 RETURN jsonb_build_object('sessionId',s.id,'scope',s.scope,'activeExecution',s.active_execution,'executions',items);
END $$;
REVOKE ALL ON FUNCTION runtime_view(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION runtime_view(uuid,uuid) TO service_role;

COMMIT;
