/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- DB-PERF PR-7b-B (placeholder number; the controller assigns the final one; applies after 0398).
-- The conversation page (runtime_view -> runtime_history_availability) and the free conversation list
-- (opc_free_conversations -> runtime_history_available per row) decide "is this saved turn still visible to its owner"
-- through a long permission chain. Within ONE such call the same sub-checks run again and again with identical
-- arguments: on staging's largest conversation (22 turns) bill2_scope_allowed ran 45 times, opc_business_context 44,
-- artifact_evidence_allowed 110, for 29 709 buffer pages and 555 ms.
--
-- Boundary (controller 2026-10-25): a result is reused only inside one top-level call of runtime_history_availability,
-- runtime_history_available or opc_free_conversations, only for exactly the same function and arguments, never across
-- calls, requests or users. These three calls only read (the chain takes FOR SHARE locks and writes nothing), so no own
-- write can change a sub-check between its first and a repeated evaluation. Locks taken by the first evaluation are held
-- to the end of the transaction, so a skipped repeat loses no lock. A failed evaluation (an exception) is never stored.
-- A change committed by another transaction while a call runs is seen by the first evaluation of each sub-check in that
-- call and by every later call; within the call, a repeat returns that first result instead of re-reading tens of
-- milliseconds later. Outside these three calls nothing is cached and every check runs exactly as before.
--
-- Mechanism: the outermost of the three calls opens a scope (graylum.check_call) and an empty map (graylum.check_memo),
-- both transaction-local settings, and clears them when it returns; an error that escapes it rolls them back with its
-- (sub)transaction. Only these two setting names are ever used, so long-lived connections accumulate nothing.
-- The memoized functions keep their names: each original is renamed *_before_memo (the repository's layering
-- convention) and a same-named wrapper consults the map, then calls it. Callers resolve names at run time, so every
-- caller now goes through the wrapper; outside a scope the wrapper only forwards.
--
-- Repeatable: each rename is skipped once done and the wrappers use CREATE OR REPLACE.
-- Rollback: drop the wrappers and helpers, rename every *_before_memo back to its original name and restore its grant
-- (opc_free_conversations: service_role); no data changes.
BEGIN;

CREATE OR REPLACE FUNCTION public.runtime_check_memo_open() RETURNS boolean
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF coalesce(current_setting('graylum.check_call',true),'')<>'' THEN RETURN false; END IF;
 PERFORM set_config('graylum.check_call',gen_random_uuid()::text,true);
 PERFORM set_config('graylum.check_memo','{}',true);
 RETURN true;
END $$;
CREATE OR REPLACE FUNCTION public.runtime_check_memo_close(p_opened boolean) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF p_opened THEN
  PERFORM set_config('graylum.check_call','',true);
  PERFORM set_config('graylum.check_memo','',true);
 END IF;
END $$;
-- NULL when no scope is open or nothing is stored for this key.
CREATE OR REPLACE FUNCTION public.runtime_check_memo_get(p_key text) RETURNS text
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF coalesce(current_setting('graylum.check_call',true),'')='' THEN RETURN NULL; END IF;
 RETURN nullif(current_setting('graylum.check_memo',true),'')::jsonb->>p_key;
END $$;
CREATE OR REPLACE FUNCTION public.runtime_check_memo_put(p_key text,p_value text) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF coalesce(current_setting('graylum.check_call',true),'')='' THEN RETURN; END IF;
 PERFORM set_config('graylum.check_memo',(coalesce(nullif(current_setting('graylum.check_memo',true),''),'{}')::jsonb
  ||jsonb_build_object(p_key,p_value))::text,true);
END $$;

DO $rename$ BEGIN
 IF to_regprocedure('public.bill2_scope_allowed_before_memo(uuid,jsonb)') IS NULL THEN
  ALTER FUNCTION public.bill2_scope_allowed(uuid,jsonb) RENAME TO bill2_scope_allowed_before_memo; END IF;
 IF to_regprocedure('public.opc_business_context_before_memo(uuid,uuid,uuid)') IS NULL THEN
  ALTER FUNCTION public.opc_business_context(uuid,uuid,uuid) RENAME TO opc_business_context_before_memo; END IF;
 IF to_regprocedure('public.opc_source_allowed_before_memo(uuid,uuid)') IS NULL THEN
  ALTER FUNCTION public.opc_source_allowed(uuid,uuid) RENAME TO opc_source_allowed_before_memo; END IF;
 IF to_regprocedure('public.artifact_evidence_allowed_before_memo(uuid,jsonb)') IS NULL THEN
  ALTER FUNCTION public.artifact_evidence_allowed(uuid,jsonb) RENAME TO artifact_evidence_allowed_before_memo; END IF;
 IF to_regprocedure('public.runtime_history_available_before_memo(uuid)') IS NULL THEN
  ALTER FUNCTION public.runtime_history_available(uuid) RENAME TO runtime_history_available_before_memo; END IF;
 IF to_regprocedure('public.runtime_history_availability_before_memo(uuid[])') IS NULL THEN
  ALTER FUNCTION public.runtime_history_availability(uuid[]) RENAME TO runtime_history_availability_before_memo; END IF;
 IF to_regprocedure('public.opc_free_conversations_before_memo(uuid)') IS NULL THEN
  ALTER FUNCTION public.opc_free_conversations(uuid) RENAME TO opc_free_conversations_before_memo; END IF;
END $rename$;

-- Memoized sub-checks: same name, arguments, return type and volatility as the original.
CREATE OR REPLACE FUNCTION public.bill2_scope_allowed(a uuid,s jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
DECLARE k text:=md5('bill2_scope_allowed|'||coalesce(a::text,'')||'|'||coalesce(s::text,''));hit text;result boolean;
BEGIN
 hit:=runtime_check_memo_get(k);
 IF hit IS NOT NULL THEN RETURN CASE hit WHEN 'n' THEN NULL ELSE hit::boolean END; END IF;
 result:=bill2_scope_allowed_before_memo(a,s);
 PERFORM runtime_check_memo_put(k,coalesce(result::text,'n'));
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION public.opc_source_allowed(a uuid,v_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
DECLARE k text:=md5('opc_source_allowed|'||coalesce(a::text,'')||'|'||coalesce(v_id::text,''));hit text;result boolean;
BEGIN
 hit:=runtime_check_memo_get(k);
 IF hit IS NOT NULL THEN RETURN CASE hit WHEN 'n' THEN NULL ELSE hit::boolean END; END IF;
 result:=opc_source_allowed_before_memo(a,v_id);
 PERFORM runtime_check_memo_put(k,coalesce(result::text,'n'));
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION public.opc_business_context(p_actor_id uuid,p_session_id uuid,p_round_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
DECLARE k text:=md5('opc_business_context|'||coalesce(p_actor_id::text,'')||'|'||coalesce(p_session_id::text,'')||'|'
 ||coalesce(p_round_id::text,''));hit text;result jsonb;
BEGIN
 hit:=runtime_check_memo_get(k);
 IF hit IS NOT NULL THEN RETURN CASE WHEN hit='n' THEN NULL ELSE substr(hit,2)::jsonb END; END IF;
 result:=opc_business_context_before_memo(p_actor_id,p_session_id,p_round_id);
 PERFORM runtime_check_memo_put(k,CASE WHEN result IS NULL THEN 'n' ELSE 'j'||result::text END);
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION public.artifact_evidence_allowed(project uuid,ids jsonb) RETURNS boolean
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE k text:=md5('artifact_evidence_allowed|'||coalesce(project::text,'')||'|'||coalesce(ids::text,''));hit text;result boolean;
BEGIN
 hit:=runtime_check_memo_get(k);
 IF hit IS NOT NULL THEN RETURN CASE hit WHEN 'n' THEN NULL ELSE hit::boolean END; END IF;
 result:=artifact_evidence_allowed_before_memo(project,ids);
 PERFORM runtime_check_memo_put(k,coalesce(result::text,'n'));
 RETURN result;
END $$;

-- Scope owners: the outermost one opens the scope and clears it when it returns.
CREATE OR REPLACE FUNCTION public.runtime_history_available(p_execution_id uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE opened boolean:=runtime_check_memo_open();
 k text:=md5('runtime_history_available|'||coalesce(p_execution_id::text,''));hit text;result boolean;
BEGIN
 hit:=runtime_check_memo_get(k);
 IF hit IS NOT NULL THEN result:=CASE hit WHEN 'n' THEN NULL ELSE hit::boolean END;
 ELSE
  result:=runtime_history_available_before_memo(p_execution_id);
  PERFORM runtime_check_memo_put(k,coalesce(result::text,'n'));
 END IF;
 PERFORM runtime_check_memo_close(opened);
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION public.runtime_history_availability(p_execution_ids uuid[])
 RETURNS TABLE(execution_id uuid,available boolean)
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE opened boolean:=runtime_check_memo_open();
BEGIN
 RETURN QUERY SELECT r.execution_id,r.available FROM runtime_history_availability_before_memo(p_execution_ids) r;
 PERFORM runtime_check_memo_close(opened);
END $$;
CREATE OR REPLACE FUNCTION public.opc_free_conversations(p_actor_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE opened boolean:=runtime_check_memo_open();result jsonb;
BEGIN
 result:=opc_free_conversations_before_memo(p_actor_id);
 PERFORM runtime_check_memo_close(opened);
 RETURN result;
END $$;

-- Same callers as before: nothing new becomes callable by clients; the list keeps its service_role grant.
DO $grants$ DECLARE fn regprocedure; BEGIN
 FOREACH fn IN ARRAY ARRAY['public.runtime_check_memo_open()','public.runtime_check_memo_close(boolean)',
  'public.runtime_check_memo_get(text)','public.runtime_check_memo_put(text,text)',
  'public.bill2_scope_allowed(uuid,jsonb)','public.opc_source_allowed(uuid,uuid)',
  'public.opc_business_context(uuid,uuid,uuid)','public.artifact_evidence_allowed(uuid,jsonb)',
  'public.runtime_history_available(uuid)','public.runtime_history_availability(uuid[])',
  'public.opc_free_conversations(uuid)','public.opc_free_conversations_before_memo(uuid)']::regprocedure[] LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',fn);
 END LOOP;
 GRANT EXECUTE ON FUNCTION public.opc_free_conversations(uuid) TO service_role;
END $grants$;
COMMIT;
