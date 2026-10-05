-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Catalog-only structural fingerprint of schema public (no business rows are read). The same text
-- runs locally after a replay and, in a READ ONLY transaction, against staging for comparison.
-- Output: group -> md5 (small enough to compare with staging); the local runner can also list
-- the per-object details of any group that differs.
WITH rel AS (
  SELECT c.oid, c.relname, c.relkind FROM pg_class c
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
), items(k, d) AS (
  SELECT 'rel:' || relname, relkind::text FROM rel
  UNION ALL
  SELECT 'col:' || r.relname || '.' || a.attname,
    format_type(a.atttypid, a.atttypmod) || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END
      || coalesce(' DEFAULT ' || pg_get_expr(ad.adbin, ad.adrelid), '')
      || coalesce(' GENERATED ' || nullif(a.attgenerated::text, ''), '')
      || coalesce(' IDENTITY ' || nullif(a.attidentity::text, ''), '')
  FROM rel r JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped
  LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
  UNION ALL
  SELECT 'colacl:' || r.relname || '.' || a.attname, (SELECT string_agg(x, ',' ORDER BY x) FROM unnest(a.attacl::text[]) x)
  FROM rel r JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped
  WHERE a.attacl IS NOT NULL
  UNION ALL
  SELECT 'con:' || r.relname || '.' || co.conname, pg_get_constraintdef(co.oid)
  FROM rel r JOIN pg_constraint co ON co.conrelid = r.oid
  UNION ALL
  SELECT 'idx:' || r.relname || '.' || i.indexrelid::regclass::text, pg_get_indexdef(i.indexrelid)
  FROM rel r JOIN pg_index i ON i.indrelid = r.oid
  UNION ALL
  SELECT 'trg:' || r.relname || '.' || t.tgname, pg_get_triggerdef(t.oid) || ' enabled=' || t.tgenabled::text
  FROM rel r JOIN pg_trigger t ON t.tgrelid = r.oid AND NOT t.tgisinternal
  UNION ALL
  SELECT 'pol:' || p.tablename || '.' || p.policyname,
    concat_ws(' | ', p.permissive, p.cmd, p.roles::text, p.qual, p.with_check)
  FROM pg_policies p WHERE p.schemaname = 'public'
  UNION ALL
  SELECT 'rls:' || c.relname, c.relrowsecurity::text || '/' || c.relforcerowsecurity::text
  FROM pg_class c JOIN rel r ON r.oid = c.oid WHERE r.relkind IN ('r', 'p')
  UNION ALL
  SELECT 'acl:' || c.relname, coalesce((SELECT string_agg(x, ',' ORDER BY x) FROM unnest(c.relacl::text[]) x), '')
  FROM pg_class c JOIN rel r ON r.oid = c.oid
  UNION ALL
  SELECT 'view:' || r.relname, pg_get_viewdef(r.oid) FROM rel r WHERE r.relkind IN ('v', 'm')
  UNION ALL
  SELECT 'fn:' || p.oid::regprocedure::text, pg_get_functiondef(p.oid)
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p')
  UNION ALL
  SELECT 'fnacl:' || p.oid::regprocedure::text,
    coalesce((SELECT string_agg(x, ',' ORDER BY x) FROM unnest(p.proacl::text[]) x), '')
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p')
  UNION ALL
  SELECT 'type:' || t.typname, (SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
    FROM pg_enum e WHERE e.enumtypid = t.oid)
  FROM pg_type t WHERE t.typnamespace = 'public'::regnamespace AND t.typtype = 'e'
  UNION ALL
  SELECT 'ext:' || extname, extnamespace::regnamespace::text FROM pg_extension
  UNION ALL
  SELECT 'evt:' || evtname, evtevent || ' ' || evtfoid::regproc::text FROM pg_event_trigger
  UNION ALL
  SELECT 'defacl:' || pg_get_userbyid(d.defaclrole) || '.' || d.defaclobjtype::text,
    (SELECT string_agg(x, ',' ORDER BY x) FROM unnest(d.defaclacl::text[]) x)
  FROM pg_default_acl d WHERE d.defaclnamespace = 'public'::regnamespace
), grouped AS (
  SELECT CASE WHEN k ~ '^(col|colacl|con|idx|trg|pol):' THEN split_part(k, '.', 1) ELSE k END AS g, k, d
  FROM items
)
SELECT md5(string_agg(k || '=' || coalesce(d, '<null>'), E'\n' ORDER BY k)) FROM grouped WHERE g ~ '^[^:]+:(payment_orders|user_subscriptions|subscription_credit_grants|payment_provider_refs|credit_packages|membership_plans)$' OR g ~ '^fn(acl)?:(pay_common_|atomic_fulfill_credit_package|atomic_grant_subscription_invoice_credits|atomic_grant_annual_subscription_credits)';
