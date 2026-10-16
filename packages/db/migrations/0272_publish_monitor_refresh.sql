-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PUBLISH-MONITOR PR-3a (docs/launch/tasks/PUBLISH-MONITOR.md §4.1 bounded refresh and empty-list rules, §7 retention,
-- §8 daily job, §9 items 3/4/11/20): refresh progress, daily snapshots, the 30/90-day data window and manual refresh.
-- Number 0272 assigned by the controller. Progress lives on the existing rows (plan §8: no new queue tables). Reading the
-- user's own Post for Me data is free (Owner 2026-10-13), so nothing here freezes or charges credits.
BEGIN;
SET LOCAL lock_timeout='5s';

-- Refresh progress per connection. refresh_day is the UTC day the refresh was settled (done, partial, empty, failed or
-- skipped): the daily job claims a connection at most once per day; an interrupted refresh keeps its cursor and resumes.
ALTER TABLE public.social_connections ADD COLUMN IF NOT EXISTS refresh_day date;
ALTER TABLE public.social_connections ADD COLUMN IF NOT EXISTS refresh_state text;
ALTER TABLE public.social_connections ADD COLUMN IF NOT EXISTS refresh_error text;
-- Consecutive UTC days whose discovery read came back empty, and the last such day (counted once per day).
ALTER TABLE public.social_connections ADD COLUMN IF NOT EXISTS empty_streak integer NOT NULL DEFAULT 0;
ALTER TABLE public.social_connections ADD COLUMN IF NOT EXISTS empty_day date;
-- Provider pages read on pages_day (daily cap shared by the job and manual refreshes, plan §4.1).
ALTER TABLE public.social_connections ADD COLUMN IF NOT EXISTS pages_day date;
ALTER TABLE public.social_connections ADD COLUMN IF NOT EXISTS pages_used integer NOT NULL DEFAULT 0;
-- Last UTC day a refresh failed: refresh_attempts counts consecutive failed days, once per day.
ALTER TABLE public.social_connections ADD COLUMN IF NOT EXISTS fail_day date;
-- Last manual refresh by the user: at most one per connection per hour (plan §5.1).
ALTER TABLE public.social_connections ADD COLUMN IF NOT EXISTS manual_refresh_at timestamptz;
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.social_connections'::regclass
  AND conname='social_connections_refresh_check') THEN
  ALTER TABLE public.social_connections ADD CONSTRAINT social_connections_refresh_check
   CHECK((refresh_state IS NULL OR refresh_state IN ('ok','partial','not_fetched','no_posts_yet','reauth_suggested',
     'failed','entitlement'))
    AND (refresh_error IS NULL OR refresh_error ~ '^[A-Z0-9_]{1,64}$')
    AND empty_streak BETWEEN 0 AND 1000 AND pages_used BETWEEN 0 AND 1000);
 END IF;
END $$;

-- Where posted_at came from (X derives it from the post ID) and the last UTC day the post got a snapshot, which drives
-- the observation schedule (daily for 7 days, weekly to day 30, fortnightly to day 90 for Gold).
ALTER TABLE public.social_posts ADD COLUMN IF NOT EXISTS posted_at_source text;
ALTER TABLE public.social_posts ADD COLUMN IF NOT EXISTS snapshot_day date;
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.social_posts'::regclass
  AND conname='social_posts_posted_at_source_check') THEN
  ALTER TABLE public.social_posts ADD CONSTRAINT social_posts_posted_at_source_check
   CHECK(posted_at_source IS NULL OR posted_at_source IN ('provider','x_snowflake','user'));
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS social_posts_refresh_due ON public.social_posts(connection_id,snapshot_day NULLS FIRST);

-- Array-valued analytics (audience, retention) kept beside the numeric metrics; bounded by the adapter.
ALTER TABLE public.social_metric_snapshots ADD COLUMN IF NOT EXISTS breakdowns jsonb NOT NULL DEFAULT '{}'::jsonb;
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.social_metric_snapshots'::regclass
  AND conname='social_metric_snapshots_breakdowns_check') THEN
  ALTER TABLE public.social_metric_snapshots ADD CONSTRAINT social_metric_snapshots_breakdowns_check
   CHECK(jsonb_typeof(breakdowns)='object' AND pg_column_size(breakdowns)<=65536 AND pg_column_size(metrics)<=65536);
 END IF;
END $$;

CREATE INDEX IF NOT EXISTS social_connections_refresh_claim ON public.social_connections(refresh_attempts,last_success_at NULLS FIRST)
 WHERE status='connected' AND source='postforme' AND role='own';

-- A connection may be read only while its owner's account is open (same rule as publish_monitor_actor, no lock).
CREATE OR REPLACE FUNCTION public.publish_monitor_actor_open(a uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM profiles p WHERE p.id=a AND p.status='active' AND p.is_deleted::text='false')
  AND NOT EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=a)
$$;

-- Claim payload: what the server needs to read one connection. ownerRef is the reference the provider account must
-- still carry (plan §4.1: check before every read); pagesUsed counts today's pages against the daily cap.
CREATE OR REPLACE FUNCTION public.publish_monitor_refresh_item(c social_connections) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('connectionId',c.id,'actorId',c.actor_id,'lease',c.lease_owner,'refreshId',c.refresh_id,
  'cursor',c.refresh_cursor,'providerAccountId',c.provider_account_id,'platform',c.platform,
  'ownerRef',(SELECT provider_ref FROM social_monitor_settings s WHERE s.actor_id=c.actor_id),
  'pagesUsed',CASE WHEN c.pages_day=(clock_timestamp() AT TIME ZONE 'UTC')::date THEN c.pages_used ELSE 0 END,
  'knownPosts',(SELECT count(*) FROM social_posts p WHERE p.connection_id=c.id))
$$;

-- Daily job: claim connections due today (plan §8). Only connected own Post for Me connections with both read and
-- automatic-tracking consent, no pending takeover, and an open owner account. Users are interleaved (each user's
-- longest-waiting connection first) so one large account cannot starve others; repeatedly failing ones go last.
CREATE OR REPLACE FUNCTION public.publish_monitor_refresh_claim(p_limit integer,p_lease_seconds integer) RETURNS jsonb
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
  WHERE c.status='connected' AND c.source='postforme' AND c.role='own' AND c.consent_read AND c.consent_auto_track
   AND NOT c.provider_disconnect_pending AND (c.refresh_day IS NULL OR c.refresh_day<today)
   AND (c.lease_expires_at IS NULL OR c.lease_expires_at<=now_at) AND publish_monitor_actor_open(c.actor_id)
 ), picked AS (
  SELECT c.id FROM social_connections c JOIN due d ON d.id=c.id
  ORDER BY d.turn,d.refresh_attempts,d.last_success_at NULLS FIRST,c.id LIMIT p_limit FOR UPDATE OF c SKIP LOCKED
 ), claimed AS (
  UPDATE social_connections c SET lease_owner=lease,lease_expires_at=now_at+make_interval(secs=>p_lease_seconds),
   refresh_id=COALESCE(c.refresh_id,gen_random_uuid()),last_attempt_at=now_at
  FROM picked WHERE c.id=picked.id RETURNING c.*
 )
 SELECT COALESCE(jsonb_agg(publish_monitor_refresh_item(claimed::social_connections)),'[]'::jsonb) INTO out FROM claimed;
 RETURN out;
END $$;

-- Manual refresh by the user (plan §5.1): their own connected connection with read consent, at most once an hour.
-- Automatic tracking is not required: without it the user's own click is the only time Graylum reads.
CREATE OR REPLACE FUNCTION public.publish_monitor_refresh_request(a uuid,p_connection_id uuid,p_lease_seconds integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c social_connections; now_at timestamptz:=clock_timestamp();
BEGIN
 IF p_connection_id IS NULL OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 900 THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 PERFORM publish_monitor_actor(a);
 SELECT * INTO c FROM social_connections WHERE id=p_connection_id AND actor_id=a AND role='own'
  AND status NOT IN ('deleting','pending_selection') FOR UPDATE;
 IF c.id IS NULL THEN RAISE EXCEPTION 'PUBLISH_MONITOR_CONNECTION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 IF c.source<>'postforme' OR c.status<>'connected' OR NOT c.consent_read OR c.provider_disconnect_pending THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_REFRESH_UNAVAILABLE' USING ERRCODE='42501'; END IF;
 IF c.manual_refresh_at>now_at-interval '1 hour' THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_REFRESH_TOO_SOON' USING ERRCODE='PT429'; END IF;
 -- A refresh already running (daily job or another tab) is not doubled; the user sees its result.
 IF c.lease_expires_at>now_at THEN RAISE EXCEPTION 'PUBLISH_MONITOR_REFRESH_RUNNING' USING ERRCODE='PT409'; END IF;
 UPDATE social_connections SET lease_owner=gen_random_uuid(),lease_expires_at=now_at+make_interval(secs=>p_lease_seconds),
  refresh_id=COALESCE(refresh_id,gen_random_uuid()),manual_refresh_at=now_at,last_attempt_at=now_at
 WHERE id=c.id RETURNING * INTO c;
 RETURN publish_monitor_refresh_item(c);
END $$;

-- The lease and refresh number of the current claim; a stale worker (re-claimed, or cleared by a webhook, takeover,
-- disconnect or erasure) gets NULL and changes nothing.
CREATE OR REPLACE FUNCTION public.publish_monitor_refresh_current(p_connection_id uuid,p_lease uuid,p_refresh_id uuid)
RETURNS social_connections LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c social_connections;
BEGIN
 IF p_connection_id IS NULL OR p_lease IS NULL OR p_refresh_id IS NULL THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 SELECT * INTO c FROM social_connections WHERE id=p_connection_id FOR UPDATE;
 IF c.id IS NULL OR c.lease_owner IS DISTINCT FROM p_lease OR c.refresh_id IS DISTINCT FROM p_refresh_id
  OR c.status<>'connected' OR c.lease_expires_at<=clock_timestamp() THEN RETURN NULL; END IF;
 RETURN c;
END $$;

-- One provider page (discovery or a batch of due posts). Posts upsert by (connection, source, platform post ID), so
-- re-reading the same page after an interruption adds nothing; each post gets at most one snapshot per UTC day (the
-- latest read of the day wins). The cursor is saved with the page, so an interrupted refresh resumes after it.
-- p_posts: [{platformPostId,url,postedAt,postedAtSource,titleExcerpt,metrics,breakdowns,missingFields}].
CREATE OR REPLACE FUNCTION public.publish_monitor_refresh_page(p_connection_id uuid,p_lease uuid,p_refresh_id uuid,
 p_posts jsonb,p_cursor text,p_save_cursor boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c social_connections; item jsonb; today date:=(clock_timestamp() AT TIME ZONE 'UTC')::date; pid uuid;
 inserted integer:=0; existing integer:=0; is_new boolean; posted timestamptz; src text;
BEGIN
 IF jsonb_typeof(p_posts) IS DISTINCT FROM 'array' OR jsonb_array_length(p_posts)>100 OR p_save_cursor IS NULL
  OR char_length(p_cursor)>2048 THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 c:=publish_monitor_refresh_current(p_connection_id,p_lease,p_refresh_id);
 IF c.id IS NULL THEN RETURN jsonb_build_object('stale',true); END IF;
 FOR item IN SELECT * FROM jsonb_array_elements(p_posts) LOOP
  IF jsonb_typeof(item->'metrics') IS DISTINCT FROM 'object' OR jsonb_typeof(item->'breakdowns') IS DISTINCT FROM 'object'
   OR jsonb_typeof(item->'missingFields') IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  posted:=(item->>'postedAt')::timestamptz;
  src:=CASE WHEN posted IS NULL THEN NULL ELSE item->>'postedAtSource' END;
  INSERT INTO social_posts AS p(actor_id,connection_id,source,platform_post_id,post_url,posted_at,posted_at_source,
   title_excerpt,snapshot_day)
  VALUES(c.actor_id,c.id,'postforme',item->>'platformPostId',item->>'url',posted,src,item->>'titleExcerpt',today)
  ON CONFLICT(connection_id,source,platform_post_id) DO UPDATE SET post_url=COALESCE(EXCLUDED.post_url,p.post_url),
   -- A provider date replaces a derived one; an absent date never erases a known one.
   posted_at=COALESCE(EXCLUDED.posted_at,p.posted_at),posted_at_source=CASE WHEN EXCLUDED.posted_at IS NULL
    THEN p.posted_at_source ELSE EXCLUDED.posted_at_source END,
   title_excerpt=COALESCE(EXCLUDED.title_excerpt,p.title_excerpt),snapshot_day=today,updated_at=clock_timestamp()
  RETURNING p.id,(xmax=0) INTO pid,is_new;
  IF is_new THEN inserted:=inserted+1; ELSE existing:=existing+1; END IF;
  INSERT INTO social_metric_snapshots AS s(actor_id,connection_id,post_id,captured_on,source,metrics,missing_fields,
   breakdowns,evidence_ref)
  VALUES(c.actor_id,c.id,pid,today,'postforme',item->'metrics',
   ARRAY(SELECT jsonb_array_elements_text(item->'missingFields')),item->'breakdowns','refresh:'||p_refresh_id)
  ON CONFLICT(post_id,captured_on) WHERE post_id IS NOT NULL DO UPDATE SET captured_at=clock_timestamp(),
   metrics=EXCLUDED.metrics,missing_fields=EXCLUDED.missing_fields,breakdowns=EXCLUDED.breakdowns,
   evidence_ref=EXCLUDED.evidence_ref;
 END LOOP;
 UPDATE social_connections SET refresh_cursor=CASE WHEN p_save_cursor THEN p_cursor ELSE refresh_cursor END,
  pages_used=CASE WHEN pages_day=today THEN LEAST(pages_used+1,1000) ELSE 1 END,pages_day=today,
  updated_at=clock_timestamp()
 WHERE id=c.id;
 RETURN jsonb_build_object('stale',false,'inserted',inserted,'existing',existing);
END $$;

-- Known posts whose observation schedule asks for a snapshot today (plan §4.1): daily for the first 7 days, weekly to
-- day 30, fortnightly to day 90 when the window allows; posts past the window keep their last numbers. Age counts from
-- posted_at, or from when Graylum first saw the post when the platform gives no date.
CREATE OR REPLACE FUNCTION public.publish_monitor_refresh_due(p_connection_id uuid,p_lease uuid,p_refresh_id uuid,
 p_window_days integer,p_limit integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c social_connections; today date:=(clock_timestamp() AT TIME ZONE 'UTC')::date; out jsonb;
BEGIN
 IF p_window_days IS NULL OR p_window_days NOT BETWEEN 1 AND 365 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 c:=publish_monitor_refresh_current(p_connection_id,p_lease,p_refresh_id);
 IF c.id IS NULL THEN RETURN NULL; END IF;
 SELECT COALESCE(jsonb_agg(d.platform_post_id ORDER BY d.snapshot_day NULLS FIRST,d.age),'[]'::jsonb) INTO out FROM (
  SELECT p.platform_post_id,p.snapshot_day,today-(COALESCE(p.posted_at,p.created_at) AT TIME ZONE 'UTC')::date AS age
  FROM social_posts p WHERE p.connection_id=c.id AND p.source='postforme'
   AND (p.snapshot_day IS NULL OR p.snapshot_day<today)
 ) d
 WHERE d.age<=p_window_days AND (d.snapshot_day IS NULL
  OR (d.age<=7) OR (d.age<=30 AND d.snapshot_day<=today-7) OR (d.snapshot_day<=today-14))
 LIMIT p_limit;
 RETURN out;
END $$;

-- Settles one claimed refresh. Outcomes:
--  done / partial  read finished (partial: the daily page cap or time ran out; the cursor is kept for tomorrow)
--  empty           discovery's first page came back empty: never proof of "no posts" (plan §4.1 empty-list rules)
--  failed          provider 5xx, timeout or unreadable answer: old data kept, no more tries today
--  rejected        provider 4xx or the account is disconnected: the owner must re-authorise
--  taken_over      the account now carries another user's reference: quarantine and queue the provider disconnect
--  entitlement     the owner's plan has no data window: nothing read today
--  release         rate limit or the batch deadline: lease dropped, cursor kept, the next batch continues
-- Returns false when the lease is no longer current (nothing changes).
CREATE OR REPLACE FUNCTION public.publish_monitor_refresh_finish(p_connection_id uuid,p_lease uuid,p_refresh_id uuid,
 p_outcome text,p_error text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c social_connections; today date:=(clock_timestamp() AT TIME ZONE 'UTC')::date; had_posts boolean; streak integer;
BEGIN
 IF p_outcome IS NULL OR p_outcome NOT IN ('done','partial','empty','failed','rejected','taken_over','entitlement','release')
  OR (p_error IS NOT NULL AND p_error !~ '^[A-Z0-9_]{1,64}$') THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 c:=publish_monitor_refresh_current(p_connection_id,p_lease,p_refresh_id);
 IF c.id IS NULL THEN RETURN false; END IF;
 IF p_outcome='release' THEN
  UPDATE social_connections SET lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=c.id;
 ELSIF p_outcome IN ('done','partial') THEN
  UPDATE social_connections SET refresh_day=today,refresh_state=CASE p_outcome WHEN 'done' THEN 'ok' ELSE 'partial' END,
   refresh_error=NULL,last_success_at=clock_timestamp(),
   refresh_attempts=0,fail_day=NULL,empty_streak=0,empty_day=NULL,
   refresh_id=CASE WHEN p_outcome='done' THEN NULL ELSE refresh_id END,
   refresh_cursor=CASE WHEN p_outcome='done' THEN NULL ELSE refresh_cursor END,
   lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=c.id;
 ELSIF p_outcome='empty' THEN
  -- Counted once per UTC day, however often the user refreshes. A connection that has shown posts before and now
  -- reads empty two days running most likely lost its authorization; one that never showed posts gets a gentle
  -- prompt after seven days. Neither ever means "no posts this week".
  had_posts:=c.last_success_at IS NOT NULL AND EXISTS(SELECT 1 FROM social_posts WHERE connection_id=c.id);
  streak:=CASE WHEN c.empty_day=today THEN c.empty_streak WHEN c.empty_day=today-1 THEN c.empty_streak+1 ELSE 1 END;
  UPDATE social_connections SET empty_streak=LEAST(streak,1000),empty_day=today,refresh_day=today,refresh_error=NULL,
   refresh_attempts=0,fail_day=NULL,
   refresh_state=CASE WHEN had_posts THEN 'not_fetched' WHEN streak>=7 THEN 'reauth_suggested' ELSE 'no_posts_yet' END,
   status=CASE WHEN had_posts AND streak>=2 THEN 'reauth_required' ELSE status END,
   refresh_id=NULL,refresh_cursor=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=c.id;
 ELSIF p_outcome='failed' THEN
  -- Consecutive failed UTC days, counted once per day however often the job or the user retries; a day without a
  -- failure (done, partial, empty) breaks the run. Three in a row show "data update failed".
  streak:=CASE WHEN c.fail_day=today THEN c.refresh_attempts WHEN c.fail_day=today-1 THEN c.refresh_attempts+1 ELSE 1 END;
  UPDATE social_connections SET refresh_day=today,fail_day=today,refresh_attempts=LEAST(streak,1000),
   refresh_state=CASE WHEN streak>=3 THEN 'failed' ELSE 'not_fetched' END,refresh_error=COALESCE(p_error,'PROVIDER_FAILED'),
   lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=c.id;
 ELSIF p_outcome='rejected' THEN
  UPDATE social_connections SET status='reauth_required',refresh_day=today,refresh_state='not_fetched',
   refresh_error=COALESCE(p_error,'PROVIDER_REJECTED'),refresh_id=NULL,refresh_cursor=NULL,lease_owner=NULL,
   lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=c.id;
 ELSIF p_outcome='taken_over' THEN
  -- Same handling as a sweep or callback that proves a takeover (0265): stop everything and queue the disconnect.
  UPDATE social_connections SET status='quarantined',provider_disconnect_pending=true,deletion_attempts=0,
   refresh_day=today,refresh_state='not_fetched',refresh_error='PROVIDER_OWNER_CHANGED',refresh_id=NULL,refresh_cursor=NULL,
   lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=c.id;
 ELSE
  UPDATE social_connections SET refresh_day=today,refresh_state='entitlement',refresh_error=NULL,refresh_id=NULL,
   refresh_cursor=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=c.id;
 END IF;
 RETURN true;
END $$;

-- The user's own data inside their plan's window (plan §9 item 4: the server decides the window, not the page).
-- Dated posts count by posted_at; posts the platform gives no date for count from when Graylum first saw them and are
-- marked undated. Each post carries its latest snapshot inside the window; missing fields stay listed, never zero.
CREATE OR REPLACE FUNCTION public.publish_monitor_data(a uuid,p_window_days integer,p_connection_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE since timestamptz; today date:=(clock_timestamp() AT TIME ZONE 'UTC')::date; out jsonb;
BEGIN
 IF p_window_days IS NULL OR p_window_days NOT BETWEEN 1 AND 365 THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 IF NOT publish_monitor_actor_open(a) THEN RAISE EXCEPTION 'PUBLISH_MONITOR_ACCOUNT_CLOSED' USING ERRCODE='42501'; END IF;
 since:=clock_timestamp()-make_interval(days=>p_window_days);
 SELECT jsonb_build_object('windowDays',p_window_days,
  'connections',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',c.id,'platform',c.platform,'status',c.status,
    'lastSuccessAt',c.last_success_at,'refreshDay',c.refresh_day,'refreshState',c.refresh_state,
    'refreshError',c.refresh_error,'autoTrack',c.consent_auto_track,
    -- Two missed daily turns: show "data update delayed" (plan §8 backlog protection).
    'delayed',c.status='connected' AND c.consent_auto_track AND (c.last_success_at IS NULL
     OR c.last_success_at<clock_timestamp()-interval '2 days') AND (c.refresh_day IS NULL OR c.refresh_day<today-1),
    'manualRefreshAt',c.manual_refresh_at) ORDER BY c.created_at,c.id)
   FROM social_connections c WHERE c.actor_id=a AND c.role='own' AND c.status NOT IN ('deleting','pending_selection')
    AND (p_connection_id IS NULL OR c.id=p_connection_id)),'[]'::jsonb),
  'posts',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'connectionId',p.connection_id,'source',p.source,
    'url',p.post_url,'postedAt',p.posted_at,'postedAtSource',p.posted_at_source,'firstSeenAt',p.created_at,
    'titleExcerpt',p.title_excerpt,'workItemId',p.work_item_id,
    'latest',(SELECT jsonb_build_object('capturedOn',s.captured_on,'metrics',s.metrics,'missingFields',to_jsonb(s.missing_fields),
      'breakdowns',s.breakdowns)
     FROM social_metric_snapshots s WHERE s.post_id=p.id AND s.captured_on>=(since AT TIME ZONE 'UTC')::date
     ORDER BY s.captured_on DESC LIMIT 1)) ORDER BY COALESCE(p.posted_at,p.created_at) DESC,p.id)
   FROM (SELECT p.* FROM social_posts p JOIN social_connections c ON c.id=p.connection_id
    WHERE p.actor_id=a AND c.role='own' AND c.status NOT IN ('deleting','pending_selection')
     AND (p_connection_id IS NULL OR p.connection_id=p_connection_id)
     AND COALESCE(p.posted_at,p.created_at)>=since
    ORDER BY COALESCE(p.posted_at,p.created_at) DESC,p.id LIMIT 500) p),'[]'::jsonb)) INTO out;
 RETURN out;
END $$;

-- Daily snapshots of one post inside the window (trend view; 90 days for Gold, counted from the connection day).
CREATE OR REPLACE FUNCTION public.publish_monitor_post_history(a uuid,p_post_id uuid,p_window_days integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p social_posts; since date;
BEGIN
 IF p_post_id IS NULL OR p_window_days IS NULL OR p_window_days NOT BETWEEN 1 AND 365 THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 IF NOT publish_monitor_actor_open(a) THEN RAISE EXCEPTION 'PUBLISH_MONITOR_ACCOUNT_CLOSED' USING ERRCODE='42501'; END IF;
 since:=(clock_timestamp() AT TIME ZONE 'UTC')::date-p_window_days;
 SELECT q.* INTO p FROM social_posts q JOIN social_connections c ON c.id=q.connection_id
 WHERE q.id=p_post_id AND q.actor_id=a AND c.role='own' AND c.status NOT IN ('deleting','pending_selection')
  AND COALESCE(q.posted_at,q.created_at)>=clock_timestamp()-make_interval(days=>p_window_days);
 IF p.id IS NULL THEN RAISE EXCEPTION 'PUBLISH_MONITOR_POST_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 RETURN jsonb_build_object('postId',p.id,'snapshots',COALESCE((SELECT jsonb_agg(jsonb_build_object('capturedOn',s.captured_on,
   'metrics',s.metrics,'missingFields',to_jsonb(s.missing_fields),'source',s.source) ORDER BY s.captured_on)
  FROM social_metric_snapshots s WHERE s.post_id=p.id AND s.captured_on>=since),'[]'::jsonb));
END $$;

-- Links one of the user's posts to a content item (plan §9 item 20): only an item of the same user on the brand account
-- the connection belongs to; anything else is refused. NULL removes the link.
CREATE OR REPLACE FUNCTION public.publish_monitor_link_post(a uuid,p_post_id uuid,p_work_item_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p social_posts; c social_connections;
BEGIN
 IF p_post_id IS NULL THEN RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 PERFORM publish_monitor_actor(a);
 SELECT * INTO p FROM social_posts WHERE id=p_post_id AND actor_id=a FOR UPDATE;
 SELECT * INTO c FROM social_connections WHERE id=p.connection_id AND actor_id=a AND role='own'
  AND status NOT IN ('deleting','pending_selection');
 IF p.id IS NULL OR c.id IS NULL THEN RAISE EXCEPTION 'PUBLISH_MONITOR_POST_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 IF p_work_item_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM opc_items i JOIN artifact_projects ap ON ap.id=i.work_item_id
   WHERE i.work_item_id=p_work_item_id AND i.account_project_id=c.account_project_id AND ap.actor_id=a) THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_WORK_ITEM_MISMATCH' USING ERRCODE='42501'; END IF;
 UPDATE social_posts SET work_item_id=p_work_item_id,updated_at=clock_timestamp() WHERE id=p.id;
 RETURN jsonb_build_object('postId',p.id,'workItemId',p_work_item_id);
END $$;

-- Retention (plan §7): snapshots are kept at most 100 days (Gold's 90 plus margin). Bounded per call.
CREATE OR REPLACE FUNCTION public.publish_monitor_snapshot_prune(p_limit integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE n integer;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50000 THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 DELETE FROM social_metric_snapshots WHERE id IN (SELECT id FROM social_metric_snapshots
  WHERE captured_on<(clock_timestamp() AT TIME ZONE 'UTC')::date-100 ORDER BY captured_on LIMIT p_limit);
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN n;
END $$;

-- Manual import (plan §4.3, used by PR-3b): rows the user has already confirmed line by line (links with numbers typed
-- in, a table export after column mapping, or screenshot recognition after review). They attach to the brand account's
-- existing connection whatever its source, or to a new manual connection when the account has none, and are stored as
-- source 'manual' so they never merge with automatically read numbers. One manual snapshot per post per day.
-- p_rows: [{postKey,url,postedAt,titleExcerpt,metrics}]; postKey is the platform post ID, or the post link when the
-- platform ID is not known.
CREATE OR REPLACE FUNCTION public.publish_monitor_manual_import(a uuid,p_account_project_id uuid,p_origin text,p_rows jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE acct opc_accounts; c social_connections; item jsonb; pid uuid; is_new boolean;
 today date:=(clock_timestamp() AT TIME ZONE 'UTC')::date; inserted integer:=0; updated integer:=0; k text; val jsonb;
BEGIN
 IF p_account_project_id IS NULL OR p_origin IS NULL OR p_origin NOT IN ('link','table','screenshot')
  OR jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows) NOT BETWEEN 1 AND 200 THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 PERFORM publish_monitor_actor(a);
 SELECT * INTO acct FROM opc_accounts WHERE project_id=p_account_project_id AND actor_id=a AND business_id IS NOT NULL;
 IF acct.project_id IS NULL THEN RAISE EXCEPTION 'PUBLISH_MONITOR_ACCOUNT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 SELECT * INTO c FROM social_connections WHERE account_project_id=acct.project_id AND actor_id=a AND role='own'
  AND status IN ('connected','reauth_required','quarantined') FOR UPDATE;
 IF c.id IS NULL THEN
  INSERT INTO social_connections(actor_id,business_id,account_project_id,role,source,platform,status,consent_read)
  VALUES(a,acct.business_id,acct.project_id,'own','manual',acct.platform,'connected',true) RETURNING * INTO c;
 END IF;
 FOR item IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
  IF jsonb_typeof(item->'metrics') IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(item->'metrics'))>50
   OR char_length(item->>'postKey') NOT BETWEEN 1 AND 256 THEN
   RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  -- Only non-negative finite numbers under plain keys; a blank field is simply absent, never zero.
  FOR k,val IN SELECT * FROM jsonb_each(item->'metrics') LOOP
   IF k !~ '^[A-Za-z0-9_.]{1,96}$' OR jsonb_typeof(val)<>'number' OR (val::text)::numeric<0 THEN
    RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  END LOOP;
  INSERT INTO social_posts AS p(actor_id,connection_id,source,platform_post_id,post_url,posted_at,posted_at_source,
   title_excerpt,snapshot_day)
  VALUES(a,c.id,'manual',item->>'postKey',item->>'url',(item->>'postedAt')::timestamptz,
   CASE WHEN item->>'postedAt' IS NULL THEN NULL ELSE 'user' END,left(item->>'titleExcerpt',120),today)
  ON CONFLICT(connection_id,source,platform_post_id) DO UPDATE SET post_url=COALESCE(EXCLUDED.post_url,p.post_url),
   posted_at=COALESCE(EXCLUDED.posted_at,p.posted_at),
   posted_at_source=CASE WHEN EXCLUDED.posted_at IS NULL THEN p.posted_at_source ELSE 'user' END,
   title_excerpt=COALESCE(EXCLUDED.title_excerpt,p.title_excerpt),snapshot_day=today,updated_at=clock_timestamp()
  RETURNING p.id,(xmax=0) INTO pid,is_new;
  IF is_new THEN inserted:=inserted+1; ELSE updated:=updated+1; END IF;
  INSERT INTO social_metric_snapshots AS s(actor_id,connection_id,post_id,captured_on,source,metrics,evidence_ref)
  VALUES(a,c.id,pid,today,'manual',item->'metrics','manual:'||p_origin)
  ON CONFLICT(post_id,captured_on) WHERE post_id IS NOT NULL DO UPDATE SET captured_at=clock_timestamp(),
   metrics=EXCLUDED.metrics,evidence_ref=EXCLUDED.evidence_ref;
 END LOOP;
 RETURN jsonb_build_object('connectionId',c.id,'inserted',inserted,'updated',updated);
END $$;

-- Connecting Post for Me later to a brand account that so far only has manually imported data upgrades that manual
-- connection in place (its manual posts stay, still marked manual), instead of refusing the account as already
-- connected. Extends 0246's confirm in place: unique anchors fail closed, the marker keeps reapplication stable.
DO $confirm$
DECLARE source text; refuse text:=E'  IF target.id IS NOT NULL THEN RAISE EXCEPTION ''PUBLISH_MONITOR_TARGET_ALREADY_CONNECTED'' USING ERRCODE=''PT409''; END IF;\n';
 inserted text:=E'   true,p_auto_track,publish,publish)\n  RETURNING id INTO conn;\n';
BEGIN
 source:=pg_get_functiondef('public.publish_monitor_connect_confirm(uuid,uuid,text,boolean,jsonb)'::regprocedure);
 IF position('-- PUBLISH-MONITOR manual upgrade' IN source)=0 THEN
  IF length(source)-length(replace(source,refuse,''))<>length(refuse)
   OR length(source)-length(replace(source,inserted,''))<>length(inserted) THEN
   RAISE EXCEPTION 'PUBLISH_MONITOR_CONFIRM_SOURCE_MISMATCH'; END IF;
  source:=replace(source,refuse,E'  -- PUBLISH-MONITOR manual upgrade\n'
   ||E'  IF target.id IS NOT NULL AND target.source=''manual'' THEN\n'
   ||E'   UPDATE social_connections SET source=''postforme'',provider_account_id=p_provider_account_id,status=''connected'',\n'
   ||E'    consent_read=true,consent_auto_track=p_auto_track,consent_publish=publish,provider_can_publish=publish,\n'
   ||E'    updated_at=clock_timestamp() WHERE id=target.id RETURNING id INTO conn;\n'
   ||E'  ELSE\n'||refuse);
  source:=replace(source,inserted,inserted||E'  END IF;\n');
  EXECUTE source;
 END IF;
END $confirm$;

DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('publish_monitor_manual_import','publish_monitor_actor_open','publish_monitor_refresh_item',
   'publish_monitor_refresh_claim','publish_monitor_refresh_request','publish_monitor_refresh_current',
   'publish_monitor_refresh_page','publish_monitor_refresh_due','publish_monitor_refresh_finish','publish_monitor_data',
   'publish_monitor_post_history','publish_monitor_link_post','publish_monitor_snapshot_prune') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f);
  IF split_part(f::text,'(',1) NOT IN ('publish_monitor_actor_open','publish_monitor_refresh_item',
   'publish_monitor_refresh_current') THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f); END IF;
 END LOOP;
END $$;
COMMIT;
