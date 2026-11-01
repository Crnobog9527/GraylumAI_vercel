-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-10b C1 (number 0447 provisional, the controller fixes it before applying): a work_item conversation moves to kind=chat.
--   opc_work_check        read-only, before a work turn opens: an archived business (OPC_BUSINESS_ARCHIVED), and the video type of a
--                         script request (OPC_VIDEO_TYPE_REQUIRED, runtime_admit's check). Outside turn_open and its closure; the read and
--                         the open are not one transaction (B1): a business archived in between is logged, the turn runs on.
--   opc_work_result_turn  opc_work_result for a turn: same container of the result in artifact_* (version, round and project share one
--                         id), registered in opc_result_links by the turn (0432), so content_erasure_* already covers it. The id is
--                         derived from the account and the turn: a repeated save returns the same version. The Skill is the one Node
--                         froze in policy.workSkill; a turn without one has no Skill result (OPC_SKILL_RESULT_REQUIRED, as before).
--   opc_work_results      whole copy of the current version; also lists a turn's results, each with its turnId.
-- Compatible: nothing calls the new functions yet and old results list as before. Repeatable: CREATE OR REPLACE and grants only.
-- Recovery: re-apply the previous opc_work_results and drop the two functions while no turn result exists; saved results are kept
-- forward only (their links and containers are user data, never deleted by a rollback). No data is written by this migration.

BEGIN;

CREATE OR REPLACE FUNCTION public.opc_work_check(p_actor_id uuid, p_session_id uuid, p_video_required boolean)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s runtime_sessions;
BEGIN
 SELECT * INTO s FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id;
 IF s.id IS NULL THEN RETURN; END IF; -- turn_open refuses another account's conversation
 -- By read only: opc_assert_business_writable takes a row lock, which the read client refuses.
 IF EXISTS(SELECT 1 FROM opc_businesses b WHERE b.id=opc_target_business(p_actor_id,jsonb_build_object('sessionId',p_session_id))
   AND b.actor_id=p_actor_id AND b.archived_at IS NOT NULL) THEN
  RAISE EXCEPTION 'OPC_BUSINESS_ARCHIVED' USING ERRCODE='42501';
 END IF;
 IF p_video_required AND s.scope->>'kind'='work_item' AND opc_item_content_type((s.scope->>'workItemId')::uuid)<>'video' THEN
  RAISE EXCEPTION 'OPC_VIDEO_TYPE_REQUIRED';
 END IF;
END $function$;

CREATE OR REPLACE FUNCTION public.opc_work_result_turn(p_actor_id uuid, p_turn_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t turns;s runtime_sessions;i opc_items;v artifact_versions;l opc_result_links;ev uuid;flow jsonb;report jsonb;descriptor jsonb;
 m uuid;k uuid;rev uuid;body text;rid uuid:=md5('opc-work-result-turn:'||p_actor_id||':'||p_turn_id)::uuid;
BEGIN
 SELECT * INTO t FROM turns WHERE actor_id=p_actor_id AND id=p_turn_id;
 IF t.id IS NULL THEN RAISE EXCEPTION 'OPC_RESULT_DENIED';END IF;
 PERFORM opc_assert_business_writable(p_actor_id,jsonb_build_object('sessionId',t.session_id));
 PERFORM bill2_actor(p_actor_id);
 -- The session first, then the turn (turn_open's order): a delete that marked this conversation is visible below, one that waits
 -- sees the link committed and cleans it; two saves of one turn take turns on its row.
 SELECT * INTO s FROM runtime_sessions WHERE id=t.session_id AND actor_id=p_actor_id FOR SHARE;
 SELECT * INTO t FROM turns WHERE actor_id=p_actor_id AND id=p_turn_id FOR UPDATE;
 SELECT * INTO i FROM opc_items WHERE work_item_id=(s.scope->>'workItemId')::uuid;
 l.turn_actor_id:=p_actor_id;l.turn_id:=p_turn_id;
 SELECT string_agg(content,E'\n\n' ORDER BY seq) INTO body FROM session_messages
  WHERE session_id=s.id AND turn_id=p_turn_id AND role='assistant' AND visible;
 IF i.work_item_id IS NULL OR t.kind<>'chat' OR t.close_kind IS DISTINCT FROM 'completed' OR NOT opc_result_link_available(l)
   OR coalesce(body,'')='' THEN RAISE EXCEPTION 'OPC_RESULT_DENIED';END IF;
 m:=(t.policy#>>'{workSkill,moduleId}')::uuid;k:=(t.policy#>>'{workSkill,skillId}')::uuid;rev:=(t.policy#>>'{workSkill,revisionId}')::uuid;
 IF m IS NULL OR k IS NULL OR rev IS NULL THEN RAISE EXCEPTION 'OPC_SKILL_RESULT_REQUIRED';END IF;
 descriptor:=read_skill_package(p_actor_id,m,k,rev,NULL,NULL);
 SELECT * INTO v FROM artifact_versions WHERE id=rid;
 IF v.id IS NULL THEN
  INSERT INTO artifact_projects(id,actor_id,module_id,skill_id,work_kind,source_project_id,work_title,current_version)
   VALUES(rid,p_actor_id,m,k,'result',i.work_item_id,'Skill 成果',1);
  flow:=jsonb_build_object('id','runtime-result','version',1,'kind','document','steps','[]'::jsonb,'report',jsonb_build_object('id','result','version',1,'title','Skill 成果','sections','[]'::jsonb));
  INSERT INTO artifact_rounds(id,project_id,revision_id,package_hash,workflow,workflow_hash,template_hash,state,steps)
   VALUES(rid,rid,rev,descriptor->>'packageHash',flow,artifact_hash(flow),artifact_hash(flow->'report'),'published','{}');
  ev:=gen_random_uuid();INSERT INTO artifact_evidence(id,project_id,kind,payload,content_hash) VALUES(ev,rid,'user',jsonb_build_object('turnId',p_turn_id),artifact_hash(to_jsonb(body)));
  INSERT INTO artifact_evidence_restrictions(evidence_id) VALUES(ev);
  INSERT INTO opc_result_links(evidence_id,turn_actor_id,turn_id,round_id,step_id) VALUES(ev,p_actor_id,p_turn_id,rid,'result');
  report:=jsonb_build_object('title','Skill 成果','sections',jsonb_build_array(jsonb_build_object('title','正文','stepId','result','body',body)),'turnId',p_turn_id);
  INSERT INTO artifact_versions(id,project_id,round_id,version,report,report_hash,evidence_ids) VALUES(rid,rid,rid,1,report,artifact_hash(report),jsonb_build_array(ev)) RETURNING * INTO v;
 END IF;
 RETURN jsonb_build_object('artifactId',v.id,'version',v.version);
END $function$;

CREATE OR REPLACE FUNCTION public.opc_work_results(p_actor_id uuid, p_session_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s runtime_sessions;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO s FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id;
 IF s.id IS NULL OR (s.content_deleted_at IS NULL AND NOT bill2_scope_allowed(p_actor_id,s.scope)) THEN RAISE EXCEPTION 'OPC_DENIED';END IF;
 RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('artifactId',v.id,'version',v.version,'sourceAvailable',artifact_evidence_allowed(v.project_id,v.evidence_ids),'body',CASE WHEN content_erasure_artifact_readable(p_actor_id,v.id) THEN v.report->'sections'->0->>'body' ELSE NULL END,'turnId',v.report->'turnId') ORDER BY v.created_at),'[]') FROM artifact_versions v
  -- CORE-PATH-V2 V2-10b: an old result's version is its execution; a turn's is named by its link (opc_work_result_turn).
  WHERE v.id IN (SELECT e.id FROM runtime_executions e WHERE e.session_id=s.id
   UNION ALL SELECT l.round_id FROM turns t JOIN opc_result_links l ON l.turn_actor_id=t.actor_id AND l.turn_id=t.id
    WHERE t.actor_id=p_actor_id AND t.session_id=s.id AND l.step_id='result'));
END $function$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['opc_work_check(uuid,uuid,boolean)','opc_work_result_turn(uuid,bigint)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated, service_role', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $$;

COMMIT;
