-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- CONTENT-CONVERSATION-DRIVEN A2 (docs/launch/implementation/CONTENT_CONVERSATION_DRIVEN_PRECONDITIONS.md
-- sections 2.4, 2.5, 3.2 and 3.3 X2). Number assigned by the controller. No remote application.
-- 1. A derived-content turn (a Skill declaring workflow.yaml contentSource) reads one saved version of its topic's
--    content through runtime_execution checkpoint_source: chosen, checked (opc_content_allowed), recorded in
--    runtime_executions.injected_source and returned in one transaction. Replays reuse the recorded version; a
--    directly chosen Skill reuses the version frozen at admission (opc_content_source_current, no body).
-- 2. An execution that injected a source is available only while that source is (single and batch history checks).
-- 3. D7: deleting a saved content family also erases every execution that injected it.
-- 4. opc_content_from_execution saves storyboard and editing; their source is the generating execution's injected
--    source (never the browser's word).
-- Functions are patched at unique anchors; D7 guards and every other statement stay as they are.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- The saved version a derived-content turn read (A2). Ids and kinds only; written once by checkpoint_source.
ALTER TABLE public.runtime_executions ADD COLUMN IF NOT EXISTS injected_source jsonb;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.runtime_executions'::regclass
  AND conname='runtime_executions_injected_source_check') THEN
  ALTER TABLE public.runtime_executions ADD CONSTRAINT runtime_executions_injected_source_check CHECK(injected_source IS NULL OR (
   jsonb_typeof(injected_source)='object' AND injected_source ?& ARRAY['items'] AND jsonb_typeof(injected_source->'items')='array'
   AND jsonb_array_length(injected_source->'items') BETWEEN 1 AND 3));
 END IF;
END $$;
COMMENT ON COLUMN public.runtime_executions.injected_source IS
 'A2: saved content versions this execution injected into its model input, {"items":[{"contentId","kind"}]}; ids only, immutable once set.';

-- The recorded source of one kind (storyboard saves read the script, editing saves the storyboard).
CREATE OR REPLACE FUNCTION public.opc_injected_source_id(p_injected jsonb,p_kind text) RETURNS uuid
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT (i->>'contentId')::uuid FROM jsonb_array_elements(coalesce(p_injected->'items','[]'::jsonb)) i
 WHERE i->>'kind'=p_kind LIMIT 1
$$;

-- Picks the saved source of a derived-content turn. A frozen version (recorded, or frozen at admission) is only
-- re-checked, never replaced by a newer one. Otherwise: the latest available final script; or the latest available
-- storyboard, which must be based on that current final script. Every read goes through opc_content_allowed.
-- p_lock: FOR SHARE on the chosen rows, after the caller's session and execution locks (the D7 lock order).
CREATE OR REPLACE FUNCTION public.opc_content_source_pick(p_actor_id uuid,p_work_item_id uuid,p_kind text,p_frozen uuid,p_lock boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c opc_content_versions;script opc_content_versions;
BEGIN
 IF p_kind IS NULL OR p_kind NOT IN ('script','storyboard') THEN RAISE EXCEPTION 'RUNTIME_CONTENT_SOURCE_DENIED';END IF;
 IF p_frozen IS NOT NULL THEN
  IF p_lock THEN PERFORM 1 FROM opc_content_versions WHERE id=p_frozen FOR SHARE;END IF;
  SELECT * INTO c FROM opc_content_versions WHERE id=p_frozen AND actor_id=p_actor_id AND work_item_id=p_work_item_id AND kind=p_kind;
  IF c.id IS NULL OR (p_kind='script' AND c.status<>'final') OR NOT opc_content_allowed(p_actor_id,c.id) THEN
   RETURN jsonb_build_object('status','refused','code','RUNTIME_CONTENT_SOURCE_MISSING');
  END IF;
 ELSE
  FOR script IN SELECT * FROM opc_content_versions WHERE actor_id=p_actor_id AND work_item_id=p_work_item_id
   AND kind='script' AND status='final' ORDER BY version DESC LOOP
   IF p_lock THEN PERFORM 1 FROM opc_content_versions WHERE id=script.id FOR SHARE;END IF;
   EXIT WHEN opc_content_allowed(p_actor_id,script.id);
   script:=NULL;
  END LOOP;
  IF p_kind='script' THEN c:=script;
  ELSE
   FOR c IN SELECT * FROM opc_content_versions WHERE actor_id=p_actor_id AND work_item_id=p_work_item_id
    AND kind='storyboard' ORDER BY version DESC LOOP
    IF p_lock THEN PERFORM 1 FROM opc_content_versions WHERE id=c.id FOR SHARE;END IF;
    EXIT WHEN opc_content_allowed(p_actor_id,c.id);
    c:=NULL;
   END LOOP;
  END IF;
  IF c.id IS NULL THEN RETURN jsonb_build_object('status','refused','code','RUNTIME_CONTENT_SOURCE_MISSING');END IF;
  -- Editing advice only from a storyboard of the current final script (#621 4.3, fifth review round).
  IF p_kind='storyboard' AND c.source_content_id IS DISTINCT FROM script.id THEN
   RETURN jsonb_build_object('status','refused','code','RUNTIME_CONTENT_SOURCE_STALE');
  END IF;
 END IF;
 RETURN jsonb_build_object('status','ready','contentId',c.id,'kind',c.kind,'version',c.version,'body',c.body,
  'bytes',octet_length(c.body));
END $$;

-- Admission of a directly chosen derived-content Skill: which version it would read, never the body.
CREATE OR REPLACE FUNCTION public.opc_content_source_current(p_actor_id uuid,p_session_id uuid,p_kind text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s runtime_sessions;picked jsonb;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO s FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id;
 IF s.id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,s.scope),false) THEN RAISE EXCEPTION 'RUNTIME_SCOPE_DENIED';END IF;
 IF s.scope->>'kind' IS DISTINCT FROM 'work_item' THEN RETURN jsonb_build_object('status','none');END IF;
 picked:=opc_content_source_pick(p_actor_id,(s.scope->>'workItemId')::uuid,p_kind,NULL,false);
 IF picked->>'status'<>'ready' THEN RETURN picked;END IF;
 RETURN jsonb_build_object('status','ready','contentId',picked->'contentId','kind',picked->'kind','bytes',picked->'bytes');
END $$;

-- runtime_execution checkpoint_source (called under its session and execution locks). Reads, checks and records the
-- source in this one transaction and returns the body: a deletion either waits for it (and then sees the record) or
-- commits first (and the pick finds nothing). A recorded or admission-frozen version is reused on every replay.
CREATE OR REPLACE FUNCTION public.runtime_source_checkpoint(p_actor_id uuid,s runtime_sessions,e runtime_executions,b bill2_runs,p_result jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE kind text;frozen uuid;picked jsonb;
BEGIN
 IF s.active_execution IS DISTINCT FROM e.id OR b.closed OR b.cancel_requested OR e.state NOT IN ('running','interrupted')
  OR jsonb_typeof(p_result) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_result) k WHERE k<>'kind')
  OR coalesce(p_result->>'kind','') NOT IN ('script','storyboard') THEN RAISE EXCEPTION 'RUNTIME_CONTENT_SOURCE_DENIED';END IF;
 kind:=p_result->>'kind';
 IF s.scope->>'kind' IS DISTINCT FROM 'work_item' THEN RETURN jsonb_build_object('status','none');END IF;
 IF e.injected_source IS NOT NULL THEN
  frozen:=opc_injected_source_id(e.injected_source,kind);
  IF frozen IS NULL THEN RAISE EXCEPTION 'RUNTIME_CONTENT_SOURCE_CONFLICT';END IF;
 ELSIF e.payload ? 'sourceContent' THEN
  IF e.payload->'sourceContent'->>'kind' IS DISTINCT FROM kind THEN RAISE EXCEPTION 'RUNTIME_CONTENT_SOURCE_CONFLICT';END IF;
  frozen:=(e.payload->'sourceContent'->>'contentId')::uuid;
 END IF;
 picked:=opc_content_source_pick(p_actor_id,(s.scope->>'workItemId')::uuid,kind,frozen,true);
 IF picked->>'status'<>'ready' THEN RETURN picked;END IF;
 IF e.injected_source IS NULL THEN
  UPDATE runtime_executions SET injected_source=jsonb_build_object('items',jsonb_build_array(
   jsonb_build_object('contentId',picked->'contentId','kind',kind))) WHERE id=e.id AND injected_source IS NULL;
 END IF;
 RETURN jsonb_build_object('status','injected','contentId',picked->'contentId','kind',kind,'version',picked->'version',
  'body',picked->'body');
END $$;
REVOKE ALL ON FUNCTION public.opc_injected_source_id(jsonb,text),
 public.opc_content_source_pick(uuid,uuid,text,uuid,boolean),public.opc_content_source_current(uuid,uuid,text),
 public.runtime_source_checkpoint(uuid,runtime_sessions,runtime_executions,bill2_runs,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.opc_content_source_current(uuid,uuid,text) TO service_role;

-- runtime_admit: a frozen source (sourceContent) is validated and share-locked while admission holds the session lock, so a
-- content deletion either committed first (admission is refused, nothing refers to the deleted content) or runs after
-- this execution exists (its payload carries the content id, so the D7 closure includes it).
CREATE OR REPLACE FUNCTION public.runtime_admit_source_check(p_actor_id uuid,s runtime_sessions,p_payload jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE frozen jsonb:=p_payload->'sourceContent';picked jsonb;
BEGIN
 IF frozen IS NULL THEN RETURN;END IF;
 IF jsonb_typeof(frozen) IS DISTINCT FROM 'object' OR coalesce(frozen->>'kind','') NOT IN ('script','storyboard')
  OR coalesce(frozen->>'contentId','') !~ '^[0-9a-f-]{36}$' OR s.scope->>'kind' IS DISTINCT FROM 'work_item' THEN
  RAISE EXCEPTION 'RUNTIME_CONTENT_SOURCE_MISSING';END IF;
 picked:=opc_content_source_pick(p_actor_id,(s.scope->>'workItemId')::uuid,frozen->>'kind',(frozen->>'contentId')::uuid,true);
 IF picked->>'status'<>'ready' THEN RAISE EXCEPTION '%',picked->>'code';END IF;
END $$;
REVOKE ALL ON FUNCTION public.runtime_admit_source_check(uuid,runtime_sessions,jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- Replace each anchor exactly once in the live definition, unless this migration's marker is already present.
CREATE FUNCTION pg_temp.a2_patch(sig text,marker text,olds text[],news text[]) RETURNS void LANGUAGE plpgsql AS $$
DECLARE definition text:=pg_get_functiondef(('public.'||sig)::regprocedure);
BEGIN
 IF position(marker IN definition)>0 THEN RETURN;END IF;
 FOR i IN 1..cardinality(olds) LOOP
  IF (length(definition)-length(replace(definition,olds[i],'')))/length(olds[i])<>1 THEN
   RAISE EXCEPTION 'CONTENT_DERIVED_SOURCE_MISMATCH: % anchor %',sig,i;END IF;
  definition:=replace(definition,olds[i],news[i]);
 END LOOP;
 IF position(marker IN definition)=0 THEN RAISE EXCEPTION 'CONTENT_DERIVED_SOURCE_MISMATCH: % marker',sig;END IF;
 EXECUTE definition;
END $$;

-- 1. checkpoint_source: same stop and PAYG ownership checks as checkpoint_match, then the delegate above.
SELECT pg_temp.a2_patch('runtime_execution(uuid,uuid,text,jsonb)','-- A2 checkpoint_source',ARRAY[
 $a$'checkpoint_primary','checkpoint_match','check_latest',$a$,
 $a$'interrupt','checkpoint_match','checkpoint_primary','check_latest','complete',$a$,
 $a$ ELSIF p_action='checkpoint_match' THEN$a$],ARRAY[
 $b$'checkpoint_primary','checkpoint_match','checkpoint_source','check_latest',$b$,
 $b$'interrupt','checkpoint_match','checkpoint_source','checkpoint_primary','check_latest','complete',$b$,
 $b$ ELSIF p_action='checkpoint_source' THEN
  -- A2 checkpoint_source: read, check and record the turn's saved source under these locks.
  RETURN runtime_source_checkpoint(p_actor_id,s,e,b,p_result);
 ELSIF p_action='checkpoint_match' THEN$b$]);

-- 2. Availability: runtime_billing_allowed (single) and runtime_history_availability (batch) both run this per execution.
SELECT pg_temp.a2_patch('runtime_direct_billing_allowed(uuid,jsonb,uuid)','-- A2 injected source',ARRAY[
 $a$ PERFORM runtime_direct_billing_allowed_before_topic(a,p,p_run_id);$a$],ARRAY[
 $b$ PERFORM runtime_direct_billing_allowed_before_topic(a,p,p_run_id);
 -- A2 injected source: an execution that read saved content stays available only while every source is.
 IF EXISTS(SELECT 1 FROM runtime_executions x CROSS JOIN LATERAL jsonb_array_elements(x.injected_source->'items') i
  WHERE x.billing_run_id=p_run_id AND x.actor_id=a AND x.injected_source IS NOT NULL
   AND NOT opc_content_allowed(a,(i->>'contentId')::uuid)) THEN RAISE EXCEPTION 'RUNTIME_CONTENT_SOURCE_REVOKED';END IF;$b$]);

-- 3. D7: the injected record joins the closure next to the frozen payload (content ids and their descendants).
SELECT pg_temp.a2_patch('content_erasure_scope(uuid,text,uuid)','-- A2 injected source',ARRAY[
 $a$ OR content_erasure_references(ex.payload,refs)
$a$],ARRAY[
 $b$ OR content_erasure_references(ex.payload,refs)
   -- A2 injected source
   OR content_erasure_references(ex.injected_source,refs)
$b$]);

-- 4. Storyboard and editing saves; their source comes from the generating execution.
SELECT pg_temp.a2_patch('opc_content_from_execution(uuid,uuid,uuid,bigint,text,text,uuid,uuid)','-- A2 derived source',ARRAY[
 $a$p_kind NOT IN ('brief','script') OR p_status$a$,
 $a$'OPC_CONTENT_INVALID';END IF;
$a$,
 $a$IF p_kind='script' AND opc_item_content_type$a$],ARRAY[
 $b$p_kind NOT IN ('brief','script','storyboard','editing') OR p_status$b$,
 $b$'OPC_CONTENT_INVALID';END IF;
 -- A2 derived source: a storyboard reads the script, editing the storyboard, as injected into the generating turn.
 IF p_kind IN ('storyboard','editing') THEN
  IF p_source_content_id IS NULL THEN
   p_source_content_id:=opc_injected_source_id(e.injected_source,CASE p_kind WHEN 'storyboard' THEN 'script' ELSE 'storyboard' END);
  ELSIF p_source_content_id IS DISTINCT FROM
   opc_injected_source_id(e.injected_source,CASE p_kind WHEN 'storyboard' THEN 'script' ELSE 'storyboard' END) THEN
   RAISE EXCEPTION 'OPC_CONTENT_SOURCE';
  END IF;
  IF p_source_content_id IS NULL OR NOT opc_content_allowed(p_actor_id,p_source_content_id) THEN RAISE EXCEPTION 'OPC_CONTENT_SOURCE';END IF;
 END IF;
$b$,
 $b$IF p_kind IN ('script','storyboard','editing') AND opc_item_content_type$b$]);
-- 5. Admission freezes the chosen source inside its own transaction (after the replay return, before any billing).
SELECT pg_temp.a2_patch('runtime_admit(uuid,uuid,uuid,jsonb,jsonb)','-- A2 source freeze',ARRAY[
 $a$ PERFORM runtime_context_allowed(p_actor_id,p_payload);
$a$],ARRAY[
 $b$ PERFORM runtime_context_allowed(p_actor_id,p_payload);
 -- A2 source freeze
 PERFORM runtime_admit_source_check(p_actor_id,s,p_payload);
$b$]);
DROP FUNCTION pg_temp.a2_patch(text,text,text[],text[]);
COMMIT;
