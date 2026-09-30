-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- SELECT only; no identities, accounts or secrets. Zero rows means no issue found.
SELECT 'digest_table' AS object_name, 'client_privilege_or_rls' AS problem
WHERE NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.opening_grant_identity_digests'::regclass)
  OR has_table_privilege('anon', 'public.opening_grant_identity_digests', 'SELECT,INSERT,UPDATE,DELETE')
  OR has_table_privilege('authenticated', 'public.opening_grant_identity_digests', 'SELECT,INSERT,UPDATE,DELETE')
  OR has_any_column_privilege('anon', 'public.opening_grant_identity_digests', 'SELECT,INSERT,UPDATE')
  OR has_any_column_privilege('authenticated', 'public.opening_grant_identity_digests', 'SELECT,INSERT,UPDATE')
UNION ALL
SELECT p.oid::regprocedure::text, 'client_rpc_access' FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('opening_grant_claim', 'opening_grant_remember', 'account_erasure_confirm_with_digests')
  AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
UNION ALL
SELECT 'account_erasure_confirm(uuid,uuid)', 'digest_step_bypass'
WHERE has_function_privilege('service_role', 'public.account_erasure_confirm(uuid,uuid)', 'EXECUTE')
UNION ALL
SELECT 'opening_grant_remember(uuid,jsonb,boolean)', 'service_private_helper_access'
WHERE has_function_privilege('service_role', 'public.opening_grant_remember(uuid,jsonb,boolean)', 'EXECUTE')
UNION ALL
SELECT 'digest_table', 'service_access'
WHERE NOT has_table_privilege('service_role', 'public.opening_grant_identity_digests', 'SELECT')
  OR has_table_privilege('service_role', 'public.opening_grant_identity_digests', 'INSERT,UPDATE,DELETE')
UNION ALL
SELECT 'opening_grant_identity_versions_idx', 'missing_or_invalid_version_index'
WHERE NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
  WHERE c.relnamespace='public'::regnamespace AND c.relname='opening_grant_identity_versions_idx'
    AND i.indrelid='public.opening_grant_identity_digests'::regclass AND i.indisvalid AND i.indisready
    AND pg_get_indexdef(i.indexrelid,1,true)='purpose'
    AND pg_get_indexdef(i.indexrelid,2,true)='key_version' AND i.indnkeyatts=2);
