/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Run only in a disposable empty database. No credentials or remote fixtures.
\set ON_ERROR_STOP on
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE TABLE profiles(id uuid PRIMARY KEY,status text,is_deleted text,credits integer);
CREATE TABLE artifact_projects(id uuid PRIMARY KEY,actor_id uuid);
CREATE TABLE artifact_generations(id uuid PRIMARY KEY,project_id uuid,round_id uuid,request_id uuid,dispatch_token uuid,state text,result jsonb,pre_deduct_id uuid,charged_credits integer);
ALTER TABLE artifact_generations ENABLE ROW LEVEL SECURITY;
INSERT INTO profiles VALUES('00000000-0000-4000-8000-000000000001','active','false',50);
INSERT INTO artifact_projects VALUES('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001');
INSERT INTO artifact_generations VALUES('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000006','unknown',null,'00000000-0000-4000-8000-000000000007',null);
CREATE TEMP TABLE original_generation AS TABLE artifact_generations;
CREATE TEMP TABLE original_profiles AS TABLE profiles;
\ir ../migrations/0104_workbench_provider_observations.sql
\ir ../migrations/0104_workbench_provider_observations.sql
DO $$
DECLARE r text;
BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF has_column_privilege(r,'artifact_generations','provider_observations','SELECT')
   OR has_column_privilege(r,'artifact_generations','provider_observations','UPDATE')
  THEN RAISE EXCEPTION 'private evidence exposed: %',r; END IF;
  IF r<>'service_role' AND has_function_privilege(r,'artifact_observe_generation(uuid,uuid,uuid,uuid,uuid,jsonb)','EXECUTE')
  THEN RAISE EXCEPTION 'client execute exposed'; END IF;
 END LOOP;
END $$;
SET ROLE service_role;
SELECT artifact_observe_generation('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000006','{"phase":"headers","httpStatus":200,"providerResponseId":"gen-header","finishReason":null,"usage":null}');
SELECT artifact_observe_generation('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000006','{"phase":"headers","httpStatus":200,"providerResponseId":"gen-header","finishReason":null,"usage":null}');
SELECT artifact_observe_generation('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000006','{"phase":"body","httpStatus":200,"providerResponseId":"gen-body","finishReason":"length","usage":{"promptTokens":4,"completionTokens":5,"reportedCostUsd":null}}');
RESET ROLE;
DO $$
DECLARE v jsonb; bad jsonb;
BEGIN
 SELECT provider_observations INTO v FROM artifact_generations;
 IF v#>>'{headers,providerResponseId}'<>'gen-header' OR v#>>'{body,providerResponseId}'<>'gen-body'
 OR v#>'{body,usage,reportedCostUsd}' IS DISTINCT FROM 'null'::jsonb
 THEN RAISE EXCEPTION 'evidence lost'; END IF;
 IF EXISTS(SELECT 1 FROM artifact_generations a,original_generation b WHERE to_jsonb(a)-'provider_observations' IS DISTINCT FROM to_jsonb(b))
 OR EXISTS((TABLE profiles EXCEPT TABLE original_profiles) UNION ALL (TABLE original_profiles EXCEPT TABLE profiles))
 THEN RAISE EXCEPTION 'business state changed'; END IF;
 FOREACH bad IN ARRAY ARRAY[
  v->'headers'||'{"providerResponseId":"gen-replacement"}'::jsonb,
  v->'body'||'{"body":"PRIVATE"}'::jsonb,
  v->'body'||'{"usage":{"promptTokens":-1,"completionTokens":0,"reportedCostUsd":null}}'::jsonb,
  v->'body'||'{"phase":null}'::jsonb,
  v->'body'||'{"httpStatus":200.5}'::jsonb,
  v->'body'||'{"providerResponseId":"bad identity"}'::jsonb
 ] LOOP
  BEGIN
   PERFORM artifact_observe_generation('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000006',bad);
   RAISE EXCEPTION 'test accepted invalid evidence' USING ERRCODE='P9999';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL; END;
 END LOOP;
 BEGIN
  PERFORM artifact_observe_generation('00000000-0000-4000-8000-000000000099','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000006',v->'headers');
  RAISE EXCEPTION 'test accepted wrong owner';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  PERFORM artifact_observe_generation('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000099','00000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000006',v->'headers');
  RAISE EXCEPTION 'test accepted wrong round' USING ERRCODE='P9999';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL; END;
 BEGIN
  PERFORM artifact_observe_generation('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000099',v->'headers');
  RAISE EXCEPTION 'test accepted wrong token' USING ERRCODE='P9999';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL; END;
 IF (SELECT provider_observations FROM artifact_generations) IS DISTINCT FROM v THEN RAISE EXCEPTION 'conflict overwrote evidence'; END IF;
END $$;
SET ROLE authenticated;
DO $$ BEGIN
 BEGIN
  PERFORM artifact_observe_generation(NULL,NULL,NULL,NULL,NULL,'{}');
  RAISE EXCEPTION 'client executed private RPC';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
RESET ROLE;
SELECT 'PASS: repeat migration, immutable observations, no business effects, owner/round/token/client denial' AS result;
