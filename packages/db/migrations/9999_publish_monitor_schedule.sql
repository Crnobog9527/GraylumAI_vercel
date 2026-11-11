-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PUBLISH-SCHEDULE PR-1 (Owner 2026-11-11, Master Plan 2.1: the publish schedule must be complete before launch; plan in
-- docs/launch/tasks/PUBLISH-SCHEDULE.md). Placeholder number 9999: the controller assigns the real number before applying.
--
-- A scheduled publish is a one-click publish job whose provider post carries scheduled_at (Post for Me publishes it at
-- that time). It reuses social_publish_jobs, the hold, the slots, the result recording and the reconciliation:
--   claimed -> (schedule_prepare: time, preview, media count) -> dispatching -> scheduled -> unknown/completed/failed
--   scheduled -> released (cancelled before the time; the hold and slots return in full)
--   scheduled    Post for Me accepted the post with a future time. Changes are refused from 10 minutes before the
--                time (Post for Me picks due posts every 2 minutes and its update re-creates the post, so a change
--                near the time could publish twice). A cron step checks each job (schedule_claim): 40 minutes before
--                the time the targets, the account and the membership; on a cancel request it deletes the provider post.
--   cancel_reason a cancellation was decided (user, target changed, account closed, membership ended). If the post goes
--                out anyway (decided inside the lock window), nothing is charged (publish_close).
-- Slots are reserved in the Post for Me billing period of the scheduled time (publish_monitor_quota_period_at), because
-- the provider counts a post when it is sent. Credits are held at claim as today and settle on the per-target results.
-- caption_preview (at most 40 characters of the caption) is kept for the schedule view; erasure clears it.
--
-- Compatibility: additive for old code. Claim, dispatch, release and unknown are unchanged; the view gains fields (the
--   TypeScript schema passes extra fields through); record, webhook_result and close change only for scheduled rows or
--   rows with cancel_reason, which old code never creates. New code calls the new functions, so apply this migration
--   before the code is deployed.
-- Repeatable: ADD COLUMN IF NOT EXISTS, constraints dropped and re-added, CREATE OR REPLACE, CREATE INDEX IF NOT EXISTS.
-- Recovery: cancel open scheduled posts first (the schedule page or schedule_begin/finish), then re-apply the earlier
--   definitions from packages/db/functions/ at the staging commit before this migration. The new columns can stay
--   (nothing reads them then); the widened state check can stay while no row is 'scheduled'.
BEGIN;
SET LOCAL lock_timeout='5s';

ALTER TABLE public.social_publish_jobs ADD COLUMN IF NOT EXISTS scheduled_at timestamptz;
ALTER TABLE public.social_publish_jobs ADD COLUMN IF NOT EXISTS caption_preview text;
ALTER TABLE public.social_publish_jobs ADD COLUMN IF NOT EXISTS media_count smallint;
ALTER TABLE public.social_publish_jobs ADD COLUMN IF NOT EXISTS preflight_at timestamptz;
ALTER TABLE public.social_publish_jobs ADD COLUMN IF NOT EXISTS cancel_reason text;

ALTER TABLE public.social_publish_jobs DROP CONSTRAINT IF EXISTS social_publish_jobs_state_check;
ALTER TABLE public.social_publish_jobs ADD CONSTRAINT social_publish_jobs_state_check
 CHECK(state IN ('claimed','dispatching','scheduled','unknown','completed','failed','released'));
ALTER TABLE public.social_publish_jobs DROP CONSTRAINT IF EXISTS social_publish_jobs_check;
ALTER TABLE public.social_publish_jobs ADD CONSTRAINT social_publish_jobs_check
 CHECK(state IN ('claimed','dispatching','scheduled','unknown') OR business_id IS NOT NULL);
ALTER TABLE public.social_publish_jobs DROP CONSTRAINT IF EXISTS social_publish_jobs_schedule_check;
ALTER TABLE public.social_publish_jobs ADD CONSTRAINT social_publish_jobs_schedule_check CHECK(
 (caption_preview IS NULL OR char_length(caption_preview) BETWEEN 1 AND 40)
 AND (media_count IS NULL OR media_count BETWEEN 0 AND 10)
 AND (cancel_reason IS NULL OR cancel_reason ~ '^[A-Z0-9_]{1,64}$')
 AND (state<>'scheduled' OR (scheduled_at IS NOT NULL AND provider_post_id IS NOT NULL)));
CREATE INDEX IF NOT EXISTS social_publish_jobs_scheduled ON public.social_publish_jobs(next_check_at,id)
 WHERE state='scheduled';
CREATE INDEX IF NOT EXISTS social_publish_jobs_calendar
 ON public.social_publish_jobs(actor_id,(coalesce(scheduled_at,dispatched_at,created_at)));

-- The Post for Me billing period containing p_at (same rule as publish_monitor_quota_period, which uses now).
CREATE OR REPLACE FUNCTION public.publish_monitor_quota_period_at(p_at timestamptz,
 OUT p_start timestamptz,OUT p_end timestamptz,OUT p_limit integer)
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE cfg jsonb;anchor timestamp;at_utc timestamp:=p_at AT TIME ZONE 'UTC';k integer;
BEGIN
 IF p_at IS NULL THEN RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 SELECT value INTO cfg FROM system_settings WHERE key='publish_monitor_publish_quota';
 IF jsonb_typeof(cfg) IS DISTINCT FROM 'object' OR coalesce(cfg->>'limit','') !~ '^[1-9][0-9]{0,6}$'
  OR jsonb_typeof(cfg->'periodAnchor') IS DISTINCT FROM 'string' THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_QUOTA_NOT_CONFIGURED' USING ERRCODE='22023';
 END IF;
 BEGIN anchor:=(cfg->>'periodAnchor')::timestamptz AT TIME ZONE 'UTC';
 EXCEPTION WHEN others THEN RAISE EXCEPTION 'PUBLISH_MONITOR_QUOTA_NOT_CONFIGURED' USING ERRCODE='22023'; END;
 IF anchor>at_utc THEN RAISE EXCEPTION 'PUBLISH_MONITOR_QUOTA_NOT_CONFIGURED' USING ERRCODE='22023'; END IF;
 k:=(extract(year FROM age(at_utc,anchor))*12+extract(month FROM age(at_utc,anchor)))::integer;
 WHILE anchor+make_interval(months=>k)>at_utc LOOP k:=k-1; END LOOP;
 WHILE anchor+make_interval(months=>k+1)<=at_utc LOOP k:=k+1; END LOOP;
 p_start:=(anchor+make_interval(months=>k)) AT TIME ZONE 'UTC';
 p_end:=(anchor+make_interval(months=>k+1)) AT TIME ZONE 'UTC';
 p_limit:=(cfg->>'limit')::integer;
END $$;

-- Moves a job's reserved slots to the period of p_at (caller holds the job row). With p_check the target period must
-- have room; without it (the provider already moved the post) the move is recorded as it is.
CREATE OR REPLACE FUNCTION public.publish_monitor_schedule_move_slots(j social_publish_jobs,p_at timestamptz,p_check boolean)
RETURNS timestamptz LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE q record;tgt social_publish_quota_periods;
BEGIN
 SELECT * INTO q FROM publish_monitor_quota_period_at(p_at);
 IF j.quota_period_start IS NULL OR q.p_start=j.quota_period_start THEN RETURN j.quota_period_start; END IF;
 INSERT INTO social_publish_quota_periods(period_start,period_end,slot_limit) VALUES(q.p_start,q.p_end,q.p_limit)
 ON CONFLICT(period_start) DO NOTHING;
 PERFORM 1 FROM social_publish_quota_periods WHERE period_start IN (j.quota_period_start,q.p_start)
  ORDER BY period_start FOR UPDATE;
 SELECT * INTO tgt FROM social_publish_quota_periods WHERE period_start=q.p_start;
 IF p_check AND tgt.period_end<>q.p_end THEN RAISE EXCEPTION 'PUBLISH_MONITOR_QUOTA_NOT_CONFIGURED' USING ERRCODE='22023'; END IF;
 IF p_check AND tgt.used+tgt.reserved+j.reserved_slots>q.p_limit THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_QUOTA_EXHAUSTED' USING ERRCODE='53400';
 END IF;
 UPDATE social_publish_quota_periods SET reserved=GREATEST(reserved-j.reserved_slots,0) WHERE period_start=j.quota_period_start;
 UPDATE social_publish_quota_periods SET reserved=reserved+j.reserved_slots,slot_limit=q.p_limit WHERE period_start=q.p_start;
 UPDATE social_publish_jobs SET quota_period_start=q.p_start WHERE id=j.id;
 RETURN q.p_start;
END $$;

CREATE OR REPLACE FUNCTION public.publish_monitor_publish_view(j social_publish_jobs)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('id',j.id,'state',j.state,'businessId',j.business_id,'workItemId',j.work_item_id,
  'targets',(SELECT coalesce(jsonb_agg(jsonb_build_object('connectionId',t->>'connectionId','platform',t->>'platform',
    'status',coalesce(j.results->(t->>'connectionId')->>'status','pending'),
    'url',j.results->(t->>'connectionId')->>'url') ORDER BY t->>'platform'),'[]'::jsonb)
   FROM jsonb_array_elements(j.targets) t),
  'holdCredits',j.hold_credits,'chargedCredits',j.charged_credits,'manualReview',j.manual_review,
  'errorCode',j.error_code,'createdAt',j.created_at,'updatedAt',j.updated_at,
  'scheduledAt',j.scheduled_at,'dispatchedAt',j.dispatched_at,'captionPreview',j.caption_preview,
  'cancelReason',j.cancel_reason)
$$;

-- A job with cancel_reason is not charged even if its post went out (the decision came inside the lock window).
CREATE OR REPLACE FUNCTION public.publish_monitor_publish_close(j social_publish_jobs,successes integer,final_state text,code text)
RETURNS social_publish_jobs LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE charged integer:=CASE WHEN successes>0 AND j.cancel_reason IS NULL THEN publish_monitor_publish_credits(j.price,successes)
 ELSE 0 END;
BEGIN
 IF j.pre_deduct_id IS NOT NULL THEN
  IF charged>0 THEN
   PERFORM atomic_settle(j.actor_id,j.pre_deduct_id,LEAST(charged,j.hold_credits),
    jsonb_build_object('source','publish_monitor','publishJobId',j.id,'successfulTargets',successes),NULL);
  ELSE PERFORM atomic_refund(j.actor_id,j.pre_deduct_id,CASE WHEN j.cancel_reason IS NOT NULL
   THEN '定时发布已取消，冻结退回' ELSE '一键发布未成功，冻结退回' END); END IF;
 END IF;
 IF j.quota_period_start IS NOT NULL THEN
  UPDATE social_publish_quota_periods SET reserved=GREATEST(reserved-j.reserved_slots,0),used=used+successes
  WHERE period_start=j.quota_period_start;
 END IF;
 -- An erased user's job has no brand left: once it is settled nothing of it needs to remain (plan §7 step 2).
 IF j.business_id IS NULL THEN DELETE FROM social_publish_jobs WHERE id=j.id; j.state:=final_state; RETURN j; END IF;
 UPDATE social_publish_jobs SET state=final_state,reserved_slots=0,charged_credits=CASE WHEN charged>0 THEN LEAST(charged,
  j.hold_credits) END,error_code=coalesce(code,CASE WHEN successes>0 AND j.cancel_reason IS NOT NULL
   THEN 'PUBLISH_SCHEDULE_SENT_AFTER_CANCEL' END,error_code),lease=NULL,lease_until=NULL,next_check_at=NULL,
  updated_at=clock_timestamp() WHERE id=j.id RETURNING * INTO j;
 RETURN j;
END $$;

-- Results of a scheduled job arrive once Post for Me sends it; partial results move it to "unknown" like a dispatch.
CREATE OR REPLACE FUNCTION public.publish_monitor_publish_record(p_job uuid,p_provider_post_id text,p_results jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j social_publish_jobs;merged jsonb;k text;r jsonb;old jsonb;pending integer;successes integer;
BEGIN
 IF jsonb_typeof(p_results) IS DISTINCT FROM 'object'
  OR (p_provider_post_id IS NOT NULL AND p_provider_post_id !~ '^[A-Za-z0-9_-]{1,128}$') THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023';
 END IF;
 j:=publish_monitor_publish_lock(p_job);
 IF j.state IN ('claimed','released') THEN RAISE EXCEPTION 'PUBLISH_MONITOR_STATE_CONFLICT' USING ERRCODE='PT409'; END IF;
 IF p_provider_post_id IS NOT NULL AND j.provider_post_id IS NOT NULL AND j.provider_post_id<>p_provider_post_id THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_RESULT_CONFLICT' USING ERRCODE='PT409';
 END IF;
 merged:=j.results;
 FOR k,r IN SELECT * FROM jsonb_each(p_results) LOOP
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(j.targets) t WHERE t->>'connectionId'=k)
   OR jsonb_typeof(r) IS DISTINCT FROM 'object' OR r-ARRAY['status','url']<>'{}'::jsonb
   OR coalesce(r->>'status','') NOT IN ('published','failed')
   OR (r ? 'url' AND (jsonb_typeof(r->'url') IS DISTINCT FROM 'string' OR char_length(r->>'url') NOT BETWEEN 1 AND 2048
    OR r->>'url' !~ '^https://')) THEN
   RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023';
  END IF;
  old:=merged->k;
  IF old IS NOT NULL AND old->>'status'<>r->>'status' THEN RAISE EXCEPTION 'PUBLISH_MONITOR_RESULT_CONFLICT' USING ERRCODE='PT409'; END IF;
  IF old IS NULL THEN merged:=merged||jsonb_build_object(k,r); END IF;
 END LOOP;
 IF j.state IN ('completed','failed') THEN
  IF merged<>j.results THEN RAISE EXCEPTION 'PUBLISH_MONITOR_RESULT_CONFLICT' USING ERRCODE='PT409'; END IF;
  RETURN publish_monitor_publish_view(j);
 END IF;
 UPDATE social_publish_jobs SET results=merged,provider_post_id=coalesce(provider_post_id,p_provider_post_id),
  updated_at=clock_timestamp() WHERE id=j.id RETURNING * INTO j;
 SELECT count(*) FILTER (WHERE j.results->(t->>'connectionId') IS NULL),
  count(*) FILTER (WHERE j.results->(t->>'connectionId')->>'status'='published')
 INTO pending,successes FROM jsonb_array_elements(j.targets) t;
 IF pending=0 THEN
  j:=publish_monitor_publish_close(j,successes,CASE WHEN successes>0 THEN 'completed' ELSE 'failed' END,NULL);
 ELSIF j.state='dispatching' THEN
  UPDATE social_publish_jobs SET state='unknown',next_check_at=clock_timestamp()+interval '2 minutes',
   updated_at=clock_timestamp() WHERE id=j.id RETURNING * INTO j;
 ELSIF j.state='scheduled' AND j.results<>'{}'::jsonb THEN
  -- It was sent: from now on it is reconciled like a dispatched job, counting the 24 hours from the scheduled time.
  UPDATE social_publish_jobs SET state='unknown',dispatched_at=LEAST(j.scheduled_at,clock_timestamp()),
   next_check_at=clock_timestamp()+interval '2 minutes',check_attempts=0,updated_at=clock_timestamp()
  WHERE id=j.id RETURNING * INTO j;
 END IF;
 RETURN publish_monitor_publish_view(j);
END $$;

CREATE OR REPLACE FUNCTION public.publish_monitor_publish_webhook_result(p_provider_post_id text,p_provider_account_id text,
 p_success boolean,p_url text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j social_publish_jobs;target text;
BEGIN
 SELECT * INTO j FROM social_publish_jobs WHERE provider_post_id=p_provider_post_id;
 IF j.id IS NULL OR j.state NOT IN ('dispatching','scheduled','unknown') OR p_success IS NULL THEN RETURN false; END IF;
 SELECT t->>'connectionId' INTO target FROM jsonb_array_elements(j.targets) t WHERE t->>'providerAccountId'=p_provider_account_id;
 IF target IS NULL OR j.results ? target THEN RETURN false; END IF;
 PERFORM publish_monitor_publish_record(j.id,p_provider_post_id,jsonb_build_object(target,
  jsonb_strip_nulls(jsonb_build_object('status',CASE WHEN p_success THEN 'published' ELSE 'failed' END,
   'url',CASE WHEN p_success AND p_url ~ '^https://' AND char_length(p_url)<=2048 THEN p_url END))));
 RETURN true;
END $$;

-- Open jobs (now including scheduled ones) keep their connection record and survive erasure until they settle.
CREATE OR REPLACE FUNCTION public.publish_monitor_erasure_scrub(a uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE n integer; total integer:=0;
BEGIN
 PERFORM account_erasure_assert_closed(a);
 -- Posts and snapshots go first through the prune loop; detach retained rows from the brand now. Deletion is a new
 -- cleanup episode (as in publish_monitor_disconnect): it must not inherit an exhausted takeover-disconnect retry count.
 UPDATE social_connections SET status='deleting',business_id=NULL,account_project_id=NULL,display_hint=NULL,
  profile_ref=NULL,consent_read=false,consent_auto_track=false,consent_publish=false,refresh_id=NULL,
  refresh_cursor=NULL,lease_owner=NULL,lease_expires_at=NULL,deletion_attempts=0,deletion_error=NULL,
  updated_at=clock_timestamp()
 WHERE actor_id=a AND provider_account_id IS NOT NULL AND status<>'deleting';
 GET DIAGNOSTICS n=ROW_COUNT;total:=total+n;
 UPDATE social_publish_jobs SET business_id=NULL,work_item_id=NULL,caption_preview=NULL,updated_at=clock_timestamp()
 WHERE actor_id=a AND state IN ('claimed','dispatching','scheduled','unknown')
  AND (business_id IS NOT NULL OR work_item_id IS NOT NULL OR caption_preview IS NOT NULL);
 GET DIAGNOSTICS n=ROW_COUNT;total:=total+n;
 UPDATE social_connect_requests SET business_id=NULL,target_account_project_id=NULL
 WHERE actor_id=a AND (state IN ('awaiting_callback','pending_confirm') OR cleaned_at IS NULL
   OR created_at>clock_timestamp()-interval '30 days')
  AND (business_id IS NOT NULL OR target_account_project_id IS NOT NULL);
 GET DIAGNOSTICS n=ROW_COUNT;total:=total+n;
 RETURN total;
END $$;

CREATE OR REPLACE FUNCTION public.publish_monitor_erasure_remaining(a uuid)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT (SELECT count(*) FROM social_monitor_settings WHERE actor_id=a)
 +(SELECT count(*) FROM social_review_runs WHERE actor_id=a)
 +(SELECT count(*) FROM social_metric_snapshots WHERE actor_id=a)
 +(SELECT count(*) FROM social_posts WHERE actor_id=a)
 +(SELECT count(*) FROM social_connections WHERE actor_id=a AND provider_account_id IS NULL)
 +(SELECT count(*) FROM social_connections WHERE actor_id=a AND provider_account_id IS NOT NULL
   AND (status<>'deleting' OR business_id IS NOT NULL))
 +(SELECT count(*) FROM social_publish_jobs WHERE actor_id=a
   AND (state NOT IN ('claimed','dispatching','scheduled','unknown') OR business_id IS NOT NULL OR caption_preview IS NOT NULL))
 +(SELECT count(*) FROM social_connect_requests WHERE actor_id=a
   AND (business_id IS NOT NULL OR target_account_project_id IS NOT NULL
    OR NOT (state IN ('awaiting_callback','pending_confirm') OR cleaned_at IS NULL
     OR created_at>clock_timestamp()-interval '30 days')))
 -- 0457: removed with their posts, review runs and brands (ON DELETE CASCADE); counted so erasure waits for them.
 +(SELECT count(*) FROM social_post_facts WHERE actor_id=a)
 +(SELECT count(*) FROM social_post_diagnostics WHERE actor_id=a)
 +(SELECT count(*) FROM social_review_experiments WHERE actor_id=a)
 +(SELECT count(*) FROM social_coach_profiles WHERE actor_id=a)
$$;

CREATE OR REPLACE FUNCTION public.publish_monitor_erasure_retained(t text,j jsonb)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT CASE t
  WHEN 'social_connections' THEN j->>'provider_account_id' IS NOT NULL
  -- Open jobs hold frozen credits and publish slots: kept until publishing releases or settles them (plan §9 item 17).
  WHEN 'social_publish_jobs' THEN j->>'state' IN ('claimed','dispatching','scheduled','unknown')
  WHEN 'social_connect_requests' THEN j->>'state' IN ('awaiting_callback','pending_confirm') OR j->>'cleaned_at' IS NULL
   OR (j->>'created_at')::timestamptz>clock_timestamp()-interval '30 days'
  ELSE false END
$$;

CREATE OR REPLACE FUNCTION public.publish_monitor_provider_work_claim(p_limit integer,p_lease_seconds integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE now_at timestamptz:=clock_timestamp(); lease uuid:=gen_random_uuid(); out jsonb;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 900 THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 WITH candidates AS (
  SELECT c.id,c.updated_at,c.status,c.provider_tokens_cleared,c.provider_disconnect_pending,
   EXISTS(SELECT 1 FROM social_publish_jobs j WHERE j.actor_id=c.actor_id
    AND j.state IN ('claimed','dispatching','scheduled','unknown')
    AND j.targets @> jsonb_build_array(jsonb_build_object('connectionId',c.id::text))) AS publishes_open
  FROM social_connections c
  WHERE c.source='postforme' AND (c.status='deleting' OR c.provider_disconnect_pending) AND c.deletion_attempts<50
   AND (c.lease_expires_at IS NULL OR c.lease_expires_at<=now_at)
 ), picked AS (
  SELECT c.id FROM social_connections c JOIN candidates k ON k.id=c.id
  -- A held record waits for its publishes, unless a new takeover was queued on it since its tokens were cleared.
  WHERE NOT (k.status='deleting' AND k.publishes_open AND k.provider_tokens_cleared AND NOT k.provider_disconnect_pending)
  ORDER BY k.updated_at LIMIT p_limit FOR UPDATE OF c SKIP LOCKED
 ), claimed AS (
  -- Attempts are counted when a result is reported (provider_work_finish), not when claimed.
  UPDATE social_connections c SET lease_owner=lease,lease_expires_at=now_at+make_interval(secs=>p_lease_seconds)
  FROM picked WHERE c.id=picked.id
  RETURNING c.id,c.actor_id,c.provider_account_id,c.status,c.owner_ref,c.provider_disconnect_pending
 )
 SELECT COALESCE(jsonb_agg(jsonb_build_object('connectionId',claimed.id,'lease',lease,
  'providerAccountId',claimed.provider_account_id,
  'deleting',claimed.status='deleting','takeoverPending',claimed.provider_disconnect_pending,
  'action',CASE WHEN claimed.status<>'deleting' OR k.publishes_open THEN 'disconnect' ELSE 'delete' END,
  'ownerRef',CASE WHEN claimed.status='deleting' THEN claimed.owner_ref
   ELSE (SELECT provider_ref FROM social_monitor_settings s WHERE s.actor_id=claimed.actor_id) END) ORDER BY k.updated_at),
  '[]'::jsonb) INTO out FROM claimed JOIN candidates k ON k.id=claimed.id;
 RETURN out;
END $$;

CREATE OR REPLACE FUNCTION public.publish_monitor_provider_work_finish(p_connection_id uuid,p_lease uuid,p_outcome text,p_error text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c social_connections;
BEGIN
 IF p_connection_id IS NULL OR p_lease IS NULL
  OR p_outcome NOT IN ('deleted','gone','owner_changed','disconnected','owner_back','retry')
  OR (p_error IS NOT NULL AND p_error !~ '^[A-Z0-9_]{1,64}$') THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 SELECT * INTO c FROM social_connections WHERE id=p_connection_id FOR UPDATE;
 IF c.id IS NULL THEN RETURN; END IF;
 -- Queueing a takeover clears the lease, so a worker that claimed before it reports a stale outcome: the record and
 -- its pending disconnect stay for the next run.
 IF c.lease_owner IS DISTINCT FROM p_lease THEN RETURN; END IF;
 -- Unresolved publishes still need this record to reconcile: hold it instead of ending it.
 IF c.status='deleting' AND p_outcome IN ('deleted','gone','owner_changed') AND EXISTS(SELECT 1 FROM social_publish_jobs j
   WHERE j.actor_id=c.actor_id AND j.state IN ('claimed','dispatching','scheduled','unknown')
    AND j.targets @> jsonb_build_array(jsonb_build_object('connectionId',c.id::text))) THEN
  UPDATE social_connections SET provider_tokens_cleared=true,provider_disconnect_pending=false,deletion_error=NULL,
   deletion_attempts=0,lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=c.id;
  RETURN;
 END IF;
 IF p_outcome IN ('deleted','gone','owner_changed') AND c.status='deleting' THEN
  -- Nothing references a deleting row: its posts and snapshots were removed when it entered 'deleting'.
  DELETE FROM social_connections WHERE id=c.id;
 ELSIF p_outcome='disconnected' AND c.status='deleting' THEN
  -- Held for unresolved publishes: tokens (including any overwriting takeover grant) are cleared, the record stays.
  UPDATE social_connections SET provider_tokens_cleared=true,provider_disconnect_pending=false,deletion_error=NULL,
   deletion_attempts=0,lease_owner=NULL,
   lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=c.id;
 ELSIF p_outcome IN ('deleted','gone','disconnected','owner_back') AND c.provider_disconnect_pending THEN
  -- A settled takeover starts the next episode with a fresh retry allowance.
  UPDATE social_connections SET provider_disconnect_pending=false,deletion_error=NULL,deletion_attempts=0,lease_owner=NULL,
   lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=c.id;
 ELSE
  UPDATE social_connections SET deletion_error=COALESCE(p_error,'PROVIDER_RETRY'),
   deletion_attempts=LEAST(deletion_attempts+1,1000),lease_owner=NULL,lease_expires_at=NULL,
   updated_at=clock_timestamp() WHERE id=c.id;
 END IF;
END $$;

-- After the claim and before dispatch: the scheduled time (NULL publishes now), the caption preview and the media
-- count of this request. The fingerprint already binds them; a replay must repeat the same values.
CREATE OR REPLACE FUNCTION public.publish_monitor_schedule_prepare(a uuid,p_job uuid,p_scheduled_at timestamptz,
 p_preview text,p_media_count integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j social_publish_jobs;prev text;
BEGIN
 IF a IS NULL OR p_job IS NULL OR p_media_count IS NULL OR p_media_count NOT BETWEEN 0 AND 10 THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 prev:=nullif(left(btrim(regexp_replace(coalesce(p_preview,''),'\s+',' ','g')),40),'');
 -- Lock order job -> quota periods (as in publish_close); the account is checked without a profile lock.
 SELECT * INTO j FROM social_publish_jobs WHERE id=p_job AND actor_id=a FOR UPDATE;
 IF j.id IS NULL THEN RAISE EXCEPTION 'PUBLISH_MONITOR_JOB_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 IF j.media_count IS NOT NULL OR j.state<>'claimed' THEN
  IF j.scheduled_at IS DISTINCT FROM p_scheduled_at OR j.media_count IS DISTINCT FROM p_media_count::smallint THEN
   RAISE EXCEPTION 'PUBLISH_MONITOR_IDEMPOTENCY_MISMATCH' USING ERRCODE='23505'; END IF;
  RETURN publish_monitor_publish_view(j);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=a AND status='active' AND is_deleted::text='false')
  OR EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=a) THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_ACCOUNT_CLOSED' USING ERRCODE='42501'; END IF;
 IF p_scheduled_at IS NOT NULL THEN
  IF p_scheduled_at<clock_timestamp()+interval '15 minutes' OR p_scheduled_at>clock_timestamp()+interval '30 days' THEN
   RAISE EXCEPTION 'PUBLISH_SCHEDULE_TIME_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM publish_monitor_schedule_move_slots(j,p_scheduled_at,true);
 END IF;
 UPDATE social_publish_jobs SET scheduled_at=p_scheduled_at,caption_preview=prev,media_count=p_media_count,
  updated_at=clock_timestamp() WHERE id=j.id RETURNING * INTO j;
 RETURN publish_monitor_publish_view(j);
END $$;

-- Post for Me accepted the post with a future time (create answer, or found by external_id after an unknown create).
CREATE OR REPLACE FUNCTION public.publish_monitor_schedule_accepted(p_job uuid,p_provider_post_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j social_publish_jobs;
BEGIN
 IF coalesce(p_provider_post_id,'') !~ '^[A-Za-z0-9_-]{1,128}$' THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 j:=publish_monitor_publish_lock(p_job);
 IF j.provider_post_id IS NOT NULL AND j.provider_post_id<>p_provider_post_id THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_RESULT_CONFLICT' USING ERRCODE='PT409'; END IF;
 IF j.scheduled_at IS NULL OR j.state NOT IN ('dispatching','unknown') OR j.results<>'{}'::jsonb THEN
  RETURN publish_monitor_publish_view(j)||jsonb_build_object('accepted',j.state='scheduled');
 END IF;
 UPDATE social_publish_jobs SET state='scheduled',provider_post_id=p_provider_post_id,error_code=NULL,check_attempts=0,
  next_check_at=GREATEST(clock_timestamp(),j.scheduled_at-interval '40 minutes'),lease=NULL,lease_until=NULL,
  updated_at=clock_timestamp() WHERE id=j.id RETURNING * INTO j;
 RETURN publish_monitor_publish_view(j)||'{"accepted":true}'::jsonb;
END $$;

-- The user's jobs whose time (scheduled, else sent, else created) falls in [p_from, p_to), at most 43 days, 500 rows.
CREATE OR REPLACE FUNCTION public.publish_monitor_schedule_list(a uuid,p_from timestamptz,p_to timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE out jsonb;
BEGIN
 IF a IS NULL OR p_from IS NULL OR p_to IS NULL OR p_to<=p_from OR p_to-p_from>interval '43 days' THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 SELECT coalesce(jsonb_agg(publish_monitor_publish_view(s.j)||jsonb_build_object('at',s.at) ORDER BY s.at,(s.j).id),
  '[]'::jsonb) INTO out
 FROM (SELECT j,coalesce(j.scheduled_at,j.dispatched_at,j.created_at) AS at FROM social_publish_jobs j
  WHERE j.actor_id=a AND j.state<>'claimed' AND coalesce(j.scheduled_at,j.dispatched_at,j.created_at)>=p_from
   AND coalesce(j.scheduled_at,j.dispatched_at,j.created_at)<p_to
  ORDER BY coalesce(j.scheduled_at,j.dispatched_at,j.created_at),j.id LIMIT 500) s;
 RETURN out;
END $$;

-- The user starts a cancel or a reschedule: a short lease on the job while the server talks to Post for Me. A cancel is
-- recorded at once (cancel_reason), so a request that dies here is finished by the cron step.
CREATE OR REPLACE FUNCTION public.publish_monitor_schedule_begin(a uuid,p_job uuid,p_action text,p_expected_at timestamptz,
 p_new_at timestamptz,p_lease_seconds integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j social_publish_jobs;q record;per social_publish_quota_periods;lease_id uuid:=gen_random_uuid();
BEGIN
 IF p_job IS NULL OR p_action IS NULL OR p_action NOT IN ('cancel','reschedule') OR p_expected_at IS NULL
  OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 300 OR (p_action='reschedule' AND p_new_at IS NULL) THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 PERFORM publish_monitor_actor(a);
 SELECT * INTO j FROM social_publish_jobs WHERE id=p_job AND actor_id=a FOR UPDATE;
 IF j.id IS NULL THEN RAISE EXCEPTION 'PUBLISH_MONITOR_JOB_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 IF j.state<>'scheduled' THEN RAISE EXCEPTION 'PUBLISH_SCHEDULE_NOT_SCHEDULED' USING ERRCODE='PT409'; END IF;
 IF j.cancel_reason IS NOT NULL THEN
  IF p_action='cancel' THEN RETURN publish_monitor_publish_view(j)||'{"lease":null}'::jsonb; END IF;
  RAISE EXCEPTION 'PUBLISH_SCHEDULE_CANCELLING' USING ERRCODE='PT409';
 END IF;
 IF j.lease IS NOT NULL AND j.lease_until>clock_timestamp() THEN
  RAISE EXCEPTION 'PUBLISH_SCHEDULE_BUSY' USING ERRCODE='PT409'; END IF;
 IF j.scheduled_at<>p_expected_at THEN RAISE EXCEPTION 'PUBLISH_SCHEDULE_CHANGED' USING ERRCODE='PT409'; END IF;
 IF clock_timestamp()>=j.scheduled_at-interval '10 minutes' THEN
  RAISE EXCEPTION 'PUBLISH_SCHEDULE_LOCKED' USING ERRCODE='PT409'; END IF;
 IF p_action='reschedule' THEN
  IF p_new_at<clock_timestamp()+interval '15 minutes' OR p_new_at>clock_timestamp()+interval '30 days'
   OR p_new_at=j.scheduled_at THEN
   RAISE EXCEPTION 'PUBLISH_SCHEDULE_TIME_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO q FROM publish_monitor_quota_period_at(p_new_at);
  IF q.p_start<>j.quota_period_start THEN
   SELECT * INTO per FROM social_publish_quota_periods WHERE period_start=q.p_start;
   IF coalesce(per.used,0)+coalesce(per.reserved,0)+j.reserved_slots>q.p_limit THEN
    RAISE EXCEPTION 'PUBLISH_MONITOR_QUOTA_EXHAUSTED' USING ERRCODE='53400'; END IF;
  END IF;
 END IF;
 UPDATE social_publish_jobs SET lease=lease_id,lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),
  cancel_reason=CASE WHEN p_action='cancel' THEN 'PUBLISH_SCHEDULE_CANCELLED' ELSE cancel_reason END,
  next_check_at=CASE WHEN p_action='cancel' THEN clock_timestamp() ELSE next_check_at END,updated_at=clock_timestamp()
 WHERE id=j.id RETURNING * INTO j;
 RETURN publish_monitor_publish_view(j)||jsonb_build_object('lease',j.lease,'providerPostId',j.provider_post_id,
  'mediaCount',j.media_count,'providerAccountIds',(SELECT jsonb_agg(t->>'providerAccountId' ORDER BY t->>'platform')
   FROM jsonb_array_elements(j.targets) t));
END $$;

-- Cron step: scheduled jobs that are due (next_check_at), plus any whose targets or account stopped being usable; for
-- those the cancellation reason is recorded here, so a post sent inside the lock window is not charged.
CREATE OR REPLACE FUNCTION public.publish_monitor_schedule_claim(p_limit integer,p_lease_seconds integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE out jsonb;now_at timestamptz:=clock_timestamp();
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 900 THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 WITH cand AS (
  SELECT j.id,
   (SELECT count(*)=jsonb_array_length(j.targets) FROM jsonb_array_elements(j.targets) t
    JOIN social_connections c ON c.id=(t->>'connectionId')::uuid AND c.actor_id=j.actor_id AND c.business_id=j.business_id
     AND c.provider_account_id=t->>'providerAccountId' AND c.status='connected' AND c.consent_publish
     AND c.provider_can_publish) AS targets_ok,
   (EXISTS(SELECT 1 FROM profiles p WHERE p.id=j.actor_id AND p.status='active' AND p.is_deleted::text='false')
    AND NOT EXISTS(SELECT 1 FROM account_erasure_requests r WHERE r.profile_id=j.actor_id)) AS actor_ok
  FROM social_publish_jobs j
  WHERE j.state='scheduled' AND NOT j.manual_review AND (j.lease_until IS NULL OR j.lease_until<=now_at)
 ), due AS (
  SELECT j.id,k.targets_ok,k.actor_ok FROM social_publish_jobs j JOIN cand k ON k.id=j.id
  WHERE j.next_check_at<=now_at OR (j.cancel_reason IS NULL AND NOT (k.targets_ok AND k.actor_ok))
  ORDER BY j.next_check_at NULLS FIRST,j.id LIMIT p_limit FOR UPDATE OF j SKIP LOCKED
 ), leased AS (
  UPDATE social_publish_jobs j SET lease=gen_random_uuid(),lease_until=now_at+make_interval(secs=>p_lease_seconds),
   cancel_reason=coalesce(j.cancel_reason,CASE WHEN NOT d.actor_ok THEN 'PUBLISH_SCHEDULE_ACCOUNT_CLOSED'
    WHEN NOT d.targets_ok THEN 'PUBLISH_SCHEDULE_TARGET_CHANGED' END),
   next_check_at=CASE WHEN j.cancel_reason IS NULL AND NOT (d.targets_ok AND d.actor_ok) THEN now_at ELSE j.next_check_at END
  FROM due d WHERE j.id=d.id RETURNING j.*)
 SELECT coalesce(jsonb_agg(jsonb_build_object('jobId',l.id,'lease',l.lease,'actorId',l.actor_id,
  'providerPostId',l.provider_post_id,'scheduledAt',l.scheduled_at,'mediaCount',l.media_count,
  'cancelReason',l.cancel_reason,'preflightDone',l.preflight_at IS NOT NULL,
  'providerAccountIds',(SELECT jsonb_agg(t->>'providerAccountId' ORDER BY t->>'platform') FROM jsonb_array_elements(l.targets) t))
  ORDER BY l.next_check_at,l.id),'[]'::jsonb) INTO out FROM leased l;
 RETURN out;
END $$;

-- Ends one leased step on a scheduled job (user request or cron). A stale lease or a job that left "scheduled" (a
-- webhook result arrived meanwhile) changes nothing.
--   cancelled  the provider post is gone: release the hold and slots in full
--   moved      the provider post now has time p_at (slots follow it to that billing period)
--   kept       nothing changed; next check at p_at
--   checked    the pre-send check passed; next check at p_at
--   mark       record cancel_reason p_code (decided inside the lock window, so the post may still go out); next at p_at
--   started    Post for Me is sending or has sent it: reconcile the results like a dispatched job (p_code, when given,
--              is a cancellation decided too late: kept as cancel_reason so the post is not charged)
--   later      the provider could not be read; back off (manual review 24 hours after the scheduled time)
CREATE OR REPLACE FUNCTION public.publish_monitor_schedule_finish(p_job uuid,p_lease uuid,p_outcome text,p_at timestamptz,
 p_code text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j social_publish_jobs;manual boolean;
BEGIN
 IF p_job IS NULL OR p_lease IS NULL OR p_outcome IS NULL
  OR p_outcome NOT IN ('cancelled','moved','kept','checked','mark','started','later')
  OR (p_code IS NOT NULL AND p_code !~ '^[A-Z0-9_]{1,64}$')
  OR (p_outcome IN ('moved','kept','checked','mark') AND p_at IS NULL) OR (p_outcome='mark' AND p_code IS NULL) THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 j:=publish_monitor_publish_lock(p_job);
 IF j.lease IS DISTINCT FROM p_lease OR j.state<>'scheduled' THEN
  RETURN publish_monitor_publish_view(j)||'{"stale":true}'::jsonb; END IF;
 IF p_outcome='cancelled' THEN
  UPDATE social_publish_jobs SET cancel_reason=coalesce(cancel_reason,p_code,'PUBLISH_SCHEDULE_CANCELLED')
  WHERE id=j.id RETURNING * INTO j;
  j:=publish_monitor_publish_close(j,0,'released',j.cancel_reason);
 ELSIF p_outcome='moved' THEN
  PERFORM publish_monitor_schedule_move_slots(j,p_at,false);
  UPDATE social_publish_jobs SET scheduled_at=p_at,next_check_at=GREATEST(clock_timestamp(),p_at-interval '40 minutes'),
   preflight_at=NULL,error_code=NULL,check_attempts=0,lease=NULL,lease_until=NULL,updated_at=clock_timestamp()
  WHERE id=j.id RETURNING * INTO j;
 ELSIF p_outcome IN ('kept','checked','mark') THEN
  UPDATE social_publish_jobs SET next_check_at=p_at,lease=NULL,lease_until=NULL,
   preflight_at=CASE WHEN p_outcome='checked' THEN clock_timestamp() ELSE preflight_at END,
   cancel_reason=CASE WHEN p_outcome='mark' THEN coalesce(cancel_reason,p_code) ELSE cancel_reason END,
   error_code=CASE WHEN p_outcome='kept' THEN p_code ELSE error_code END,updated_at=clock_timestamp()
  WHERE id=j.id RETURNING * INTO j;
 ELSIF p_outcome='started' THEN
  UPDATE social_publish_jobs SET state='unknown',dispatched_at=LEAST(j.scheduled_at,clock_timestamp()),
   next_check_at=clock_timestamp()+interval '2 minutes',check_attempts=0,lease=NULL,lease_until=NULL,
   cancel_reason=coalesce(cancel_reason,p_code),updated_at=clock_timestamp() WHERE id=j.id RETURNING * INTO j;
 ELSE
  manual:=clock_timestamp()>j.scheduled_at+interval '24 hours';
  UPDATE social_publish_jobs SET error_code=coalesce(p_code,'PUBLISH_SCHEDULE_CHECK_FAILED'),
   check_attempts=LEAST(check_attempts+1,1000),manual_review=manual,lease=NULL,lease_until=NULL,
   next_check_at=CASE WHEN manual THEN NULL ELSE clock_timestamp()
    +LEAST(interval '30 minutes',interval '2 minutes'*power(2,LEAST(check_attempts,4))) END,
   updated_at=clock_timestamp() WHERE id=j.id RETURNING * INTO j;
 END IF;
 RETURN publish_monitor_publish_view(j);
END $$;

DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('publish_monitor_quota_period_at','publish_monitor_schedule_move_slots',
   'publish_monitor_schedule_prepare','publish_monitor_schedule_accepted','publish_monitor_schedule_list',
   'publish_monitor_schedule_begin','publish_monitor_schedule_claim','publish_monitor_schedule_finish') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f);
  -- Helpers stay internal; only the entry points are callable by the server.
  IF split_part(f::text,'(',1) NOT IN ('publish_monitor_quota_period_at','publish_monitor_schedule_move_slots') THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f); END IF;
 END LOOP;
END $$;
COMMIT;
