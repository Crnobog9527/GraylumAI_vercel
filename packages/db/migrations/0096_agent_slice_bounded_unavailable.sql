/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
BEGIN;
ALTER TABLE public.agent_slice_calls ADD COLUMN IF NOT EXISTS dispatched_at timestamptz;
CREATE OR REPLACE FUNCTION public.agent_slice_stamp_dispatch() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ BEGIN
 IF NEW.state='dispatched' AND OLD.state='prepared' THEN NEW.dispatched_at:=clock_timestamp(); END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.agent_slice_stamp_dispatch() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS agent_slice_stamp_dispatch ON public.agent_slice_calls;
CREATE TRIGGER agent_slice_stamp_dispatch BEFORE UPDATE ON public.agent_slice_calls FOR EACH ROW EXECUTE FUNCTION public.agent_slice_stamp_dispatch();
DO $$ BEGIN
 IF to_regprocedure('public.agent_slice_result_before_deadline(uuid,uuid,text,text,text)') IS NULL THEN
  ALTER FUNCTION public.agent_slice_result(uuid,uuid,text,text,text) RENAME TO agent_slice_result_before_deadline;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION public.agent_slice_result(p_actor_id uuid,p_execution_id uuid,p_phase text,p_action text,p_body text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;c agent_slice_calls%ROWTYPE;
BEGIN
 result:=agent_slice_result_before_deadline(p_actor_id,p_execution_id,p_phase,p_action,p_body);
 IF p_action='read' AND result->>'state'='pending' THEN
  SELECT * INTO c FROM agent_slice_calls WHERE execution_id=p_execution_id AND phase=p_phase ORDER BY sequence DESC LIMIT 1;
  -- Provider work is bounded to 45 seconds per phase. After two minutes an
  -- uncommitted result is not a live generation, nor permission to resend it.
  IF c.id IS NOT NULL AND c.state<>'prepared' AND coalesce(c.dispatched_at,c.created_at)<clock_timestamp()-interval '2 minutes' THEN
   RETURN jsonb_build_object('state','unavailable','reason',CASE WHEN c.state IN ('dispatched','unknown') THEN 'outcome_unknown' ELSE 'result_unavailable' END);
  END IF;
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.agent_slice_result_before_deadline(uuid,uuid,text,text,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.agent_slice_result(uuid,uuid,text,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.agent_slice_result(uuid,uuid,text,text,text) TO service_role;
COMMIT;
