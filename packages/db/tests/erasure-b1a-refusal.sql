-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Runs after erasure-b1a-cases.sql (whose fixture commits a closed account): commits a real scrub
-- so the next step, the B1a rollback, must refuse with ERASURE_ROLLBACK_REFUSED.
SELECT public.account_erasure_scrub_content(profile_id) IS NOT NULL
FROM public.account_erasure_requests ORDER BY confirmed_at DESC LIMIT 1;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.artifact_candidates WHERE erased_at IS NOT NULL) THEN
    RAISE EXCEPTION 'refusal check needs erased rows';
  END IF;
END $$;
