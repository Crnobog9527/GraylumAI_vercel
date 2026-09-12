/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
BEGIN;
-- Recover admission before consulting mutable routing/pricing. No new spending.
CREATE OR REPLACE FUNCTION public.agent_slice_admission_replay(p_actor_id uuid,p_conversation_id uuid,p_request_id uuid,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e agent_slice_executions%ROWTYPE;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false') OR NOT EXISTS(SELECT 1 FROM conversations WHERE id=p_conversation_id AND user_id=p_actor_id AND is_deleted='false') THEN RAISE EXCEPTION 'slice denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO e FROM agent_slice_executions WHERE request_id=p_request_id;
 IF NOT FOUND THEN RETURN 'null'; END IF;
 RETURN agent_slice_begin(p_actor_id,p_conversation_id,p_request_id,p_payload||jsonb_build_object('modelId',e.model_id,'budgetCredits',e.budget_credits));
END $$;
REVOKE ALL ON FUNCTION public.agent_slice_admission_replay(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.agent_slice_admission_replay(uuid,uuid,uuid,jsonb) TO service_role;
CREATE OR REPLACE FUNCTION public.agent_slice_admit(p_actor_id uuid,p_conversation_id uuid,p_request_id uuid,p_payload jsonb,p_summary_model_id uuid,p_summary_max_tokens integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM 1 FROM system_settings WHERE key IN ('v3_summary_model_id','v3_summary_max_tokens') FOR SHARE;
 IF (SELECT value#>>'{}' FROM system_settings WHERE key='v3_summary_model_id') IS DISTINCT FROM p_summary_model_id::text
  OR coalesce((SELECT (value#>>'{}')::integer FROM system_settings WHERE key='v3_summary_max_tokens'),2048) IS DISTINCT FROM p_summary_max_tokens
 THEN RAISE EXCEPTION 'slice summary configuration changed'; END IF;
 RETURN agent_slice_begin(p_actor_id,p_conversation_id,p_request_id,p_payload);
END $$;
REVOKE ALL ON FUNCTION public.agent_slice_admit(uuid,uuid,uuid,jsonb,uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.agent_slice_admit(uuid,uuid,uuid,jsonb,uuid,integer) TO service_role;
COMMIT;
