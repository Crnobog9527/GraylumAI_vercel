-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Local rehearsal only. Never run against retained financial facts; use a forward fix instead.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $rollback$
DECLARE actual text;
BEGIN
LOCK TABLE public.payment_orders,public.user_subscriptions,public.subscription_credit_grants,
  public.payment_provider_refs IN ACCESS EXCLUSIVE MODE;
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
SELECT md5(string_agg(k || '=' || coalesce(d, '<null>'), E'\n' ORDER BY k)) INTO actual FROM grouped WHERE g ~ '^[^:]+:(payment_orders|user_subscriptions|subscription_credit_grants|payment_provider_refs)$' OR g ~ '^fn(acl)?:pay_common_';
IF actual IS DISTINCT FROM 'a006da3060397b886bd7e33162eb7f33' THEN RAISE EXCEPTION 'PAY_COMMON_ROLLBACK_DRIFT'; END IF;
IF EXISTS(SELECT 1 FROM public.payment_provider_refs)
  OR EXISTS(SELECT 1 FROM public.payment_orders WHERE payment_mode IS NOT NULL OR payment_channel IS NOT NULL OR source_order_id IS NOT NULL OR subscription_id IS NOT NULL OR purchase_snapshot IS NOT NULL OR merchant_namespace IS NOT NULL OR purchase_request_id IS NOT NULL OR payment_amount_facts IS NOT NULL OR purchase_payload_hash IS NOT NULL)
  OR EXISTS(SELECT 1 FROM public.user_subscriptions WHERE payment_mode IS NOT NULL OR payment_channel IS NOT NULL OR contract_snapshot IS NOT NULL OR merchant_namespace IS NOT NULL)
  OR EXISTS(SELECT 1 FROM public.subscription_credit_grants WHERE grant_snapshot IS NOT NULL OR source_order_id IS NOT NULL OR subscription_id IS NOT NULL) THEN RAISE EXCEPTION 'PAY_COMMON_ROLLBACK_REQUIRES_FORWARD_FIX'; END IF;
DROP TABLE public.payment_provider_refs;
DROP TRIGGER pay_common_order_freeze ON public.payment_orders;
DROP TRIGGER pay_common_subscription_freeze ON public.user_subscriptions;
DROP TRIGGER pay_common_grant_freeze ON public.subscription_credit_grants;
ALTER TABLE public.payment_orders DROP CONSTRAINT pay_common_order_contract;
ALTER TABLE public.payment_orders DROP CONSTRAINT pay_common_order_link_owner;
ALTER TABLE public.payment_orders DROP CONSTRAINT pay_common_order_not_self;
ALTER TABLE public.payment_orders DROP CONSTRAINT pay_common_order_source_fk;
ALTER TABLE public.payment_orders DROP CONSTRAINT pay_common_order_request_unique;
ALTER TABLE public.payment_orders DROP CONSTRAINT pay_common_order_subscription_fk;
ALTER TABLE public.payment_orders DROP CONSTRAINT payment_orders_payment_mode_check;
ALTER TABLE public.payment_orders DROP CONSTRAINT payment_orders_payment_channel_check;
ALTER TABLE public.user_subscriptions DROP CONSTRAINT pay_common_subscription_contract;
ALTER TABLE public.subscription_credit_grants DROP CONSTRAINT pay_common_grant_contract;
ALTER TABLE public.payment_orders DROP CONSTRAINT payment_orders_purchase_snapshot_check;
ALTER TABLE public.subscription_credit_grants DROP CONSTRAINT pay_common_grant_source_fk;
ALTER TABLE public.payment_orders DROP CONSTRAINT payment_orders_merchant_namespace_check;
ALTER TABLE public.payment_orders DROP CONSTRAINT payment_orders_payment_amount_facts_check;
ALTER TABLE public.user_subscriptions DROP CONSTRAINT user_subscriptions_payment_mode_check;
ALTER TABLE public.payment_orders DROP CONSTRAINT payment_orders_purchase_payload_hash_check;
ALTER TABLE public.subscription_credit_grants DROP CONSTRAINT pay_common_grant_subscription_fk;
ALTER TABLE public.user_subscriptions DROP CONSTRAINT user_subscriptions_payment_channel_check;
ALTER TABLE public.user_subscriptions DROP CONSTRAINT user_subscriptions_contract_snapshot_check;
ALTER TABLE public.user_subscriptions DROP CONSTRAINT user_subscriptions_merchant_namespace_check;
ALTER TABLE public.subscription_credit_grants DROP CONSTRAINT subscription_credit_grants_grant_snapshot_check;
ALTER TABLE public.payment_orders DROP CONSTRAINT pay_common_order_owner_key;
ALTER TABLE public.user_subscriptions DROP CONSTRAINT pay_common_subscription_owner_key;
ALTER TABLE public.payment_orders DROP COLUMN payment_mode, DROP COLUMN payment_channel, DROP COLUMN source_order_id, DROP COLUMN subscription_id, DROP COLUMN purchase_snapshot, DROP COLUMN merchant_namespace, DROP COLUMN purchase_request_id, DROP COLUMN payment_amount_facts, DROP COLUMN purchase_payload_hash;
ALTER TABLE public.payment_orders DROP CONSTRAINT payment_orders_user_id_profiles_id_fk, ADD CONSTRAINT payment_orders_user_id_profiles_id_fk FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE SET NULL;
REVOKE SELECT (id,mode,status,item_id,user_id,currency,metadata,item_type,created_at,updated_at,amount_total,fulfilled_at,billing_cycle,payment_status,stripe_price_id,stripe_invoice_id,stripe_customer_id,stripe_subscription_id,stripe_checkout_session_id) ON public.payment_orders FROM authenticated;
GRANT SELECT ON public.payment_orders TO authenticated;
ALTER TABLE public.user_subscriptions DROP COLUMN payment_mode, DROP COLUMN payment_channel, DROP COLUMN contract_snapshot, DROP COLUMN merchant_namespace;
ALTER TABLE public.user_subscriptions DROP CONSTRAINT user_subscriptions_user_id_profiles_id_fk, ADD CONSTRAINT user_subscriptions_user_id_profiles_id_fk FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
REVOKE SELECT (id,status,user_id,metadata,created_at,updated_at,billing_cycle,stripe_price_id,current_period_end,membership_plan_id,stripe_customer_id,cancel_at_period_end,current_period_start,stripe_subscription_id,credit_release_terminated_at,credit_release_terminated_reason,credit_release_terminated_event_id,credit_release_terminated_period_key) ON public.user_subscriptions FROM authenticated;
GRANT SELECT ON public.user_subscriptions TO authenticated;
ALTER TABLE public.subscription_credit_grants DROP COLUMN grant_snapshot, DROP COLUMN source_order_id, DROP COLUMN subscription_id;
ALTER TABLE public.subscription_credit_grants DROP CONSTRAINT subscription_credit_grants_user_id_fkey, ADD CONSTRAINT subscription_credit_grants_user_id_fkey FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
REVOKE SELECT (id,status,user_id,metadata,created_at,grant_type,period_end,updated_at,period_index,period_start,billing_cycle,total_periods,consumed_amount,credits_granted,idempotency_key,accounting_state,grant_period_key,stripe_invoice_id,membership_plan_id,credit_transaction_id,stripe_subscription_id,accounting_review_reason) ON public.subscription_credit_grants FROM authenticated;
DROP FUNCTION public.pay_common_snapshot_valid(jsonb);
DROP FUNCTION public.pay_common_amount_facts_valid(jsonb);
DROP FUNCTION public.pay_common_frozen_guard();
DROP FUNCTION public.pay_common_ref_guard();
END $rollback$;
COMMIT;
