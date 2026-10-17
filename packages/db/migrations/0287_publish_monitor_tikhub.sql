-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PUBLISH-MONITOR PR-4a (docs/launch/tasks/PUBLISH-MONITOR.md §4.2, §8): the user's own Xiaohongshu/Douyin accounts and
-- Gold benchmark accounts read through TikHub. Number 0287 assigned by the controller. Connections, the daily claim and
-- writing a read's results; the billed read itself (BILL2 background runs) is PR-4b, so nothing here calls TikHub or
-- charges credits, and the daily TikHub step stays off until 4b lands.
BEGIN;
SET LOCAL lock_timeout='5s';

-- Platforms read through TikHub for the user's own account (plan §1 table: Xiaohongshu and Douyin).
CREATE OR REPLACE FUNCTION public.publish_monitor_tikhub_own_platform(p text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$ SELECT p IN ('xiaohongshu','douyin') $$;

-- Connect one of the user's own brand accounts by its public profile (plan §4.2): no authorization, public data only.
-- The profile reference is the canonical TikHub account id the server derived from the profile link. A brand account
-- that so far has only manually imported data is upgraded in place (its manual posts stay marked manual); one already
-- connected through Post for Me is refused.
CREATE OR REPLACE FUNCTION public.publish_monitor_tikhub_connect(a uuid,p_account_project_id uuid,p_platform text,
 p_profile_ref text,p_auto_track boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE acct opc_accounts; c social_connections;
BEGIN
 IF p_account_project_id IS NULL OR p_auto_track IS NULL OR p_profile_ref IS NULL
  OR p_profile_ref !~ '^[A-Za-z0-9_-]{1,160}$' THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 PERFORM publish_monitor_actor(a);
 SELECT * INTO acct FROM opc_accounts WHERE project_id=p_account_project_id AND actor_id=a AND business_id IS NOT NULL;
 IF acct.project_id IS NULL THEN RAISE EXCEPTION 'PUBLISH_MONITOR_ACCOUNT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 -- The profile link must be for the brand account's own platform.
 IF NOT publish_monitor_tikhub_own_platform(acct.platform) OR p_platform IS DISTINCT FROM acct.platform THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_PLATFORM_UNSUPPORTED' USING ERRCODE='22023'; END IF;
 SELECT * INTO c FROM social_connections WHERE account_project_id=acct.project_id AND actor_id=a AND role='own'
  AND status IN ('connected','reauth_required','quarantined') FOR UPDATE;
 IF c.id IS NOT NULL AND c.source='postforme' THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_TARGET_ALREADY_CONNECTED' USING ERRCODE='PT409'; END IF;
 IF c.id IS NOT NULL THEN
  -- Another profile on the same brand account starts a new history: the old profile's posts and snapshots go.
  IF c.source='tikhub' AND c.profile_ref IS DISTINCT FROM p_profile_ref THEN
   DELETE FROM social_metric_snapshots WHERE connection_id=c.id AND source='tikhub';
   DELETE FROM social_posts WHERE connection_id=c.id AND source='tikhub';
  END IF;
  UPDATE social_connections SET source='tikhub',profile_ref=p_profile_ref,status='connected',consent_read=true,
   consent_auto_track=p_auto_track,refresh_id=NULL,refresh_cursor=NULL,refresh_day=NULL,refresh_state=NULL,
   refresh_error=NULL,empty_streak=0,empty_day=NULL,fail_day=NULL,refresh_attempts=0,lease_owner=NULL,
   lease_expires_at=NULL,updated_at=clock_timestamp()
  WHERE id=c.id RETURNING * INTO c;
 ELSE
  INSERT INTO social_connections(actor_id,business_id,account_project_id,role,source,platform,profile_ref,status,
   consent_read,consent_auto_track)
  VALUES(a,acct.business_id,acct.project_id,'own','tikhub',acct.platform,p_profile_ref,'connected',true,p_auto_track)
  RETURNING * INTO c;
 END IF;
 RETURN jsonb_build_object('connectionId',c.id,'platform',c.platform);
END $$;

-- Gold benchmark accounts (plan §4.2): hung on the brand, not on a brand account; at most p_max per brand (admin
-- setting, passed by the server after it checked the Gold entitlement). The same profile once per brand.
CREATE OR REPLACE FUNCTION public.publish_monitor_benchmark_add(a uuid,p_business_id uuid,p_platform text,
 p_profile_ref text,p_display_hint text,p_max integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c social_connections; n integer;
BEGIN
 IF p_business_id IS NULL OR p_platform IS NULL OR p_platform !~ '^[a-z0-9_-]{1,32}$' OR p_profile_ref IS NULL
  OR p_profile_ref !~ '^[A-Za-z0-9_.-]{1,160}$' OR p_max IS NULL OR p_max NOT BETWEEN 1 AND 50
  OR char_length(p_display_hint)>64 THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 PERFORM publish_monitor_actor(a);
 -- Lock the brand so two concurrent adds cannot both pass the count.
 PERFORM 1 FROM opc_businesses WHERE id=p_business_id AND actor_id=a FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'PUBLISH_MONITOR_ACCOUNT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 IF EXISTS(SELECT 1 FROM social_connections WHERE business_id=p_business_id AND role='benchmark' AND platform=p_platform
   AND profile_ref=p_profile_ref AND status<>'deleting') THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_BENCHMARK_EXISTS' USING ERRCODE='PT409'; END IF;
 SELECT count(*) INTO n FROM social_connections WHERE business_id=p_business_id AND role='benchmark' AND status<>'deleting';
 IF n>=p_max THEN RAISE EXCEPTION 'PUBLISH_MONITOR_BENCHMARK_LIMIT' USING ERRCODE='PT409'; END IF;
 INSERT INTO social_connections(actor_id,business_id,role,source,platform,profile_ref,display_hint,status,consent_read,
  consent_auto_track)
 VALUES(a,p_business_id,'benchmark','tikhub',p_platform,p_profile_ref,NULLIF(p_display_hint,''),'connected',true,true)
 RETURNING * INTO c;
 RETURN jsonb_build_object('connectionId',c.id,'platform',c.platform,'count',n+1);
END $$;

-- Claim payload for a TikHub read: what the server needs to read one profile and its newest posts.
CREATE OR REPLACE FUNCTION public.publish_monitor_tikhub_item(c social_connections) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('connectionId',c.id,'actorId',c.actor_id,'businessId',c.business_id,'role',c.role,
  'lease',c.lease_owner,'refreshId',c.refresh_id,'platform',c.platform,'account',c.profile_ref,
  'knownPosts',(SELECT count(*) FROM social_posts p WHERE p.connection_id=c.id AND p.source='tikhub'))
$$;

-- Daily claim of TikHub connections due today (plan §4.2, §8): own accounts with read and automatic-tracking consent,
-- and benchmark accounts; each read at most once per UTC day. Users are interleaved as in the Post for Me claim.
CREATE OR REPLACE FUNCTION public.publish_monitor_tikhub_claim(p_limit integer,p_lease_seconds integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE now_at timestamptz:=clock_timestamp(); today date:=(clock_timestamp() AT TIME ZONE 'UTC')::date;
 lease uuid:=gen_random_uuid(); out jsonb;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 900 THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 WITH due AS (
  SELECT c.id,row_number() OVER (PARTITION BY c.actor_id ORDER BY c.last_success_at NULLS FIRST,c.id) AS turn,
   c.refresh_attempts,c.last_success_at
  FROM social_connections c
  WHERE c.status='connected' AND c.source='tikhub' AND c.consent_read AND (c.role='benchmark' OR c.consent_auto_track)
   AND (c.refresh_day IS NULL OR c.refresh_day<today) AND (c.lease_expires_at IS NULL OR c.lease_expires_at<=now_at)
   AND publish_monitor_actor_open(c.actor_id)
 ), picked AS (
  SELECT c.id FROM social_connections c JOIN due d ON d.id=c.id
  ORDER BY d.turn,d.refresh_attempts,d.last_success_at NULLS FIRST,c.id LIMIT p_limit FOR UPDATE OF c SKIP LOCKED
 ), claimed AS (
  UPDATE social_connections c SET lease_owner=lease,lease_expires_at=now_at+make_interval(secs=>p_lease_seconds),
   refresh_id=COALESCE(c.refresh_id,gen_random_uuid()),last_attempt_at=now_at
  FROM picked WHERE c.id=picked.id RETURNING c.*
 )
 SELECT COALESCE(jsonb_agg(publish_monitor_tikhub_item(claimed::social_connections)),'[]'::jsonb) INTO out FROM claimed;
 RETURN out;
END $$;

-- Writes one TikHub read (plan §4.2): the account's profile numbers as the day's account snapshot, and its newest posts
-- with their day snapshots, upserted by (connection, 'tikhub', post id) so a re-applied read adds nothing. Missing
-- fields stay listed, never zero. p_profile: {metrics, missingFields} or null; p_posts: [{platformPostId,url,postedAt,
-- titleExcerpt,metrics,missingFields}]. The caller then settles with publish_monitor_refresh_finish (0272).
CREATE OR REPLACE FUNCTION public.publish_monitor_tikhub_write(p_connection_id uuid,p_lease uuid,p_refresh_id uuid,
 p_profile jsonb,p_posts jsonb,p_evidence_ref text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c social_connections; item jsonb; today date:=(clock_timestamp() AT TIME ZONE 'UTC')::date; pid uuid;
 is_new boolean; inserted integer:=0; existing integer:=0;
BEGIN
 IF jsonb_typeof(p_posts) IS DISTINCT FROM 'array' OR jsonb_array_length(p_posts)>50
  OR (p_profile IS NOT NULL AND (jsonb_typeof(p_profile->'metrics') IS DISTINCT FROM 'object'
   OR jsonb_typeof(p_profile->'missingFields') IS DISTINCT FROM 'array'))
  OR char_length(p_evidence_ref)>256 THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 c:=publish_monitor_refresh_current(p_connection_id,p_lease,p_refresh_id);
 IF c.id IS NULL THEN RETURN jsonb_build_object('stale',true); END IF;
 IF c.source<>'tikhub' THEN RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 IF p_profile IS NOT NULL THEN
  INSERT INTO social_metric_snapshots AS s(actor_id,connection_id,post_id,captured_on,source,metrics,missing_fields,evidence_ref)
  VALUES(c.actor_id,c.id,NULL,today,'tikhub',p_profile->'metrics',
   ARRAY(SELECT jsonb_array_elements_text(p_profile->'missingFields')),p_evidence_ref)
  ON CONFLICT(connection_id,captured_on) WHERE post_id IS NULL DO UPDATE SET captured_at=clock_timestamp(),
   metrics=EXCLUDED.metrics,missing_fields=EXCLUDED.missing_fields,evidence_ref=EXCLUDED.evidence_ref;
 END IF;
 FOR item IN SELECT * FROM jsonb_array_elements(p_posts) LOOP
  IF jsonb_typeof(item->'metrics') IS DISTINCT FROM 'object' OR jsonb_typeof(item->'missingFields') IS DISTINCT FROM 'array'
   OR char_length(item->>'platformPostId') NOT BETWEEN 1 AND 256 THEN
   RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  INSERT INTO social_posts AS p(actor_id,connection_id,source,platform_post_id,post_url,posted_at,posted_at_source,
   title_excerpt,snapshot_day)
  VALUES(c.actor_id,c.id,'tikhub',item->>'platformPostId',item->>'url',(item->>'postedAt')::timestamptz,
   CASE WHEN item->>'postedAt' IS NULL THEN NULL ELSE 'provider' END,left(item->>'titleExcerpt',120),today)
  ON CONFLICT(connection_id,source,platform_post_id) DO UPDATE SET post_url=COALESCE(EXCLUDED.post_url,p.post_url),
   posted_at=COALESCE(EXCLUDED.posted_at,p.posted_at),
   posted_at_source=CASE WHEN EXCLUDED.posted_at IS NULL THEN p.posted_at_source ELSE 'provider' END,
   title_excerpt=COALESCE(EXCLUDED.title_excerpt,p.title_excerpt),snapshot_day=today,updated_at=clock_timestamp()
  RETURNING p.id,(xmax=0) INTO pid,is_new;
  IF is_new THEN inserted:=inserted+1; ELSE existing:=existing+1; END IF;
  INSERT INTO social_metric_snapshots AS s(actor_id,connection_id,post_id,captured_on,source,metrics,missing_fields,evidence_ref)
  VALUES(c.actor_id,c.id,pid,today,'tikhub',item->'metrics',ARRAY(SELECT jsonb_array_elements_text(item->'missingFields')),
   p_evidence_ref)
  ON CONFLICT(post_id,captured_on) WHERE post_id IS NOT NULL DO UPDATE SET captured_at=clock_timestamp(),
   metrics=EXCLUDED.metrics,missing_fields=EXCLUDED.missing_fields,evidence_ref=EXCLUDED.evidence_ref;
 END LOOP;
 RETURN jsonb_build_object('stale',false,'inserted',inserted,'existing',existing);
END $$;

DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('publish_monitor_tikhub_own_platform','publish_monitor_tikhub_connect',
   'publish_monitor_benchmark_add','publish_monitor_tikhub_item','publish_monitor_tikhub_claim',
   'publish_monitor_tikhub_write') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f);
  IF split_part(f::text,'(',1) NOT IN ('publish_monitor_tikhub_own_platform','publish_monitor_tikhub_item') THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f); END IF;
 END LOOP;
END $$;
COMMIT;
