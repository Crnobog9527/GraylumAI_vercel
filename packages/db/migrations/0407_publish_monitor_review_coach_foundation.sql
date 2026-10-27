-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PUBLISH-MONITOR (operations-coach review, RC-1; Owner decisions 2026-10-27 in MASTER_PLAN 2.1):
-- the coach's memory and the scheduling base it needs.
--   * social_coach_profiles: per brand, the confirmed positioning version, content pillars and a pillar-mix target.
--     Stage is not stored here: it stays opc_accounts.stage (per platform account), and a strategy check remembers
--     the stages it last saw.
--   * social_post_facts: per post, the settled day-7 / day-30 values (or the earliest cumulative value when a post
--     was first seen after day 7) and its pillar. Unlike daily snapshots these are never pruned after 100 days.
--   * social_review_experiments: the ledger (hypothesis -> action -> metric -> verdict), reviewed next time.
--   * social_post_diagnostics: per post, the confirmed back-office rates and opening text for the funnel diagnosis.
--   * social_review_runs: brand, cadence, attempt and the fixed review pack; a unique key per brand and cadence.
--   * publish_monitor_review_step: an interrupted review (RUNTIME_INTERRUPTED with a closed bill) is retried with a
--     new request id, at most three attempts, instead of losing the week (defect seen on staging 2026-10-26). All
--     attempts share the review's cost cap: the earlier attempt's known actual cost is subtracted, and an attempt
--     whose cost is still unknown is not retried (BILL2 recovery owns it, as before).
--   * publish_monitor_review_claim: unchanged unless system setting publish_monitor_coach_enabled is true; then one
--     review per brand, weekly / monthly (28 days) / quarterly (91 days or a stage change, recorded only when that
--     check completes, so a skipped check is scheduled again). The coach output carries
--     businessId, cadence and attempt, which only the coach-aware app (RC-3) accepts: turn the setting on after it.
--   * publish_monitor_settle_facts(limit) and publish_monitor_review_pack_rows(actor, brand, weeks): database-only
--     batch and one-round-trip read for the host-built review pack. Nothing calls them until RC-3.
-- Erasure: every new row hangs off social_posts, social_review_runs or opc_businesses with ON DELETE CASCADE, so the
-- existing prune order removes it; publish_monitor_erasure_remaining counts the new tables.
-- Compatibility: old code keeps working. The claim output is byte-for-byte the old shape while the coach setting is
-- off; step returns the same fields; new columns have defaults; old rows read as weekly, attempt 1, no brand.
-- Repeatability: IF NOT EXISTS / CREATE OR REPLACE / guarded constraint changes; applying twice changes nothing.
-- Recovery: restore the previous claim, step and erasure_remaining from packages/db/tests/publish-monitor-coach/
-- rollback-0407.sql and leave the new tables and columns in place (nothing old reads them); review rows, BILL2 runs
-- and journals are never rewritten, so any pending financial recovery is unaffected.
BEGIN;

CREATE TABLE IF NOT EXISTS public.social_coach_profiles(
 actor_id uuid NOT NULL,
 business_id uuid NOT NULL,
 strategy_version_id uuid,
 -- [{key,name,definition}] 0-6 items; keys never change once given (renames keep the key).
 pillars jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(pillars)='array' AND jsonb_array_length(pillars)<=6),
 pillars_source text CHECK(pillars_source IN ('extracted','user')),
 pillar_mix_target jsonb CHECK(pillar_mix_target IS NULL OR jsonb_typeof(pillar_mix_target)='object'),
 -- opc_accounts.stage of the brand's accounts when the last strategy check was scheduled.
 strategy_check_stages jsonb CHECK(strategy_check_stages IS NULL OR jsonb_typeof(strategy_check_stages)='object'),
 strategy_checked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(actor_id,business_id),
 FOREIGN KEY(actor_id,business_id) REFERENCES public.opc_businesses(actor_id,id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.social_post_facts(
 post_id uuid PRIMARY KEY,
 actor_id uuid NOT NULL,
 connection_id uuid NOT NULL,
 business_id uuid,
 platform text NOT NULL CHECK(platform ~ '^[a-z0-9_-]{1,32}$'),
 posted_at timestamptz NOT NULL,
 pillar_key text CHECK(pillar_key ~ '^[a-z0-9_]{1,16}$'),
 pillar_source text CHECK(pillar_source IN ('item','model','user')),
 format_tags text[] NOT NULL DEFAULT '{}' CHECK(cardinality(format_tags)<=8),
 -- NULL until something is settled; day30 > day7 > cumulative_at_import.
 settled_basis text CHECK(settled_basis IN ('day7','day30','cumulative_at_import')),
 day7 jsonb, day7_on date,
 day30 jsonb, day30_on date,
 import_cumulative jsonb, import_on date,
 -- 'day7' / 'day30' once that point can no longer be settled, plus fields missing in the settled snapshot.
 missing_fields text[] NOT NULL DEFAULT '{}',
 -- Next day the settle batch looks at this post; NULL = final.
 next_check_on date,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(post_id,actor_id) REFERENCES public.social_posts(id,actor_id) ON DELETE CASCADE,
 CHECK((pillar_key IS NULL)=(pillar_source IS NULL)),
 CHECK((day7 IS NULL)=(day7_on IS NULL) AND (day30 IS NULL)=(day30_on IS NULL)
  AND (import_cumulative IS NULL)=(import_on IS NULL))
);
CREATE INDEX IF NOT EXISTS social_post_facts_due ON public.social_post_facts(next_check_on) WHERE next_check_on IS NOT NULL;
CREATE INDEX IF NOT EXISTS social_post_facts_brand ON public.social_post_facts(actor_id,business_id,posted_at DESC);

ALTER TABLE public.social_review_runs ADD COLUMN IF NOT EXISTS business_id uuid;
ALTER TABLE public.social_review_runs ADD COLUMN IF NOT EXISTS cadence text NOT NULL DEFAULT 'weekly';
ALTER TABLE public.social_review_runs ADD COLUMN IF NOT EXISTS attempt smallint NOT NULL DEFAULT 1;
-- The fixed-size review pack the model read (host-built, numbers by code); NULL for old reviews.
ALTER TABLE public.social_review_runs ADD COLUMN IF NOT EXISTS pack jsonb;
ALTER TABLE public.social_review_runs ADD COLUMN IF NOT EXISTS basics_pass boolean;
ALTER TABLE public.social_review_runs ADD COLUMN IF NOT EXISTS diagnostic_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE public.social_review_runs ADD COLUMN IF NOT EXISTS cost_breakdown jsonb;
-- BILL2 runs of earlier interrupted attempts: their actual cost already came off this review's cap.
ALTER TABLE public.social_review_runs ADD COLUMN IF NOT EXISTS prior_bill2_run_ids uuid[] NOT NULL DEFAULT '{}';
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.social_review_runs'::regclass
  AND conname='social_review_runs_coach_check') THEN
  ALTER TABLE public.social_review_runs ADD CONSTRAINT social_review_runs_coach_check
   CHECK(cadence IN ('weekly','monthly','quarterly','chat') AND attempt BETWEEN 1 AND 3
    AND (pack IS NULL OR jsonb_typeof(pack)='object') AND (cost_breakdown IS NULL OR jsonb_typeof(cost_breakdown)='object')
    AND cardinality(diagnostic_ids)<=3 AND cardinality(prior_bill2_run_ids)<=2);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.social_review_runs'::regclass
  AND conname='social_review_runs_business_fkey') THEN
  ALTER TABLE public.social_review_runs ADD CONSTRAINT social_review_runs_business_fkey FOREIGN KEY(actor_id,business_id)
   REFERENCES public.opc_businesses(actor_id,id) ON DELETE SET NULL (business_id);
 END IF;
 -- One review per user, brand, period and cadence; old rows (no brand) keep their per-user period.
 CREATE UNIQUE INDEX IF NOT EXISTS social_review_runs_period
  ON public.social_review_runs(actor_id,business_id,period_start,cadence) NULLS NOT DISTINCT;
 IF EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.social_review_runs'::regclass
  AND conname='social_review_runs_actor_id_period_start_key') THEN
  ALTER TABLE public.social_review_runs DROP CONSTRAINT social_review_runs_actor_id_period_start_key;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.social_review_runs'::regclass
  AND conname='social_review_runs_id_actor_key') THEN
  ALTER TABLE public.social_review_runs ADD CONSTRAINT social_review_runs_id_actor_key UNIQUE(id,actor_id);
 END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.social_review_experiments(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 actor_id uuid NOT NULL,
 business_id uuid NOT NULL,
 proposed_in uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('tactic','basics','pillar_mix','strategy')),
 status text NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','running','declined','concluded','extended')),
 hypothesis text NOT NULL CHECK(char_length(hypothesis) BETWEEN 1 AND 300),
 action text NOT NULL CHECK(char_length(action) BETWEEN 1 AND 300),
 metric text NOT NULL CHECK(metric ~ '^[a-z0-9_]{1,32}$'),
 -- Funnel layer for a basics experiment (settled on back-office rates); NULL for day-7 experiments.
 layer text CHECK(layer ~ '^[a-z0-9_]{1,24}$'),
 -- Target: a multiple of the frozen baseline, or a handbook line such as {"max":0.5} for a rate.
 target_mult numeric(6,3) CHECK(target_mult IS NULL OR target_mult BETWEEN 0.1 AND 10),
 target_line jsonb CHECK(target_line IS NULL OR jsonb_typeof(target_line)='object'),
 -- {pillar_key, platform?, format_tags?[]}: the code matches the next period's posts with it.
 match jsonb NOT NULL CHECK(jsonb_typeof(match)='object'),
 -- Frozen when proposed: {metric, median, samples, window_weeks, basis}.
 baseline jsonb CHECK(baseline IS NULL OR jsonb_typeof(baseline)='object'),
 evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object'),
 period_start date NOT NULL,
 period_end date NOT NULL CHECK(period_end>=period_start),
 verdict text CHECK(verdict IN ('worked','failed','inconclusive','not_run')),
 verdict_detail jsonb CHECK(verdict_detail IS NULL OR jsonb_typeof(verdict_detail)='object'),
 verdict_in uuid,
 extended_once boolean NOT NULL DEFAULT false,
 user_decision text CHECK(user_decision IN ('accepted','declined')),
 decided_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(actor_id,business_id) REFERENCES public.opc_businesses(actor_id,id) ON DELETE CASCADE,
 FOREIGN KEY(proposed_in,actor_id) REFERENCES public.social_review_runs(id,actor_id) ON DELETE CASCADE,
 FOREIGN KEY(verdict_in,actor_id) REFERENCES public.social_review_runs(id,actor_id) ON DELETE SET NULL (verdict_in),
 CHECK(status<>'concluded' OR verdict IS NOT NULL),
 CHECK((user_decision IS NULL)=(decided_at IS NULL))
);
CREATE INDEX IF NOT EXISTS social_review_experiments_brand
 ON public.social_review_experiments(actor_id,business_id,status,period_end);
CREATE INDEX IF NOT EXISTS social_review_experiments_run ON public.social_review_experiments(proposed_in);
CREATE INDEX IF NOT EXISTS social_review_experiments_verdict_run ON public.social_review_experiments(verdict_in)
 WHERE verdict_in IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.social_post_diagnostics(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 actor_id uuid NOT NULL,
 business_id uuid NOT NULL,
 post_id uuid NOT NULL,
 platform text NOT NULL CHECK(platform ~ '^[a-z0-9_-]{1,32}$'),
 source text NOT NULL CHECK(source IN ('screenshot','manual')),
 -- Normalized rate keys only, values as fractions or seconds; a missing key is absent, never zero.
 rates jsonb NOT NULL CHECK(jsonb_typeof(rates)='object'),
 -- Label -> value as read from a screenshot, kept for audit and re-mapping.
 rates_raw jsonb CHECK(rates_raw IS NULL OR jsonb_typeof(rates_raw)='object'),
 -- Storage key of the uploaded screenshot until it is deleted (retention is an Owner decision, RC-2b).
 screenshot_asset text CHECK(char_length(screenshot_asset) BETWEEN 1 AND 512),
 opening_text text CHECK(char_length(opening_text)<=2000),
 video_seconds integer CHECK(video_seconds BETWEEN 1 AND 86400),
 -- Second where the retention curve drops off, when the user read it from the back office.
 drop_second integer CHECK(drop_second BETWEEN 0 AND 86400),
 captured_on date NOT NULL,
 confirmed_at timestamptz NOT NULL,
 read_run_id uuid,
 review_run_id uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(post_id,captured_on),
 FOREIGN KEY(post_id,actor_id) REFERENCES public.social_posts(id,actor_id) ON DELETE CASCADE,
 FOREIGN KEY(review_run_id,actor_id) REFERENCES public.social_review_runs(id,actor_id) ON DELETE SET NULL (review_run_id)
);
CREATE INDEX IF NOT EXISTS social_post_diagnostics_brand
 ON public.social_post_diagnostics(actor_id,business_id,captured_on DESC);
CREATE INDEX IF NOT EXISTS social_post_diagnostics_run ON public.social_post_diagnostics(review_run_id)
 WHERE review_run_id IS NOT NULL;

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['social_coach_profiles','social_post_facts','social_review_experiments','social_post_diagnostics'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  -- Same rule as 0240: no client or service_role table access; definer functions only.
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',t);
 END LOOP;
END $$;

-- publish_monitor_review_claim(integer)
CREATE OR REPLACE FUNCTION public.publish_monitor_review_claim(p_limit integer DEFAULT 5)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE a uuid;s social_monitor_settings;r social_review_runs;base timestamptz;out jsonb:='[]';
 cfg jsonb;mid text;cap text;session jsonb;coach boolean;biz uuid;held boolean;cad text;stages jsonb;
 prof social_coach_profiles;last_month timestamptz;last_quarter timestamptz;
BEGIN
 -- Missing user settings are OFF. No creation time or migration time can silently opt a user into paid work.
 IF p_limit NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID';END IF;
 coach:=coalesce((SELECT value='true'::jsonb FROM system_settings WHERE key='publish_monitor_coach_enabled'),false);
 SELECT value#>>'{}' INTO mid FROM system_settings WHERE key='publish_monitor_review_model_id';
 IF mid IS NULL OR mid='' THEN SELECT value#>>'{}' INTO mid FROM system_settings WHERE key='primary_model_id';END IF;
 SELECT value#>>'{}' INTO cap FROM system_settings WHERE key='publish_monitor_review_max_usd';
 FOR a IN SELECT actor_id FROM social_review_runs WHERE status='claimed' AND lease_expires_at<=clock_timestamp()
  UNION SELECT actor_id FROM social_monitor_settings WHERE auto_review_enabled ORDER BY actor_id LOOP
  EXIT WHEN jsonb_array_length(out)>=p_limit;
  SELECT * INTO s FROM social_monitor_settings WHERE actor_id=a FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN CONTINUE;END IF;
  IF NOT coach THEN
   SELECT * INTO r FROM social_review_runs WHERE actor_id=a AND status='claimed' ORDER BY created_at LIMIT 1 FOR UPDATE;
   IF FOUND THEN
    IF r.lease_expires_at>clock_timestamp() THEN CONTINUE;END IF;
    UPDATE social_review_runs SET lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '5 minutes'
     WHERE id=r.id RETURNING * INTO r;
   ELSE
    IF NOT publish_monitor_review_allowed(a) THEN CONTINUE;END IF;
    SELECT greatest(s.auto_review_enabled_at,coalesce(max(finished_at),s.auto_review_enabled_at)) INTO base
     FROM social_review_runs WHERE actor_id=a AND status IN ('completed','skipped');
    IF base+interval '7 days'>clock_timestamp() THEN CONTINUE;END IF;
    INSERT INTO social_review_runs(actor_id,period_start,status,lease_expires_at,lease_token,runtime_request_id,model_id,max_cost_usd)
    VALUES(a,(base+interval '7 days')::date,'claimed',clock_timestamp()+interval '5 minutes',gen_random_uuid(),gen_random_uuid(),
     CASE WHEN mid~'^[0-9a-fA-F-]{36}$' THEN mid::uuid END,
     CASE WHEN cap~'^(0|[1-9][0-9]{0,3})(\.[0-9]{1,6})?$' THEN cap::numeric ELSE 0 END)
    ON CONFLICT(actor_id,business_id,period_start,cadence) DO NOTHING RETURNING * INTO r;
    IF NOT FOUND THEN CONTINUE;END IF;
    session:=runtime_start(a,r.runtime_request_id,'{"scope":{"kind":"positioning_draft"}}');
    UPDATE social_review_runs SET runtime_session_id=(session->>'sessionId')::uuid WHERE id=r.id RETURNING * INTO r;
   END IF;
   out:=out||jsonb_build_array(jsonb_build_object('id',r.id,'actorId',a,'token',r.lease_token,
    'requestId',r.runtime_request_id,'sessionId',r.runtime_session_id,'modelId',r.model_id,'maxCostUsd',r.max_cost_usd::text));
   CONTINUE;
  END IF;
  -- Coach mode: one paid review at a time per user. Expired claims of any brand are taken over first.
  held:=false;
  FOR r IN SELECT * FROM social_review_runs WHERE actor_id=a AND status='claimed' ORDER BY created_at FOR UPDATE LOOP
   held:=true;
   EXIT WHEN jsonb_array_length(out)>=p_limit;
   IF r.lease_expires_at>clock_timestamp() THEN CONTINUE;END IF;
   UPDATE social_review_runs SET lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '5 minutes'
    WHERE id=r.id RETURNING * INTO r;
   out:=out||jsonb_build_array(publish_monitor_review_claim_item(r));
  END LOOP;
  IF held OR NOT publish_monitor_review_allowed(a) THEN CONTINUE;END IF;
  FOR biz IN SELECT DISTINCT c.business_id FROM social_connections c JOIN opc_businesses b ON b.id=c.business_id
   AND b.actor_id=a AND b.erased_at IS NULL AND b.archived_at IS NULL
   WHERE c.actor_id=a AND c.role='own' AND c.status IN ('connected','reauth_required','quarantined') ORDER BY 1 LOOP
   EXIT WHEN jsonb_array_length(out)>=p_limit;
   SELECT coalesce(jsonb_object_agg(project_id::text,stage),'{}') INTO stages FROM opc_accounts
    WHERE actor_id=a AND business_id=biz AND erased_at IS NULL;
   -- First sight of a brand: the confirmed positioning version and its pillars as extracted candidates.
   INSERT INTO social_coach_profiles(actor_id,business_id,strategy_version_id,pillars,pillars_source,strategy_check_stages)
   SELECT a,biz,b.current_source_version_id,coalesce(x.pillars,'[]'),CASE WHEN x.pillars IS NOT NULL THEN 'extracted' END,stages
   FROM opc_businesses b LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('key','p'||n,'name',left(btrim(p),40),
     'definition',left(btrim(p),200)) ORDER BY n) pillars
    FROM artifact_versions v,jsonb_array_elements_text(CASE WHEN jsonb_typeof(v.report#>'{generatedReport,data,data,content,pillars}')
     ='array' THEN v.report#>'{generatedReport,data,data,content,pillars}' ELSE '[]' END) WITH ORDINALITY q(p,n)
    WHERE v.id=b.current_source_version_id AND n<=6 AND btrim(p)<>'') x ON true
   WHERE b.id=biz
   ON CONFLICT(actor_id,business_id) DO NOTHING;
   SELECT * INTO prof FROM social_coach_profiles WHERE actor_id=a AND business_id=biz FOR UPDATE;
   -- Old per-user rows count for every brand, so turning the coach on never adds an early review.
   SELECT greatest(s.auto_review_enabled_at,coalesce(max(finished_at),s.auto_review_enabled_at)) INTO base
    FROM social_review_runs WHERE actor_id=a AND (business_id=biz OR business_id IS NULL)
     AND status IN ('completed','skipped') AND cadence<>'chat';
   IF base+interval '7 days'>clock_timestamp() THEN CONTINUE;END IF;
   SELECT coalesce(max(finished_at) FILTER (WHERE cadence IN ('monthly','quarterly')),s.auto_review_enabled_at),
    coalesce(max(finished_at) FILTER (WHERE cadence='quarterly'),s.auto_review_enabled_at) INTO last_month,last_quarter
    FROM social_review_runs WHERE actor_id=a AND business_id=biz AND status='completed';
   cad:=CASE WHEN prof.strategy_check_stages IS DISTINCT FROM stages AND prof.strategy_check_stages IS NOT NULL
     OR last_quarter+interval '91 days'<=clock_timestamp() THEN 'quarterly'
    WHEN last_month+interval '28 days'<=clock_timestamp() THEN 'monthly' ELSE 'weekly' END;
   INSERT INTO social_review_runs(actor_id,business_id,cadence,period_start,status,lease_expires_at,lease_token,runtime_request_id,
    model_id,max_cost_usd)
   VALUES(a,biz,cad,(base+interval '7 days')::date,'claimed',clock_timestamp()+interval '5 minutes',gen_random_uuid(),
    gen_random_uuid(),CASE WHEN mid~'^[0-9a-fA-F-]{36}$' THEN mid::uuid END,
    CASE WHEN cap~'^(0|[1-9][0-9]{0,3})(\.[0-9]{1,6})?$' THEN cap::numeric ELSE 0 END)
   ON CONFLICT(actor_id,business_id,period_start,cadence) DO NOTHING RETURNING * INTO r;
   IF NOT FOUND THEN CONTINUE;END IF;
   session:=runtime_start(a,r.runtime_request_id,'{"scope":{"kind":"positioning_draft"}}');
   UPDATE social_review_runs SET runtime_session_id=(session->>'sessionId')::uuid WHERE id=r.id RETURNING * INTO r;
   out:=out||jsonb_build_array(publish_monitor_review_claim_item(r));
   -- One new review per user per batch; the next brand waits for this one to finish.
   EXIT;
  END LOOP;
 END LOOP;
 RETURN out;
END $function$;

-- publish_monitor_review_claim_item(social_review_runs)
CREATE OR REPLACE FUNCTION public.publish_monitor_review_claim_item(r social_review_runs)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT jsonb_build_object('id',r.id,'actorId',r.actor_id,'token',r.lease_token,'requestId',r.runtime_request_id,
  'sessionId',r.runtime_session_id,'modelId',r.model_id,'maxCostUsd',r.max_cost_usd::text,
  'businessId',r.business_id,'cadence',r.cadence,'attempt',r.attempt)
$function$;

-- publish_monitor_review_step(uuid,uuid,text,text)
CREATE OR REPLACE FUNCTION public.publish_monitor_review_step(p_id uuid, p_token uuid, p_action text, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r social_review_runs;x runtime_executions;allowed boolean;spent numeric;
BEGIN
 SELECT * INTO r FROM social_review_runs WHERE id=p_id FOR UPDATE;
 IF r.id IS NULL OR r.lease_token IS DISTINCT FROM p_token OR r.status<>'claimed'
  OR r.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'PUBLISH_MONITOR_REVIEW_LEASE_LOST';END IF;
 allowed:=publish_monitor_review_allowed(r.actor_id) AND r.created_at>=(SELECT auto_review_enabled_at
  FROM social_monitor_settings WHERE actor_id=r.actor_id);
 IF p_action='skip' THEN
  -- Serialize the terminal decision with a result commit. Native admission locks session -> review,
  -- so never wait for its execution row while owning the review: a busy owner makes this RPC retry.
  SELECT * INTO x FROM runtime_executions WHERE actor_id=r.actor_id AND request_id=r.runtime_request_id FOR UPDATE NOWAIT;
 ELSE
  SELECT * INTO x FROM runtime_executions WHERE actor_id=r.actor_id AND request_id=r.runtime_request_id;
 END IF;
 IF x.id IS NOT NULL THEN
  UPDATE social_review_runs SET runtime_execution_id=x.id,bill2_run_id=x.billing_run_id WHERE id=r.id;
 END IF;
 IF p_action IN ('observe','skip') AND x.state='completed' THEN
  UPDATE social_review_runs SET status='completed',finished_at=clock_timestamp(),lease_expires_at=NULL WHERE id=r.id;
  -- Only a completed strategy check consumes a stage change; a skipped one is scheduled again (Owner 2026-10-27).
  IF r.cadence='quarterly' AND r.business_id IS NOT NULL THEN
   UPDATE social_coach_profiles SET strategy_check_stages=(SELECT coalesce(jsonb_object_agg(project_id::text,stage),'{}')
     FROM opc_accounts WHERE actor_id=r.actor_id AND business_id=r.business_id AND erased_at IS NULL),
    strategy_checked_at=clock_timestamp(),updated_at=clock_timestamp() WHERE actor_id=r.actor_id AND business_id=r.business_id;
  END IF;
 ELSIF p_action='skip' AND x.result IS NOT NULL THEN
  -- The owner completed after expiry was observed, but billing can still be cost_pending.
  -- Keep the original claim so native financial recovery and the next observe can publish it.
  RETURN jsonb_build_object('allowed',false,'actorId',r.actor_id,'executionId',x.id,'state',x.state,'expired',false);
 ELSIF p_action='skip' OR p_action='observe' AND x.state IN ('cancelled','failed') THEN
  -- An unknown financial outcome keeps the claim: existing Runtime recovery owns the held credits.
  IF x.id IS NOT NULL AND NOT coalesce((SELECT closed FROM bill2_runs WHERE id=x.billing_run_id),false) THEN
   RETURN jsonb_build_object('allowed',false,'actorId',r.actor_id,'executionId',x.id,'state','cost_pending');END IF;
  spent:=CASE WHEN x.id IS NULL THEN 0 ELSE (SELECT provider_cost_usd FROM bill2_runs WHERE id=x.billing_run_id) END;
  IF p_action='skip' AND p_reason='RUNTIME_INTERRUPTED' AND r.attempt<3 AND allowed AND r.max_cost_usd-spent>0 THEN
   -- A deploy or a killed invocation is not the user's week lost: the settled attempt keeps its own request, bill
   -- and journal; the next attempt gets a new request in the same session, claimable by the next batch at once.
   -- Every attempt shares one cap: the known actual cost comes off it; an unknown cost (NULL) never retries.
   UPDATE social_review_runs SET attempt=attempt+1,runtime_request_id=gen_random_uuid(),runtime_execution_id=NULL,
    bill2_run_id=NULL,max_cost_usd=r.max_cost_usd-spent,
    prior_bill2_run_ids=prior_bill2_run_ids||CASE WHEN x.billing_run_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[x.billing_run_id] END,
    created_at=clock_timestamp(),lease_expires_at=clock_timestamp() WHERE id=r.id;
   RETURN jsonb_build_object('allowed',false,'actorId',r.actor_id,'executionId',x.id,'state','retrying','expired',false);
  END IF;
  UPDATE social_review_runs SET status='skipped',skip_reason=coalesce(p_reason,'RUNTIME_ENDED'),
   finished_at=clock_timestamp(),lease_expires_at=NULL WHERE id=r.id;
 ELSIF p_action NOT IN ('authorize','observe') THEN RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID';END IF;
 RETURN jsonb_build_object('allowed',allowed,'actorId',r.actor_id,'executionId',x.id,'state',x.state,
  'sessionId',r.runtime_session_id,'requestId',r.runtime_request_id,'modelId',r.model_id,'maxCostUsd',r.max_cost_usd::text,
  -- A scheduler-owned review has no user present to resume it. A live dispatch still owns its lease.
  -- Return only a deadline decision here: cancellation takes the native session/run locks in a separate RPC,
  -- never while holding this review row (admission uses session -> review).
  'expired',r.created_at<=clock_timestamp()-interval '15 minutes' AND x.result IS NULL
   AND NOT EXISTS(SELECT 1 FROM bill2_runs b WHERE b.id=x.billing_run_id AND NOT b.closed
    AND b.runtime_dispatch_deadline>clock_timestamp()));
END $function$;

-- publish_monitor_settle_facts(integer)
CREATE OR REPLACE FUNCTION public.publish_monitor_settle_facts(p_limit integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE today date:=(clock_timestamp() AT TIME ZONE 'UTC')::date;p record;f social_post_facts;pd date;
 s7 social_metric_snapshots;s30 social_metric_snapshots;first social_metric_snapshots;miss text[];n integer:=0;nxt date;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 5000 THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 -- New own posts at least 7 days old, then facts whose next check is due. Snapshots are only read, never changed.
 FOR p IN (SELECT sp.id,sp.actor_id,sp.connection_id,sp.posted_at,c.business_id,c.platform FROM social_posts sp
   JOIN social_connections c ON c.id=sp.connection_id AND c.role='own'
   WHERE sp.posted_at IS NOT NULL AND sp.posted_at<=clock_timestamp()-interval '7 days'
    AND NOT EXISTS(SELECT 1 FROM social_post_facts x WHERE x.post_id=sp.id)
   ORDER BY sp.posted_at LIMIT p_limit)
  UNION ALL (SELECT sp.id,sp.actor_id,sp.connection_id,sp.posted_at,c.business_id,c.platform FROM social_post_facts x
   JOIN social_posts sp ON sp.id=x.post_id JOIN social_connections c ON c.id=sp.connection_id
   WHERE x.next_check_on<=today ORDER BY x.next_check_on LIMIT p_limit) LOOP
  EXIT WHEN n>=p_limit;
  pd:=(p.posted_at AT TIME ZONE 'UTC')::date;
  SELECT * INTO f FROM social_post_facts WHERE post_id=p.id FOR UPDATE SKIP LOCKED;
  IF f.post_id IS NULL AND EXISTS(SELECT 1 FROM social_post_facts WHERE post_id=p.id) THEN CONTINUE;END IF;
  SELECT * INTO first FROM social_metric_snapshots WHERE post_id=p.id ORDER BY captured_on LIMIT 1;
  SELECT * INTO s7 FROM social_metric_snapshots WHERE post_id=p.id AND captured_on BETWEEN pd+7 AND pd+9
   ORDER BY captured_on LIMIT 1;
  SELECT * INTO s30 FROM social_metric_snapshots WHERE post_id=p.id AND captured_on BETWEEN pd+30 AND pd+33
   ORDER BY captured_on LIMIT 1;
  miss:=coalesce(f.missing_fields,'{}');
  IF f.day7 IS NULL AND s7.id IS NOT NULL THEN
   f.day7:=s7.metrics;f.day7_on:=s7.captured_on;miss:=miss||s7.missing_fields;
  ELSIF f.day7 IS NULL AND today>pd+9 AND NOT 'day7'=ANY(miss) THEN miss:=miss||'day7'::text;
  END IF;
  IF f.day30 IS NULL AND s30.id IS NOT NULL THEN
   f.day30:=s30.metrics;f.day30_on:=s30.captured_on;miss:=miss||s30.missing_fields;
  ELSIF f.day30 IS NULL AND today>pd+33 AND NOT 'day30'=ANY(miss) THEN miss:=miss||'day30'::text;
  END IF;
  -- First seen after day 7 (connected later, or older snapshots pruned): the earliest cumulative value we hold.
  IF f.import_cumulative IS NULL AND f.day7 IS NULL AND first.id IS NOT NULL AND first.captured_on>pd+9 THEN
   f.import_cumulative:=first.metrics;f.import_on:=first.captured_on;miss:=miss||first.missing_fields;
  END IF;
  nxt:=CASE WHEN f.day30 IS NOT NULL OR 'day30'=ANY(miss) THEN NULL
   WHEN f.day7 IS NOT NULL OR 'day7'=ANY(miss) THEN greatest(pd+30,today+1) ELSE today+1 END;
  INSERT INTO social_post_facts AS t(post_id,actor_id,connection_id,business_id,platform,posted_at,settled_basis,day7,day7_on,
   day30,day30_on,import_cumulative,import_on,missing_fields,next_check_on)
  VALUES(p.id,p.actor_id,p.connection_id,p.business_id,p.platform,p.posted_at,
   CASE WHEN f.day30 IS NOT NULL THEN 'day30' WHEN f.day7 IS NOT NULL THEN 'day7'
    WHEN f.import_cumulative IS NOT NULL THEN 'cumulative_at_import' END,
   f.day7,f.day7_on,f.day30,f.day30_on,f.import_cumulative,f.import_on,
   ARRAY(SELECT DISTINCT unnest(miss) ORDER BY 1),nxt)
  ON CONFLICT(post_id) DO UPDATE SET business_id=EXCLUDED.business_id,posted_at=EXCLUDED.posted_at,
   settled_basis=EXCLUDED.settled_basis,day7=EXCLUDED.day7,day7_on=EXCLUDED.day7_on,day30=EXCLUDED.day30,
   day30_on=EXCLUDED.day30_on,import_cumulative=EXCLUDED.import_cumulative,import_on=EXCLUDED.import_on,
   missing_fields=EXCLUDED.missing_fields,next_check_on=EXCLUDED.next_check_on,updated_at=clock_timestamp();
  n:=n+1;
 END LOOP;
 RETURN n;
END $function$;

-- publish_monitor_review_pack_rows(uuid,uuid,integer)
CREATE OR REPLACE FUNCTION public.publish_monitor_review_pack_rows(a uuid, p_business_id uuid, p_weeks integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE since timestamptz;
BEGIN
 IF p_business_id IS NULL OR p_weeks IS NULL OR p_weeks NOT BETWEEN 1 AND 104 THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 IF NOT publish_monitor_actor_open(a) THEN RAISE EXCEPTION 'PUBLISH_MONITOR_ACCOUNT_CLOSED' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM opc_businesses WHERE id=p_business_id AND actor_id=a AND erased_at IS NULL) THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_BUSINESS_NOT_FOUND' USING ERRCODE='42501'; END IF;
 since:=clock_timestamp()-make_interval(weeks=>p_weeks);
 -- Long-run memory is not cut to the plan's data window (Owner 2026-10-27); counts are bounded instead.
 RETURN jsonb_build_object(
  'profile',(SELECT jsonb_build_object('strategyVersionId',p.strategy_version_id,'pillars',p.pillars,
    'pillarsSource',p.pillars_source,'pillarMixTarget',p.pillar_mix_target,'strategyCheckedAt',p.strategy_checked_at)
   FROM social_coach_profiles p WHERE p.actor_id=a AND p.business_id=p_business_id),
  -- The confirmed report's strategy fields (same structure opc_strategy_data validates); the host trims them.
  'strategy',(SELECT jsonb_object_agg(k,d->k) FROM social_coach_profiles p JOIN artifact_versions v ON v.id=p.strategy_version_id
    CROSS JOIN LATERAL (SELECT opc_strategy_data(v.id)->'data' d) x
    CROSS JOIN unnest(ARRAY['summary','goal','positioning','audience','accountKit','content','roadmap','funnel']) k
   WHERE p.actor_id=a AND p.business_id=p_business_id AND x.d ? k),
  'accounts',coalesce((SELECT jsonb_agg(jsonb_build_object('projectId',o.project_id,'platform',o.platform,'stage',o.stage)
    ORDER BY o.platform) FROM opc_accounts o WHERE o.actor_id=a AND o.business_id=p_business_id AND o.erased_at IS NULL),'[]'),
  -- Account-level follower snapshots (TikHub profiles only) inside the 100-day retention, for stage signals.
  'followers',coalesce((SELECT jsonb_agg(jsonb_build_object('connectionId',c.id,'platform',c.platform,'source',c.source,
    'points',(SELECT coalesce(jsonb_agg(jsonb_build_object('date',s.captured_on,'value',s.metrics->'followers') ORDER BY s.captured_on),'[]')
     FROM social_metric_snapshots s WHERE s.connection_id=c.id AND s.post_id IS NULL AND s.metrics ? 'followers'
      AND NOT ('followers'=ANY(s.missing_fields)))) ORDER BY c.platform)
   FROM social_connections c WHERE c.actor_id=a AND c.business_id=p_business_id AND c.role='own'
    AND c.status IN ('connected','reauth_required','quarantined')),'[]'),
  'facts',coalesce((SELECT jsonb_agg(jsonb_build_object('postId',f.post_id,'platform',f.platform,'postedAt',f.posted_at,
    'title',sp.title_excerpt,'url',sp.post_url,'pillarKey',f.pillar_key,'pillarSource',f.pillar_source,'formatTags',f.format_tags,
    'basis',f.settled_basis,'day7',f.day7,'day7On',f.day7_on,'day30',f.day30,'day30On',f.day30_on,
    'importCumulative',f.import_cumulative,'importOn',f.import_on,'missing',f.missing_fields) ORDER BY f.posted_at DESC)
   FROM (SELECT * FROM social_post_facts WHERE actor_id=a AND business_id=p_business_id AND posted_at>=since
    ORDER BY posted_at DESC LIMIT 1500) f JOIN social_posts sp ON sp.id=f.post_id),'[]'),
  -- Own posts of the last 14 days not settled yet: counted and listed as too new, never judged.
  'recent',coalesce((SELECT jsonb_agg(jsonb_build_object('postId',sp.id,'platform',c.platform,'postedAt',sp.posted_at,
    'title',sp.title_excerpt,'pillarKey',f.pillar_key) ORDER BY sp.posted_at DESC)
   FROM social_posts sp JOIN social_connections c ON c.id=sp.connection_id AND c.role='own' AND c.business_id=p_business_id
   LEFT JOIN social_post_facts f ON f.post_id=sp.id
   WHERE sp.actor_id=a AND sp.posted_at>=clock_timestamp()-interval '14 days' AND (f.post_id IS NULL OR f.day7 IS NULL)
    AND (f.post_id IS NULL OR f.import_cumulative IS NULL)),'[]'),
  'experiments',coalesce((SELECT jsonb_agg(to_jsonb(e)-'actor_id'-'business_id' ORDER BY e.created_at DESC)
   FROM (SELECT * FROM social_review_experiments WHERE actor_id=a AND business_id=p_business_id
    ORDER BY created_at DESC LIMIT 100) e),'[]'),
  'diagnostics',coalesce((SELECT jsonb_agg(jsonb_build_object('id',d.id,'postId',d.post_id,'platform',d.platform,
    'source',d.source,'rates',d.rates,'openingText',d.opening_text,'videoSeconds',d.video_seconds,'dropSecond',d.drop_second,
    'capturedOn',d.captured_on,'reviewRunId',d.review_run_id) ORDER BY d.captured_on DESC)
   FROM (SELECT * FROM social_post_diagnostics WHERE actor_id=a AND business_id=p_business_id
    AND captured_on>=(since AT TIME ZONE 'UTC')::date ORDER BY captured_on DESC LIMIT 30) d),'[]'));
END $function$;

-- publish_monitor_erasure_remaining(uuid)
CREATE OR REPLACE FUNCTION public.publish_monitor_erasure_remaining(a uuid)
 RETURNS bigint
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT (SELECT count(*) FROM social_monitor_settings WHERE actor_id=a)
 +(SELECT count(*) FROM social_review_runs WHERE actor_id=a)
 +(SELECT count(*) FROM social_metric_snapshots WHERE actor_id=a)
 +(SELECT count(*) FROM social_posts WHERE actor_id=a)
 +(SELECT count(*) FROM social_connections WHERE actor_id=a AND provider_account_id IS NULL)
 +(SELECT count(*) FROM social_connections WHERE actor_id=a AND provider_account_id IS NOT NULL
   AND (status<>'deleting' OR business_id IS NOT NULL))
 +(SELECT count(*) FROM social_publish_jobs WHERE actor_id=a
   AND (state NOT IN ('claimed','dispatching','unknown') OR business_id IS NOT NULL))
 +(SELECT count(*) FROM social_connect_requests WHERE actor_id=a
   AND (business_id IS NOT NULL OR target_account_project_id IS NOT NULL
    OR NOT (state IN ('awaiting_callback','pending_confirm') OR cleaned_at IS NULL
     OR created_at>clock_timestamp()-interval '30 days')))
 -- 0407: removed with their posts, review runs and brands (ON DELETE CASCADE); counted so erasure waits for them.
 +(SELECT count(*) FROM social_post_facts WHERE actor_id=a)
 +(SELECT count(*) FROM social_post_diagnostics WHERE actor_id=a)
 +(SELECT count(*) FROM social_review_experiments WHERE actor_id=a)
 +(SELECT count(*) FROM social_coach_profiles WHERE actor_id=a)
$function$;

DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('publish_monitor_review_claim','publish_monitor_review_claim_item',
   'publish_monitor_review_step','publish_monitor_settle_facts','publish_monitor_review_pack_rows',
   'publish_monitor_erasure_remaining') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f);
  IF split_part(f::text,'(',1) IN ('publish_monitor_review_claim','publish_monitor_review_step',
   'publish_monitor_settle_facts','publish_monitor_review_pack_rows') THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f);END IF;
 END LOOP;
END $$;
COMMIT;
