-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Read-only DATA-ERASURE T17 audit: a new table that records who it belongs to must be wired into erasure.
-- A public table with an owner column (FK to profiles, or actor_id/user_id/profile_id/owner_id) must be named by
-- some erasure function, or be listed below with the reason it is retained or handled elsewhere.
-- Also: no public FK to auth.users (Auth deletion would cascade unseen), CASCADE FKs to profiles stay the reviewed
-- set (erasure keeps the profile shell, but a new cascade must be looked at), and erasure never deletes profiles.
-- Expected: 0 rows.
WITH exempt(t, reason) AS (VALUES
  ('announcements', 'admin-authored platform content; admin accounts cannot be erased'),
  ('diagnostic_results', 'admin-run diagnostics'),
  ('modules', 'admin-authored platform modules'),
  ('prompts', 'admin-authored platform prompts'),
  ('skills', 'admin-published platform Skills'),
  ('skill_revisions', 'admin-published platform Skill revisions'),
  ('skill_revision_revocations', 'admin revocation audit'),
  ('skill_packages', 'platform Skill packages; actor is the publishing admin'),
  ('invitations', 'invite codes and the two profile ids only, no body'),
  ('credit_package_sources', 'financial ledger, retained until the financial expiry'),
  ('credit_source_entries', 'financial ledger, retained until the financial expiry'),
  ('social_billed_runs', 'ids and prices only; open runs must close after the account is gone'),
  ('social_billed_reads', 'results stripped by the social_connections delete trigger; ids and prices kept for billing')
), reviewed_cascade(t, col) AS (VALUES
  ('billing_history', 'user_id'), ('conversations', 'user_id'), ('invitations', 'created_by'),
  ('token_stats', 'user_id'), ('user_checkins', 'user_id'), ('runtime_session_results', 'actor_id'),
  ('runtime_session_names', 'actor_id'), ('founder_wall_entries', 'user_id'),
  ('founder_community_status', 'user_id'), ('payment_notices', 'user_id'),
  ('analytics_checkout_ids', 'user_id'), ('analytics_consent_withdrawals', 'user_id')
), erasure_src AS (
  SELECT string_agg(pg_get_functiondef(p.oid), E'\n') AS s FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' AND p.proname LIKE '%erasure%'
), owned AS (
  SELECT DISTINCT c.relname AS t FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname <> 'profiles'
    AND (a.attname IN ('actor_id', 'user_id', 'profile_id', 'owner_id')
      OR EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'f'
        AND k.confrelid = 'public.profiles'::regclass AND a.attnum = ANY (k.conkey)))
)
SELECT o.t AS relname, 'owner_table_not_wired' AS problem, NULL AS detail FROM owned o
WHERE NOT EXISTS (SELECT 1 FROM exempt e WHERE e.t = o.t)
  AND (SELECT s FROM erasure_src) !~ ('\m' || o.t || '\M')
UNION ALL
SELECT e.t, 'exempt_table_missing', e.reason FROM exempt e
WHERE to_regclass('public.' || quote_ident(e.t)) IS NULL
UNION ALL
SELECT k.conrelid::regclass::text, 'fk_to_auth_users', k.conname FROM pg_constraint k
WHERE k.contype = 'f' AND k.confrelid = to_regclass('auth.users') AND k.connamespace = 'public'::regnamespace
UNION ALL
SELECT c.relname, 'profile_cascade_not_reviewed', a.attname FROM pg_constraint k
JOIN pg_class c ON c.oid = k.conrelid JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)
WHERE k.contype = 'f' AND k.confrelid = 'public.profiles'::regclass AND k.confdeltype = 'c'
  AND NOT EXISTS (SELECT 1 FROM reviewed_cascade r WHERE r.t = c.relname AND r.col = a.attname)
UNION ALL
SELECT 'profiles', 'erasure_deletes_profiles', NULL WHERE (SELECT s FROM erasure_src) ~* 'DELETE\s+FROM\s+(public\.)?profiles\M'
ORDER BY 1, 2, 3;
