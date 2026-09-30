-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Requires separate authorization remotely. Revert the API together with this migration.
-- Never discard live anti-abuse facts: losing them would make repeated opening grants possible.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.opening_grant_identity_digests) THEN
    RAISE EXCEPTION 'OPENING_GRANT_ROLLBACK_REFUSED';
  END IF;
END $$;
DROP FUNCTION public.account_erasure_confirm_with_digests(uuid, uuid, jsonb);
DROP FUNCTION public.opening_grant_claim(uuid, jsonb);
DROP FUNCTION public.opening_grant_remember(uuid, jsonb, boolean);
DROP INDEX public.opening_grant_identity_versions_idx;
DROP TABLE public.opening_grant_identity_digests;
GRANT EXECUTE ON FUNCTION public.account_erasure_confirm(uuid, uuid) TO service_role;
COMMIT;
