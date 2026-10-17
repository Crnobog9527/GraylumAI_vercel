-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PUBLISH-MONITOR PR-5 (docs/launch/tasks/PUBLISH-MONITOR.md §2.1, §6, §9 items 7/8/17/18): one-click publishing.
-- Number 0274 assigned by the controller.
--
-- A publish job moves claimed -> dispatching -> (unknown) -> completed | failed, or claimed -> released:
--   claimed      the idempotency key, the request fingerprint, the global slots and the credit hold are taken; nothing
--                was sent. Only the same request (same key and fingerprint) can dispatch it before claim_expires_at;
--                afterwards the daily job releases the hold and the slots.
--   dispatching  set immediately before the single provider create call; from here the job is never sent again and
--                is only reconciled by querying the provider for external_id = job id (plan §6).
--   unknown      the create call had no definite answer, or some platforms have no result yet; hold and slots stay.
--                After 24 hours without a result the job waits for manual review (never released automatically).
-- Money: the hold is a legacy pre-deduct (atomic_pre_deduct / atomic_settle / atomic_refund, the same primitives a
-- BILL2 v1 run uses) of the upper bound for every target; it settles once, for the successful targets only.
-- The BILL2 PAYG run is not used: its scopes are positioning drafts and work items, and a tool call with an unknown
-- result settles at zero at its recovery deadline, while an unknown publish must keep its hold until reconciled.
-- Price: ceil(creditsPerUsd x multiplier x usdPerTarget x successes), rounded once per job (Owner 2026-10-13:
-- 0.01 USD per successful platform x 6 = 6 credits). It is frozen into the job at claim.
-- Slots: one counter row per Post for Me billing period (anchored at the subscription renewal date, not the calendar
-- month). It is a new table because account erasure deletes finished jobs, so a sum over jobs would undercount, and a
-- system_settings row is an admin-editable value, not a lockable counter. 80% raises an alert; the limit pauses.
--
-- Compatibility: additive. Old code never writes social_publish_jobs. Recovery: stop the feature switch, let the
-- daily job release claimed jobs, reconcile open ones by hand; the functions can be dropped without data loss.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE TABLE IF NOT EXISTS public.social_publish_quota_periods(
 period_start timestamptz PRIMARY KEY,
 period_end timestamptz NOT NULL,
 slot_limit integer NOT NULL CHECK(slot_limit BETWEEN 1 AND 10000000),
 used integer NOT NULL DEFAULT 0 CHECK(used>=0),
 reserved integer NOT NULL DEFAULT 0 CHECK(reserved>=0),
 alerted_at timestamptz,
 CHECK(period_end>period_start)
);
ALTER TABLE public.social_publish_quota_periods ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.social_publish_quota_periods FROM PUBLIC,anon,authenticated,service_role;

ALTER TABLE public.social_publish_jobs ADD COLUMN IF NOT EXISTS pre_deduct_id uuid REFERENCES public.billing_history(id);
ALTER TABLE public.social_publish_jobs ADD COLUMN IF NOT EXISTS price jsonb;
ALTER TABLE public.social_publish_jobs ADD COLUMN IF NOT EXISTS hold_credits integer;
ALTER TABLE public.social_publish_jobs ADD COLUMN IF NOT EXISTS charged_credits integer;
ALTER TABLE public.social_publish_jobs ADD COLUMN IF NOT EXISTS quota_period_start timestamptz
 REFERENCES public.social_publish_quota_periods(period_start);
ALTER TABLE public.social_publish_jobs ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz;
ALTER TABLE public.social_publish_jobs ADD COLUMN IF NOT EXISTS dispatched_at timestamptz;
ALTER TABLE public.social_publish_jobs ADD COLUMN IF NOT EXISTS next_check_at timestamptz;
ALTER TABLE public.social_publish_jobs ADD COLUMN IF NOT EXISTS check_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE public.social_publish_jobs ADD COLUMN IF NOT EXISTS manual_review boolean NOT NULL DEFAULT false;
ALTER TABLE public.social_publish_jobs ADD COLUMN IF NOT EXISTS lease uuid;
ALTER TABLE public.social_publish_jobs ADD COLUMN IF NOT EXISTS lease_until timestamptz;
ALTER TABLE public.social_publish_jobs ADD COLUMN IF NOT EXISTS error_code text;
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.social_publish_jobs'::regclass
  AND conname='social_publish_jobs_publish_check') THEN
  ALTER TABLE public.social_publish_jobs ADD CONSTRAINT social_publish_jobs_publish_check CHECK(
   (hold_credits IS NULL OR hold_credits>0) AND (charged_credits IS NULL OR charged_credits>=0)
   AND check_attempts BETWEEN 0 AND 1000 AND (error_code IS NULL OR error_code ~ '^[A-Z0-9_]{1,64}$')
   AND (lease IS NULL)=(lease_until IS NULL)
   AND (state NOT IN ('completed','failed','released') OR reserved_slots=0));
 END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS social_publish_jobs_pre_deduct ON public.social_publish_jobs(pre_deduct_id)
 WHERE pre_deduct_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS social_publish_jobs_provider_post ON public.social_publish_jobs(provider_post_id)
 WHERE provider_post_id IS NOT NULL;

-- Owner 2026-10-13: 0.01 USD per successful platform (10 USD / 1,000 posts) x multiplier 6, 100 credits per USD.
INSERT INTO public.system_settings(key,value)
VALUES('publish_monitor_publish_price','{"usdPerTarget":"0.01","multiplier":"6","creditsPerUsd":"100"}'::jsonb)
ON CONFLICT(key) DO NOTHING;
-- The slot limit and the subscription renewal anchor have no default: publishing stays closed until an admin records
-- the current Post for Me plan ({"limit":1000,"periodAnchor":"<renewal timestamp>"}, plan §6).

CREATE OR REPLACE FUNCTION public.publish_monitor_publish_price() RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
DECLARE p jsonb;d text:='^(0|[1-9][0-9]{0,5})(\.[0-9]{1,6})?$';
BEGIN
 SELECT value INTO p FROM system_settings WHERE key='publish_monitor_publish_price';
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR p-ARRAY['usdPerTarget','multiplier','creditsPerUsd']<>'{}'::jsonb
  OR coalesce(p->>'usdPerTarget','') !~ d OR coalesce(p->>'multiplier','') !~ d OR coalesce(p->>'creditsPerUsd','') !~ d
  OR (p->>'usdPerTarget')::numeric<=0 OR (p->>'multiplier')::numeric<=0 OR (p->>'creditsPerUsd')::numeric<=0 THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_PRICE_NOT_CONFIGURED' USING ERRCODE='22023';
 END IF;
 RETURN jsonb_build_object('usdPerTarget',p->>'usdPerTarget','multiplier',p->>'multiplier','creditsPerUsd',p->>'creditsPerUsd');
END $$;

-- Exact numeric, rounded up once for the whole job.
CREATE OR REPLACE FUNCTION public.publish_monitor_publish_credits(p jsonb,n integer) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT ceil((p->>'creditsPerUsd')::numeric*(p->>'multiplier')::numeric*(p->>'usdPerTarget')::numeric*n)::integer
$$;

-- The Post for Me billing period containing now: monthly from the configured renewal anchor, in UTC.
CREATE OR REPLACE FUNCTION public.publish_monitor_quota_period(OUT p_start timestamptz,OUT p_end timestamptz,
 OUT p_limit integer)
LANGUAGE plpgsql VOLATILE SET search_path=public,pg_temp AS $$
DECLARE cfg jsonb;anchor timestamp;now_utc timestamp:=clock_timestamp() AT TIME ZONE 'UTC';k integer;
BEGIN
 SELECT value INTO cfg FROM system_settings WHERE key='publish_monitor_publish_quota';
 IF jsonb_typeof(cfg) IS DISTINCT FROM 'object' OR coalesce(cfg->>'limit','') !~ '^[1-9][0-9]{0,6}$'
  OR jsonb_typeof(cfg->'periodAnchor') IS DISTINCT FROM 'string' THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_QUOTA_NOT_CONFIGURED' USING ERRCODE='22023';
 END IF;
 BEGIN anchor:=(cfg->>'periodAnchor')::timestamptz AT TIME ZONE 'UTC';
 EXCEPTION WHEN others THEN RAISE EXCEPTION 'PUBLISH_MONITOR_QUOTA_NOT_CONFIGURED' USING ERRCODE='22023'; END;
 IF anchor>now_utc THEN RAISE EXCEPTION 'PUBLISH_MONITOR_QUOTA_NOT_CONFIGURED' USING ERRCODE='22023'; END IF;
 k:=(extract(year FROM age(now_utc,anchor))*12+extract(month FROM age(now_utc,anchor)))::integer;
 -- Month arithmetic clips at month ends (Jan 31 + 1 month = Feb 28); step back when that overshoots now.
 WHILE anchor+make_interval(months=>k)>now_utc LOOP k:=k-1; END LOOP;
 WHILE anchor+make_interval(months=>k+1)<=now_utc LOOP k:=k+1; END LOOP;
 p_start:=(anchor+make_interval(months=>k)) AT TIME ZONE 'UTC';
 p_end:=(anchor+make_interval(months=>k+1)) AT TIME ZONE 'UTC';
 p_limit:=(cfg->>'limit')::integer;
END $$;

-- What a user may see of their own job: no request content (there is none stored), no provider identifiers.
CREATE OR REPLACE FUNCTION public.publish_monitor_publish_view(j social_publish_jobs) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('id',j.id,'state',j.state,'businessId',j.business_id,'workItemId',j.work_item_id,
  'targets',(SELECT coalesce(jsonb_agg(jsonb_build_object('connectionId',t->>'connectionId','platform',t->>'platform',
    'status',coalesce(j.results->(t->>'connectionId')->>'status','pending'),
    'url',j.results->(t->>'connectionId')->>'url') ORDER BY t->>'platform'),'[]'::jsonb)
   FROM jsonb_array_elements(j.targets) t),
  'holdCredits',j.hold_credits,'chargedCredits',j.charged_credits,'manualReview',j.manual_review,
  'errorCode',j.error_code,'createdAt',j.created_at,'updatedAt',j.updated_at)
$$;

-- Plan §6 / §9 items 8, 18: take the idempotency key, check every target, reserve slots and freeze credits, all in one
-- transaction and before any provider call. The same key with the same fingerprint returns the caller's own job; the
-- same key with another fingerprint is refused. Keys are scoped to the user, so nobody sees another user's job.
CREATE OR REPLACE FUNCTION public.publish_monitor_publish_claim(a uuid,p_key text,p_fingerprint text,p_business uuid,
 p_work_item uuid,p_connections uuid[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j social_publish_jobs;n integer;tg jsonb;price jsonb;hold integer;q record;per social_publish_quota_periods;
 balance integer;pre uuid;alert boolean:=false;
BEGIN
 PERFORM publish_monitor_actor(a);
 IF coalesce(p_key,'') !~ '^[A-Za-z0-9_-]{8,128}$' OR coalesce(p_fingerprint,'') !~ '^[0-9a-f]{64}$' OR p_business IS NULL
  OR p_connections IS NULL THEN RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 SELECT * INTO j FROM social_publish_jobs WHERE actor_id=a AND idempotency_key=p_key FOR UPDATE;
 IF j.id IS NOT NULL THEN
  IF j.request_fingerprint<>p_fingerprint THEN RAISE EXCEPTION 'PUBLISH_MONITOR_IDEMPOTENCY_MISMATCH' USING ERRCODE='23505'; END IF;
  RETURN publish_monitor_publish_view(j)||jsonb_build_object('replayed',true);
 END IF;
 n:=cardinality(p_connections);
 IF n NOT BETWEEN 1 AND 9 OR (SELECT count(DISTINCT x) FROM unnest(p_connections) x)<>n THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023';
 END IF;
 -- Plan §6: a user whose posts the provider keeps refusing waits before trying again (no trial and error loop).
 IF (SELECT count(*) FROM social_publish_jobs WHERE actor_id=a AND state='failed'
  AND error_code LIKE 'PUBLISH_MONITOR_PROVIDER_REJECTED%' AND updated_at>clock_timestamp()-interval '1 hour')>=5 THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_TOO_MANY_REJECTIONS' USING ERRCODE='53400';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM opc_businesses WHERE id=p_business AND actor_id=a) THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_TARGET_INVALID' USING ERRCODE='42501';
 END IF;
 -- The content item, when given, belongs to this user and to an account of this brand.
 IF p_work_item IS NOT NULL AND NOT EXISTS(SELECT 1 FROM opc_items i JOIN opc_accounts oa ON oa.project_id=i.account_project_id
  WHERE i.work_item_id=p_work_item AND oa.actor_id=a AND oa.business_id=p_business) THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_WORK_ITEM_INVALID' USING ERRCODE='42501';
 END IF;
 -- Every target: this user's own Post for Me connection on this brand's account for that platform, connected, with
 -- publishing consent and provider publishing access. One target per platform.
 SELECT coalesce(jsonb_agg(jsonb_build_object('connectionId',c.id::text,'platform',c.platform,
   'providerAccountId',c.provider_account_id) ORDER BY c.platform),'[]'::jsonb) INTO tg
 FROM social_connections c JOIN opc_accounts oa ON oa.project_id=c.account_project_id AND oa.actor_id=a
  AND oa.business_id=p_business AND oa.platform=c.platform
 WHERE c.id=ANY(p_connections) AND c.actor_id=a AND c.business_id=p_business AND c.role='own' AND c.source='postforme'
  AND c.status='connected' AND c.consent_publish AND c.provider_can_publish;
 IF jsonb_array_length(tg)<>n OR (SELECT count(DISTINCT t->>'platform') FROM jsonb_array_elements(tg) t)<>n THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_TARGET_INVALID' USING ERRCODE='42501';
 END IF;
 PERFORM 1 FROM social_connections WHERE id=ANY(p_connections) ORDER BY id FOR SHARE;
 price:=publish_monitor_publish_price();
 hold:=publish_monitor_publish_credits(price,n);
 SELECT * INTO q FROM publish_monitor_quota_period();
 INSERT INTO social_publish_quota_periods(period_start,period_end,slot_limit) VALUES(q.p_start,q.p_end,q.p_limit)
 ON CONFLICT(period_start) DO NOTHING;
 SELECT * INTO per FROM social_publish_quota_periods WHERE period_start=q.p_start FOR UPDATE;
 IF per.period_end<>q.p_end THEN RAISE EXCEPTION 'PUBLISH_MONITOR_QUOTA_NOT_CONFIGURED' USING ERRCODE='22023'; END IF;
 IF per.used+per.reserved+n>q.p_limit THEN RAISE EXCEPTION 'PUBLISH_MONITOR_QUOTA_EXHAUSTED' USING ERRCODE='53400'; END IF;
 SELECT credits INTO balance FROM profiles WHERE id=a;
 IF coalesce(balance,0)<hold THEN RAISE EXCEPTION 'PUBLISH_MONITOR_INSUFFICIENT_CREDITS' USING ERRCODE='53400'; END IF;
 INSERT INTO social_publish_jobs(actor_id,business_id,idempotency_key,request_fingerprint,work_item_id,targets,state,
  reserved_slots,price,hold_credits,quota_period_start,claim_expires_at)
 VALUES(a,p_business,p_key,p_fingerprint,p_work_item,tg,'claimed',n,price,hold,q.p_start,
  clock_timestamp()+interval '15 minutes') RETURNING * INTO j;
 SELECT pre_deduct_id INTO pre FROM atomic_pre_deduct(a,hold,'一键发布冻结',j.id);
 alert:=per.alerted_at IS NULL AND (per.used+per.reserved+n)*5>=q.p_limit*4;
 UPDATE social_publish_quota_periods SET reserved=reserved+n,slot_limit=q.p_limit,
  alerted_at=CASE WHEN alert THEN clock_timestamp() ELSE alerted_at END WHERE period_start=q.p_start;
 UPDATE social_publish_jobs SET pre_deduct_id=pre WHERE id=j.id RETURNING * INTO j;
 RETURN publish_monitor_publish_view(j)||jsonb_build_object('replayed',false,'quotaAlert',alert,
  'externalId',j.id,'claimExpiresAt',j.claim_expires_at);
END $$;

-- Ends a job that holds credits and slots: settles the hold for `successes` targets (or refunds it) and moves the
-- slots from reserved to used for the successes only. Caller holds the profile and job locks, in that order.
CREATE OR REPLACE FUNCTION public.publish_monitor_publish_close(j social_publish_jobs,successes integer,final_state text,
 code text) RETURNS social_publish_jobs
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE charged integer:=CASE WHEN successes>0 THEN publish_monitor_publish_credits(j.price,successes) ELSE 0 END;
BEGIN
 IF j.pre_deduct_id IS NOT NULL THEN
  IF charged>0 THEN
   PERFORM atomic_settle(j.actor_id,j.pre_deduct_id,LEAST(charged,j.hold_credits),
    jsonb_build_object('source','publish_monitor','publishJobId',j.id,'successfulTargets',successes),NULL);
  ELSE PERFORM atomic_refund(j.actor_id,j.pre_deduct_id,'一键发布未成功，冻结退回'); END IF;
 END IF;
 IF j.quota_period_start IS NOT NULL THEN
  UPDATE social_publish_quota_periods SET reserved=GREATEST(reserved-j.reserved_slots,0),used=used+successes
  WHERE period_start=j.quota_period_start;
 END IF;
 -- An erased user's job has no brand left: once it is settled nothing of it needs to remain (plan §7 step 2).
 IF j.business_id IS NULL THEN DELETE FROM social_publish_jobs WHERE id=j.id; j.state:=final_state; RETURN j; END IF;
 UPDATE social_publish_jobs SET state=final_state,reserved_slots=0,charged_credits=CASE WHEN charged>0 THEN LEAST(charged,
  j.hold_credits) END,error_code=coalesce(code,error_code),lease=NULL,lease_until=NULL,next_check_at=NULL,
  updated_at=clock_timestamp() WHERE id=j.id RETURNING * INTO j;
 RETURN j;
END $$;

-- Lock a job together with its owner's profile, profile first (same order as claim and atomic_settle).
CREATE OR REPLACE FUNCTION public.publish_monitor_publish_lock(p_job uuid) RETURNS social_publish_jobs
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE owner uuid;j social_publish_jobs;
BEGIN
 SELECT actor_id INTO owner FROM social_publish_jobs WHERE id=p_job;
 IF owner IS NULL THEN RAISE EXCEPTION 'PUBLISH_MONITOR_JOB_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 PERFORM 1 FROM profiles WHERE id=owner FOR UPDATE;
 SELECT * INTO j FROM social_publish_jobs WHERE id=p_job FOR UPDATE;
 RETURN j;
END $$;

-- Plan §9 item 17: the last step before the single provider call. Only the claiming user, only before the claim
-- expires, and only while every target is still connected with publishing consent; otherwise the hold is released.
-- p_observed is what the server just read from Post for Me for each target account
-- ({"<providerAccountId>":{"ownerRef":"<first half of external_id>"|null,"connected":bool}}, plan §4.1): an account now
-- carrying another owner's reference is a proven takeover (quarantined and queued for disconnect, as in the callback);
-- a disconnected or unreadable one just stops this job.
CREATE OR REPLACE FUNCTION public.publish_monitor_publish_dispatch(a uuid,p_job uuid,p_observed jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j social_publish_jobs;ok boolean;mine text;tgt jsonb;o jsonb;taken boolean:=false;
BEGIN
 PERFORM publish_monitor_actor(a);
 IF jsonb_typeof(p_observed) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023';
 END IF;
 SELECT * INTO j FROM social_publish_jobs WHERE id=p_job AND actor_id=a FOR UPDATE;
 IF j.id IS NULL THEN RAISE EXCEPTION 'PUBLISH_MONITOR_JOB_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 IF j.state<>'claimed' THEN RETURN publish_monitor_publish_view(j)||'{"dispatch":false}'::jsonb; END IF;
 IF j.claim_expires_at<=clock_timestamp() THEN
  j:=publish_monitor_publish_close(j,0,'released','PUBLISH_MONITOR_CLAIM_EXPIRED');
  RETURN publish_monitor_publish_view(j)||'{"dispatch":false}'::jsonb;
 END IF;
 SELECT count(*)=jsonb_array_length(j.targets) INTO ok FROM jsonb_array_elements(j.targets) t
  JOIN social_connections c ON c.id=(t->>'connectionId')::uuid AND c.actor_id=a AND c.business_id=j.business_id
   AND c.provider_account_id=t->>'providerAccountId' AND c.status='connected' AND c.consent_publish AND c.provider_can_publish;
 IF ok THEN
  SELECT provider_ref INTO mine FROM social_monitor_settings WHERE actor_id=a;
  FOR tgt IN SELECT * FROM jsonb_array_elements(j.targets) LOOP
   o:=p_observed->(tgt->>'providerAccountId');
   IF jsonb_typeof(o->'ownerRef')='string' AND mine IS NOT NULL AND o->>'ownerRef'<>mine THEN
    UPDATE social_connections SET status='quarantined',provider_disconnect_pending=true,deletion_attempts=0,lease_owner=NULL,
     lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=(tgt->>'connectionId')::uuid AND status='connected';
    taken:=true;
   ELSIF mine IS NULL OR o->'connected' IS DISTINCT FROM 'true'::jsonb OR o->>'ownerRef' IS DISTINCT FROM mine THEN
    ok:=false;
   END IF;
  END LOOP;
  IF taken THEN
   j:=publish_monitor_publish_close(j,0,'released','PUBLISH_MONITOR_ACCOUNT_OWNER_CHANGED');
   RETURN publish_monitor_publish_view(j)||'{"dispatch":false}'::jsonb;
  END IF;
 END IF;
 IF NOT ok THEN
  j:=publish_monitor_publish_close(j,0,'released','PUBLISH_MONITOR_TARGET_CHANGED');
  RETURN publish_monitor_publish_view(j)||'{"dispatch":false}'::jsonb;
 END IF;
 UPDATE social_publish_jobs SET state='dispatching',dispatched_at=clock_timestamp(),updated_at=clock_timestamp()
 WHERE id=j.id RETURNING * INTO j;
 RETURN publish_monitor_publish_view(j)||jsonb_build_object('dispatch',true,'externalId',j.id,
  'providerAccountIds',(SELECT jsonb_agg(t->>'providerAccountId' ORDER BY t->>'platform') FROM jsonb_array_elements(j.targets) t));
END $$;

-- Releases a job that was never sent ('claimed') or that the provider definitely refused (a synchronous 4xx while
-- 'dispatching'; plan §6): refund the hold and the slots. A job whose result is unknown is never released here.
CREATE OR REPLACE FUNCTION public.publish_monitor_publish_release(p_job uuid,p_code text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j social_publish_jobs;
BEGIN
 IF coalesce(p_code,'') !~ '^[A-Z0-9_]{1,64}$' THEN RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 j:=publish_monitor_publish_lock(p_job);
 IF j.state IN ('released','failed') THEN RETURN publish_monitor_publish_view(j); END IF;
 IF j.state NOT IN ('claimed','dispatching') OR j.provider_post_id IS NOT NULL OR j.results<>'{}'::jsonb THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_STATE_CONFLICT' USING ERRCODE='40001';
 END IF;
 j:=publish_monitor_publish_close(j,0,CASE WHEN j.state='claimed' THEN 'released' ELSE 'failed' END,p_code);
 RETURN publish_monitor_publish_view(j);
END $$;

-- No definite answer to the create call: keep everything and reconcile by external_id (plan §6).
CREATE OR REPLACE FUNCTION public.publish_monitor_publish_unknown(p_job uuid,p_code text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j social_publish_jobs;
BEGIN
 IF coalesce(p_code,'') !~ '^[A-Z0-9_]{1,64}$' THEN RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 j:=publish_monitor_publish_lock(p_job);
 IF j.state='dispatching' THEN
  UPDATE social_publish_jobs SET state='unknown',error_code=p_code,next_check_at=clock_timestamp()+interval '2 minutes',
   updated_at=clock_timestamp() WHERE id=j.id RETURNING * INTO j;
 END IF;
 RETURN publish_monitor_publish_view(j);
END $$;

-- Records what the provider reports for this job: its post id and per-target results
-- ({"<connectionId>":{"status":"published"|"failed","url":...}}; missing targets are still pending). A final result never
-- changes; a contradicting one is refused. When every target is final the job settles once (plan §6, §9 item 7).
CREATE OR REPLACE FUNCTION public.publish_monitor_publish_record(p_job uuid,p_provider_post_id text,p_results jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j social_publish_jobs;merged jsonb;k text;r jsonb;old jsonb;pending integer;successes integer;
BEGIN
 IF jsonb_typeof(p_results) IS DISTINCT FROM 'object'
  OR (p_provider_post_id IS NOT NULL AND p_provider_post_id !~ '^[A-Za-z0-9_-]{1,128}$') THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023';
 END IF;
 j:=publish_monitor_publish_lock(p_job);
 IF j.state IN ('claimed','released') THEN RAISE EXCEPTION 'PUBLISH_MONITOR_STATE_CONFLICT' USING ERRCODE='40001'; END IF;
 IF p_provider_post_id IS NOT NULL AND j.provider_post_id IS NOT NULL AND j.provider_post_id<>p_provider_post_id THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_RESULT_CONFLICT' USING ERRCODE='40001';
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
  IF old IS NOT NULL AND old->>'status'<>r->>'status' THEN RAISE EXCEPTION 'PUBLISH_MONITOR_RESULT_CONFLICT' USING ERRCODE='40001'; END IF;
  IF old IS NULL THEN merged:=merged||jsonb_build_object(k,r); END IF;
 END LOOP;
 IF j.state IN ('completed','failed') THEN
  IF merged<>j.results THEN RAISE EXCEPTION 'PUBLISH_MONITOR_RESULT_CONFLICT' USING ERRCODE='40001'; END IF;
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
 END IF;
 RETURN publish_monitor_publish_view(j);
END $$;

-- Webhook social.post.result.created (plan §4.1): a shortcut into the same idempotent record path. A result for an
-- unknown post or account changes nothing; polling by external_id stays authoritative.
CREATE OR REPLACE FUNCTION public.publish_monitor_publish_webhook_result(p_provider_post_id text,p_provider_account_id text,
 p_success boolean,p_url text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j social_publish_jobs;target text;
BEGIN
 SELECT * INTO j FROM social_publish_jobs WHERE provider_post_id=p_provider_post_id;
 IF j.id IS NULL OR j.state NOT IN ('dispatching','unknown') OR p_success IS NULL THEN RETURN false; END IF;
 SELECT t->>'connectionId' INTO target FROM jsonb_array_elements(j.targets) t WHERE t->>'providerAccountId'=p_provider_account_id;
 IF target IS NULL OR j.results ? target THEN RETURN false; END IF;
 PERFORM publish_monitor_publish_record(j.id,p_provider_post_id,jsonb_build_object(target,
  jsonb_strip_nulls(jsonb_build_object('status',CASE WHEN p_success THEN 'published' ELSE 'failed' END,
   'url',CASE WHEN p_success AND p_url ~ '^https://' AND char_length(p_url)<=2048 THEN p_url END))));
 RETURN true;
END $$;

-- Daily job (plan §6, §9 item 17): expired claims are released; dispatched jobs without a final result are checked
-- against the provider by external_id. A job dispatched more than 5 minutes ago that never reached 'unknown' (the
-- process died during the call) is checked the same way. Leased so two batches never work the same job.
-- p_release_only: without a provider key the daily job can still release expired claims (database only); jobs that
-- need a provider check are then not handed out at all.
CREATE OR REPLACE FUNCTION public.publish_monitor_publish_reconcile_claim(p_limit integer,p_lease_seconds integer,
 p_release_only boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE out jsonb;
BEGIN
 IF p_limit NOT BETWEEN 1 AND 200 OR p_lease_seconds NOT BETWEEN 30 AND 900 THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023';
 END IF;
 WITH due AS (
  SELECT id FROM social_publish_jobs WHERE (lease_until IS NULL OR lease_until<=clock_timestamp()) AND NOT manual_review
   AND ((state='claimed' AND claim_expires_at<=clock_timestamp())
    OR (NOT coalesce(p_release_only,false) AND state='unknown' AND next_check_at<=clock_timestamp())
    OR (NOT coalesce(p_release_only,false) AND state='dispatching'
     AND coalesce(dispatched_at,updated_at)<=clock_timestamp()-interval '5 minutes'))
  ORDER BY updated_at,id LIMIT p_limit FOR UPDATE SKIP LOCKED),
 leased AS (
  UPDATE social_publish_jobs j SET lease=gen_random_uuid(),lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds)
  FROM due WHERE j.id=due.id RETURNING j.*)
 SELECT coalesce(jsonb_agg(jsonb_build_object('jobId',l.id,'lease',l.lease,
  'action',CASE WHEN l.state='claimed' THEN 'release' ELSE 'check' END,'externalId',l.id,'providerPostId',l.provider_post_id,
  'targets',(SELECT jsonb_agg(jsonb_build_object('connectionId',t->>'connectionId','providerAccountId',t->>'providerAccountId'))
   FROM jsonb_array_elements(l.targets) t)) ORDER BY l.updated_at,l.id),'[]'::jsonb) INTO out FROM leased l;
 RETURN out;
END $$;

-- A check found nothing final (or could not ask): back off; after 24 hours stop and wait for a person (plan §6: not
-- finding the post is no evidence it was not sent). Holds and slots stay.
CREATE OR REPLACE FUNCTION public.publish_monitor_publish_check_later(p_job uuid,p_lease uuid,p_code text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j social_publish_jobs;manual boolean;
BEGIN
 IF coalesce(p_code,'') !~ '^[A-Z0-9_]{1,64}$' THEN RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 j:=publish_monitor_publish_lock(p_job);
 IF j.lease IS DISTINCT FROM p_lease OR j.state NOT IN ('dispatching','unknown') THEN RETURN publish_monitor_publish_view(j); END IF;
 manual:=coalesce(j.dispatched_at,j.created_at)<=clock_timestamp()-interval '24 hours';
 UPDATE social_publish_jobs SET state='unknown',error_code=p_code,check_attempts=LEAST(check_attempts+1,1000),
  manual_review=manual,lease=NULL,lease_until=NULL,
  next_check_at=CASE WHEN manual THEN NULL ELSE clock_timestamp()
   +LEAST(interval '4 hours',interval '2 minutes'*power(2,LEAST(check_attempts,8))) END,
  updated_at=clock_timestamp() WHERE id=j.id RETURNING * INTO j;
 RETURN publish_monitor_publish_view(j)||jsonb_build_object('manualReview',manual);
END $$;

-- Releases a reconcile lease after a 'release' or a successful record, so the row is free for the next batch.
CREATE OR REPLACE FUNCTION public.publish_monitor_publish_unlease(p_job uuid,p_lease uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 UPDATE social_publish_jobs SET lease=NULL,lease_until=NULL WHERE id=p_job AND lease=p_lease
$$;

-- Manual review (plan §6): an admin who checked the Post for Me dashboard and the platforms records either that the
-- post was never sent (hold and slots released) or the per-target results (settled as usual).
CREATE OR REPLACE FUNCTION public.publish_monitor_publish_manual_resolve(p_admin uuid,p_job uuid,p_not_sent boolean,
 p_results jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j social_publish_jobs;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_admin AND role='admin' AND status='active' AND is_deleted::text='false') THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_ADMIN_REQUIRED' USING ERRCODE='42501';
 END IF;
 j:=publish_monitor_publish_lock(p_job);
 IF j.state NOT IN ('dispatching','unknown') THEN RAISE EXCEPTION 'PUBLISH_MONITOR_STATE_CONFLICT' USING ERRCODE='40001'; END IF;
 IF p_not_sent THEN
  IF j.results<>'{}'::jsonb THEN RAISE EXCEPTION 'PUBLISH_MONITOR_RESULT_CONFLICT' USING ERRCODE='40001'; END IF;
  j:=publish_monitor_publish_close(j,0,'failed','PUBLISH_MONITOR_MANUAL_NOT_SENT');
 ELSE
  PERFORM publish_monitor_publish_record(p_job,NULL,p_results);
  SELECT * INTO j FROM social_publish_jobs WHERE id=p_job;
  IF j.id IS NULL THEN RETURN '{"state":"settled"}'::jsonb; END IF;
 END IF;
 INSERT INTO user_activity_logs(admin_id,action,action_type,details)
 VALUES(p_admin,'publish_monitor_manual_resolve','admin',jsonb_build_object('jobId',p_job,'notSent',p_not_sent));
 RETURN publish_monitor_publish_view(j);
END $$;

CREATE OR REPLACE FUNCTION public.publish_monitor_publish_job(a uuid,p_job uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j social_publish_jobs;
BEGIN
 SELECT * INTO j FROM social_publish_jobs WHERE id=p_job AND actor_id=a;
 IF j.id IS NULL THEN RAISE EXCEPTION 'PUBLISH_MONITOR_JOB_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 RETURN publish_monitor_publish_view(j);
END $$;

-- Server-only lookups for one of the user's own jobs: the provider account of each target (to check its owner before
-- dispatch) and what reconciling needs. Never part of the user view.
CREATE OR REPLACE FUNCTION public.publish_monitor_publish_targets(a uuid,p_job uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j social_publish_jobs;
BEGIN
 SELECT * INTO j FROM social_publish_jobs WHERE id=p_job AND actor_id=a;
 IF j.id IS NULL THEN RAISE EXCEPTION 'PUBLISH_MONITOR_JOB_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 RETURN jsonb_build_object('providerAccountIds',(SELECT jsonb_agg(t->>'providerAccountId' ORDER BY t->>'platform')
  FROM jsonb_array_elements(j.targets) t));
END $$;

CREATE OR REPLACE FUNCTION public.publish_monitor_publish_check_info(a uuid,p_job uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j social_publish_jobs;
BEGIN
 SELECT * INTO j FROM social_publish_jobs WHERE id=p_job AND actor_id=a;
 IF j.id IS NULL THEN RAISE EXCEPTION 'PUBLISH_MONITOR_JOB_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 RETURN jsonb_build_object('jobId',j.id,'providerPostId',j.provider_post_id,
  'targets',(SELECT jsonb_agg(jsonb_build_object('connectionId',t->>'connectionId','providerAccountId',t->>'providerAccountId'))
   FROM jsonb_array_elements(j.targets) t));
END $$;

DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('publish_monitor_publish_price','publish_monitor_publish_credits',
   'publish_monitor_quota_period','publish_monitor_publish_view','publish_monitor_publish_claim','publish_monitor_publish_close',
   'publish_monitor_publish_lock','publish_monitor_publish_dispatch','publish_monitor_publish_release',
   'publish_monitor_publish_unknown','publish_monitor_publish_record','publish_monitor_publish_webhook_result',
   'publish_monitor_publish_reconcile_claim','publish_monitor_publish_check_later','publish_monitor_publish_unlease',
   'publish_monitor_publish_manual_resolve','publish_monitor_publish_job','publish_monitor_publish_targets',
   'publish_monitor_publish_check_info') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f);
  -- Helpers stay internal; only the entry points are callable by the server.
  IF split_part(f::text,'(',1) NOT IN ('publish_monitor_publish_price','publish_monitor_publish_credits',
   'publish_monitor_quota_period','publish_monitor_publish_view','publish_monitor_publish_close','publish_monitor_publish_lock') THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f); END IF;
 END LOOP;
END $$;
COMMIT;
