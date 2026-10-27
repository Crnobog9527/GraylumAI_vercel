-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Run after fixture.sql in the disposable file-built database, never against a remote database.
BEGIN;
-- Reference for 0404: erasure_ledger_value as it was before (walks every key of the shape). The new one must return
-- the same value, or fail, for every metadata object in the database and for the edge cases below.
CREATE FUNCTION pg_temp.old_ledger_value(v jsonb, shape jsonb) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE k text; item jsonb; result jsonb; typ text:=shape#>>'{}';
BEGIN
 IF v IS NULL OR v='null'::jsonb THEN RETURN v; END IF;
 IF jsonb_typeof(shape)='object' AND shape ? '$enum' THEN
  IF jsonb_typeof(v)='string' AND (shape->'$enum') @> jsonb_build_array(v) THEN RETURN v; END IF;
  RAISE EXCEPTION 'ERASURE_LEDGER_INVALID_EVIDENCE';
 END IF;
 IF jsonb_typeof(shape)='object' THEN
  IF jsonb_typeof(v)<>'object' THEN RAISE EXCEPTION 'ERASURE_LEDGER_INVALID_EVIDENCE'; END IF;
  result:='{}';
  FOR k,item IN SELECT * FROM jsonb_each(shape) LOOP
   IF v ? k THEN result:=result||jsonb_build_object(k,pg_temp.old_ledger_value(v->k,item)); END IF;
  END LOOP;
  RETURN result;
 ELSIF jsonb_typeof(shape)='array' THEN
  IF jsonb_typeof(v)<>'array' THEN RAISE EXCEPTION 'ERASURE_LEDGER_INVALID_EVIDENCE'; END IF;
  result:='[]';
  FOR item IN SELECT value FROM jsonb_array_elements(v) LOOP
   result:=result||jsonb_build_array(pg_temp.old_ledger_value(item,shape->0));
  END LOOP;
  RETURN result;
 END IF;
 IF typ='number' AND jsonb_typeof(v) IN ('number','string')
  AND v#>>'{}' ~ '^-?[0-9]+(\.[0-9]+)?$' THEN RETURN v; END IF;
 IF typ='delivery_failure_reason' AND v='"confirmed_delivery_failure"'::jsonb THEN RETURN v; END IF;
 IF typ='boolean' AND jsonb_typeof(v)='boolean' THEN RETURN v; END IF;
 IF typ='id' AND jsonb_typeof(v)='string' AND length(v#>>'{}')>0 THEN RETURN v; END IF;
 RAISE EXCEPTION 'ERASURE_LEDGER_INVALID_EVIDENCE';
END $f$;
CREATE TEMP TABLE ledger_before ON COMMIT DROP AS
 SELECT 'credit_transactions' tbl,x.id::text id,to_jsonb(x) j FROM credit_transactions x WHERE FALSE;
SET LOCAL statement_timeout='8s';
-- Count function calls in this transaction (pg_stat_xact_user_functions): the guard below does not depend on machine speed.
SET LOCAL track_functions='all';
DO $$
DECLARE f jsonb; a uuid; sid uuid; run_id uuid; pre uuid; other uuid; response jsonb;
 started timestamptz; elapsed numeric; before_money jsonb; after_money jsonb; before_other text; after_other text;
 sample jsonb; subject jsonb; key text; expected boolean; actual boolean; uuid_parses bigint; projections bigint; erased_rows bigint; owned_checks bigint;
 shape jsonb; bad bigint; md jsonb; one text; two text;
BEGIN
 SELECT fixture INTO f FROM erasure_perf_test.target;
 a:=(f->>'actor')::uuid; sid:=(f->>'session')::uuid;
 SELECT id,pre_deduct_id INTO run_id,pre FROM bill2_runs WHERE session_ref=sid ORDER BY id LIMIT 1;
 SELECT actor INTO other FROM erasure_perf_test.actors WHERE n=1;
 IF (SELECT count(*) FROM credit_transactions)<15000 OR (SELECT count(*) FROM bill2_runs)<3000
  OR (SELECT count(*) FROM bill2_calls)<5000 OR (SELECT count(*) FROM bill2_receipts)<9000
  OR (SELECT count(*) FROM runtime_session_history)<7000
  OR (SELECT count(*) FROM runtime_executions WHERE session_id=sid)<>26
  OR (SELECT count(*) FROM bill2_calls c JOIN bill2_runs r ON r.id=c.run_id WHERE r.session_ref=sid)<>26
  OR EXISTS(SELECT 1 FROM bill2_runs WHERE session_ref=sid AND (state<>'settled' OR NOT closed OR charged IS DISTINCT FROM 1)) THEN
  RAISE EXCEPTION 'ERASURE_PERF_FIXTURE_TOO_SMALL';
 END IF;
 SELECT jsonb_build_object('balance',(SELECT credits FROM profiles WHERE id=a),
  'ledgerSum',(SELECT sum(amount) FROM credit_transactions WHERE user_id=a),
  'ledgerCount',(SELECT count(*) FROM credit_transactions WHERE user_id=a),
  'runs',(SELECT jsonb_agg(jsonb_build_array(id,state,closed,charged,actual_restore,provider_cost_usd) ORDER BY id)
   FROM bill2_runs WHERE session_ref=sid)) INTO before_money;
 SELECT md5(string_agg(body,'|' ORDER BY body)) INTO before_other FROM (
  SELECT to_jsonb(e)::text body FROM runtime_executions e JOIN erasure_perf_test.background b ON b.execution=e.id
  UNION ALL SELECT to_jsonb(r)::text FROM bill2_runs r JOIN erasure_perf_test.background b ON b.run=r.id
  UNION ALL SELECT to_jsonb(t)::text FROM credit_transactions t WHERE description='OTHER_LEDGER_PRIVATE'
  UNION ALL SELECT to_jsonb(t)::text FROM billing_history t WHERE reason='OTHER_BILLING_PRIVATE'
 ) untouched;
 -- An unmarked original run does not authorize erasure through any ledger binding.
 IF content_erasure_ledger_owned(jsonb_build_object('user_id',a,'bill2_run_id',run_id)) THEN
  RAISE EXCEPTION 'UNMARKED_LEDGER_MATCH';
 END IF;
 -- Snapshot of every ledger row of the deleting account before the deletion (equivalence oracle below).
 INSERT INTO ledger_before SELECT 'credit_transactions',id::text,to_jsonb(x) FROM credit_transactions x WHERE user_id=a;
 INSERT INTO ledger_before SELECT 'billing_history',id::text,to_jsonb(x) FROM billing_history x WHERE user_id=a;
 INSERT INTO ledger_before SELECT 'token_stats',id::text,to_jsonb(x) FROM token_stats x WHERE user_id=a;
 INSERT INTO ledger_before SELECT 'ai_usage_logs',id::text,to_jsonb(x) FROM ai_usage_logs x WHERE user_id=a;
 started:=clock_timestamp();
 response:=content_erasure_mark_session(a,sid);
 elapsed:=extract(epoch FROM clock_timestamp()-started)*1000;
 RAISE NOTICE 'DATA-ERASURE: 26 completed executions, 3000+ runs, 15000+ ledger rows: % ms',round(elapsed,2);
 -- Structural guard (replaces a 2 s wall-clock limit that failed on slow CI runners at about 2.1 s): the number of
 -- identity parses (content_erasure_uuid calls) made by one deletion. The fixed lookup parses each ledger row's
 -- identities once, about 50 thousand calls here; the previous lookup parsed them again for every candidate run,
 -- about 1.07 million. The count is the same on every run and every machine; a limit of 100 thousand keeps a 2x
 -- margin over the fixed lookup and fails the previous lookup by a factor of 10. The elapsed time stays in the NOTICE.
 PERFORM pg_stat_force_next_flush();
 SELECT coalesce(sum(calls),0) INTO uuid_parses FROM pg_stat_xact_user_functions WHERE funcname='content_erasure_uuid';
 RAISE NOTICE 'DATA-ERASURE: % identity parses in one deletion',uuid_parses;
 IF uuid_parses>100000 THEN RAISE EXCEPTION 'ERASURE_PERF_TOO_MANY_PARSES: %',uuid_parses; END IF;
 IF uuid_parses=0 THEN RAISE EXCEPTION 'ERASURE_PERF_GUARD_NOT_MEASURING'; END IF;
 -- 0404: erasing a ledger row projects its metadata once. Before, the statement projected it, then erasure_ledger_guard
 -- projected NEW and OLD again: three projections per row (about 4700 here), now one (about 1600, one per erased row).
 SELECT count(*) INTO erased_rows FROM ledger_before b WHERE b.j->>'content_erased_at' IS NULL AND EXISTS(
  SELECT 1 FROM (SELECT 'credit_transactions' tbl,id::text id,content_erased_at FROM credit_transactions WHERE user_id=a
   UNION ALL SELECT 'billing_history',id::text,content_erased_at FROM billing_history WHERE user_id=a
   UNION ALL SELECT 'token_stats',id::text,content_erased_at FROM token_stats WHERE user_id=a
   UNION ALL SELECT 'ai_usage_logs',id::text,content_erased_at FROM ai_usage_logs WHERE user_id=a) n
  WHERE n.tbl=b.tbl AND n.id=b.id AND n.content_erased_at IS NOT NULL);
 SELECT coalesce(sum(calls),0) INTO projections FROM pg_stat_xact_user_functions WHERE funcname='erasure_ledger_metadata';
 RAISE NOTICE 'DATA-ERASURE: % rows erased with % metadata projections',erased_rows,projections;
 IF erased_rows<1500 THEN RAISE EXCEPTION 'ERASURE_PERF_LEDGER_FIXTURE_TOO_SMALL: %',erased_rows; END IF;
 SELECT coalesce(sum(calls),0) INTO owned_checks FROM pg_stat_xact_user_functions WHERE funcname='content_erasure_ledger_owned';
 RAISE NOTICE 'DATA-ERASURE: % ledger ownership checks',owned_checks;
 -- The ledger statement tests ownership only for rows naming a content-deleted run of the account (one check there, one in
 -- the guard trigger per erased row, about 3200 here); the previous one tested every unerased row of the account (about 11200).
 IF owned_checks>erased_rows*5/2 THEN RAISE EXCEPTION 'ERASURE_PERF_LEDGER_SWEEP_TOO_WIDE: % for % rows',owned_checks,erased_rows; END IF;
 IF projections>erased_rows*3/2 THEN RAISE EXCEPTION 'ERASURE_PERF_TOO_MANY_PROJECTIONS: % for % rows',projections,erased_rows; END IF;
 -- Same result as the specification, row by row: every erased row has exactly the old projection of its original
 -- metadata, its text fields cleared, a stamp, and every other column unchanged; no other ledger row changed.
 SELECT count(*) INTO bad FROM ledger_before b JOIN (
   SELECT 'credit_transactions' tbl,id::text id,to_jsonb(x) j FROM credit_transactions x WHERE user_id=a
   UNION ALL SELECT 'billing_history',id::text,to_jsonb(x) FROM billing_history x WHERE user_id=a
   UNION ALL SELECT 'token_stats',id::text,to_jsonb(x) FROM token_stats x WHERE user_id=a
   UNION ALL SELECT 'ai_usage_logs',id::text,to_jsonb(x) FROM ai_usage_logs x WHERE user_id=a) n ON n.tbl=b.tbl AND n.id=b.id
  WHERE CASE WHEN n.j->>'content_erased_at' IS NULL THEN n.j IS DISTINCT FROM b.j
   ELSE (n.j-ARRAY['description','reason','error_message','ip_address','user_agent','metadata','content_erased_at'])
     IS DISTINCT FROM (b.j-ARRAY['description','reason','error_message','ip_address','user_agent','metadata','content_erased_at'])
    OR n.j->'metadata' IS DISTINCT FROM pg_temp.old_ledger_value(b.j->'metadata',
     (SELECT (regexp_match(prosrc,'\$shape\$(.*)\$shape\$','s'))[1]::jsonb FROM pg_proc WHERE proname='erasure_ledger_metadata'))
    OR coalesce(n.j->>'description','')<>'' OR coalesce(n.j->>'reason','')<>'' OR coalesce(n.j->>'error_message','')<>''
    OR coalesce(n.j->>'ip_address','')<>'' OR coalesce(n.j->>'user_agent','')<>'' END;
 IF bad>0 THEN RAISE EXCEPTION 'LEDGER_ERASURE_RESULT_CHANGED: % rows',bad; END IF;
 -- erasure_ledger_value equals its previous definition for every metadata object in the database (valid or not) and edge cases.
 SELECT (regexp_match(prosrc,'\$shape\$(.*)\$shape\$','s'))[1]::jsonb INTO shape FROM pg_proc WHERE proname='erasure_ledger_metadata';
 FOR md IN SELECT DISTINCT m FROM (SELECT metadata m FROM credit_transactions UNION ALL SELECT metadata FROM billing_history
   UNION ALL SELECT metadata FROM token_stats UNION ALL SELECT metadata FROM ai_usage_logs) s WHERE m IS NOT NULL
   UNION SELECT e FROM unnest(ARRAY['{}','null','[]','"x"','{"runId":"r","extra":1,"usage":{"inputTokens":3,"other":"x"}}',
    '{"runId":1}','{"usage":[]}','{"reversedGrantPeriodKeys":["a",1]}','{"reversedGrantPeriodKeys":["a","b"]}','{"balance_before":"12.5","x":{}}',
    '{"aborted":"yes"}','{"timestamp":""}','{"consumedTokens":{"inputTokens":"1"}}']::jsonb[]) e LOOP
  one:=NULL;two:=NULL;
  BEGIN one:=erasure_ledger_value(md,shape)::text; EXCEPTION WHEN OTHERS THEN one:='ERR '||SQLERRM; END;
  BEGIN two:=pg_temp.old_ledger_value(md,shape)::text; EXCEPTION WHEN OTHERS THEN two:='ERR '||SQLERRM; END;
  IF one IS DISTINCT FROM two THEN RAISE EXCEPTION 'LEDGER_VALUE_CHANGED: % -> % vs %',md,one,two; END IF;
 END LOOP;
 IF response->>'status'<>'deleted' OR (response->>'financialReviewCount')::int<>0
  OR NOT EXISTS(SELECT 1 FROM runtime_sessions WHERE id=sid AND content_deleted_at IS NOT NULL AND erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM runtime_executions WHERE session_id=sid AND (payload IS NOT NULL OR result IS NOT NULL)) THEN
  RAISE EXCEPTION 'CONVERSATION_ERASURE_INCOMPLETE';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM artifact_versions v JOIN opc_drafts d ON d.project_id=v.project_id
  WHERE d.session_id=sid AND v.report->>'body'='KEEP_SAVED_REPORT' AND v.erased_at IS NULL) THEN
  RAISE EXCEPTION 'SAVED_REPORT_LOST';
 END IF;
 IF EXISTS(SELECT 1 FROM bill2_receipts x JOIN bill2_calls c ON c.id=x.call_id JOIN bill2_runs r ON r.id=c.run_id
  WHERE r.session_ref=sid AND (x.financial_projection_version IS DISTINCT FROM 1 OR x.payload::text LIKE '%ERASE_PRIVATE_RECEIPT%')) THEN
  RAISE EXCEPTION 'PRIVATE_RECEIPT_NOT_ERASED';
 END IF;
 -- All five identities match their original run, including pre-deduction IDs kept in ledger metadata.
 FOR sample IN SELECT value FROM jsonb_array_elements(jsonb_build_array(
  jsonb_build_object('bill2_run_id',run_id),jsonb_build_object('id',pre),
  jsonb_build_object('metadata',jsonb_build_object('usage',jsonb_build_object('runId',run_id))),
  jsonb_build_object('metadata',jsonb_build_object('runId',run_id)),
  jsonb_build_object('metadata',jsonb_build_object('preDeductId',pre)),
  jsonb_build_object('bill2_run_id',upper(run_id::text)),jsonb_build_object('id','bad-uuid'),
  jsonb_build_object('bill2_run_id',NULL),jsonb_build_object('metadata',jsonb_build_object('runId',17)),
  jsonb_build_object('id',(SELECT run FROM erasure_perf_test.background WHERE n=0 LIMIT 1)),
  '{}'::jsonb)) LOOP
  FOREACH key IN ARRAY ARRAY[a::text,other::text,'bad-actor',''] LOOP
   subject:=sample||jsonb_build_object('user_id',key);
   SELECT EXISTS(SELECT 1 FROM bill2_runs r WHERE r.actor_id=content_erasure_uuid(subject->>'user_id')
    AND r.content_deleted_at IS NOT NULL AND (r.id=content_erasure_uuid(subject->>'bill2_run_id')
     OR r.pre_deduct_id=content_erasure_uuid(subject->>'id')
     OR r.id=content_erasure_uuid(subject#>>'{metadata,usage,runId}')
     OR r.id=content_erasure_uuid(subject#>>'{metadata,runId}')
     OR r.pre_deduct_id=content_erasure_uuid(subject#>>'{metadata,preDeductId}'))) INTO expected;
   actual:=content_erasure_ledger_owned(subject);
   IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'LEDGER_LOOKUP_CHANGED: %',subject; END IF;
  END LOOP;
 END LOOP;
 response:=content_erasure_mark_session(a,sid);
 IF NOT (response->>'alreadyDeleted')::boolean THEN RAISE EXCEPTION 'DELETE_REPLAY_NOT_IDEMPOTENT'; END IF;
 SELECT jsonb_build_object('balance',(SELECT credits FROM profiles WHERE id=a),
  'ledgerSum',(SELECT sum(amount) FROM credit_transactions WHERE user_id=a),
  'ledgerCount',(SELECT count(*) FROM credit_transactions WHERE user_id=a),
  'runs',(SELECT jsonb_agg(jsonb_build_array(id,state,closed,charged,actual_restore,provider_cost_usd) ORDER BY id)
   FROM bill2_runs WHERE session_ref=sid)) INTO after_money;
 IF after_money IS DISTINCT FROM before_money THEN RAISE EXCEPTION 'ERASURE_CHANGED_MONEY'; END IF;
 SELECT md5(string_agg(body,'|' ORDER BY body)) INTO after_other FROM (
  SELECT to_jsonb(e)::text body FROM runtime_executions e JOIN erasure_perf_test.background b ON b.execution=e.id
  UNION ALL SELECT to_jsonb(r)::text FROM bill2_runs r JOIN erasure_perf_test.background b ON b.run=r.id
  UNION ALL SELECT to_jsonb(t)::text FROM credit_transactions t WHERE description='OTHER_LEDGER_PRIVATE'
  UNION ALL SELECT to_jsonb(t)::text FROM billing_history t WHERE reason='OTHER_BILLING_PRIVATE'
 ) untouched;
 IF after_other IS DISTINCT FROM before_other THEN RAISE EXCEPTION 'UNRELATED_CONTENT_CHANGED'; END IF;
 RAISE NOTICE 'DATA-ERASURE PASS: identities unchanged; replay, saved report, unrelated accounts and money preserved';
END $$;
ROLLBACK;
