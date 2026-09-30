-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Controller-only READ-ONLY catalog extraction; the B1b implementer never connects remotely.
-- Return BOTH the md5 and the complete definition. No business rows or configuration are read.
BEGIN READ ONLY;
SELECT p.oid::regprocedure AS signature,
  md5(pg_get_functiondef(p.oid)) AS definition_md5,
  pg_get_functiondef(p.oid) AS definition
FROM pg_proc p
WHERE p.oid IN (
  'public.artifact_chat_message_guard()'::regprocedure,
  'public.erasure_update_allowed(jsonb,jsonb,text[])'::regprocedure
)
ORDER BY p.oid::regprocedure::text;
COMMIT;
