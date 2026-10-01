-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- SELECT only, BEFORE applying PR-E. Controller executes; this task never connects remotely.
-- Aggregate readiness facts only: no account, identity, key, project or raw digest values.
-- Closed accounts predating PR-E need their retained Auth identity remembered before PR-C removes it.
WITH gifted_closed AS (
  SELECT p.id FROM public.profiles p
  JOIN public.account_erasure_requests r ON r.profile_id = p.id
  WHERE EXISTS (
    SELECT 1 FROM public.credit_transactions c
    WHERE c.user_id = p.id AND c.idempotency_key = 'opening_grant:' || p.id::text AND c.amount > 0
  )
)
SELECT count(*) AS gifted_closed_profiles,
  count(*) FILTER (WHERE u.id IS NULL) AS missing_auth_users,
  count(*) FILTER (WHERE nullif(trim(u.email), '') IS NULL AND NOT EXISTS (
    SELECT 1 FROM auth.identities i WHERE i.user_id = g.id AND i.provider <> 'email'
      AND nullif(i.identity_data->>'sub', '') IS NOT NULL
      AND (i.provider = 'google' OR nullif(i.identity_data->>'iss', '') IS NOT NULL)
  )) AS missing_usable_identities,
  count(*) FILTER (WHERE (
    u.raw_app_meta_data->>'provider' = 'google'
    OR coalesce(u.raw_app_meta_data->'providers', '[]'::jsonb) ? 'google'
  ) AND NOT EXISTS (
    SELECT 1 FROM auth.identities i WHERE i.user_id = g.id AND i.provider = 'google'
      AND nullif(i.identity_data->>'sub', '') IS NOT NULL
  )) AS missing_google_subjects
FROM gifted_closed g LEFT JOIN auth.users u ON u.id = g.id;
