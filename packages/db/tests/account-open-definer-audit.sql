-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Read-only DATA-ERASURE triage: SECURITY DEFINER functions in public that a signed-in client can
-- execute. They bypass RLS, so account_open_required does not stop a closed account's unexpired JWT.
-- Each row must be triaged: writes user data or credits -> add a closed-account check; read-only or
-- self-checking -> record why. Safe for staging read-only use; no function body is printed.
SELECT p.oid::regprocedure AS function_signature,
  p.provolatile AS volatility,
  pg_get_userbyid(p.proowner) AS owner,
  p.prosrc ~* 'current_account_is_closed' AS checks_closed_account,
  p.prosrc ~* 'status\s*=\s*''active''' AS checks_active_status,
  p.prosrc ~* '\m(insert|update|delete)\M' AS has_write_statement
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
  AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
ORDER BY 1;
