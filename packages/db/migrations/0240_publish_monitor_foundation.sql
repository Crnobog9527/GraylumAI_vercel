-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PUBLISH-MONITOR PR-1 (docs/launch/tasks/PUBLISH-MONITOR.md §3, §7, §9): storage foundation,
-- membership entitlements and account-erasure wiring. Number 0240 assigned by the controller.
-- No provider calls, no publishing: adapters arrive in PR-2..PR-5 and the feature switch stays off.
BEGIN;
SET LOCAL lock_timeout='5s';

-- §3.4 entitlements, values exactly as Master Plan §2.1 item 51 (Pro: own data 30 days and publishing;
-- Gold: also benchmark monitoring, 90-day trend, weekly automatic review). Fill only missing values.
ALTER TABLE public.membership_plans
 ADD COLUMN IF NOT EXISTS allow_publish boolean,
 ADD COLUMN IF NOT EXISTS own_data_window_days integer,
 ADD COLUMN IF NOT EXISTS allow_benchmark_monitor boolean,
 ADD COLUMN IF NOT EXISTS allow_weekly_auto_review boolean;
UPDATE public.membership_plans
SET allow_publish=COALESCE(allow_publish,level<>'free'),
 own_data_window_days=COALESCE(own_data_window_days,CASE level WHEN 'free' THEN 0 WHEN 'pro' THEN 30 ELSE 90 END),
 allow_benchmark_monitor=COALESCE(allow_benchmark_monitor,level='gold'),
 allow_weekly_auto_review=COALESCE(allow_weekly_auto_review,level='gold')
WHERE allow_publish IS NULL OR own_data_window_days IS NULL OR allow_benchmark_monitor IS NULL
 OR allow_weekly_auto_review IS NULL;
-- Plans created later without these fields get nothing (fail closed); existing rows keep their fill.
ALTER TABLE public.membership_plans
 ALTER COLUMN allow_publish SET DEFAULT false,
 ALTER COLUMN own_data_window_days SET DEFAULT 0,
 ALTER COLUMN allow_benchmark_monitor SET DEFAULT false,
 ALTER COLUMN allow_weekly_auto_review SET DEFAULT false,
 ALTER COLUMN allow_publish SET NOT NULL,
 ALTER COLUMN own_data_window_days SET NOT NULL,
 ALTER COLUMN allow_benchmark_monitor SET NOT NULL,
 ALTER COLUMN allow_weekly_auto_review SET NOT NULL;
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.membership_plans'::regclass
  AND conname='membership_plans_own_data_window_days_check') THEN
  ALTER TABLE public.membership_plans ADD CONSTRAINT membership_plans_own_data_window_days_check
   CHECK(own_data_window_days BETWEEN 0 AND 365);
 END IF;
END $$;

-- Admin catalog saves go through an allow-list; extend it in place (anchor + marker, fail closed).
DO $catalog$
DECLARE source text; needle text:='''allow_fusion_review'',''allow_fusion_compare'',''library_storage_bytes''';
BEGIN
 source:=pg_get_functiondef('public.pay_common_save_catalog(text,uuid,jsonb,jsonb,text,text,text)'::regprocedure);
 IF position('allow_weekly_auto_review' IN source)=0 THEN
  IF length(source)-length(replace(source,needle,''))<>length(needle) THEN
   RAISE EXCEPTION 'PUBLISH_MONITOR_CATALOG_SOURCE_MISMATCH'; END IF;
  EXECUTE replace(source,needle,needle||',''allow_publish'',''own_data_window_days'',''allow_benchmark_monitor'',''allow_weekly_auto_review''');
 END IF;
END $catalog$;

-- Composite targets so a connection or request can only name the actor's own brand account.
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.opc_accounts'::regclass
  AND conname='opc_accounts_project_actor_business_key') THEN
  ALTER TABLE public.opc_accounts ADD CONSTRAINT opc_accounts_project_actor_business_key
   UNIQUE(project_id,actor_id,business_id);
 END IF;
END $$;

-- §3.2 tables. New: no existing relation stores third-party social connections, post metrics over
-- time, weekly-review claims or OAuth attempts (§3.3). All access goes through the definer functions.

-- Per-user automatic weekly review switch (Owner 2026-10-13: default on, can be turned off; first run
-- seven days after enabled_at). profiles is client-visible, so the switch lives in its own table.
CREATE TABLE IF NOT EXISTS public.social_monitor_settings(
 actor_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE RESTRICT,
 auto_review_enabled boolean NOT NULL DEFAULT true,
 auto_review_enabled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- One row per connected own account, benchmark account, or retained provider-deletion record.
-- Own accounts hang on opc_accounts (one effective connection each); benchmarks hang on the brand.
CREATE TABLE IF NOT EXISTS public.social_connections(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 actor_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
 business_id uuid,
 account_project_id uuid,
 role text NOT NULL CHECK(role IN ('own','benchmark')),
 source text NOT NULL CHECK(source IN ('postforme','tikhub','manual')),
 platform text NOT NULL CHECK(platform ~ '^[a-z0-9_-]{1,32}$'),
 provider_account_id text CHECK(provider_account_id ~ '^[A-Za-z0-9_-]{1,128}$'),
 profile_ref text CHECK(char_length(profile_ref) BETWEEN 1 AND 512),
 display_hint text CHECK(char_length(display_hint) BETWEEN 1 AND 64),
 status text NOT NULL CHECK(status IN
  ('pending_selection','connected','reauth_required','quarantined','disconnected','deleting')),
 consent_read boolean NOT NULL DEFAULT false,
 consent_auto_track boolean NOT NULL DEFAULT false,
 consent_publish boolean NOT NULL DEFAULT false,
 provider_can_publish boolean NOT NULL DEFAULT false,
 last_success_at timestamptz,
 refresh_id uuid,
 refresh_cursor text CHECK(char_length(refresh_cursor)<=2048),
 lease_owner uuid,
 lease_expires_at timestamptz,
 refresh_attempts integer NOT NULL DEFAULT 0 CHECK(refresh_attempts BETWEEN 0 AND 1000),
 last_attempt_at timestamptz,
 deletion_attempts integer NOT NULL DEFAULT 0 CHECK(deletion_attempts BETWEEN 0 AND 1000),
 deletion_error text CHECK(deletion_error ~ '^[A-Z0-9_]{1,64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(actor_id,business_id) REFERENCES public.opc_businesses(actor_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(account_project_id,actor_id,business_id)
  REFERENCES public.opc_accounts(project_id,actor_id,business_id) ON DELETE RESTRICT,
 CHECK(source<>'postforme' OR provider_account_id IS NOT NULL),
 CHECK(role<>'benchmark' OR (source='tikhub' AND account_project_id IS NULL AND profile_ref IS NOT NULL)),
 -- A retained deletion record keeps no brand binding and no user-visible identity (DATA-ERASURE §2).
 CHECK(status='deleting' OR business_id IS NOT NULL),
 CHECK(status='deleting' OR role<>'own' OR account_project_id IS NOT NULL),
 CHECK(status<>'deleting' OR (business_id IS NULL AND account_project_id IS NULL AND display_hint IS NULL
  AND profile_ref IS NULL AND NOT consent_read AND NOT consent_auto_track AND NOT consent_publish)),
 CHECK((lease_owner IS NULL)=(lease_expires_at IS NULL)),
 UNIQUE(id,actor_id)
);
-- The provider account ID stays reserved until the row is really gone, in every retained state (§3.2).
CREATE UNIQUE INDEX IF NOT EXISTS social_connections_provider_account
 ON public.social_connections(provider_account_id) WHERE provider_account_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS social_connections_effective_account
 ON public.social_connections(account_project_id)
 WHERE account_project_id IS NOT NULL AND status IN ('connected','reauth_required','quarantined');
CREATE UNIQUE INDEX IF NOT EXISTS social_connections_benchmark
 ON public.social_connections(business_id,platform,profile_ref) WHERE role='benchmark' AND status<>'deleting';
CREATE INDEX IF NOT EXISTS social_connections_actor ON public.social_connections(actor_id,status);
CREATE INDEX IF NOT EXISTS social_connections_refresh_due
 ON public.social_connections(last_success_at NULLS FIRST) WHERE status='connected' AND consent_auto_track;

CREATE TABLE IF NOT EXISTS public.social_posts(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 actor_id uuid NOT NULL,
 connection_id uuid NOT NULL,
 source text NOT NULL CHECK(source IN ('postforme','tikhub','manual')),
 platform_post_id text NOT NULL CHECK(char_length(platform_post_id) BETWEEN 1 AND 256),
 post_url text CHECK(char_length(post_url) BETWEEN 1 AND 2048),
 posted_at timestamptz,
 -- First 120 characters only, to recognise the post in a review; no body or media is stored.
 title_excerpt text CHECK(char_length(title_excerpt)<=120),
 work_item_id uuid REFERENCES public.opc_items(work_item_id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(connection_id,actor_id) REFERENCES public.social_connections(id,actor_id) ON DELETE RESTRICT,
 UNIQUE(connection_id,source,platform_post_id),
 UNIQUE(id,actor_id),
 UNIQUE(id,connection_id)
);
CREATE INDEX IF NOT EXISTS social_posts_connection_posted ON public.social_posts(connection_id,posted_at DESC);

-- One snapshot per post (or per account when post_id is NULL) per day; missing fields are listed,
-- never written as zero (§3.2).
CREATE TABLE IF NOT EXISTS public.social_metric_snapshots(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 actor_id uuid NOT NULL,
 connection_id uuid NOT NULL,
 post_id uuid,
 captured_on date NOT NULL,
 captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 source text NOT NULL CHECK(source IN ('postforme','tikhub','manual')),
 metrics jsonb NOT NULL CHECK(jsonb_typeof(metrics)='object'),
 missing_fields text[] NOT NULL DEFAULT '{}',
 evidence_ref text CHECK(char_length(evidence_ref)<=256),
 FOREIGN KEY(connection_id,actor_id) REFERENCES public.social_connections(id,actor_id) ON DELETE RESTRICT,
 FOREIGN KEY(post_id,actor_id) REFERENCES public.social_posts(id,actor_id) ON DELETE RESTRICT,
 -- A post snapshot belongs to the post's own connection.
 FOREIGN KEY(post_id,connection_id) REFERENCES public.social_posts(id,connection_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS social_metric_snapshots_post_day
 ON public.social_metric_snapshots(post_id,captured_on) WHERE post_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS social_metric_snapshots_account_day
 ON public.social_metric_snapshots(connection_id,captured_on) WHERE post_id IS NULL;
CREATE INDEX IF NOT EXISTS social_metric_snapshots_retention ON public.social_metric_snapshots(captured_on);

-- Weekly automatic review claim (§8): one row per user and review period.
CREATE TABLE IF NOT EXISTS public.social_review_runs(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 actor_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
 period_start date NOT NULL,
 status text NOT NULL CHECK(status IN ('claimed','completed','skipped')),
 lease_expires_at timestamptz,
 runtime_request_id uuid NOT NULL UNIQUE,
 runtime_execution_id uuid,
 bill2_run_id uuid,
 skip_reason text CHECK(skip_reason ~ '^[A-Z0-9_]{1,64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 finished_at timestamptz,
 UNIQUE(actor_id,period_start),
 CHECK((status='claimed')=(lease_expires_at IS NOT NULL)),
 CHECK((status='skipped')=(skip_reason IS NOT NULL))
);

-- One-time OAuth attempt, written before redirecting (§4.1).
CREATE TABLE IF NOT EXISTS public.social_connect_requests(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 actor_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
 business_id uuid,
 target_account_project_id uuid,
 platform text NOT NULL CHECK(platform ~ '^[a-z0-9_-]{1,32}$'),
 permissions text[] NOT NULL CHECK(permissions <@ ARRAY['feeds','posts'] AND cardinality(permissions) BETWEEN 1 AND 2),
 -- Full provider external_id: <non-reversible user mapping>.<attempt suffix>; no identity in clear.
 external_id text NOT NULL UNIQUE CHECK(external_id ~ '^[a-z0-9]{16,64}\.[a-z0-9]{16,64}$'),
 state text NOT NULL CHECK(state IN ('awaiting_callback','pending_confirm','applied','abandoned')),
 candidate_provider_ids text[] NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz,
 confirm_expires_at timestamptz,
 FOREIGN KEY(actor_id,business_id) REFERENCES public.opc_businesses(actor_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(target_account_project_id,actor_id,business_id)
  REFERENCES public.opc_accounts(project_id,actor_id,business_id) ON DELETE SET NULL(target_account_project_id),
 CHECK(state<>'awaiting_callback' OR consumed_at IS NULL),
 CHECK(state NOT IN ('pending_confirm','applied') OR consumed_at IS NOT NULL),
 CHECK((state='pending_confirm')=(confirm_expires_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS social_connect_requests_one_open
 ON public.social_connect_requests(actor_id) WHERE state='awaiting_callback';

-- Publish jobs (§6). The idempotency key is scoped to its owner; the row is inserted before any quota
-- reservation or provider call, and it is the provider external_id source.
CREATE TABLE IF NOT EXISTS public.social_publish_jobs(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 actor_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
 business_id uuid,
 idempotency_key text NOT NULL CHECK(idempotency_key ~ '^[A-Za-z0-9_-]{8,128}$'),
 request_fingerprint text NOT NULL CHECK(request_fingerprint ~ '^[0-9a-f]{64}$'),
 work_item_id uuid REFERENCES public.opc_items(work_item_id) ON DELETE SET NULL,
 targets jsonb NOT NULL CHECK(jsonb_typeof(targets)='array' AND jsonb_array_length(targets) BETWEEN 1 AND 9),
 state text NOT NULL CHECK(state IN ('claimed','dispatching','unknown','completed','failed','released')),
 provider_post_id text CHECK(provider_post_id ~ '^[A-Za-z0-9_-]{1,128}$'),
 results jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(results)='object'),
 reserved_slots integer NOT NULL DEFAULT 0 CHECK(reserved_slots BETWEEN 0 AND 9),
 bill2_run_id uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(actor_id,business_id) REFERENCES public.opc_businesses(actor_id,id) ON DELETE RESTRICT,
 CHECK(state IN ('dispatching','unknown') OR business_id IS NOT NULL),
 UNIQUE(actor_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS social_publish_jobs_open ON public.social_publish_jobs(state,updated_at)
 WHERE state IN ('claimed','dispatching','unknown');

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['social_monitor_settings','social_connections','social_posts','social_metric_snapshots',
  'social_review_runs','social_connect_requests','social_publish_jobs'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  -- No client or service_role table access: every read and write goes through definer functions.
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',t);
 END LOOP;
END $$;

-- Closed accounts are rejected by every writer (same rule as 0212).
CREATE OR REPLACE FUNCTION public.publish_monitor_actor(a uuid) RETURNS profiles
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p profiles;
BEGIN
 IF a IS NULL THEN RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 SELECT * INTO p FROM profiles WHERE id=a FOR UPDATE;
 IF p.id IS NULL THEN RAISE EXCEPTION 'PUBLISH_MONITOR_PROFILE_MISSING' USING ERRCODE='P0002'; END IF;
 IF p.status IS DISTINCT FROM 'active' OR p.is_deleted::text IS DISTINCT FROM 'false'
  OR EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=a) THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_ACCOUNT_CLOSED' USING ERRCODE='42501';
 END IF;
 RETURN p;
END $$;

CREATE OR REPLACE FUNCTION public.publish_monitor_settings(a uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('autoReviewEnabled',COALESCE(s.auto_review_enabled,true),
  'autoReviewEnabledAt',s.auto_review_enabled_at)
 FROM (SELECT 1) one LEFT JOIN social_monitor_settings s ON s.actor_id=a
$$;

-- Turning the switch on (again) restarts the seven-day wait; turning it off is always allowed.
CREATE OR REPLACE FUNCTION public.publish_monitor_set_auto_review(a uuid,p_enabled boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF p_enabled IS NULL THEN RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 PERFORM publish_monitor_actor(a);
 INSERT INTO social_monitor_settings AS s(actor_id,auto_review_enabled) VALUES(a,p_enabled)
 ON CONFLICT(actor_id) DO UPDATE SET auto_review_enabled=EXCLUDED.auto_review_enabled,
  auto_review_enabled_at=CASE WHEN EXCLUDED.auto_review_enabled AND NOT s.auto_review_enabled
   THEN clock_timestamp() ELSE s.auto_review_enabled_at END,
  updated_at=clock_timestamp();
 RETURN publish_monitor_settings(a);
END $$;

-- Read-only overview of the user's connections. Retained deletion records and identifiers used only by
-- the server (provider IDs, refresh leases) are never returned.
CREATE OR REPLACE FUNCTION public.publish_monitor_connections(a uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',c.id,'businessId',c.business_id,
  'accountProjectId',c.account_project_id,'role',c.role,'source',c.source,'platform',c.platform,
  'displayHint',c.display_hint,'status',c.status,'consentRead',c.consent_read,
  'consentAutoTrack',c.consent_auto_track,'consentPublish',c.consent_publish,
  'lastSuccessAt',c.last_success_at,'postCount',(SELECT count(*) FROM social_posts p WHERE p.connection_id=c.id))
  ORDER BY c.created_at,c.id),'[]'::jsonb)
 FROM social_connections c WHERE c.actor_id=a AND c.status NOT IN ('deleting','pending_selection')
$$;

-- §7 account erasure. Rows that still mirror state at the provider are kept as identity-free deletion
-- records until PR-2's processor confirms provider-side cleanup; everything else is pruned.
CREATE OR REPLACE FUNCTION public.publish_monitor_erasure_retained(t text,j jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT CASE t
  WHEN 'social_connections' THEN j->>'provider_account_id' IS NOT NULL
  WHEN 'social_publish_jobs' THEN j->>'state' IN ('dispatching','unknown')
  WHEN 'social_connect_requests' THEN j->>'state' IN ('awaiting_callback','pending_confirm')
  ELSE false END
$$;

CREATE OR REPLACE FUNCTION public.publish_monitor_erasure_scrub(a uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE n integer; total integer:=0;
BEGIN
 PERFORM account_erasure_assert_closed(a);
 -- Posts and snapshots go first through the prune loop; detach retained rows from the brand now.
 UPDATE social_connections SET status='deleting',business_id=NULL,account_project_id=NULL,display_hint=NULL,
  profile_ref=NULL,consent_read=false,consent_auto_track=false,consent_publish=false,refresh_id=NULL,
  refresh_cursor=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
 WHERE actor_id=a AND provider_account_id IS NOT NULL AND status<>'deleting';
 GET DIAGNOSTICS n=ROW_COUNT;total:=total+n;
 UPDATE social_publish_jobs SET business_id=NULL,work_item_id=NULL,updated_at=clock_timestamp()
 WHERE actor_id=a AND state IN ('dispatching','unknown') AND (business_id IS NOT NULL OR work_item_id IS NOT NULL);
 GET DIAGNOSTICS n=ROW_COUNT;total:=total+n;
 UPDATE social_connect_requests SET business_id=NULL,target_account_project_id=NULL
 WHERE actor_id=a AND state IN ('awaiting_callback','pending_confirm')
  AND (business_id IS NOT NULL OR target_account_project_id IS NOT NULL);
 GET DIAGNOSTICS n=ROW_COUNT;total:=total+n;
 RETURN total;
END $$;

CREATE OR REPLACE FUNCTION public.publish_monitor_erasure_remaining(a uuid) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT (SELECT count(*) FROM social_monitor_settings WHERE actor_id=a)
 +(SELECT count(*) FROM social_review_runs WHERE actor_id=a)
 +(SELECT count(*) FROM social_metric_snapshots WHERE actor_id=a)
 +(SELECT count(*) FROM social_posts WHERE actor_id=a)
 +(SELECT count(*) FROM social_connections WHERE actor_id=a AND provider_account_id IS NULL)
 +(SELECT count(*) FROM social_connections WHERE actor_id=a AND provider_account_id IS NOT NULL
   AND (status<>'deleting' OR business_id IS NOT NULL))
 +(SELECT count(*) FROM social_publish_jobs WHERE actor_id=a
   AND (state NOT IN ('dispatching','unknown') OR business_id IS NOT NULL))
 +(SELECT count(*) FROM social_connect_requests WHERE actor_id=a
   AND (state NOT IN ('awaiting_callback','pending_confirm') OR business_id IS NOT NULL))
$$;

-- Extend the merged erasure functions in place (0192/0203/0209 pattern): unique anchors fail closed,
-- the marker makes repeated application stable.
DO $$
DECLARE source text; needle text; replacement text; sig text;
BEGIN
 FOR sig,needle,replacement IN SELECT * FROM (VALUES
  ('erasure_business_owner(text,jsonb)', E' CASE\n',
   E' CASE\n WHEN t IN (''social_monitor_settings'',''social_connections'',''social_posts'',\n  ''social_metric_snapshots'',''social_review_runs'',''social_connect_requests'',''social_publish_jobs'')\n  THEN RETURN (j->>''actor_id'')::uuid;\n'),
  ('account_erasure_prune_business(uuid,integer)', E' FOREACH t IN ARRAY ARRAY[\n',
   E' PERFORM publish_monitor_erasure_scrub(p_profile_id);\n FOREACH t IN ARRAY ARRAY[\n  ''social_metric_snapshots'',''social_posts'',''social_review_runs'',''social_publish_jobs'',\n  ''social_connect_requests'',''social_connections'',''social_monitor_settings'',\n'),
  ('account_erasure_business_remaining(uuid)', ' SELECT ',
   E' SELECT public.publish_monitor_erasure_remaining(p_profile_id)+')
 ) changes(signature,anchor,patch) LOOP
  source:=pg_get_functiondef(('public.'||sig)::regprocedure);
  IF position('-- PUBLISH-MONITOR erasure' IN source)=0 THEN
   IF length(source)-length(replace(source,needle,''))<>length(needle) THEN
    RAISE EXCEPTION 'PUBLISH_MONITOR_ERASURE_SOURCE_MISMATCH: %',sig; END IF;
   source:=replace(source,needle,E' -- PUBLISH-MONITOR erasure\n'||replacement);
   IF sig='account_erasure_prune_business(uuid,integer)' THEN
    needle:='   IF item.body ? ''erased_at''';
    IF length(source)-length(replace(source,needle,''))<>length(needle) THEN
     RAISE EXCEPTION 'PUBLISH_MONITOR_ERASURE_PRUNE_MISMATCH'; END IF;
    source:=replace(source,needle,
     E'   IF t LIKE ''social_%'' AND public.publish_monitor_erasure_retained(t,item.body) THEN CONTINUE; END IF;\n'||needle);
   END IF;
   EXECUTE source;
  END IF;
 END LOOP;
END $$;

DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('publish_monitor_actor','publish_monitor_settings',
   'publish_monitor_set_auto_review','publish_monitor_connections','publish_monitor_erasure_retained',
   'publish_monitor_erasure_scrub','publish_monitor_erasure_remaining') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f);
  IF split_part(f::text,'(',1) IN ('publish_monitor_settings','publish_monitor_set_auto_review',
   'publish_monitor_connections') THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f);END IF;
 END LOOP;
END $$;
COMMIT;
