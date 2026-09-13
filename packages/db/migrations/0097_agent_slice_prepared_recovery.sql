/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
BEGIN;
DO $$ BEGIN
 IF to_regprocedure('public.agent_slice_call_before_prepared_recovery(uuid,uuid,uuid,text,jsonb)') IS NULL THEN
  ALTER FUNCTION public.agent_slice_call(uuid,uuid,uuid,text,jsonb) RENAME TO agent_slice_call_before_prepared_recovery;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION public.agent_slice_call(p_actor_id uuid,p_execution_id uuid,p_call_id uuid,p_action text,p_payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;c agent_slice_calls%ROWTYPE;
BEGIN
 IF p_action<>'recover_prepared' THEN
  RETURN agent_slice_call_before_prepared_recovery(p_actor_id,p_execution_id,p_call_id,p_action,p_payload);
 END IF;
 -- The original get validates ownership and holds the execution lock until this
 -- transaction finishes. Dispatch uses that same lock: only one side can win.
 result:=agent_slice_call_before_prepared_recovery(p_actor_id,p_execution_id,p_call_id,'get','{}');
 SELECT * INTO c FROM agent_slice_calls WHERE id=p_call_id;
 IF c.state='prepared' AND c.created_at<clock_timestamp()-interval '2 minutes' THEN
  RETURN agent_slice_call_before_prepared_recovery(p_actor_id,p_execution_id,p_call_id,'refund',jsonb_build_object('token',c.dispatch_token));
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.agent_slice_call_before_prepared_recovery(uuid,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.agent_slice_call(uuid,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.agent_slice_call(uuid,uuid,uuid,text,jsonb) TO service_role;
COMMIT;
