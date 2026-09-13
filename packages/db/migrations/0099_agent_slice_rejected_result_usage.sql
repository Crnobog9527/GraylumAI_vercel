/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
BEGIN;
ALTER TABLE public.agent_slice_calls ADD COLUMN IF NOT EXISTS result_rejected boolean NOT NULL DEFAULT false;
-- Commit trusted usage and the checked final body in the existing candidate store
-- together. A server exit after this commit cannot lose a paid final answer.
CREATE OR REPLACE FUNCTION public.agent_slice_record_final(p_actor_id uuid,p_execution_id uuid,p_call_id uuid,p_phase text,p_payload jsonb,p_body text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 PERFORM agent_slice_call(p_actor_id,p_execution_id,p_call_id,'evidence',p_payload);
 IF NOT EXISTS(SELECT 1 FROM agent_slice_calls WHERE id=p_call_id AND execution_id=p_execution_id AND phase=p_phase
  AND evidence->>'finishReason'='stop' AND evidence->>'outcome'='responded') THEN RAISE EXCEPTION 'slice final invalid'; END IF;
 BEGIN
  result:=agent_slice_result(p_actor_id,p_execution_id,p_phase,'save',p_body);
 EXCEPTION WHEN insufficient_privilege THEN result:=jsonb_build_object('state','restricted');
 WHEN raise_exception THEN
  IF SQLERRM='Skill unavailable' THEN result:=jsonb_build_object('state','restricted');
  ELSIF SQLERRM IN ('slice result invalid','candidate capacity') THEN
   UPDATE agent_slice_calls SET result_rejected=true WHERE id=p_call_id;
   result:=jsonb_build_object('state','unavailable','reason','result_unavailable');
  ELSE RAISE;END IF;
 END;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.agent_slice_record_final(uuid,uuid,uuid,text,jsonb,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.agent_slice_record_final(uuid,uuid,uuid,text,jsonb,text) TO service_role;
DO $$ BEGIN
 IF to_regprocedure('public.agent_slice_result_before_rejected(uuid,uuid,text,text,text)') IS NULL THEN
  ALTER FUNCTION public.agent_slice_result(uuid,uuid,text,text,text) RENAME TO agent_slice_result_before_rejected;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION public.agent_slice_result(p_actor_id uuid,p_execution_id uuid,p_phase text,p_action text,p_body text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 result:=agent_slice_result_before_rejected(p_actor_id,p_execution_id,p_phase,p_action,p_body);
 IF p_action='read' AND result->>'state'='pending' AND EXISTS(SELECT 1 FROM agent_slice_calls WHERE execution_id=p_execution_id AND phase=p_phase AND result_rejected) THEN
  RETURN jsonb_build_object('state','unavailable','reason','result_unavailable');
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.agent_slice_result_before_rejected(uuid,uuid,text,text,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.agent_slice_result(uuid,uuid,text,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.agent_slice_result(uuid,uuid,text,text,text) TO service_role;
COMMIT;
