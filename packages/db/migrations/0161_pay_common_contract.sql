-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PAY-COMMON PR-1 only. Provisional 0161 after 0159 / 0160; no data backfill or payment dispatch.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $migration$
DECLARE actual text; relrow record; old_columns text;
BEGIN
  LOCK TABLE public.payment_orders, public.user_subscriptions, public.subscription_credit_grants IN ACCESS EXCLUSIVE MODE;
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

  IF actual = 'a006da3060397b886bd7e33162eb7f33' THEN RETURN; END IF;
  IF actual IS DISTINCT FROM '178f7c617b86e7cd66f5d4dacbc91a20' THEN
    RAISE EXCEPTION 'PAY_COMMON_SCHEMA_DRIFT';
  END IF;

CREATE FUNCTION public.pay_common_snapshot_valid(v jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $fn$
BEGIN
  IF v IS NULL THEN RETURN true; END IF;
  IF jsonb_typeof(v) <> 'object' OR NOT v ?& ARRAY['version','item_type','item_id','item_updated_at','billing_cycle',
    'currency','unit','price','discount','tax_behavior','credits','bonus_credits']
    OR (SELECT count(*) FROM jsonb_object_keys(v)) <> 12 THEN RETURN false; END IF;
  IF v->'version' <> '1'::jsonb OR v->>'item_type' NOT IN ('credit_package','membership_plan')
    OR v->>'billing_cycle' NOT IN ('one_time','monthly','yearly')
    OR ((v->>'item_type' = 'credit_package') <> (v->>'billing_cycle' = 'one_time'))
    OR v->>'item_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR v->>'item_updated_at' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$'
    OR v->>'currency' !~ '^[a-z]{3}$' OR v->>'unit' <> 'major'
    OR v->>'tax_behavior' NOT IN ('inclusive','exclusive','unspecified') THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each(v) x WHERE x.key NOT IN ('version','credits','bonus_credits')
    AND jsonb_typeof(x.value) <> 'string') THEN RETURN false; END IF;
  IF jsonb_typeof(v->'credits') <> 'number' OR jsonb_typeof(v->'bonus_credits') <> 'number'
    OR v->>'credits' !~ '^(0|[1-9][0-9]*)$' OR v->>'bonus_credits' !~ '^(0|[1-9][0-9]*)$'
    OR (v->>'credits')::numeric > 2147483647 OR (v->>'bonus_credits')::numeric > 2147483647
    OR v->>'price' !~ '^(0|[1-9][0-9]{0,17})(\.[0-9]{1,12})?$'
    OR v->>'discount' !~ '^(0|[1-9][0-9]{0,17})(\.[0-9]{1,12})?$' THEN RETURN false; END IF;
  PERFORM (v->>'item_updated_at')::timestamptz;
  RETURN true;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $fn$;
CREATE FUNCTION public.pay_common_amount_facts_valid(v jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $fn$
DECLARE x jsonb;
BEGIN
  IF v IS NULL THEN RETURN true; END IF;
  IF jsonb_typeof(v) <> 'array' OR jsonb_array_length(v)>128 THEN RETURN false; END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(v) LOOP
    IF jsonb_typeof(x)<>'object' OR NOT x ?& ARRAY['kind','amount','currency','unit','evidence_ref']
      OR (SELECT count(*) FROM jsonb_object_keys(x))<>5 THEN RETURN false; END IF;
    IF x->>'kind' NOT IN ('list_price','discount','tax','paid','refund','fee','net')
      OR x->>'currency' !~ '^[a-z]{3}$' OR x->>'unit'<>'major'
      OR x->>'evidence_ref' !~ '^[A-Za-z0-9_:-]{1,160}$'
      OR EXISTS(SELECT 1 FROM jsonb_each(x) e WHERE e.key<>'amount' AND jsonb_typeof(e.value)<>'string')
      OR (x->'amount'<>'null'::jsonb AND (jsonb_typeof(x->'amount')<>'string'
        OR x->>'amount' !~ '^-?(0|[1-9][0-9]{0,17})(\.[0-9]{1,12})?$')) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $fn$;
CREATE FUNCTION public.pay_common_frozen_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $fn$
DECLARE prior jsonb:=to_jsonb(OLD); incoming jsonb:=to_jsonb(NEW); key text; facts jsonb;
BEGIN
  IF (prior->>'payment_channel' IS NOT NULL OR prior->>'grant_snapshot' IS NOT NULL)
    AND prior->'user_id' IS DISTINCT FROM incoming->'user_id' THEN
    RAISE EXCEPTION 'PAY_COMMON_OWNER_REBIND' USING ERRCODE='23514';
  END IF;
  FOREACH key IN ARRAY TG_ARGV LOOP
    IF prior->key IS NOT NULL AND prior->key<>'null'::jsonb
      AND prior->key IS DISTINCT FROM incoming->key THEN
      RAISE EXCEPTION 'PAY_COMMON_FROZEN_FIELD: %',key USING ERRCODE='23514';
    END IF;
  END LOOP;
  -- Financial observations are append-only. Unknown observations may be followed by known ones.
  facts:=prior->'payment_amount_facts';
  IF facts IS NOT NULL AND facts<>'null'::jsonb AND (
    incoming->'payment_amount_facts' IS NULL OR incoming->'payment_amount_facts'='null'::jsonb
    OR jsonb_typeof(incoming->'payment_amount_facts')<>'array') THEN
    RAISE EXCEPTION 'PAY_COMMON_FACTS_REWRITE' USING ERRCODE='23514';
  END IF;
  IF jsonb_typeof(facts)='array' AND EXISTS(SELECT 1 FROM jsonb_array_elements(facts) WITH ORDINALITY e(v,n)
    WHERE v IS DISTINCT FROM incoming->'payment_amount_facts'->(n::integer-1)) THEN
    RAISE EXCEPTION 'PAY_COMMON_FACTS_REWRITE' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public.pay_common_frozen_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pay_common_snapshot_valid(jsonb), public.pay_common_amount_facts_valid(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pay_common_snapshot_valid(jsonb), public.pay_common_amount_facts_valid(jsonb)
  TO service_role;

  FOR relrow IN SELECT unnest(ARRAY['payment_orders','user_subscriptions','subscription_credit_grants']) AS name LOOP
    SELECT string_agg(quote_ident(a.attname),',' ORDER BY a.attnum) INTO old_columns
      FROM pg_attribute a WHERE a.attrelid=format('public.%I',relrow.name)::regclass
        AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege('authenticated',a.attrelid,a.attnum,'SELECT');
    EXECUTE format('REVOKE SELECT ON public.%I FROM authenticated',relrow.name);
    IF old_columns IS NOT NULL THEN
      EXECUTE format('GRANT SELECT (%s) ON public.%I TO authenticated',old_columns,relrow.name);
    END IF;
  END LOOP;
ALTER TABLE public.user_subscriptions ADD CONSTRAINT pay_common_subscription_owner_key UNIQUE(id,user_id);
ALTER TABLE public.payment_orders ADD CONSTRAINT pay_common_order_owner_key UNIQUE(id,user_id);
ALTER TABLE public.payment_orders
  ADD COLUMN payment_channel text CHECK (payment_channel IN ('stripe','waffo')),
  ADD COLUMN merchant_namespace text CHECK (merchant_namespace ~ '^[A-Za-z0-9_-]{1,64}$'),
  ADD COLUMN payment_mode text CHECK (payment_mode IN ('test','live')),

  ADD COLUMN purchase_request_id uuid,
  ADD COLUMN purchase_payload_hash text CHECK (purchase_payload_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN purchase_snapshot jsonb CHECK (public.pay_common_snapshot_valid(purchase_snapshot)),
  ADD COLUMN subscription_id uuid,
  ADD COLUMN source_order_id uuid,
  ADD COLUMN payment_amount_facts jsonb CHECK (public.pay_common_amount_facts_valid(payment_amount_facts)),
  ADD CONSTRAINT pay_common_order_contract CHECK (
    (payment_channel IS NULL AND merchant_namespace IS NULL AND payment_mode IS NULL
      AND purchase_request_id IS NULL AND purchase_payload_hash IS NULL AND purchase_snapshot IS NULL)
    OR (payment_channel IS NOT NULL AND merchant_namespace IS NOT NULL AND payment_mode IS NOT NULL
      AND purchase_request_id IS NOT NULL AND purchase_payload_hash IS NOT NULL AND purchase_snapshot IS NOT NULL
      AND user_id IS NOT NULL AND purchase_snapshot->>'item_id'=item_id::text
      AND purchase_snapshot->>'item_type'=item_type AND purchase_snapshot->>'billing_cycle'=billing_cycle)),
  ADD CONSTRAINT pay_common_order_subscription_fk FOREIGN KEY(subscription_id,user_id) REFERENCES public.user_subscriptions(id,user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT pay_common_order_source_fk FOREIGN KEY(source_order_id,user_id) REFERENCES public.payment_orders(id,user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT pay_common_order_link_owner CHECK (
    (subscription_id IS NULL AND source_order_id IS NULL) OR user_id IS NOT NULL),
  ADD CONSTRAINT pay_common_order_not_self CHECK (source_order_id IS DISTINCT FROM id),
  ADD CONSTRAINT pay_common_order_request_unique UNIQUE (user_id,purchase_request_id);
ALTER TABLE public.user_subscriptions
  ADD COLUMN payment_channel text CHECK (payment_channel IN ('stripe','waffo')),
  ADD COLUMN merchant_namespace text CHECK (merchant_namespace ~ '^[A-Za-z0-9_-]{1,64}$'),
  ADD COLUMN payment_mode text CHECK (payment_mode IN ('test','live')),

  ADD COLUMN contract_snapshot jsonb CHECK (public.pay_common_snapshot_valid(contract_snapshot)),
  ADD CONSTRAINT pay_common_subscription_contract CHECK (
    (payment_channel IS NULL AND merchant_namespace IS NULL AND payment_mode IS NULL AND contract_snapshot IS NULL)
    OR (payment_channel IS NOT NULL AND merchant_namespace IS NOT NULL AND payment_mode IS NOT NULL
      AND contract_snapshot IS NOT NULL AND membership_plan_id IS NOT NULL
      -- Original opening contract; upgrade/renewal terms belong to order and grant snapshots.
      AND contract_snapshot->>'item_type'='membership_plan'));
ALTER TABLE public.subscription_credit_grants
  ADD COLUMN subscription_id uuid,
  ADD COLUMN source_order_id uuid,
  ADD COLUMN grant_snapshot jsonb CHECK (public.pay_common_snapshot_valid(grant_snapshot)),
  ADD CONSTRAINT pay_common_grant_subscription_fk FOREIGN KEY(subscription_id,user_id) REFERENCES public.user_subscriptions(id,user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT pay_common_grant_source_fk FOREIGN KEY(source_order_id,user_id) REFERENCES public.payment_orders(id,user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT pay_common_grant_contract CHECK (grant_snapshot IS NULL OR
    (subscription_id IS NOT NULL AND source_order_id IS NOT NULL
     AND membership_plan_id IS NOT NULL AND grant_snapshot->>'item_id'=membership_plan_id::text
     AND grant_snapshot->>'billing_cycle'=billing_cycle AND grant_snapshot->>'item_type'='membership_plan'));
GRANT SELECT (subscription_id,source_order_id,grant_snapshot),
  INSERT (subscription_id,source_order_id,grant_snapshot),
  UPDATE (subscription_id,source_order_id,grant_snapshot) ON public.subscription_credit_grants TO service_role;
ALTER TABLE public.payment_orders DROP CONSTRAINT payment_orders_user_id_profiles_id_fk,
  ADD CONSTRAINT payment_orders_user_id_profiles_id_fk FOREIGN KEY(user_id) REFERENCES public.profiles(id) ON DELETE RESTRICT;
ALTER TABLE public.user_subscriptions DROP CONSTRAINT user_subscriptions_user_id_profiles_id_fk,
  ADD CONSTRAINT user_subscriptions_user_id_profiles_id_fk FOREIGN KEY(user_id) REFERENCES public.profiles(id) ON DELETE RESTRICT;
ALTER TABLE public.subscription_credit_grants DROP CONSTRAINT subscription_credit_grants_user_id_fkey,
  ADD CONSTRAINT subscription_credit_grants_user_id_fkey FOREIGN KEY(user_id) REFERENCES public.profiles(id) ON DELETE RESTRICT;
CREATE TABLE public.payment_provider_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL CHECK (channel IN ('stripe','waffo')),
  merchant_namespace text NOT NULL CHECK (merchant_namespace ~ '^[A-Za-z0-9_-]{1,64}$'),
  mode text NOT NULL CHECK (mode IN ('test','live')),
  object_type text NOT NULL CHECK (object_type IN ('price','checkout','invoice','payment','subscription','refund')),
  external_id text NOT NULL CHECK (external_id ~ '^[A-Za-z0-9_:-]{1,160}$'),
  membership_plan_id uuid REFERENCES public.membership_plans(id) ON DELETE RESTRICT,
  credit_package_id uuid REFERENCES public.credit_packages(id) ON DELETE RESTRICT,
  order_id uuid REFERENCES public.payment_orders(id) ON DELETE RESTRICT,
  subscription_id uuid REFERENCES public.user_subscriptions(id) ON DELETE RESTRICT,
  billing_cycle text CHECK (billing_cycle IN ('one_time','monthly','yearly')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pay_common_ref_identity UNIQUE(channel,merchant_namespace,object_type,external_id),
  CONSTRAINT pay_common_ref_target CHECK (
    (object_type='price' AND num_nonnulls(membership_plan_id,credit_package_id)=1
      AND order_id IS NULL AND subscription_id IS NULL AND billing_cycle IS NOT NULL
      AND ((credit_package_id IS NOT NULL AND billing_cycle='one_time')
        OR (membership_plan_id IS NOT NULL AND billing_cycle IN ('monthly','yearly'))))
    OR (object_type IN ('checkout','invoice','payment','refund') AND order_id IS NOT NULL
      AND num_nonnulls(membership_plan_id,credit_package_id,subscription_id,billing_cycle)=0)
    OR (object_type='subscription' AND subscription_id IS NOT NULL
      AND num_nonnulls(membership_plan_id,credit_package_id,order_id,billing_cycle)=0))
);
ALTER TABLE public.payment_provider_refs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payment_provider_refs FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT ON public.payment_provider_refs TO service_role;
CREATE POLICY pay_common_service_refs ON public.payment_provider_refs FOR ALL TO service_role USING(true) WITH CHECK(true);
CREATE FUNCTION public.pay_common_ref_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $fn$
DECLARE expected record;
BEGIN
  IF NEW.order_id IS NOT NULL THEN
    SELECT payment_channel,merchant_namespace,payment_mode INTO expected
      FROM public.payment_orders WHERE id=NEW.order_id FOR KEY SHARE;
  ELSIF NEW.subscription_id IS NOT NULL THEN
    SELECT payment_channel,merchant_namespace,payment_mode INTO expected
      FROM public.user_subscriptions WHERE id=NEW.subscription_id FOR KEY SHARE;
  ELSE RETURN NEW;
  END IF;
  IF NOT FOUND OR expected.payment_channel IS DISTINCT FROM NEW.channel
    OR expected.merchant_namespace IS DISTINCT FROM NEW.merchant_namespace
    OR expected.payment_mode IS DISTINCT FROM NEW.mode THEN
    RAISE EXCEPTION 'PAY_COMMON_REF_SCOPE_MISMATCH' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public.pay_common_ref_guard() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER pay_common_ref_scope BEFORE INSERT OR UPDATE ON public.payment_provider_refs
  FOR EACH ROW EXECUTE FUNCTION public.pay_common_ref_guard();
CREATE TRIGGER pay_common_order_freeze BEFORE UPDATE ON public.payment_orders FOR EACH ROW
  EXECUTE FUNCTION public.pay_common_frozen_guard('payment_channel','merchant_namespace','payment_mode',
    'purchase_request_id','purchase_payload_hash','purchase_snapshot','subscription_id','source_order_id');
CREATE TRIGGER pay_common_subscription_freeze BEFORE UPDATE ON public.user_subscriptions FOR EACH ROW
  EXECUTE FUNCTION public.pay_common_frozen_guard('payment_channel','merchant_namespace','payment_mode','contract_snapshot');
CREATE TRIGGER pay_common_grant_freeze BEFORE UPDATE ON public.subscription_credit_grants FOR EACH ROW
  EXECUTE FUNCTION public.pay_common_frozen_guard('subscription_id','source_order_id','grant_snapshot');
END $migration$;
COMMIT;
