-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Business version conflicts must not use serialization_failure: PostgREST retries 40001.
-- PT409 is a terminal HTTP conflict. Locks, version checks, trigger and grants are unchanged.
-- Apply with the API mapping for PT409; preserve data and forward-fix, never restore 40001.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $check$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=
    'public.pay_common_channel_setting_guard()'::regprocedure)
    NOT IN ('74063149af95709918e9d706b7ab0ea5', '9869bc243d4d9e26efdc712b2d287afc') THEN
    RAISE EXCEPTION 'PAY_COMMON_CHANNEL_SCHEMA_DRIFT';
  END IF;
END $check$;
CREATE OR REPLACE FUNCTION public.pay_common_channel_setting_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $guard$
DECLARE prior jsonb; expected bigint;
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.key='payment_new_purchase_channel' AND
    (TG_OP='DELETE' OR NEW.key IS DISTINCT FROM OLD.key) THEN
    RAISE EXCEPTION 'PAY_COMMON_CHANNEL_DELETE_DENIED' USING ERRCODE='42501';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF NEW.key <> 'payment_new_purchase_channel' THEN RETURN NEW; END IF;
  IF current_user NOT IN ('postgres','service_role') THEN
    RAISE EXCEPTION 'PAY_COMMON_CHANNEL_WRITE_DENIED' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(7063, 1);
  IF jsonb_typeof(NEW.value) IS DISTINCT FROM 'object'
    OR NOT (NEW.value ?& ARRAY['channel','version'])
    OR (NEW.value - 'channel' - 'version') <> '{}'::jsonb
    OR NEW.value->>'channel' NOT IN ('waffo','stripe')
    OR jsonb_typeof(NEW.value->'channel') IS DISTINCT FROM 'string'
    OR jsonb_typeof(NEW.value->'version') IS DISTINCT FROM 'number'
    OR (NEW.value->>'version') !~ '^[1-9][0-9]{0,9}$' THEN
    RAISE EXCEPTION 'PAY_COMMON_CHANNEL_SETTING_INVALID' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' THEN prior := OLD.value;
  ELSE SELECT value INTO prior FROM public.system_settings WHERE key=NEW.key; END IF;
  expected := coalesce((prior->>'version')::bigint,0)+1;
  IF (NEW.value->>'version')::bigint <> expected THEN
    RAISE EXCEPTION 'PAY_COMMON_CHANNEL_VERSION_CONFLICT' USING ERRCODE='PT409';
  END IF;
  RETURN NEW;
END $guard$;

COMMIT;
