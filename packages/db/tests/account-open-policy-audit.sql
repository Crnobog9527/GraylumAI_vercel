-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Read-only DATA-ERASURE §6 audit: public tables a signed-in client can read or write that lack the
-- account_open_required RESTRICTIVE policy (or have RLS off). Expected result: zero rows.
-- profiles is exempt by design (the API must read the closed state). Safe for staging read-only use.
SELECT c.relname AS table_name,
  CASE WHEN NOT c.relrowsecurity THEN 'rls_disabled' ELSE 'policy_missing' END AS problem
FROM pg_class c
WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
  AND c.relname NOT IN ('profiles', 'account_erasure_requests')
  AND (has_table_privilege('authenticated', c.oid, 'SELECT, INSERT, UPDATE, DELETE')
    OR has_any_column_privilege('authenticated', c.oid, 'SELECT, INSERT, UPDATE'))
  AND (NOT c.relrowsecurity OR NOT EXISTS (
    SELECT 1 FROM pg_policies p
    WHERE p.schemaname = 'public' AND p.tablename = c.relname
      AND p.policyname = 'account_open_required' AND p.permissive = 'RESTRICTIVE'
      AND 'authenticated' = ANY (p.roles)))
ORDER BY c.relname;
