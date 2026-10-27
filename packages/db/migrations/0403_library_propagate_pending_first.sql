-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- DB-PERF (library_cleanup scan, number 0403 assigned by the controller).
-- Since 2026-10-26 15:00 UTC the staging library_cleanup job fails every run (statement timeout 57014): the own-post
-- loops of runtime_library_propagate called runtime_workspace_posts_history_erased (recursive lineage + several EXISTS,
-- about 13 ms) for every execution whose payload says ownPosts, 786 of them after the third load-test round, none of
-- which holds a my_posts or read_source call. Their result was always false, but the scan grows with every such
-- execution ever created and has no bound.
-- Two cheap, exact filters now run before the check; deletion semantics are unchanged:
--  1. posts_scope seed: an ownPosts execution counts only if it has an erased read_source call with no result (the only
--     way the check's second branch is true); my_posts results stay as before. The check needs one of the two in the
--     lineage, so it is false for everything outside the scope (same argument as 0363).
--  2. each loop first collects (MATERIALIZED, so it runs before the check) the executions that still have something to
--     clear: the loop's own pending tests, unchanged, or for the receipt loop a closed run with content marker and an
--     unprojected receipt. The check, the money-allowed test, the locks and every UPDATE stay in the same place.
-- Compatibility: same signature and result shape; old and new code are interchangeable. Repeatable: CREATE OR REPLACE
-- only, no data or index change. Recovery: re-apply runtime_library_propagate from packages/db/functions as of 0402
-- (slower scan, same effects); no data needs repair.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.runtime_library_propagate(p_actor_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 20)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE target record; e runtime_executions; b bill2_runs; stamp timestamptz:=clock_timestamp(); scrub jsonb;
 done integer:=0; waiting integer:=0; posts_scope uuid[];
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'LIBRARY_INVALID'; END IF;
 FOR target IN SELECT DISTINCT r.execution_id FROM runtime_library_references r
  WHERE r.propagated_at IS NULL AND (p_actor_id IS NULL OR r.actor_id=p_actor_id)
   AND NOT EXISTS(SELECT 1 FROM library_documents d WHERE d.id=r.document_id AND d.deleted_at IS NULL AND d.status<>'deleting')
  ORDER BY r.execution_id LIMIT p_limit LOOP
  -- Lock order of content_erasure_confirm: profile (share), execution, billing run; never wait, retry later.
  BEGIN
   SELECT * INTO e FROM runtime_executions WHERE id=target.execution_id;
   PERFORM id FROM profiles WHERE id=e.actor_id FOR SHARE NOWAIT;
   SELECT * INTO e FROM runtime_executions WHERE id=target.execution_id FOR UPDATE NOWAIT;
   -- Content erasure of the answer or conversation already removed every copy in this execution.
   IF e.erased_at IS NOT NULL OR e.content_deleted_at IS NOT NULL THEN
    UPDATE runtime_library_references SET propagated_at=stamp WHERE execution_id=e.id AND propagated_at IS NULL;
    done:=done+1; CONTINUE;
   END IF;
   IF e.state NOT IN ('completed','cancelled') THEN
    UPDATE runtime_executions SET unavailable_reason=coalesce(unavailable_reason,'source_deleted') WHERE id=e.id;
    waiting:=waiting+1; CONTINUE;
   END IF;
   IF e.billing_run_id IS NOT NULL THEN
    SELECT * INTO b FROM bill2_runs WHERE id=e.billing_run_id FOR UPDATE NOWAIT;
   END IF;
   UPDATE runtime_tool_calls SET arguments=NULL,result=NULL,erased_at=stamp
    WHERE execution_id=e.id AND erased_at IS NULL AND name='read_source'
     AND result->>'kind' IN ('library_index','library_directory','library_segment','library_search');
   UPDATE runtime_session_history SET item=NULL,erased_at=stamp
    WHERE execution_id=e.id AND erased_at IS NULL AND item->>'role' IS DISTINCT FROM 'user';
   UPDATE runtime_session_batches SET items=NULL,erased_at=stamp WHERE execution_id=e.id AND erased_at IS NULL;
   IF e.billing_run_id IS NOT NULL THEN
    IF NOT b.closed THEN waiting:=waiting+1; CONTINUE; END IF;
    -- The 0201 content marker on the closed run is the existing authority to project its receipts to money
    -- fields. It marks receipt copies only: the execution keeps its shown answer and no amount changes.
    UPDATE bill2_runs SET content_deleted_at=stamp WHERE id=b.id AND content_deleted_at IS NULL;
    IF NOT coalesce(content_erasure_financial_allowed(e.actor_id,coalesce(b.pre_deduct_id,b.id)),false) THEN
     waiting:=waiting+1; CONTINUE;
    END IF;
    scrub:=account_erasure_scrub_receipts(e.actor_id,b.id,100);
    -- Rows that cannot be projected stay for the existing manual financial review.
    IF (scrub->>'remaining')::bigint>(scrub->>'manualReview')::bigint THEN waiting:=waiting+1; CONTINUE; END IF;
   END IF;
   UPDATE runtime_library_references SET propagated_at=stamp WHERE execution_id=e.id AND propagated_at IS NULL;
   done:=done+1;
  EXCEPTION WHEN lock_not_available THEN
   waiting:=waiting+1;
  END;
 END LOOP;
 -- DB-PERF PR-7a own-post scope: the only executions runtime_workspace_posts_history_erased can be
 -- true for. Executions holding a my_posts result or an erased own-post read_source call (the check needs one of the two
 -- in the lineage), then every execution depending on them (reverse index). DB-PERF 0403: an own-post execution without
 -- such a call is not in the scope; the cheap pending tests below run before the check, which only sees what is left.
 posts_scope:=ARRAY(WITH RECURSIVE reach(id) AS (
   SELECT t.execution_id FROM runtime_tool_calls t WHERE t.result->>'kind'='my_posts'
   UNION SELECT ex.id FROM runtime_executions ex WHERE ex.payload->>'ownPosts'='true'
    AND EXISTS(SELECT 1 FROM runtime_tool_calls t WHERE t.execution_id=ex.id AND t.name='read_source'
     AND t.erased_at IS NOT NULL AND t.result IS NULL)
   UNION SELECT dep.execution_id FROM runtime_history_dependencies dep JOIN reach r ON dep.dependency_id=r.id
  ) SELECT id FROM reach);
 -- B2 pending own-post receipts: separate bounded batches; no connection transaction owns historical cleanup.
 FOR target IN WITH pending AS MATERIALIZED (SELECT ex.id FROM runtime_executions ex
  WHERE ex.id=ANY(posts_scope) AND (p_actor_id IS NULL OR ex.actor_id=p_actor_id)
   AND (EXISTS(SELECT 1 FROM runtime_tool_calls t WHERE t.execution_id=ex.id AND t.result->>'kind'='my_posts')
    OR EXISTS(SELECT 1 FROM runtime_session_history h WHERE h.execution_id=ex.id AND h.erased_at IS NULL
     AND h.item->>'role' IS DISTINCT FROM 'user')
    OR EXISTS(SELECT 1 FROM runtime_session_batches sb WHERE sb.execution_id=ex.id AND sb.erased_at IS NULL)
    OR EXISTS(SELECT 1 FROM bill2_runs br WHERE br.id=ex.billing_run_id AND br.content_deleted_at IS NULL)
    OR ex.state NOT IN ('completed','cancelled') AND ex.unavailable_reason IS NULL))
  SELECT ex.id execution_id FROM pending pe JOIN runtime_executions ex ON ex.id=pe.id JOIN profiles p ON p.id=ex.actor_id
  WHERE runtime_workspace_posts_history_erased(ex.id)
   AND (ex.billing_run_id IS NULL OR EXISTS(SELECT 1 FROM bill2_runs br WHERE br.id=ex.billing_run_id FOR UPDATE SKIP LOCKED))
  ORDER BY ex.id LIMIT p_limit FOR UPDATE OF ex,p SKIP LOCKED LOOP
  SELECT * INTO e FROM runtime_executions WHERE id=target.execution_id;
  IF e.state NOT IN ('completed','cancelled') THEN
   UPDATE runtime_executions SET unavailable_reason=coalesce(unavailable_reason,'source_deleted') WHERE id=e.id;
  END IF;
  UPDATE runtime_tool_calls SET arguments=NULL,result=NULL,erased_at=stamp WHERE execution_id=e.id AND name='read_source'
   AND result->>'kind'='my_posts';
  UPDATE runtime_session_history SET item=NULL,erased_at=stamp
   WHERE execution_id=e.id AND erased_at IS NULL AND item->>'role' IS DISTINCT FROM 'user';
  UPDATE runtime_session_batches SET items=NULL,erased_at=stamp WHERE execution_id=e.id AND erased_at IS NULL;
  UPDATE bill2_runs SET content_deleted_at=coalesce(content_deleted_at,stamp) WHERE id=e.billing_run_id;
  done:=done+1;
 END LOOP;
 -- Readiness and SKIP LOCKED are evaluated before LIMIT: open, untrusted or locked rows cannot starve later runs.
 FOR target IN WITH pending AS MATERIALIZED (SELECT ex.id FROM runtime_executions ex JOIN bill2_runs br ON br.id=ex.billing_run_id
  WHERE ex.id=ANY(posts_scope) AND br.content_deleted_at IS NOT NULL AND br.closed
   AND (p_actor_id IS NULL OR ex.actor_id=p_actor_id)
   AND EXISTS(SELECT 1 FROM bill2_receipts r JOIN bill2_calls c ON c.id=r.call_id
    WHERE c.run_id=br.id AND r.financial_projection_version IS NULL))
  SELECT ex.id execution_id FROM pending pe JOIN runtime_executions ex ON ex.id=pe.id
  JOIN bill2_runs br ON br.id=ex.billing_run_id JOIN profiles p ON p.id=ex.actor_id
  WHERE runtime_workspace_posts_history_erased(ex.id)
   AND coalesce(content_erasure_financial_allowed(ex.actor_id,coalesce(br.pre_deduct_id,br.id)),false)
   AND EXISTS(SELECT 1 FROM bill2_receipts r JOIN bill2_calls c ON c.id=r.call_id
    WHERE c.run_id=br.id AND r.financial_projection_version IS NULL AND runtime_workspace_posts_receipt_ready(r.payload,c))
  ORDER BY ex.id LIMIT p_limit FOR UPDATE OF ex,br,p SKIP LOCKED LOOP
  BEGIN
   SELECT * INTO e FROM runtime_executions WHERE id=target.execution_id;
   scrub:=account_erasure_scrub_receipts(e.actor_id,e.billing_run_id,100);
   IF (scrub->>'remaining')::bigint>(scrub->>'manualReview')::bigint THEN waiting:=waiting+1;
   ELSE done:=done+1;END IF;
  EXCEPTION WHEN lock_not_available THEN waiting:=waiting+1;
  END;
 END LOOP;
 RETURN jsonb_build_object('processed',done,'waiting',waiting);
END $function$;

COMMIT;
