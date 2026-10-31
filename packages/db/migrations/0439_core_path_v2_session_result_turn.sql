-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2: a free conversation's results folder for replies written by a turn. A turn has no runtime_executions row; its reply
-- is the assistant message it saved in session_messages, so that message is what a save is checked against (a whole reply or a
-- verbatim excerpt, as runtime_session_result_save). Only the conversation's owner, and only a turn that closed completed.
ALTER TABLE public.runtime_session_results ADD COLUMN IF NOT EXISTS source_turn_id bigint;

-- runtime_session_result_view keeps its shape: the running API parses it strictly and this migration lands before the new API. The
-- turn path's own reads add sourceTurnId on top.
CREATE OR REPLACE FUNCTION public.runtime_session_result_turn_view(r runtime_session_results, p_versions integer)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT runtime_session_result_view(r,p_versions)||jsonb_build_object('sourceTurnId',r.source_turn_id)
  -- A saved turn's reply can go later (a deleted voice version hides it); the saved text stays, and the folder says the source is gone.
  ||CASE WHEN r.source_turn_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('sourceAvailable',EXISTS(SELECT 1 FROM session_messages m
    WHERE m.session_id=r.session_id AND m.turn_id=r.source_turn_id AND m.role='assistant' AND m.visible AND m.deleted_at IS NULL)) END
$function$;

CREATE OR REPLACE FUNCTION public.runtime_session_results_list_turns(p_actor_id uuid, p_session_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s runtime_sessions;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted::text='false') THEN
  RAISE EXCEPTION 'TURN_ACCOUNT_DENIED' USING ERRCODE='42501';END IF;
 s:=runtime_session_results_session(p_actor_id,p_session_id);
 RETURN coalesce((SELECT jsonb_agg(runtime_session_result_turn_view(r,n.versions) ORDER BY n.first_at,r.family_id)
  FROM (SELECT family_id,max(version) latest,count(*)::integer versions,min(created_at) first_at
        FROM runtime_session_results WHERE session_id=s.id AND actor_id=p_actor_id GROUP BY family_id) n
  JOIN runtime_session_results r ON r.family_id=n.family_id AND r.version=n.latest),'[]'::jsonb);
END $function$;

CREATE OR REPLACE FUNCTION public.runtime_session_result_save_turn(p_actor_id uuid, p_session_id uuid, p_turn_id bigint, p_request_id uuid,
 p_result_type text, p_title text, p_excerpt text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s runtime_sessions;t turns;r runtime_session_results;reply text;saved text;clean text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted::text='false') THEN
  RAISE EXCEPTION 'TURN_ACCOUNT_DENIED' USING ERRCODE='42501';END IF;
 IF p_request_id IS NULL OR p_turn_id IS NULL THEN RAISE EXCEPTION 'SESSION_RESULT_INVALID' USING ERRCODE='22023';END IF;
 -- Identical concurrent requests (double click, transport retry) queue here; the second one replays the first.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||p_request_id::text,337));
 s:=runtime_session_results_session(p_actor_id,p_session_id);
 SELECT * INTO t FROM turns WHERE id=p_turn_id AND actor_id=p_actor_id AND session_id=s.id FOR SHARE;
 IF t.id IS NULL OR t.state<>'closed' OR t.close_kind IS DISTINCT FROM 'completed' THEN
  RAISE EXCEPTION 'SESSION_RESULT_SOURCE' USING ERRCODE='42501';END IF;
 SELECT content INTO reply FROM session_messages WHERE session_id=s.id AND turn_id=t.id AND role='assistant' AND visible AND deleted_at IS NULL
  ORDER BY seq DESC LIMIT 1;
 IF reply IS NULL THEN RAISE EXCEPTION 'SESSION_RESULT_SOURCE' USING ERRCODE='42501';END IF;
 saved:=coalesce(p_excerpt,reply);
 IF btrim(saved)='' OR char_length(saved)>20000 OR position(saved IN reply)=0
  OR p_result_type NOT IN ('script','storyboard','editing','body','topic_list','copy') THEN
  RAISE EXCEPTION 'SESSION_RESULT_INVALID' USING ERRCODE='22023';
 END IF;
 clean:=runtime_session_result_title(p_title,saved);
 IF char_length(clean)>80 OR clean ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'SESSION_RESULT_INVALID' USING ERRCODE='22023';END IF;
 SELECT * INTO r FROM runtime_session_results WHERE actor_id=p_actor_id AND request_id=p_request_id;
 IF FOUND THEN
  -- The title is not part of the identity of a save: the same reply, type and text saved again keeps its first title.
  IF r.session_id<>s.id OR r.source_turn_id IS DISTINCT FROM t.id OR r.version<>1 OR r.result_type<>p_result_type
   OR r.body<>saved THEN RAISE EXCEPTION 'SESSION_RESULT_REQUEST_CONFLICT' USING ERRCODE='23505';END IF;
 ELSE
  IF (SELECT count(*) FROM runtime_session_results WHERE session_id=s.id AND version=1)>=200 THEN
   RAISE EXCEPTION 'SESSION_RESULT_LIMIT' USING ERRCODE='54000';END IF;
  r.id:=gen_random_uuid();
  INSERT INTO runtime_session_results(id,actor_id,session_id,family_id,version,result_type,title,body,source_turn_id,request_id)
   VALUES(r.id,p_actor_id,s.id,r.id,1,p_result_type,clean,saved,t.id,p_request_id) RETURNING * INTO r;
 END IF;
 RETURN runtime_session_result_turn_view(r,(SELECT count(*)::integer FROM runtime_session_results WHERE family_id=r.family_id));
END $function$;

REVOKE ALL ON FUNCTION public.runtime_session_result_turn_view(runtime_session_results,integer) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.runtime_session_result_save_turn(uuid,uuid,bigint,uuid,text,text,text),
 public.runtime_session_results_list_turns(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.runtime_session_result_save_turn(uuid,uuid,bigint,uuid,text,text,text),
 public.runtime_session_results_list_turns(uuid,uuid) TO service_role;
