-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Recovery for 0242: restore the 0107 guard and the 0192 allow-list. Only functions change; drafts
-- already deleted for closed accounts were private content under erasure and are not restored.
-- Restoring this re-opens the bug (accounts with a positioning draft cannot finish erasure).
BEGIN;
CREATE OR REPLACE FUNCTION public.opc_draft_identity() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' OR to_jsonb(OLD)-'round_id' IS DISTINCT FROM to_jsonb(NEW)-'round_id' THEN RAISE EXCEPTION 'OPC_IMMUTABLE_DRAFT';END IF;RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.erasure_business_delete_allowed(t text,j jsonb)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT (j->>'erased_at' IS NOT NULL OR t IN
  ('opc_video_material_bindings','opc_account_strategy_request_bases','opc_account_strategy_drafts','opc_result_links'))
  AND EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=erasure_business_owner(t,j));
$$;
REVOKE ALL ON FUNCTION public.opc_draft_identity() FROM PUBLIC,anon,authenticated;
COMMIT;
