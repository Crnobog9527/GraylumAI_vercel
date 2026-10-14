-- UI-FINISH: ordinary conversations can be renamed (Owner 2026-10-13: "普通对话加重命名，不加归档").
-- The name is user content in its own small table, not a runtime_sessions column: erased
-- runtime_sessions rows are frozen by erasure guards and cleared-column constraints, while a
-- name row can simply be deleted with its conversation or its account (DATA-ERASURE).

CREATE TABLE IF NOT EXISTS public.runtime_session_names (
 session_id uuid PRIMARY KEY REFERENCES public.runtime_sessions(id) ON DELETE CASCADE,
 actor_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80 AND name=btrim(name)),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS runtime_session_names_actor ON public.runtime_session_names(actor_id);
-- Ownership in the database, not only in the RPC (DATA-ERASURE §6): a name row always belongs to the
-- owner of its conversation, so conversation deletion (by session) and account erasure and its
-- completion proof (by actor) always see the same rows, whoever writes them.
CREATE OR REPLACE FUNCTION public.runtime_session_names_owner_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM runtime_sessions s WHERE s.id=NEW.session_id AND s.actor_id=NEW.actor_id) THEN
  RAISE EXCEPTION 'CONVERSATION_NAME_OWNER_MISMATCH' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.runtime_session_names_owner_guard() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS runtime_session_names_owner_guard ON public.runtime_session_names;
CREATE TRIGGER runtime_session_names_owner_guard BEFORE INSERT OR UPDATE ON public.runtime_session_names
 FOR EACH ROW EXECUTE FUNCTION public.runtime_session_names_owner_guard();
ALTER TABLE public.runtime_session_names ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.runtime_session_names FROM PUBLIC,anon,authenticated,service_role;

-- Only the owner's live free conversation can be renamed. The session row is locked in share
-- mode, so a rename serializes with deletion (which takes it FOR UPDATE) and can never write a
-- name after the conversation was deleted. An empty name restores the default title.
CREATE OR REPLACE FUNCTION public.opc_conversation_rename(p_actor_id uuid,p_session_id uuid,p_name text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s runtime_sessions; clean text:=btrim(coalesce(p_name,''));
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO s FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id FOR SHARE;
 IF s.id IS NULL THEN RAISE EXCEPTION 'CONVERSATION_NOT_FOUND' USING ERRCODE='42501'; END IF;
 IF s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL THEN
  RAISE EXCEPTION 'CONTENT_ERASED' USING ERRCODE='42501';
 END IF;
 IF s.scope->>'kind' IS DISTINCT FROM 'positioning_draft'
  OR EXISTS(SELECT 1 FROM opc_drafts draft WHERE draft.session_id=s.id)
  OR EXISTS(SELECT 1 FROM opc_topic_workspaces topics WHERE topics.session_id=s.id) THEN
  RAISE EXCEPTION 'CONVERSATION_NOT_FOUND' USING ERRCODE='42501';
 END IF;
 IF char_length(clean)>80 OR clean ~ '[[:cntrl:]]' THEN
  RAISE EXCEPTION 'CONVERSATION_NAME_INVALID' USING ERRCODE='22023';
 END IF;
 IF clean='' THEN
  DELETE FROM runtime_session_names WHERE session_id=s.id;
 ELSE
  INSERT INTO runtime_session_names(session_id,actor_id,name) VALUES(s.id,p_actor_id,clean)
  ON CONFLICT (session_id) DO UPDATE SET name=EXCLUDED.name,updated_at=now();
 END IF;
 RETURN jsonb_build_object('sessionId',s.id,'name',nullif(clean,''));
END $$;
REVOKE ALL ON FUNCTION public.opc_conversation_rename(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.opc_conversation_rename(uuid,uuid,text) TO service_role;

-- Patch the live definitions at unique anchors (same method as 0209).
DO $$ DECLARE source text;sig text;needle text;replacement text;marker text; BEGIN
 FOR sig,needle,replacement,marker IN SELECT * FROM (VALUES
 ('opc_free_conversations(uuid)',
  $n$  'title',CASE WHEN runtime_history_available(s.execution_id)
    THEN left(coalesce(nullif(btrim(s.payload->>'input'),''),'新对话'),80)
    ELSE '对话记录' END,$n$,
  $r$  'title',coalesce((SELECT n.name FROM runtime_session_names n WHERE n.session_id=s.id AND n.actor_id=p_actor_id),
   CASE WHEN runtime_history_available(s.execution_id)
    THEN left(coalesce(nullif(btrim(s.payload->>'input'),''),'新对话'),80)
    ELSE '对话记录' END),$r$,'conversation name'),
 ('content_erasure_confirm(uuid,text,uuid,text)',
  $n$ UPDATE runtime_sessions SET scope=NULL,start_payload=NULL,erased_at=stamp WHERE id=ANY(sessions) AND erased_at IS NULL;$n$,
  $r$ DELETE FROM runtime_session_names WHERE session_id=ANY(sessions);
 UPDATE runtime_sessions SET scope=NULL,start_payload=NULL,erased_at=stamp WHERE id=ANY(sessions) AND erased_at IS NULL;$r$,
  'conversation name erasure'),
 ('account_erasure_scrub_content(uuid)', $n$  RETURN counts;$n$,
  $r$  DELETE FROM runtime_session_names WHERE actor_id=p_profile_id;
  GET DIAGNOSTICS n=ROW_COUNT;counts:=counts||jsonb_build_object('runtime_session_names_deleted',n);
  RETURN counts;$r$,'account name scrub'),
 ('account_erasure_body_remaining(uuid)',
  $n$total bigint:=(SELECT count(*) FROM opc_data_events WHERE actor_id=p_profile_id);$n$,
  $r$total bigint:=(SELECT count(*) FROM opc_data_events WHERE actor_id=p_profile_id)
  +(SELECT count(*) FROM runtime_session_names WHERE actor_id=p_profile_id);$r$,'account name proof')
 ) changes(signature,anchor,patch,label) LOOP
  marker:='-- 0232 '||marker;
  source:=pg_get_functiondef(('public.'||sig)::regprocedure);
  IF position(marker IN source)=0 THEN
   IF length(source)-length(replace(source,needle,''))<>length(needle)
   THEN RAISE EXCEPTION 'CONVERSATION_NAME_SOURCE_MISMATCH: % %',sig,marker;END IF;
   source:=replace(source,needle,replacement);
   source:=replace(source,'AS $function$',E'AS $function$\n'||marker||E'\n');
   EXECUTE source;
  END IF;
 END LOOP;
END $$;
