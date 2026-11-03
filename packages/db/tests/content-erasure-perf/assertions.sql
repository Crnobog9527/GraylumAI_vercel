-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Run after fixture.sql in the disposable file-built database, never against a remote database.
BEGIN;
-- References for 0406: the two helpers as they were (every node / every shape key walked). The new ones must return the
-- same value, or fail the same way, for every input below.
CREATE FUNCTION pg_temp.old_references(v jsonb, ids uuid[]) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $f$
DECLARE x record;
BEGIN
 IF cardinality(ids)=0 OR v IS NULL THEN RETURN false; END IF;
 IF jsonb_typeof(v)='object' THEN
  FOR x IN SELECT * FROM jsonb_each(v) LOOP
   IF x.key IN ('executionId','sourceExecutionId','sourceVersionId','sourceContentId','projectId',
    'workItemId','roundId','conversationId','sessionId','dependencyId','source_message_id',
    'sourceScriptId','contentId','draftId','accountProjectId')
    AND lower(x.value#>>'{}')=ANY(ids::text[]) THEN RETURN true; END IF;
   IF pg_temp.old_references(x.value,ids) THEN RETURN true; END IF;
  END LOOP;
 ELSIF jsonb_typeof(v)='array' THEN
  FOR x IN SELECT value FROM jsonb_array_elements(v) LOOP
   IF pg_temp.old_references(x.value,ids) THEN RETURN true; END IF;
  END LOOP;
 ELSIF jsonb_typeof(v)='string' AND ((v#>>'{}') IS JSON OBJECT OR (v#>>'{}') IS JSON ARRAY) THEN
  RETURN pg_temp.old_references((v#>>'{}')::jsonb,ids);
 END IF;
 RETURN false;
END $f$;
CREATE FUNCTION pg_temp.gen(seed text, depth integer, ids text[]) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE r integer:=('x'||substr(md5(seed),1,6))::bit(24)::integer; kind integer:=r%9; id text:=ids[1+(r/9)%array_length(ids,1)];
 other text:=substr(md5(seed||'o'),1,8)||'-'||substr(md5(seed||'o'),9,4)||'-4'||substr(md5(seed||'o'),13,3)||'-8'||substr(md5(seed||'o'),16,3)||'-'||substr(md5(seed||'o'),19,12);
 keys text[]:=ARRAY['executionId','sessionId','projectId','note','x','draftId','dependencyId','other','sourceVersionId'];
 res jsonb:='{}'; arr jsonb:='[]'; i integer;
BEGIN
 IF depth>=3 THEN kind:=kind%4; END IF;
 IF kind=0 THEN RETURN to_jsonb(id);
 ELSIF kind=1 THEN RETURN to_jsonb(upper(id));
 ELSIF kind=2 THEN RETURN to_jsonb(other);
 ELSIF kind=3 THEN RETURN to_jsonb(r);
 ELSIF kind=4 THEN
  FOR i IN 1..3 LOOP res:=res||jsonb_build_object(keys[1+((r/7)+i*5)%9],pg_temp.gen(seed||'k'||i,depth+1,ids)); END LOOP; RETURN res;
 ELSIF kind=5 THEN
  FOR i IN 1..3 LOOP arr:=arr||jsonb_build_array(pg_temp.gen(seed||'a'||i,depth+1,ids)); END LOOP; RETURN arr;
 ELSIF kind=6 THEN RETURN to_jsonb(jsonb_build_object('executionId',id)::text);
 ELSIF kind=7 THEN RETURN to_jsonb(replace(jsonb_build_object('sessionId',id)::text,left(id,1),'\u00'||to_hex(ascii(left(id,1)))));
 ELSE RETURN to_jsonb(jsonb_build_array(jsonb_build_object('projectId',other))::text);
 END IF;
END $f$;
CREATE FUNCTION pg_temp.old_fields(v jsonb, shape jsonb) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE result jsonb; k text; spec jsonb; item jsonb; typ text := shape #>> '{}'; s text := v #>> '{}';
BEGIN
  IF jsonb_typeof(shape) = 'object' THEN
    IF jsonb_typeof(v) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'BILL2_ERASURE_INVALID_FINANCIAL_FIELD'; END IF;
    result := '{}';
    IF shape ? '$map' THEN
      FOR k, item IN SELECT * FROM jsonb_each(v) LOOP
        PERFORM pg_temp.old_fields(to_jsonb(k), shape->'$map');
        result := result || jsonb_build_object(k, pg_temp.old_fields(item, shape->'$value'));
      END LOOP;
    ELSE
      FOR k, spec IN SELECT * FROM jsonb_each(shape) LOOP
        IF v ? k THEN result := result || jsonb_build_object(k, pg_temp.old_fields(v->k, spec)); END IF;
      END LOOP;
    END IF;
    RETURN result;
  ELSIF jsonb_typeof(shape) = 'array' THEN
    IF jsonb_typeof(v) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'BILL2_ERASURE_INVALID_FINANCIAL_FIELD'; END IF;
    result := '[]';
    FOR item IN SELECT value FROM jsonb_array_elements(v) LOOP
      result := result || jsonb_build_array(pg_temp.old_fields(item, shape->0));
    END LOOP;
    RETURN result;
  END IF;
  IF typ = 'boolean' AND jsonb_typeof(v) = 'boolean' THEN RETURN v; END IF;
  IF typ = 'integer' AND jsonb_typeof(v) = 'number' AND s ~ '^(0|[1-9][0-9]*)$' THEN RETURN v; END IF;
  IF jsonb_typeof(v) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'BILL2_ERASURE_INVALID_FINANCIAL_FIELD'; END IF;
  IF typ = 'id' AND length(s) > 0 THEN RETURN v; END IF;
  IF typ = 'hash' AND s ~ '^[a-f0-9]{64}$' THEN RETURN v; END IF;
  IF typ = 'uuid' AND s ~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RETURN v; END IF;
  IF typ = 'currency' AND s ~ '^[A-Z]{3}$' THEN RETURN v; END IF;
  IF typ = 'decimal' THEN PERFORM bill2_decimal(v); RETURN v; END IF;
  IF typ = 'timestamp' AND s ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9:.+-]+(Z)?$' THEN
    PERFORM s::timestamptz; RETURN v;
  END IF;
  RAISE EXCEPTION 'BILL2_ERASURE_INVALID_FINANCIAL_FIELD';
END $f$;
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
 sample jsonb; subject jsonb; key text; expected boolean; actual boolean; uuid_parses bigint; projections bigint; erased_rows bigint; owned_checks bigint; ref_calls bigint; fz jsonb; fids uuid[]; r1 text; r2 text; n_cases integer:=0;
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
 -- 0406: reference tests visit JSON nodes. The account's other conversation holds 60 materials of about 600 nodes (36000
 -- nodes); the previous helper walked all of them (about 55000 calls with the rest of the account), the new one looks at each
 -- value's text once and walks only values that name a deleted id.
 SELECT coalesce(sum(calls),0) INTO ref_calls FROM pg_stat_xact_user_functions
  WHERE funcname IN ('content_erasure_references','content_erasure_references_walk');
 RAISE NOTICE 'DATA-ERASURE: % reference-helper calls',ref_calls;
 IF ref_calls>15000 THEN RAISE EXCEPTION 'ERASURE_PERF_REFERENCE_WALK_TOO_WIDE: %',ref_calls; END IF;
 IF ref_calls=0 THEN RAISE EXCEPTION 'ERASURE_PERF_REFERENCE_GUARD_NOT_MEASURING'; END IF;
 -- content_erasure_references: same answer as the previous walker on 1500 generated documents (ids in the sixth to the
 -- last position, upper-case ids, ids in nested JSON strings, nested strings that spell an id with unicode escapes).
 fids:=ARRAY(SELECT ('00000000-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid FROM generate_series(1,6) g);
 FOR n_cases IN 1..1500 LOOP
  fz:=pg_temp.gen('doc'||n_cases,0,ARRAY(SELECT x::text FROM unnest(fids) x));
  IF content_erasure_references(fz,fids) IS DISTINCT FROM pg_temp.old_references(fz,fids) THEN
   RAISE EXCEPTION 'REFERENCES_CHANGED: % %',fz,fids;
  END IF;
  IF pg_temp.old_references(fz,fids) THEN bad:=coalesce(bad,0)+1; END IF;
 END LOOP;
 IF bad NOT BETWEEN 100 AND 1400 THEN RAISE EXCEPTION 'REFERENCES_FUZZ_ONE_SIDED: %',bad; END IF;
 IF content_erasure_references(NULL,fids) IS NOT FALSE OR content_erasure_references('{"executionId":"x"}',ARRAY[]::uuid[]) IS NOT FALSE
  OR content_erasure_references('{"executionId":"00000000-0000-4000-8000-000000000001"}',ARRAY[NULL]::uuid[]) IS NOT FALSE
  OR content_erasure_references('{"executionId":"00000000-0000-4000-8000-000000000001"}',fids) IS NOT TRUE THEN
  RAISE EXCEPTION 'REFERENCES_EDGE_CHANGED';
 END IF;
 -- bill2_erasure_fields: same value, or the same error, as the previous definition for a typical shape and its mutations.
 shape:='{"a":"id","n":"integer","c":{"d":"boolean","e":["uuid"],"t":"timestamp"},"m":{"$map":"id","$value":{"v":"decimal","h":"hash"}},"cur":"currency"}';
 FOR md IN SELECT m FROM unnest(ARRAY[
   '{"a":"x","n":3,"c":{"d":true,"e":["00000000-0000-4000-8000-000000000001"],"t":"2026-10-26T00:00:00Z"},"m":{"k":{"v":"0.5","h":"%s"}},"cur":"USD"}',
   '{}','{"extra":1}','{"a":1}','{"a":""}','{"n":"3"}','{"n":3.5}','{"c":[]}','{"c":{"e":"x"}}','{"c":{"e":["bad"]}}','{"c":{"t":"yesterday"}}',
   '{"m":{"k":{"v":"x"}}}','{"m":{"":{"v":"1"}}}','{"m":[]}','{"cur":"usd"}','{"cur":null}','{"c":{"d":"true"}}','{"c":{"d":false,"zzz":1}}',
   '[]','"x"','null','{"a":"x","c":{"extra":{"deep":[1,2]}}}']::text[]) m0, LATERAL (SELECT replace(m0,'%s',repeat('a',64))::jsonb m) z LOOP
  r1:=NULL;r2:=NULL;
  BEGIN r1:=bill2_erasure_fields(md,shape)::text; EXCEPTION WHEN OTHERS THEN r1:='ERR '||SQLERRM; END;
  BEGIN r2:=pg_temp.old_fields(md,shape)::text; EXCEPTION WHEN OTHERS THEN r2:='ERR '||SQLERRM; END;
  IF r1 IS DISTINCT FROM r2 THEN RAISE EXCEPTION 'FIELDS_CHANGED: % -> % vs %',md,r1,r2; END IF;
 END LOOP;
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
