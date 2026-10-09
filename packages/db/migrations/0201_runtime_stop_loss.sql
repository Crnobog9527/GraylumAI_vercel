-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Reuse settings, settled BILL2 costs and diagnostic_results; no second ledger.
BEGIN;

CREATE OR REPLACE FUNCTION public.runtime_stop_loss_config() RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
DECLARE v jsonb;k text;
BEGIN
 SELECT value INTO v FROM system_settings WHERE key='runtime_stop_loss';
 IF v IS NULL THEN RETURN jsonb_build_object('version',1,'userDailyUsd',NULL,
  'siteDailyUsd',NULL,'siteAlertUsd',NULL,'providerBalanceAlertUsd',NULL,'notificationChannel',NULL);END IF;
 IF jsonb_typeof(v)='string' THEN v:=(v#>>'{}')::jsonb;END IF;
 IF jsonb_typeof(v)<>'object' OR v->>'version' IS DISTINCT FROM '1'
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(v) x WHERE x NOT IN
   ('version','userDailyUsd','siteDailyUsd','siteAlertUsd','providerBalanceAlertUsd','notificationChannel'))
 THEN RAISE EXCEPTION 'RUNTIME_STOP_LOSS_CONFIG_INVALID';END IF;
 FOREACH k IN ARRAY ARRAY['userDailyUsd','siteDailyUsd','siteAlertUsd','providerBalanceAlertUsd'] LOOP
  IF NOT v ? k OR (v->k<>'null'::jsonb AND (jsonb_typeof(v->k)<>'string'
   OR v->>k !~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,12})?$'))
  THEN RAISE EXCEPTION 'RUNTIME_STOP_LOSS_CONFIG_INVALID';END IF;
 END LOOP;
 IF NOT v ? 'notificationChannel' OR (v->'notificationChannel'<>'null'::jsonb AND
  (jsonb_typeof(v->'notificationChannel')<>'string' OR length(v->>'notificationChannel')>100))
 THEN RAISE EXCEPTION 'RUNTIME_STOP_LOSS_CONFIG_INVALID';END IF;
 RETURN v;
END $$;

CREATE OR REPLACE FUNCTION public.runtime_stop_loss_usage(a uuid) RETURNS jsonb
LANGUAGE sql VOLATILE SET search_path=public,pg_temp AS $$
 WITH day AS MATERIALIZED (
  SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date AS utc_date
 )
 SELECT jsonb_build_object('utcDate',day.utc_date,
  'userUsd',coalesce(sum((t.metadata->>'providerCostUsd')::numeric) FILTER(WHERE t.user_id=a),0)::text,
  'siteUsd',coalesce(sum((t.metadata->>'providerCostUsd')::numeric),0)::text)
 FROM day LEFT JOIN credit_transactions t ON
  t.reason_code='bill2_release' AND t.metadata->>'providerCostUsd' IS NOT NULL
  AND t.created_at >= (day.utc_date::timestamp AT TIME ZONE 'UTC')
  AND t.created_at < ((day.utc_date+1)::timestamp AT TIME ZONE 'UTC')
 GROUP BY day.utc_date;
$$;

CREATE OR REPLACE FUNCTION public.runtime_stop_loss_assert(a uuid,check_cost boolean) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path=public,pg_temp AS $$
DECLARE v jsonb;u jsonb;s jsonb;
BEGIN
 -- The same lock orders new claims, settled costs and switch/config writes.
 -- No run/profile locks are acquired after this lock by these helpers.
 PERFORM pg_advisory_xact_lock(201,1);
 SELECT value INTO s FROM system_settings WHERE key='runtime_rate_limits';
 IF jsonb_typeof(s)='string' THEN s:=(s#>>'{}')::jsonb;END IF;
 IF s IS NOT NULL AND (jsonb_typeof(s)<>'object' OR jsonb_typeof(s->'stopNewCalls') IS DISTINCT FROM 'boolean')
 THEN RAISE EXCEPTION 'RUNTIME_STOP_LOSS_CONFIG_INVALID';END IF;
 IF s->>'stopNewCalls'='true' THEN RAISE EXCEPTION 'RUNTIME_NEW_CALLS_STOPPED';END IF;
 IF NOT check_cost THEN RETURN;END IF;
 v:=runtime_stop_loss_config();
 IF v->>'userDailyUsd' IS NULL AND v->>'siteDailyUsd' IS NULL THEN RETURN;END IF;
 u:=runtime_stop_loss_usage(a);
 IF (u->>'userUsd')::numeric >= (v->>'userDailyUsd')::numeric
 THEN RAISE EXCEPTION 'RUNTIME_USER_DAILY_USD_LIMIT';END IF;
 IF (u->>'siteUsd')::numeric >= (v->>'siteDailyUsd')::numeric
 THEN RAISE EXCEPTION 'RUNTIME_SITE_DAILY_USD_LIMIT';END IF;
END $$;

CREATE OR REPLACE FUNCTION public.runtime_stop_loss_alert(k text,d jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(201,1);
 IF NOT EXISTS(SELECT 1 FROM diagnostic_results WHERE test_id=k
  AND details->>'dedupeKey'=d->>'dedupeKey') THEN
  INSERT INTO diagnostic_results(test_id,test_name,category,status,message,details,run_type)
  VALUES(k,'Runtime stop-loss','billing','warning',k,d,'cron');
 END IF;
END $$;

CREATE OR REPLACE FUNCTION public.runtime_stop_loss_observe(a uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=public,pg_temp AS $$
DECLARE v jsonb;u jsonb;k text;threshold numeric;
BEGIN
 PERFORM pg_advisory_xact_lock(201,1);
 v:=runtime_stop_loss_config();u:=runtime_stop_loss_usage(a);
 FOREACH k IN ARRAY ARRAY['siteDailyUsd','siteAlertUsd','userDailyUsd'] LOOP
  threshold:=(v->>k)::numeric;
  IF (k<>'userDailyUsd' OR a IS NOT NULL) AND threshold IS NOT NULL AND (u->>CASE WHEN k='userDailyUsd' THEN 'userUsd' ELSE 'siteUsd' END)::numeric>=threshold THEN
   PERFORM runtime_stop_loss_alert('runtime_stop_loss_'||k,jsonb_build_object(
    'dedupeKey',(u->>'utcDate')||':'||k||':'||coalesce(CASE WHEN k='userDailyUsd' THEN a::text END,'site')||':'||threshold::text,
    'utcDate',u->>'utcDate','scope',CASE WHEN k='userDailyUsd' THEN 'user' ELSE 'site' END,
    'actorId',CASE WHEN k='userDailyUsd' THEN a END,'thresholdUsd',threshold::text,
    'actualUsd',u->>CASE WHEN k='userDailyUsd' THEN 'userUsd' ELSE 'siteUsd' END));
  END IF;
 END LOOP;
 RETURN u;
END $$;

CREATE OR REPLACE FUNCTION public.runtime_stop_loss_call_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a uuid;
BEGIN
 SELECT actor_id INTO a FROM bill2_runs WHERE id=NEW.run_id;
 IF TG_OP='INSERT' THEN
  PERFORM runtime_stop_loss_assert(a,true);
 ELSIF OLD.dispatched_at IS NULL AND NEW.dispatched_at IS NOT NULL THEN
  -- Already frozen calls may settle above daily caps; the emergency switch still blocks new HTTP grants.
  PERFORM runtime_stop_loss_assert(a,false);

 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS runtime_stop_loss_call_guard ON public.bill2_calls;
CREATE TRIGGER runtime_stop_loss_call_guard BEFORE INSERT OR UPDATE OF dispatched_at
 ON public.bill2_calls FOR EACH ROW EXECUTE FUNCTION public.runtime_stop_loss_call_guard();

CREATE OR REPLACE FUNCTION public.runtime_stop_loss_settled() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.reason_code<>'bill2_release' THEN RETURN NEW;END IF;
 IF TG_WHEN='BEFORE' THEN
  PERFORM pg_advisory_xact_lock(201,1);
  RETURN NEW;
 END IF;
 -- Reservation-release ledger rows freeze actual provider cost once, including refunded calls.
 -- A disabled/broken monitor cannot prevent financial completion.
 BEGIN PERFORM runtime_stop_loss_observe(NEW.user_id);
 EXCEPTION WHEN OTHERS THEN
  BEGIN
   PERFORM runtime_stop_loss_alert('runtime_stop_loss_monitor_unavailable',jsonb_build_object(
    'dedupeKey',(clock_timestamp() AT TIME ZONE 'UTC')::date::text,'code','RUNTIME_STOP_LOSS_MONITOR_UNAVAILABLE'));
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'RUNTIME_STOP_LOSS_MONITOR_UNAVAILABLE';
  END;
 END;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS runtime_stop_loss_settlement_lock ON public.credit_transactions;
CREATE TRIGGER runtime_stop_loss_settlement_lock BEFORE INSERT ON public.credit_transactions
 FOR EACH ROW EXECUTE FUNCTION public.runtime_stop_loss_settled();
DROP TRIGGER IF EXISTS runtime_stop_loss_settled ON public.credit_transactions;
CREATE TRIGGER runtime_stop_loss_settled AFTER INSERT ON public.credit_transactions
 FOR EACH ROW EXECUTE FUNCTION public.runtime_stop_loss_settled();

CREATE OR REPLACE FUNCTION public.runtime_stop_loss_settings_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF coalesce(NEW.key,OLD.key) IN ('runtime_stop_loss','runtime_rate_limits') THEN
  PERFORM pg_advisory_xact_lock(201,1);
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS runtime_stop_loss_settings_guard ON public.system_settings;
CREATE TRIGGER runtime_stop_loss_settings_guard BEFORE INSERT OR UPDATE OR DELETE ON public.system_settings
 FOR EACH ROW EXECUTE FUNCTION public.runtime_stop_loss_settings_guard();

REVOKE ALL ON FUNCTION public.runtime_stop_loss_config(),public.runtime_stop_loss_usage(uuid),
 public.runtime_stop_loss_assert(uuid,boolean),public.runtime_stop_loss_alert(text,jsonb),
 public.runtime_stop_loss_observe(uuid),public.runtime_stop_loss_call_guard(),
 public.runtime_stop_loss_settled(),public.runtime_stop_loss_settings_guard() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.runtime_stop_loss_config(),public.runtime_stop_loss_usage(uuid),
 public.runtime_stop_loss_observe(uuid),public.runtime_stop_loss_alert(text,jsonb) TO service_role;
COMMIT;
