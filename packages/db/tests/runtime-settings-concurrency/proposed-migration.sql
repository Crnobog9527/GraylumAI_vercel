-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- DRAFT ONLY: pending a migration number from the controlling PR #795 comment.
-- Local disposable database validation only; not in the deployment migration ledger.
BEGIN;
SET LOCAL lock_timeout='5s';

-- Store the concurrency revision beside the existing stop-loss configuration.
CREATE OR REPLACE FUNCTION public.runtime_stop_loss_config() RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
DECLARE v jsonb;k text;channel text;
BEGIN
 SELECT value INTO v FROM system_settings WHERE key='runtime_stop_loss';
 IF v IS NULL THEN RETURN jsonb_build_object('version',1,'userDailyUsd',NULL,
  'siteDailyUsd',NULL,'siteAlertUsd',NULL,'providerBalanceAlertUsd',NULL,'notificationChannel',NULL);END IF;
 IF jsonb_typeof(v)='string' THEN
  BEGIN v:=(v#>>'{}')::jsonb;
  EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'RUNTIME_STOP_LOSS_CONFIG_INVALID';END;
 END IF;
 IF jsonb_typeof(v)<>'object' OR v->'version' IS DISTINCT FROM '1'::jsonb
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(v) x WHERE x NOT IN
   ('version','userDailyUsd','siteDailyUsd','siteAlertUsd','providerBalanceAlertUsd','notificationChannel','revision'))
 THEN RAISE EXCEPTION 'RUNTIME_STOP_LOSS_CONFIG_INVALID';END IF;
 IF v ? 'revision' AND (jsonb_typeof(v->'revision') IS DISTINCT FROM 'number'
  OR v->>'revision' !~ '^(0|[1-9][0-9]{0,9})$' OR (v->>'revision')::bigint>9999999999)
 THEN RAISE EXCEPTION 'RUNTIME_STOP_LOSS_CONFIG_INVALID';END IF;
 FOREACH k IN ARRAY ARRAY['userDailyUsd','siteDailyUsd','siteAlertUsd','providerBalanceAlertUsd'] LOOP
  IF NOT v ? k OR (v->k<>'null'::jsonb AND (jsonb_typeof(v->k)<>'string'
   OR v->>k !~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,12})?$'))
  THEN RAISE EXCEPTION 'RUNTIME_STOP_LOSS_CONFIG_INVALID';END IF;
 END LOOP;
 channel:=btrim(v->>'notificationChannel',
  U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007'
  ||U&'\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
 IF NOT v ? 'notificationChannel' OR (v->'notificationChannel'<>'null'::jsonb AND
  (jsonb_typeof(v->'notificationChannel')<>'string' OR length(channel)>100 OR length(channel)=0))
 THEN RAISE EXCEPTION 'RUNTIME_STOP_LOSS_CONFIG_INVALID';END IF;
 RETURN v;
END $$;

-- Both writers use the same lock as Runtime call admission (0202).
-- The supplied patch is constructed by dedicated RPCs, never by the client.
CREATE OR REPLACE FUNCTION public.runtime_rate_limits_patch(p_patch jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE v jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(201,1);
 INSERT INTO system_settings(key,value) VALUES('runtime_rate_limits',jsonb_build_object(
  'version',1,'admissionPerMinute',10,'admissionPer24Hours',200,
  'callsPerMinute',30,'callsPer24Hours',600,'stopNewCalls',false)||p_patch)
 ON CONFLICT(key) DO UPDATE SET value=(CASE WHEN jsonb_typeof(system_settings.value)='string'
  THEN (system_settings.value#>>'{}')::jsonb ELSE system_settings.value END)||p_patch
 RETURNING value INTO v;
 IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR v->'version' IS DISTINCT FROM '1'::jsonb
  OR jsonb_typeof(v->'stopNewCalls') IS DISTINCT FROM 'boolean' THEN
  RAISE EXCEPTION 'RUNTIME_RATE_LIMIT_CONFIG_INVALID' USING ERRCODE='23514';
 END IF;
 RETURN v;
END $$;

CREATE OR REPLACE FUNCTION public.runtime_set_stop_new_calls(p_stopped boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF p_stopped IS NULL THEN RAISE EXCEPTION 'RUNTIME_STOP_INPUT_INVALID' USING ERRCODE='23514';END IF;
 RETURN runtime_rate_limits_patch(jsonb_build_object('stopNewCalls',p_stopped));
END $$;

CREATE OR REPLACE FUNCTION public.runtime_update_rate_limits(p_limits jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE k text;n bigint;
BEGIN
 IF jsonb_typeof(p_limits) IS DISTINCT FROM 'object'
  OR NOT (p_limits ?& ARRAY['admissionPerMinute','admissionPer24Hours','callsPerMinute','callsPer24Hours'])
  OR (p_limits - ARRAY['admissionPerMinute','admissionPer24Hours','callsPerMinute','callsPer24Hours'])<>'{}'::jsonb
 THEN RAISE EXCEPTION 'RUNTIME_RATE_LIMIT_INPUT_INVALID' USING ERRCODE='23514';END IF;
 FOREACH k IN ARRAY ARRAY['admissionPerMinute','admissionPer24Hours','callsPerMinute','callsPer24Hours'] LOOP
  IF jsonb_typeof(p_limits->k) IS DISTINCT FROM 'number' OR p_limits->>k !~ '^[1-9][0-9]{0,4}$'
  THEN RAISE EXCEPTION 'RUNTIME_RATE_LIMIT_INPUT_INVALID' USING ERRCODE='23514';END IF;
  n:=(p_limits->>k)::bigint;
  IF n>(CASE k WHEN 'admissionPerMinute' THEN 60 WHEN 'admissionPer24Hours' THEN 5000
    WHEN 'callsPerMinute' THEN 180 ELSE 15000 END)
  THEN RAISE EXCEPTION 'RUNTIME_RATE_LIMIT_INPUT_INVALID' USING ERRCODE='23514';END IF;
 END LOOP;
 IF (p_limits->>'admissionPer24Hours')::int<(p_limits->>'admissionPerMinute')::int
  OR (p_limits->>'callsPer24Hours')::int<(p_limits->>'callsPerMinute')::int
 THEN RAISE EXCEPTION 'RUNTIME_RATE_LIMIT_INPUT_INVALID' USING ERRCODE='23514';END IF;
 RETURN runtime_rate_limits_patch(p_limits);
END $$;

CREATE OR REPLACE FUNCTION public.runtime_update_stop_loss(p_config jsonb,p_expected_version bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE prior jsonb;v jsonb;revision bigint;
BEGIN
 PERFORM pg_advisory_xact_lock(201,1);
 prior:=runtime_stop_loss_config();
 revision:=coalesce((prior->>'revision')::bigint,0);
 IF p_expected_version IS NULL OR p_expected_version<0 OR p_expected_version>=9999999999
  OR jsonb_typeof(p_config) IS DISTINCT FROM 'object' OR p_config ? 'revision'
 THEN RAISE EXCEPTION 'RUNTIME_STOP_LOSS_INPUT_INVALID' USING ERRCODE='23514';END IF;
 IF p_expected_version<>revision THEN
  RAISE EXCEPTION 'RUNTIME_STOP_LOSS_VERSION_CONFLICT' USING ERRCODE='PT409';
 END IF;
 INSERT INTO system_settings(key,value) VALUES('runtime_stop_loss',p_config||jsonb_build_object('revision',revision+1))
 ON CONFLICT(key) DO UPDATE SET value=excluded.value;
 -- Existing authoritative validator; an invalid replacement rolls back the entire statement.
 v:=runtime_stop_loss_config();
 RETURN v;
END $$;

-- The deployment may temporarily contain old service-role API instances. Reject their
-- direct full-row writes before acquiring the admission lock. Only postgres-owned
-- SECURITY DEFINER RPCs can mutate these keys; role grants alone cannot bypass this.
CREATE OR REPLACE FUNCTION public.runtime_stop_loss_settings_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF (TG_OP<>'INSERT' AND OLD.key IN ('runtime_stop_loss','runtime_rate_limits'))
  OR (TG_OP<>'DELETE' AND NEW.key IN ('runtime_stop_loss','runtime_rate_limits')) THEN
  IF current_user<>'postgres' THEN
   RAISE EXCEPTION 'RUNTIME_SETTINGS_DEDICATED_WRITE_REQUIRED' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(201,1);
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;
 RETURN NEW;
END $$;
-- Bind the approved writer identity explicitly, independent of the migration session role.
ALTER FUNCTION public.runtime_set_stop_new_calls(boolean) OWNER TO postgres;
ALTER FUNCTION public.runtime_update_rate_limits(jsonb) OWNER TO postgres;
ALTER FUNCTION public.runtime_update_stop_loss(jsonb,bigint) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.runtime_rate_limits_patch(jsonb),
 public.runtime_set_stop_new_calls(boolean),public.runtime_update_rate_limits(jsonb),
 public.runtime_update_stop_loss(jsonb,bigint) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.runtime_set_stop_new_calls(boolean),public.runtime_update_rate_limits(jsonb),
 public.runtime_update_stop_loss(jsonb,bigint) TO service_role;
COMMIT;
