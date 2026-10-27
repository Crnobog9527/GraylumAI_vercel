-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Run after fixture.sql in the disposable file-built database, never against a remote database.
BEGIN;
SET LOCAL statement_timeout='8s';
-- Count function calls in this transaction (pg_stat_xact_user_functions): the guard below does not depend on machine speed.
SET LOCAL track_functions='all';
DO $$
DECLARE f jsonb; a uuid; sid uuid; run_id uuid; pre uuid; other uuid; response jsonb;
 started timestamptz; elapsed numeric; before_money jsonb; after_money jsonb; before_other text; after_other text;
 sample jsonb; subject jsonb; key text; expected boolean; actual boolean; uuid_parses bigint; owned_checks bigint;
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
 -- 0404: the ledger work of one conversation deletion follows that conversation's runs, not the account's ledger. This
 -- account holds 5000+ credit_transactions, 3000+ billing_history rows and 60 older content-deleted runs with 900
 -- unerased ledger rows; the previous statement tested every unerased row of the account (about 8200 calls here, about
 -- 11000 with the guard), the fixed one tests the session's own 182 rows twice (about 1500 including the guard).
 SELECT coalesce(sum(calls),0) INTO owned_checks FROM pg_stat_xact_user_functions WHERE funcname='content_erasure_ledger_owned';
 RAISE NOTICE 'DATA-ERASURE: % ledger ownership checks in one deletion',owned_checks;
 IF owned_checks>4000 THEN RAISE EXCEPTION 'ERASURE_PERF_LEDGER_SWEEP_TOO_WIDE: %',owned_checks; END IF;
 IF owned_checks=0 THEN RAISE EXCEPTION 'ERASURE_PERF_LEDGER_GUARD_NOT_MEASURING'; END IF;
 -- Every ledger row of the deleted session's runs is erased (and the session has some); the older runs' rows are not part of this deletion.
 IF NOT EXISTS(SELECT 1 FROM credit_transactions t JOIN bill2_runs r ON r.id=t.bill2_run_id WHERE r.session_ref=sid AND t.content_erased_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM credit_transactions t JOIN bill2_runs r ON r.id=t.bill2_run_id WHERE r.session_ref=sid AND t.content_erased_at IS NULL)
  OR EXISTS(SELECT 1 FROM billing_history h JOIN bill2_runs r ON r.pre_deduct_id=h.id OR r.pre_deduct_id::text=h.metadata->>'preDeductId'
   WHERE r.session_ref=sid AND h.content_erased_at IS NULL) THEN
  RAISE EXCEPTION 'SESSION_LEDGER_NOT_ERASED';
 END IF;
 IF (SELECT count(*) FROM billing_history WHERE reason='OLDER_RUN_LEDGER' AND content_erased_at IS NULL)<>900 THEN
  RAISE EXCEPTION 'OLDER_RUN_LEDGER_CHANGED';
 END IF;
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
