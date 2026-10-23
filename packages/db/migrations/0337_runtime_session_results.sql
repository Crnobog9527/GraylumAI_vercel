-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- CONTENT-CONVERSATION-DRIVEN C1-lite: the "本对话成果夹" of an ordinary free conversation
-- (Owner 2026-10-13, option A; docs/launch/implementation/CONTENT_CONVERSATION_DRIVEN_PRECONDITIONS.md 8.1.2–8.1.5).
--   * A result is text the user confirmed saving from one completed, available reply of the conversation: the whole
--     reply or an excerpt that appears in it verbatim. The AI never writes here; minutes are never saved here (Q1).
--   * Editing appends a version (source_execution_id NULL, source_result_id = previous version); versions are never
--     rewritten. Deleting one result deletes all its versions; the reply that produced it stays in the conversation.
--   * Only ordinary free conversations (the same rule as 0232 rename). Topic windows keep saving into
--     opc_content_versions; positioning keeps its own flow.
-- Lite scope (not in this migration): AI save proposals (save_content), the D7 "result" preview branch, copying a
-- result into the library, result_adoption data events.
-- Erasure (design 8.1.5): deleting the conversation, the result itself, or the account deletes the results. Erasing only
-- the reply a result was saved from keeps the user's saved (and edited) text; it is then marked "source unavailable"
-- (sourceAvailable=false, because runtime_history_available of the erased reply is false). Account erasure deletes
-- every row and the body proof counts them.
-- Compatibility: a new table and new functions; existing functions only gain the delete lines, so old code is
-- unaffected. Repeatable: IF NOT EXISTS, CREATE OR REPLACE, marker-skipped patches.
-- Recovery: restore content_erasure_confirm, account_erasure_scrub_content and account_erasure_body_remaining from
-- their previous definitions, then drop the functions and the table (results are user copies of replies that stay
-- in the conversation; dropping them loses only the saved edits).
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE TABLE IF NOT EXISTS public.runtime_session_results (
 id uuid PRIMARY KEY,
 actor_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 session_id uuid NOT NULL REFERENCES public.runtime_sessions(id) ON DELETE CASCADE,
 family_id uuid NOT NULL,
 version integer NOT NULL CHECK (version BETWEEN 1 AND 50),
 result_type text NOT NULL CHECK (result_type IN ('script','storyboard','editing','body','topic_list','copy')),
 title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80 AND title=btrim(title)),
 body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 20000),
 source_execution_id uuid REFERENCES public.runtime_executions(id) ON DELETE SET NULL,
 source_result_id uuid,
 request_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (actor_id,request_id), UNIQUE (family_id,version),
 CHECK ((version=1)=(family_id=id)), CHECK ((version=1)=(source_result_id IS NULL))
);
CREATE INDEX IF NOT EXISTS runtime_session_results_session ON public.runtime_session_results(session_id,family_id,version);
CREATE INDEX IF NOT EXISTS runtime_session_results_actor ON public.runtime_session_results(actor_id);
CREATE INDEX IF NOT EXISTS runtime_session_results_source ON public.runtime_session_results(source_execution_id)
 WHERE source_execution_id IS NOT NULL;
-- A row always belongs to the owner of its conversation (as 0232), so deletion by session and by actor see the same rows.
CREATE OR REPLACE FUNCTION public.runtime_session_results_owner_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM runtime_sessions s WHERE s.id=NEW.session_id AND s.actor_id=NEW.actor_id) THEN
  RAISE EXCEPTION 'SESSION_RESULT_OWNER_MISMATCH' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.runtime_session_results_owner_guard() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS runtime_session_results_owner_guard ON public.runtime_session_results;
CREATE TRIGGER runtime_session_results_owner_guard BEFORE INSERT OR UPDATE ON public.runtime_session_results
 FOR EACH ROW EXECUTE FUNCTION public.runtime_session_results_owner_guard();
ALTER TABLE public.runtime_session_results ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.runtime_session_results FROM PUBLIC,anon,authenticated,service_role;

-- The owner's live ordinary free conversation, locked in share mode so a write serializes with deletion
-- (which takes the session FOR UPDATE first, then its executions): delete first -> the write is refused;
-- write first -> deletion sees the new row and removes it.
CREATE OR REPLACE FUNCTION public.runtime_session_results_session(p_actor_id uuid,p_session_id uuid) RETURNS runtime_sessions
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE s runtime_sessions;
BEGIN
 SELECT * INTO s FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id FOR SHARE;
 IF s.id IS NULL THEN RAISE EXCEPTION 'SESSION_RESULT_NOT_FOUND' USING ERRCODE='42501';END IF;
 IF s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL THEN RAISE EXCEPTION 'CONTENT_ERASED' USING ERRCODE='42501';END IF;
 IF s.scope->>'kind' IS DISTINCT FROM 'positioning_draft'
  OR EXISTS(SELECT 1 FROM opc_drafts draft WHERE draft.session_id=s.id)
  OR EXISTS(SELECT 1 FROM opc_topic_workspaces topics WHERE topics.session_id=s.id) THEN
  RAISE EXCEPTION 'SESSION_RESULT_NOT_FOUND' USING ERRCODE='42501';
 END IF;
 RETURN s;
END $$;

CREATE OR REPLACE FUNCTION public.runtime_session_result_view(r runtime_session_results,p_versions integer) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('id',r.id,'familyId',r.family_id,'version',r.version,'versions',p_versions,
  'resultType',r.result_type,'title',r.title,'body',r.body,'sourceExecutionId',r.source_execution_id,
  'sourceAvailable',r.source_execution_id IS NULL OR runtime_history_available(r.source_execution_id),
  'createdAt',r.created_at)
$$;

CREATE OR REPLACE FUNCTION public.runtime_session_result_title(p_title text,p_body text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT coalesce(nullif(btrim(p_title),''),left(btrim(regexp_replace(p_body,'[[:space:]]+',' ','g')),40))
$$;

-- Save the user's confirmed text from one completed, available reply of this conversation.
CREATE OR REPLACE FUNCTION public.runtime_session_result_save(p_actor_id uuid,p_session_id uuid,p_execution_id uuid,
 p_request_id uuid,p_result_type text,p_title text,p_excerpt text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s runtime_sessions;e runtime_executions;r runtime_session_results;reply text;saved text;clean text;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 IF p_request_id IS NULL OR p_execution_id IS NULL THEN RAISE EXCEPTION 'SESSION_RESULT_INVALID' USING ERRCODE='22023';END IF;
 -- Identical concurrent requests (double click, transport retry) queue here; the second one replays the first.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||p_request_id::text,337));
 s:=runtime_session_results_session(p_actor_id,p_session_id);
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND actor_id=p_actor_id AND session_id=s.id FOR SHARE;
 IF e.id IS NULL OR e.state<>'completed' OR e.content_deleted_at IS NOT NULL OR e.erased_at IS NOT NULL
  OR NOT runtime_history_available(e.id) THEN RAISE EXCEPTION 'SESSION_RESULT_SOURCE' USING ERRCODE='42501';END IF;
 reply:=coalesce(e.result->>'body',e.primary_result->>'body');
 saved:=coalesce(p_excerpt,reply);
 IF reply IS NULL OR saved IS NULL OR btrim(saved)='' OR char_length(saved)>20000 OR position(saved IN reply)=0
  OR p_result_type NOT IN ('script','storyboard','editing','body','topic_list','copy') THEN
  RAISE EXCEPTION 'SESSION_RESULT_INVALID' USING ERRCODE='22023';
 END IF;
 clean:=runtime_session_result_title(p_title,saved);
 IF char_length(clean)>80 OR clean ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'SESSION_RESULT_INVALID' USING ERRCODE='22023';END IF;
 SELECT * INTO r FROM runtime_session_results WHERE actor_id=p_actor_id AND request_id=p_request_id;
 IF FOUND THEN
  -- The title is not part of the identity of a save: the same reply, type and text saved again keeps its first title.
  IF r.session_id<>s.id OR r.source_execution_id IS DISTINCT FROM e.id OR r.version<>1 OR r.result_type<>p_result_type
   OR r.body<>saved THEN RAISE EXCEPTION 'SESSION_RESULT_REQUEST_CONFLICT' USING ERRCODE='23505';END IF;
 ELSE
  IF (SELECT count(*) FROM runtime_session_results WHERE session_id=s.id AND version=1)>=200 THEN
   RAISE EXCEPTION 'SESSION_RESULT_LIMIT' USING ERRCODE='54000';END IF;
  r.id:=gen_random_uuid();
  INSERT INTO runtime_session_results(id,actor_id,session_id,family_id,version,result_type,title,body,source_execution_id,request_id)
   VALUES(r.id,p_actor_id,s.id,r.id,1,p_result_type,clean,saved,e.id,p_request_id) RETURNING * INTO r;
 END IF;
 RETURN runtime_session_result_view(r,(SELECT count(*)::integer FROM runtime_session_results WHERE family_id=r.family_id));
END $$;

-- Edit: append the next version of a result (the newest version must be the one the user edited).
CREATE OR REPLACE FUNCTION public.runtime_session_result_edit(p_actor_id uuid,p_family_id uuid,p_request_id uuid,
 p_expected_version integer,p_title text,p_body text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s runtime_sessions;latest runtime_session_results;r runtime_session_results;clean text;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 IF p_request_id IS NULL THEN RAISE EXCEPTION 'SESSION_RESULT_INVALID' USING ERRCODE='22023';END IF;
 -- Replays of one request queue, then edits and deletion of one result queue (the delete takes the same family lock):
 -- an edit never inserts a version after the family was deleted, and a delete always sees every committed version.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||p_request_id::text,337));
 PERFORM pg_advisory_xact_lock(hashtextextended(p_family_id::text,338));
 SELECT * INTO latest FROM runtime_session_results WHERE family_id=p_family_id AND actor_id=p_actor_id ORDER BY version DESC LIMIT 1;
 IF latest.id IS NULL THEN RAISE EXCEPTION 'SESSION_RESULT_NOT_FOUND' USING ERRCODE='42501';END IF;
 s:=runtime_session_results_session(p_actor_id,latest.session_id);
 -- Re-read under the session lock: a concurrent edit or delete has committed or is ordered after us.
 SELECT * INTO latest FROM runtime_session_results WHERE family_id=p_family_id AND actor_id=p_actor_id ORDER BY version DESC LIMIT 1;
 IF latest.id IS NULL THEN RAISE EXCEPTION 'SESSION_RESULT_NOT_FOUND' USING ERRCODE='42501';END IF;
 IF p_body IS NULL OR btrim(p_body)='' OR char_length(p_body)>20000 THEN RAISE EXCEPTION 'SESSION_RESULT_INVALID' USING ERRCODE='22023';END IF;
 clean:=runtime_session_result_title(p_title,p_body);
 IF char_length(clean)>80 OR clean ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'SESSION_RESULT_INVALID' USING ERRCODE='22023';END IF;
 SELECT * INTO r FROM runtime_session_results WHERE actor_id=p_actor_id AND request_id=p_request_id;
 IF FOUND THEN
  IF r.family_id<>p_family_id OR r.version<>p_expected_version+1 OR r.body<>p_body OR r.title<>clean THEN
   RAISE EXCEPTION 'SESSION_RESULT_REQUEST_CONFLICT' USING ERRCODE='23505';END IF;
 ELSE
  IF latest.version<>p_expected_version THEN RAISE EXCEPTION 'SESSION_RESULT_VERSION_CONFLICT' USING ERRCODE='40001';END IF;
  IF latest.version>=50 THEN RAISE EXCEPTION 'SESSION_RESULT_LIMIT' USING ERRCODE='54000';END IF;
  INSERT INTO runtime_session_results(id,actor_id,session_id,family_id,version,result_type,title,body,source_execution_id,
   source_result_id,request_id)
   VALUES(gen_random_uuid(),p_actor_id,s.id,p_family_id,latest.version+1,latest.result_type,clean,p_body,NULL,latest.id,p_request_id)
   RETURNING * INTO r;
 END IF;
 RETURN runtime_session_result_view(r,(SELECT count(*)::integer FROM runtime_session_results WHERE family_id=r.family_id));
END $$;

-- Delete one result with all its versions. Repeating it after success is a no-op.
CREATE OR REPLACE FUNCTION public.runtime_session_result_delete(p_actor_id uuid,p_family_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE sid uuid;n integer;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 PERFORM pg_advisory_xact_lock(hashtextextended(p_family_id::text,338));
 SELECT session_id INTO sid FROM runtime_session_results WHERE family_id=p_family_id AND actor_id=p_actor_id LIMIT 1;
 IF sid IS NULL THEN RETURN jsonb_build_object('familyId',p_family_id,'deleted',0);END IF;
 PERFORM runtime_session_results_session(p_actor_id,sid);
 DELETE FROM runtime_session_results WHERE family_id=p_family_id AND actor_id=p_actor_id;
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN jsonb_build_object('familyId',p_family_id,'deleted',n);
END $$;

-- The conversation's results: the newest version of each, oldest result first.
CREATE OR REPLACE FUNCTION public.runtime_session_results_list(p_actor_id uuid,p_session_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s runtime_sessions;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 s:=runtime_session_results_session(p_actor_id,p_session_id);
 RETURN coalesce((SELECT jsonb_agg(runtime_session_result_view(r,n.versions) ORDER BY n.first_at,r.family_id)
  FROM (SELECT family_id,max(version) latest,count(*)::integer versions,min(created_at) first_at
        FROM runtime_session_results WHERE session_id=s.id AND actor_id=p_actor_id GROUP BY family_id) n
  JOIN runtime_session_results r ON r.family_id=n.family_id AND r.version=n.latest),'[]'::jsonb);
END $$;

-- Every version of one result, newest first ("旧版本仍可看").
CREATE OR REPLACE FUNCTION public.runtime_session_result_versions(p_actor_id uuid,p_family_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE sid uuid;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT session_id INTO sid FROM runtime_session_results WHERE family_id=p_family_id AND actor_id=p_actor_id LIMIT 1;
 IF sid IS NULL THEN RAISE EXCEPTION 'SESSION_RESULT_NOT_FOUND' USING ERRCODE='42501';END IF;
 PERFORM runtime_session_results_session(p_actor_id,sid);
 -- One statement, one snapshot: the version count always matches the returned rows even if an edit commits meanwhile.
 RETURN coalesce((SELECT jsonb_agg(runtime_session_result_view(r,c.n) ORDER BY r.version DESC)
  FROM runtime_session_results r,
   LATERAL (SELECT count(*)::integer n FROM runtime_session_results x WHERE x.family_id=p_family_id AND x.actor_id=p_actor_id) c
  WHERE r.family_id=p_family_id AND r.actor_id=p_actor_id),'[]'::jsonb);
END $$;

-- Erasure, patched at unique anchors (same method as 0232 / 0320).
DO $$ DECLARE source text;sig text;needle text;replacement text;marker text; BEGIN
 FOR sig,needle,replacement,marker IN SELECT * FROM (VALUES
 ('content_erasure_confirm(uuid,text,uuid,text)',
  $n$ -- 0320 shortfall: the choice card goes with its answer or conversation.$n$,
  $r$ -- 0337 session results: a saved result goes with its conversation; erasing only its source reply keeps it (shown as source unavailable).
 DELETE FROM runtime_session_results WHERE actor_id=a AND session_id=ANY(sessions);
 -- 0320 shortfall: the choice card goes with its answer or conversation.$r$,'conversation results erasure'),
 ('account_erasure_scrub_content(uuid)',
  $n$  -- 0320 shortfall$n$,
  $r$  -- 0337 session results
  DELETE FROM runtime_session_results WHERE actor_id=p_profile_id;
  GET DIAGNOSTICS n=ROW_COUNT;counts:=counts||jsonb_build_object('runtime_session_results_deleted',n);
  -- 0320 shortfall$r$,'account results scrub'),
 ('account_erasure_body_remaining(uuid)',
  $n$+(SELECT count(*) FROM fusion_compares WHERE actor_id=p_profile_id)$n$,
  $r$+(SELECT count(*) FROM fusion_compares WHERE actor_id=p_profile_id)
  +(SELECT count(*) FROM runtime_session_results WHERE actor_id=p_profile_id)$r$,'account results proof')
 ) changes(signature,anchor,patch,label) LOOP
  marker:='-- 0337 '||marker;
  source:=pg_get_functiondef(('public.'||sig)::regprocedure);
  IF position(marker IN source)=0 THEN
   IF length(source)-length(replace(source,needle,''))<>length(needle)
   THEN RAISE EXCEPTION 'SESSION_RESULT_SOURCE_MISMATCH: % %',sig,marker;END IF;
   source:=replace(source,needle,replacement);
   source:=replace(source,'AS $function$',E'AS $function$\n'||marker||E'\n');
   EXECUTE source;
  END IF;
 END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.runtime_session_results_session(uuid,uuid),
 public.runtime_session_result_view(runtime_session_results,integer),public.runtime_session_result_title(text,text)
 FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.runtime_session_result_save(uuid,uuid,uuid,uuid,text,text,text),
 public.runtime_session_result_edit(uuid,uuid,uuid,integer,text,text),public.runtime_session_result_delete(uuid,uuid),
 public.runtime_session_results_list(uuid,uuid),public.runtime_session_result_versions(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.runtime_session_result_save(uuid,uuid,uuid,uuid,text,text,text),
 public.runtime_session_result_edit(uuid,uuid,uuid,integer,text,text),public.runtime_session_result_delete(uuid,uuid),
 public.runtime_session_results_list(uuid,uuid),public.runtime_session_result_versions(uuid,uuid) TO service_role;

COMMIT;
