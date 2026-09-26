-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Only the owner of a consumed, one-shot host send capability may revoke a
-- grant it can prove never entered transport. Absence of an ID is not proof.
BEGIN;
ALTER TABLE public.bill2_calls ADD COLUMN IF NOT EXISTS dispatch_granted_at timestamptz;
ALTER TABLE public.bill2_calls ADD COLUMN IF NOT EXISTS dispatch_revoked_at timestamptz;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.bill2_calls'::regclass AND conname='bill2_unstarted_dispatch') THEN
  ALTER TABLE public.bill2_calls ADD CONSTRAINT bill2_unstarted_dispatch CHECK(
   (dispatch_granted_at IS NULL AND dispatch_revoked_at IS NULL) OR
   (dispatch_granted_at IS NOT NULL AND dispatch_revoked_at IS NOT NULL AND dispatched_at IS NULL AND state='cancelled'));
 END IF;
END $$;
CREATE OR REPLACE FUNCTION public.bill2_revoke_unstarted_dispatch(
 p_actor_id uuid,p_run_id uuid,p_call_id uuid,p_token uuid,p_request_hash text,p_inspect boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r bill2_runs;c bill2_calls;eligible boolean;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id FOR UPDATE;
 IF r.id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,r.scope),false) THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM bill2_calls WHERE id=p_call_id AND run_id=r.id FOR UPDATE;
 IF c.id IS NULL OR p_token IS NULL OR c.token IS DISTINCT FROM p_token
  OR p_request_hash IS NULL OR c.payload->>'requestHash' IS DISTINCT FROM p_request_hash
  OR c.provider<>'openrouter' OR c.payload->>'protocol' IS DISTINCT FROM 'openrouter-chat-v1'
 THEN RAISE EXCEPTION 'BILL2_UNSTARTED_DISPATCH_DENIED' USING ERRCODE='42501';END IF;
 -- Retain the original token for exact idempotent readback. Cancelled state
 -- permanently prevents rotate/dispatch; bill2_record rejects NULL dispatch.
 IF c.dispatch_revoked_at IS NOT NULL THEN RETURN jsonb_build_object('revoked',true,'eligible',false);END IF;
 eligible:=NOT r.conflict AND c.state='dispatched' AND c.dispatched_at IS NOT NULL
  AND c.provider_id IS NULL AND c.selected_cost_usd IS NULL
  AND NOT EXISTS(SELECT 1 FROM bill2_receipts WHERE call_id=c.id)
  AND NOT EXISTS(SELECT 1 FROM bill2_provider_ids WHERE call_id=c.id);
 IF p_inspect THEN RETURN jsonb_build_object('revoked',false,'eligible',eligible);END IF;
 IF NOT eligible THEN RAISE EXCEPTION 'BILL2_UNSTARTED_DISPATCH_DENIED' USING ERRCODE='42501';END IF;
 -- The dispatch timestamp represented a permission grant, not observed HTTP.
 -- Preserve it before clearing the existing possible-dispatch accounting flag.
 UPDATE bill2_calls SET dispatch_granted_at=dispatched_at,dispatch_revoked_at=clock_timestamp(),dispatched_at=NULL,state='cancelled' WHERE id=c.id;
 PERFORM bill2_cancel(p_actor_id,r.id);
 PERFORM bill2_finalize(p_actor_id,r.id);
 RETURN jsonb_build_object('revoked',true,'eligible',false);
END $$;
REVOKE ALL ON FUNCTION public.bill2_revoke_unstarted_dispatch(uuid,uuid,uuid,uuid,text,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.bill2_revoke_unstarted_dispatch(uuid,uuid,uuid,uuid,text,boolean) TO service_role;
COMMIT;
