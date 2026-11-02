-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- CORE-PATH-V2 V2-12 B8b (number 0477 assigned by the controller; Owner 2026-11-02 "复盘必须开"): the weekly review runs as a
-- kind='review' turn (policy.review.mode = 'weekly') instead of a Runtime execution on a BILL2 run.
--   * social_review_runs.turn_id: the review's turn (turns.id). runtime_execution_id / bill2_run_id / prior_bill2_run_ids stay for rows
--     written before this migration and are dropped with the old tables (batch F).
--   * publish_monitor_review_session(actor, run): the review's hidden conversation (scope kind 'publish_monitor_review', one per run);
--     publish_monitor_review_claim uses it instead of runtime_start.
--   * publish_monitor_review_save_pack(run, token, pack): the code-computed my_posts result the review was written from (what the page
--     shows as its tables), kept under the run's lease.
--   * publish_monitor_review_step: the same actions (authorize / observe / skip) over the turn: a delivered completed turn completes the
--     review; a closed turn that did not deliver ends it, or retries an interruption (up to 3 attempts sharing one cost cap, the known
--     cost of the failed attempt taken off it, an unknown cost never retried); an unsettled turn keeps the claim.
--   * publish_monitor_reviews: the page reads the body from the turn's saved assistant message and the tables from the saved pack;
--     both are shown only while every source account of the pack is still visible, and a trigger on social_connections wipes the pack and
--     the saved text when a source account is disconnected (marked deleting) or deleted.
-- The admit / call / result guard functions on the old tables stay until batch F. Repeatable: CREATE OR REPLACE / IF NOT EXISTS only.
-- Recovery: re-apply 0457's publish_monitor_review_claim, review_step and 0289-era publish_monitor_reviews (packages/db/functions
-- history); turn_id and the new functions can stay.
BEGIN;
SET LOCAL lock_timeout='5s';

ALTER TABLE public.social_review_runs ADD COLUMN IF NOT EXISTS turn_id bigint;

CREATE OR REPLACE FUNCTION public.publish_monitor_review_session(p_actor_id uuid,p_run_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE sc jsonb; s runtime_sessions;
BEGIN
 IF p_actor_id IS NULL OR p_run_id IS NULL OR NOT EXISTS(SELECT 1 FROM social_review_runs WHERE id=p_run_id AND actor_id=p_actor_id)
  OR NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted::text='false') THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 sc:=jsonb_build_object('kind','publish_monitor_review','runId',p_run_id);
 INSERT INTO runtime_sessions(actor_id,scope,start_request_id,start_payload)
 VALUES(p_actor_id,sc,gen_random_uuid(),jsonb_build_object('scope',sc)) ON CONFLICT(actor_id,scope) DO NOTHING;
 SELECT * INTO s FROM runtime_sessions WHERE actor_id=p_actor_id AND scope=sc;
 IF s.id IS NULL THEN RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 RETURN s.id;
END $$;

CREATE OR REPLACE FUNCTION public.publish_monitor_review_save_pack(p_id uuid,p_token uuid,p_pack jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE n integer;
BEGIN
 IF jsonb_typeof(p_pack) IS DISTINCT FROM 'object' OR pg_column_size(p_pack)>65536 THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 UPDATE social_review_runs SET pack=p_pack WHERE id=p_id AND lease_token=p_token AND status='claimed'
  AND lease_expires_at>clock_timestamp();
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN n=1;
END $$;

-- The claim: the review's conversation comes from publish_monitor_review_session (was runtime_start).
CREATE OR REPLACE FUNCTION public.publish_monitor_review_claim(p_limit integer DEFAULT 5)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
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
    UPDATE social_review_runs SET runtime_session_id=publish_monitor_review_session(a,r.id) WHERE id=r.id RETURNING * INTO r;
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
   UPDATE social_review_runs SET runtime_session_id=publish_monitor_review_session(a,r.id) WHERE id=r.id RETURNING * INTO r;
   out:=out||jsonb_build_array(publish_monitor_review_claim_item(r));
   -- One new review per user per batch; the next brand waits for this one to finish.
   EXIT;
  END LOOP;
 END LOOP;
 RETURN out;
END $$;

-- The review's turn is found by the review's request id. State words: NULL (no turn yet), 'running', 'completed' (closed, delivered),
-- 'failed' (closed, nothing delivered). A closed turn whose settlement is still pending keeps the review claimed ('cost_pending').
CREATE OR REPLACE FUNCTION public.publish_monitor_review_step(p_id uuid,p_token uuid,p_action text,p_reason text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r social_review_runs;x turns;lx runtime_executions;allowed boolean;spent numeric;st text;why text;
BEGIN
 SELECT * INTO r FROM social_review_runs WHERE id=p_id FOR UPDATE;
 IF r.id IS NULL OR r.lease_token IS DISTINCT FROM p_token OR r.status<>'claimed'
  OR r.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'PUBLISH_MONITOR_REVIEW_LEASE_LOST';END IF;
 IF p_action NOT IN ('authorize','observe','skip') THEN RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID';END IF;
 allowed:=publish_monitor_review_allowed(r.actor_id) AND r.created_at>=(SELECT auto_review_enabled_at
  FROM social_monitor_settings WHERE actor_id=r.actor_id);
 SELECT * INTO x FROM turns WHERE actor_id=r.actor_id AND request_id=r.runtime_request_id AND kind='review';
 -- A review claimed before this migration may already have a Runtime execution on a BILL2 run (written by the old path). It is never
 -- started again as a turn: it completes when its execution completed, ends when the execution ended and its bill is settled, and
 -- otherwise keeps the claim for the old financial recovery (which still owns its held credits).
 IF x.id IS NULL THEN
  SELECT * INTO lx FROM runtime_executions WHERE actor_id=r.actor_id AND request_id=r.runtime_request_id;
  IF lx.id IS NOT NULL THEN
   UPDATE social_review_runs SET runtime_execution_id=lx.id,bill2_run_id=lx.billing_run_id WHERE id=r.id;
   IF lx.state='completed' THEN
    UPDATE social_review_runs SET status='completed',finished_at=clock_timestamp(),lease_expires_at=NULL WHERE id=r.id;
    RETURN jsonb_build_object('allowed',false,'actorId',r.actor_id,'turnId',NULL,'state','completed','expired',false);
   ELSIF lx.state IN ('cancelled','failed') AND coalesce((SELECT closed FROM bill2_runs WHERE id=lx.billing_run_id),true) THEN
    UPDATE social_review_runs SET status='skipped',skip_reason=coalesce(p_reason,'RUNTIME_ENDED'),
     finished_at=clock_timestamp(),lease_expires_at=NULL WHERE id=r.id;
    RETURN jsonb_build_object('allowed',false,'actorId',r.actor_id,'turnId',NULL,'state','failed','expired',false);
   END IF;
   -- Still unfinished: past the 15-minute deadline with no result the caller cancels it (runtime_cancel, which settles known usage
   -- and refunds what was not dispatched) and then skips; a running owner keeps its claim until then.
   RETURN jsonb_build_object('allowed',false,'actorId',r.actor_id,'turnId',NULL,'executionId',lx.id,'state','cost_pending',
    'expired',coalesce(lx.result IS NULL AND r.created_at<=clock_timestamp()-interval '15 minutes',false));
  END IF;
 END IF;
 IF x.id IS NOT NULL AND r.turn_id IS DISTINCT FROM x.id THEN
  UPDATE social_review_runs SET turn_id=x.id WHERE id=r.id;
 END IF;
 st:=CASE WHEN x.id IS NULL THEN NULL WHEN x.state<>'closed' THEN 'running'
  WHEN x.close_kind='completed' AND x.delivered THEN 'completed' ELSE 'failed' END;
 IF p_action IN ('observe','skip') AND st='completed' THEN
  UPDATE social_review_runs SET status='completed',finished_at=clock_timestamp(),lease_expires_at=NULL WHERE id=r.id;
  -- Only a completed strategy check consumes a stage change; a skipped one is scheduled again (Owner 2026-10-27).
  IF r.cadence='quarterly' AND r.business_id IS NOT NULL THEN
   UPDATE social_coach_profiles SET strategy_check_stages=(SELECT coalesce(jsonb_object_agg(project_id::text,stage),'{}')
     FROM opc_accounts WHERE actor_id=r.actor_id AND business_id=r.business_id AND erased_at IS NULL),
    strategy_checked_at=clock_timestamp(),updated_at=clock_timestamp() WHERE actor_id=r.actor_id AND business_id=r.business_id;
  END IF;
 ELSIF p_action='skip' AND st='running' THEN
  -- The caller closes an expired or disabled turn before it skips; a turn still running here keeps the claim.
  RETURN jsonb_build_object('allowed',false,'actorId',r.actor_id,'turnId',x.id,'state','running','expired',false);
 ELSIF p_action='skip' OR p_action='observe' AND st='failed' THEN
  -- An interruption the turn recovery job closed before this scheduler looked (observe) is retried like one reported by skip.
  why:=coalesce(p_reason,CASE WHEN p_action='observe' AND x.close_kind IN ('interrupted','failed','expired') THEN 'RUNTIME_INTERRUPTED' END);
  -- An unknown financial outcome keeps the claim: the turn recovery owns the held credits until the turn is settled.
  IF x.id IS NOT NULL AND x.settlement IS DISTINCT FROM 'done' THEN
   RETURN jsonb_build_object('allowed',false,'actorId',r.actor_id,'turnId',x.id,'state','cost_pending');END IF;
  spent:=CASE WHEN x.id IS NULL THEN 0 ELSE (SELECT coalesce(sum(turn_call_spent_usd(call_kind,nominal_usd,actual_usd)) FILTER (WHERE status='ok'),0)
    +coalesce(sum(actual_usd) FILTER (WHERE status='unusable'),0) FROM turn_calls WHERE turn_id=x.id) END;
  IF why='RUNTIME_INTERRUPTED' AND r.attempt<3 AND allowed AND r.max_cost_usd-spent>0 THEN
   -- A deploy or a killed invocation is not the user's week lost: the settled attempt keeps its own request and receipts; the next
   -- attempt gets a new request in the same session, claimable by the next batch at once. Every attempt shares one cap: the known
   -- cost comes off it; a turn whose cost is still unknown (settlement pending) never retries (returned above).
   UPDATE social_review_runs SET attempt=attempt+1,runtime_request_id=gen_random_uuid(),turn_id=NULL,max_cost_usd=r.max_cost_usd-spent,
    created_at=clock_timestamp(),lease_expires_at=clock_timestamp() WHERE id=r.id;
   RETURN jsonb_build_object('allowed',false,'actorId',r.actor_id,'turnId',x.id,'state','retrying','expired',false);
  END IF;
  UPDATE social_review_runs SET status='skipped',skip_reason=coalesce(why,'RUNTIME_ENDED'),
   finished_at=clock_timestamp(),lease_expires_at=NULL WHERE id=r.id;
 END IF;
 RETURN jsonb_build_object('allowed',allowed,'actorId',r.actor_id,'turnId',x.id,'state',st,
  'sessionId',r.runtime_session_id,'requestId',r.runtime_request_id,'modelId',r.model_id,'maxCostUsd',r.max_cost_usd::text,
  'cadence',r.cadence,'businessId',r.business_id,'attempt',r.attempt,
  -- A scheduler-owned review has no user present to resume it: a turn still running after 15 minutes is expired (the caller
  -- closes it as interrupted and then skips); the turn recovery job closes what the caller never reaches.
  'expired',coalesce(st='running' AND r.created_at<=clock_timestamp()-interval '15 minutes',false));
END $$;

CREATE OR REPLACE FUNCTION public.publish_monitor_reviews(a uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM publish_monitor_actor(a);
 RETURN coalesce((SELECT jsonb_agg(v ORDER BY v->>'createdAt' DESC) FROM (
  SELECT jsonb_build_object('id',r.id,'periodStart',r.period_start,'status',r.status,'skipReason',r.skip_reason,
   'createdAt',r.created_at,'sessionId',r.runtime_session_id,'executionId',coalesce(r.turn_id::text,r.runtime_execution_id::text),
   -- The body is the turn's saved assistant message (or, for a row written before B8b, the execution's result); a deleted
   -- conversation or an erasing account shows nothing.
   'body',CASE WHEN r.status='completed' AND r.turn_id IS NOT NULL AND s.id IS NOT NULL AND s.content_deleted_at IS NULL AND s.erased_at IS NULL
      AND r.pack IS NOT NULL AND runtime_workspace_posts_visible(a,r.pack) THEN
     (SELECT m.content FROM session_messages m WHERE m.session_id=s.id AND m.turn_id=r.turn_id AND m.role='assistant'
       AND m.deleted_at IS NULL ORDER BY m.seq DESC LIMIT 1)
    WHEN r.status='completed' AND r.turn_id IS NULL AND x.content_deleted_at IS NULL AND x.erased_at IS NULL THEN x.result->>'body' END,
   -- The numeric table comes only from the host's code-computed result saved with the review. Model text is never parsed into it.
   'tables',CASE WHEN r.status='completed' AND r.turn_id IS NOT NULL AND r.pack IS NOT NULL AND s.content_deleted_at IS NULL AND s.erased_at IS NULL
      AND runtime_workspace_posts_visible(a,r.pack) THEN r.pack->'review'
    WHEN r.status='completed' AND r.turn_id IS NULL AND x.content_deleted_at IS NULL AND x.erased_at IS NULL THEN
    (SELECT t.result->'review' FROM runtime_tool_calls t WHERE t.execution_id=x.id AND t.result->>'kind'='my_posts'
     AND t.result->>'window_days'='90' AND runtime_workspace_posts_visible(a,t.result) ORDER BY (t.result->>'window_days')::int DESC,t.call_id DESC LIMIT 1) END,
   'notice',CASE WHEN r.status='completed' THEN '本周复盘已生成'
    WHEN r.status='claimed' AND t.close_kind='completed' AND t.delivered AND t.settlement='pending' THEN '本周复盘已生成，费用正在核对。'
    WHEN r.skip_reason='BALANCE_LOW' THEN '余额不足，未复盘'
    WHEN r.skip_reason='RUNTIME_INTERRUPTED' THEN CASE
     WHEN t.id IS NULL OR t.settlement='done' THEN '本周复盘生成中断，已用积分按实际结算，未用部分已退回。'
     ELSE '本周复盘生成中断，费用正在核对；核对后退回未用部分。' END
    WHEN r.skip_reason='RUNTIME_ENDED' THEN '本周复盘生成未完成，这一周已结束，下周会正常安排。' END) v
  FROM social_review_runs r LEFT JOIN runtime_sessions s ON s.id=r.runtime_session_id AND s.actor_id=a
  LEFT JOIN turns t ON t.id=r.turn_id AND t.actor_id=a
  LEFT JOIN runtime_executions x ON x.id=r.runtime_execution_id AND x.actor_id=a
  WHERE r.actor_id=a ORDER BY r.created_at DESC LIMIT 52) q),'[]'::jsonb);
END $$;

-- A review is written from the user's own posts: when a source account is disconnected (marked deleting, then deleted) the saved
-- tables and the text that quotes those posts go with it, as the old path's source-deletion propagation did for its executions.
CREATE OR REPLACE FUNCTION public.publish_monitor_review_wipe_sources() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' AND NOT (NEW.status='deleting' AND OLD.status IS DISTINCT FROM 'deleting') THEN RETURN NEW; END IF;
 -- The review's turn is found by its request id too: the text may already be saved while turn_id is not yet written back.
 WITH wiped AS (UPDATE social_review_runs SET pack=NULL WHERE actor_id=OLD.actor_id AND pack IS NOT NULL
   AND coalesce(pack->'source_connections','[]'::jsonb) ? OLD.id::text RETURNING actor_id,runtime_session_id,runtime_request_id,turn_id)
 DELETE FROM session_messages m USING wiped w WHERE m.session_id=w.runtime_session_id AND (m.turn_id=w.turn_id OR m.turn_id IN
   (SELECT t.id FROM turns t WHERE t.actor_id=w.actor_id AND t.request_id=w.runtime_request_id AND t.kind='review'));
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS social_connections_wipe_review_sources ON public.social_connections;
CREATE TRIGGER social_connections_wipe_review_sources BEFORE UPDATE OF status OR DELETE ON public.social_connections
 FOR EACH ROW EXECUTE FUNCTION public.publish_monitor_review_wipe_sources();

DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('publish_monitor_review_session','publish_monitor_review_save_pack',
   'publish_monitor_review_claim','publish_monitor_review_step','publish_monitor_reviews','publish_monitor_review_wipe_sources') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f);
 END LOOP;
END $$;
COMMIT;
