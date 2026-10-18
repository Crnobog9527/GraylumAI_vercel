/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Disconnect/delete removes saved tool and history copies too (same answer-retention rule as library deletion).
-- In-progress work is stopped; closed BILL2 receipts are projected to money-only fields. No amounts are changed.
CREATE OR REPLACE FUNCTION public.runtime_workspace_posts_deleted() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e runtime_executions;stamp timestamptz:=clock_timestamp();closed boolean;
BEGIN
 IF TG_OP<>'DELETE' AND (NEW.status<>'deleting' OR OLD.status='deleting') THEN RETURN NEW;END IF;
 FOR e IN SELECT DISTINCT ex.* FROM runtime_executions ex JOIN runtime_tool_calls t ON t.execution_id=ex.id
  WHERE ex.actor_id=OLD.actor_id AND t.result->>'kind'='my_posts' AND t.result->'source_connections' ? OLD.id::text
  ORDER BY ex.id LOOP
  IF e.state NOT IN ('completed','cancelled') THEN
   UPDATE runtime_executions SET unavailable_reason=coalesce(unavailable_reason,'source_deleted') WHERE id=e.id;
  END IF;
  UPDATE runtime_tool_calls SET arguments=NULL,result=NULL,erased_at=stamp WHERE execution_id=e.id AND name='read_source'
   AND result->>'kind'='my_posts';
  UPDATE runtime_session_history SET item=NULL,erased_at=stamp
   WHERE execution_id=e.id AND erased_at IS NULL AND item->>'role' IS DISTINCT FROM 'user';
  UPDATE runtime_session_batches SET items=NULL,erased_at=stamp WHERE execution_id=e.id AND erased_at IS NULL;
  IF e.billing_run_id IS NOT NULL THEN
   UPDATE bill2_runs SET content_deleted_at=coalesce(content_deleted_at,stamp) WHERE id=e.billing_run_id RETURNING bill2_runs.closed INTO closed;
   IF closed AND content_erasure_financial_allowed(e.actor_id,e.billing_run_id) THEN
    PERFORM account_erasure_scrub_receipts(e.actor_id,e.billing_run_id,100);
   END IF;
  END IF;
 END LOOP;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
REVOKE ALL ON FUNCTION public.runtime_workspace_posts_deleted() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS runtime_workspace_posts_deleted ON social_connections;
CREATE TRIGGER runtime_workspace_posts_deleted AFTER DELETE OR UPDATE OF status ON social_connections
 FOR EACH ROW EXECUTE FUNCTION public.runtime_workspace_posts_deleted();

