-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- DATA-ERASURE E7 (logs at most 30 days; Owner 2026-10-12 approved adding the cleanup before launch).
-- 0148 dropped cleanup_old_logs and nothing replaced it. The daily account-erasure cron calls this,
-- so the cutoff is 29 days: a row written just after one run is gone by the run 29 days later,
-- before it is 30 days old. Bounded batches; repeated daily until nothing is left.
-- Not covered here on purpose: user_activity_logs (admin audit incl. credit adjustments and PAYG
-- metering review evidence referenced by bill2_calls) and ai_usage_logs (accounting, 3 years).
-- Owner 2026-10-12: "同意管理员审计记录（user_activity_logs）按账务记录保留 3 年，不按 30 天日志清理。"
-- So account erasure no longer deletes those rows: like other accounting rows it keeps the row and
-- removes identifying text (action wording, IP, free-text details), marking content_erased_at.
BEGIN;

CREATE OR REPLACE FUNCTION public.log_retention_cleanup(p_limit integer DEFAULT 5000)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE cutoff timestamptz:=clock_timestamp()-interval '29 days'; n_app bigint; n_diag bigint; n_jobs bigint;
BEGIN
 IF p_limit IS NULL OR p_limit<1 OR p_limit>20000 THEN RAISE EXCEPTION 'LOG_RETENTION_LIMIT_INVALID'; END IF;
 DELETE FROM application_logs WHERE id IN
  (SELECT id FROM application_logs WHERE created_at<cutoff ORDER BY created_at LIMIT p_limit);
 GET DIAGNOSTICS n_app=ROW_COUNT;
 DELETE FROM diagnostic_results WHERE id IN
  (SELECT id FROM diagnostic_results WHERE created_at<cutoff ORDER BY created_at LIMIT p_limit);
 GET DIAGNOSTICS n_diag=ROW_COUNT;
 -- Job runs expire like any log. Library cleanup runs daily, so its resume cursor always lives in a
 -- recent row; only after 29+ days without a run does its orphan scan start again from the beginning.
 DELETE FROM scheduled_job_runs WHERE id IN
  (SELECT id FROM scheduled_job_runs WHERE started_at<cutoff ORDER BY started_at LIMIT p_limit);
 GET DIAGNOSTICS n_jobs=ROW_COUNT;
 RETURN jsonb_build_object('applicationLogs',n_app,'diagnosticResults',n_diag,'scheduledJobRuns',n_jobs,
  'more',n_app=p_limit OR n_diag=p_limit OR n_jobs=p_limit);
END $$;

REVOKE ALL ON FUNCTION public.log_retention_cleanup(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.log_retention_cleanup(integer) TO service_role;

ALTER TABLE public.user_activity_logs ADD COLUMN IF NOT EXISTS content_erased_at timestamptz;

-- Audit details keep numbers and booleans (amounts, balances, flags) and the identifiers that make a
-- PAYG metering review (0167) still provable: call/run ids, model, evidence hash and versions,
-- also inside the nested `review` object. Free text (an admin's reason, reviewReference, names) is dropped.
CREATE OR REPLACE FUNCTION public.erasure_audit_details(d jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT coalesce(jsonb_object_agg(e.key,CASE WHEN jsonb_typeof(e.value)='object' THEN
   (SELECT coalesce(jsonb_object_agg(i.key,i.value),'{}'::jsonb) FROM jsonb_each(e.value) i
    WHERE jsonb_typeof(i.value) IN ('number','boolean') OR (jsonb_typeof(i.value)='string' AND i.key IN
     ('callId','runId','model','evidenceHash','expectedEvidenceHash','profileVersion','evidenceVersion')))
  ELSE e.value END) FILTER (WHERE jsonb_typeof(e.value) IN ('number','boolean')
   OR (jsonb_typeof(e.value)='string' AND e.key IN
    ('callId','runId','model','evidenceHash','expectedEvidenceHash','profileVersion','evidenceVersion'))
   OR (jsonb_typeof(e.value)='object' AND e.key='review')),'{}'::jsonb)
 FROM jsonb_each(CASE WHEN jsonb_typeof(d)='object' THEN d ELSE '{}'::jsonb END) e
$$;

-- Closed accounts still reject new or changed log rows (0192), except the one-way audit scrub:
-- same row, action reduced to its type, IP removed, details reduced, content_erased_at set once.
CREATE OR REPLACE FUNCTION public.account_erasure_log_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o jsonb; n jsonb;
BEGIN
 IF TG_TABLE_NAME='user_activity_logs' AND TG_OP='UPDATE' THEN
  o:=to_jsonb(OLD); n:=to_jsonb(NEW);
  IF o->>'content_erased_at' IS NULL AND n->>'content_erased_at' IS NOT NULL
   AND (o-ARRAY['action','ip_address','details','content_erased_at'])=(n-ARRAY['action','ip_address','details','content_erased_at'])
   AND n->>'action' IS NOT DISTINCT FROM o->>'action_type' AND n->>'ip_address' IS NULL
   AND n->'details' IS NOT DISTINCT FROM erasure_audit_details(o->'details') THEN
   RETURN NEW;
  END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=NEW.user_id)
  OR TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=OLD.user_id) THEN
  RETURN NULL;
 END IF;
 RETURN NEW;
END $$;

-- Exact, single replacements in the live erasure cleanup (as 0192/0197/0200 did): stop deleting
-- the audit rows, scrub them instead, and count only unscrubbed rows as remaining work.
DO $$
DECLARE source text; old_text text; new_text text;
BEGIN
 source:=pg_get_functiondef('public.account_erasure_local_cleanup(uuid,boolean)'::regprocedure);
 IF position('erasure_audit_details' IN source)=0 THEN
  old_text:=E' FOR entry IN SELECT unnest(ARRAY[''application_logs'',''user_activity_logs'',''user_checkins'']) tbl LOOP\n';
  new_text:=E' UPDATE user_activity_logs SET action=action_type,ip_address=NULL,details=erasure_audit_details(details),\n'
   ||E'  content_erased_at=clock_timestamp() WHERE ctid IN (SELECT ctid FROM user_activity_logs\n'
   ||E'  WHERE user_id=p_profile_id AND content_erased_at IS NULL LIMIT 100 FOR UPDATE SKIP LOCKED);\n'
   ||E' FOR entry IN SELECT unnest(ARRAY[''application_logs'',''user_checkins'']) tbl LOOP\n';
  IF length(source)-length(replace(source,old_text,''))<>length(old_text) THEN
   RAISE EXCEPTION 'AUDIT_RETENTION_CLEANUP_SOURCE_MISMATCH';
  END IF;
  EXECUTE replace(source,old_text,new_text);
 END IF;
 source:=pg_get_functiondef('public.account_erasure_local_remaining(uuid)'::regprocedure);
 old_text:='+(SELECT count(*) FROM user_activity_logs WHERE user_id=p_profile_id)';
 new_text:='+(SELECT count(*) FROM user_activity_logs WHERE user_id=p_profile_id AND content_erased_at IS NULL)';
 IF position(new_text IN source)=0 THEN
  IF length(source)-length(replace(source,old_text,''))<>length(old_text) THEN
   RAISE EXCEPTION 'AUDIT_RETENTION_REMAINING_SOURCE_MISMATCH';
  END IF;
  EXECUTE replace(source,old_text,new_text);
 END IF;
END $$;
REVOKE ALL ON FUNCTION public.erasure_audit_details(jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.account_erasure_log_guard() FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
