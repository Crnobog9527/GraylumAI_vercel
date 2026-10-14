-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- DATA-ERASURE: account erasure could never finish for anyone with a positioning draft.
-- The opc_drafts trigger is named artifact_immutable but runs opc_draft_identity() (0107), which 0192
-- did not patch, and opc_drafts has no erased_at column, so erasure_business_delete_allowed never
-- allowed it either. account_erasure_prune_business then hit OPC_IMMUTABLE_DRAFT (P0001), which it does
-- not catch, and the whole account_erasure_local_cleanup aborted every day.
-- Same closed-subject-only DELETE exception as 0192; UPDATE immutability and open accounts unchanged.
BEGIN;
SET LOCAL lock_timeout='2s';

-- opc_drafts joins the explicitly listed link tables: the draft row holds ids and the registration
-- reference only; its bodies live in rounds, turns and plans, which B1/B2 already scrub.
CREATE OR REPLACE FUNCTION public.erasure_business_delete_allowed(t text,j jsonb)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT (j->>'erased_at' IS NOT NULL OR t IN
  ('opc_video_material_bindings','opc_account_strategy_request_bases','opc_account_strategy_drafts','opc_result_links',
   'opc_drafts'))
  AND EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=erasure_business_owner(t,j));
$$;
REVOKE ALL ON FUNCTION public.erasure_business_delete_allowed(text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.erasure_business_delete_allowed(text,jsonb) TO service_role;

-- Exact, single insertion into the live guard (as 0192 did for artifact_immutable()).
DO $$
DECLARE original text; needle text:=E'BEGIN\n';
 addition text:=$patch$  IF TG_OP='DELETE' AND public.erasure_business_delete_allowed('opc_drafts',to_jsonb(OLD)) THEN
    RETURN OLD;
  END IF;
$patch$;
BEGIN
 original:=pg_get_functiondef('public.opc_draft_identity()'::regprocedure);
 IF position('public.erasure_business_delete_allowed' IN original)=0 THEN
  IF length(original)-length(replace(original,needle,''))<>length(needle) THEN
   RAISE EXCEPTION 'ERASURE_DRAFT_SOURCE_MISMATCH';
  END IF;
  EXECUTE replace(original,needle,needle||addition);
 END IF;
END $$;
REVOKE ALL ON FUNCTION public.opc_draft_identity() FROM PUBLIC,anon,authenticated;
COMMIT;
