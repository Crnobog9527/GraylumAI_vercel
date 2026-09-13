/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
BEGIN;
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS agent_slice_mode boolean NOT NULL DEFAULT false;
UPDATE conversations c SET agent_slice_mode=true WHERE EXISTS(SELECT 1 FROM agent_slice_executions e WHERE e.conversation_id=c.id) AND NOT c.agent_slice_mode;
DO $$ BEGIN
 IF to_regprocedure('public.agent_slice_begin_before_entry(uuid,uuid,uuid,jsonb)') IS NULL THEN
  ALTER FUNCTION public.agent_slice_begin(uuid,uuid,uuid,jsonb) RENAME TO agent_slice_begin_before_entry;
 END IF;
END $$;
REVOKE ALL ON FUNCTION public.agent_slice_begin_before_entry(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.agent_slice_begin(p_actor_id uuid,p_conversation_id uuid,p_request_id uuid,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM conversations WHERE id=p_conversation_id AND user_id=p_actor_id AND agent_slice_mode AND is_deleted='false') THEN RAISE EXCEPTION 'slice denied' USING ERRCODE='42501'; END IF;
 RETURN agent_slice_begin_before_entry(p_actor_id,p_conversation_id,p_request_id,p_payload);
END $$;
REVOKE ALL ON FUNCTION public.agent_slice_begin(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.agent_slice_begin(uuid,uuid,uuid,jsonb) TO service_role;
DROP TRIGGER IF EXISTS agent_slice_mode_immutable ON public.conversations;
CREATE TRIGGER agent_slice_mode_immutable BEFORE UPDATE OF agent_slice_mode ON public.conversations FOR EACH ROW WHEN (OLD.agent_slice_mode IS DISTINCT FROM NEW.agent_slice_mode) EXECUTE FUNCTION public.artifact_immutable();
CREATE OR REPLACE FUNCTION public.agent_slice_open(p_actor_id uuid,p_request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false') THEN RAISE EXCEPTION 'slice denied' USING ERRCODE='42501'; END IF;
 INSERT INTO conversations(id,user_id,title,agent_slice_mode) VALUES(p_request_id,p_actor_id,'连续创作',true) ON CONFLICT(id) DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM conversations WHERE id=p_request_id AND user_id=p_actor_id AND agent_slice_mode AND is_deleted='false') THEN RAISE EXCEPTION 'slice denied' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('conversationId',p_request_id);
END $$;
-- Public configuration and owned active drafts only. No method files or bodies.
CREATE OR REPLACE FUNCTION public.agent_slice_targets(p_actor_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE item record; result jsonb:='[]';
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false') THEN RAISE EXCEPTION 'slice denied' USING ERRCODE='42501'; END IF;
 FOR item IN SELECT p.id project_id,p.module_id,p.skill_id,p.work_title,r.id round_id,r.revision_id,r.workflow,r.steps,c.id pair_id,source.account,
  CASE WHEN w.id=c.script_workflow THEN 'script' ELSE 'title' END purpose
  FROM artifact_projects p JOIN artifact_rounds r ON r.project_id=p.id AND r.state='draft'
  JOIN artifact_projects source ON source.id=p.source_project_id AND source.actor_id=p_actor_id
  JOIN artifact_workflows w ON w.module_id=p.module_id AND w.skill_id=p.skill_id AND w.workflow->>'id'=r.workflow->>'id' AND w.enabled
  JOIN agent_slice_pairs c ON (c.script_workflow=w.id OR c.title_workflow=w.id) AND c.enabled
  WHERE p.actor_id=p_actor_id AND p.work_kind='script' ORDER BY p.created_at DESC,p.id,c.id LIMIT 100
 LOOP
  BEGIN PERFORM read_skill_package(p_actor_id,item.module_id,item.skill_id,item.revision_id,NULL,NULL);
  EXCEPTION WHEN insufficient_privilege THEN CONTINUE; END;
  result:=result||jsonb_build_array(jsonb_build_object('projectId',item.project_id,'roundId',item.round_id,'pairId',item.pair_id,'purpose',item.purpose,
   'title',coalesce(item.work_title,item.workflow->'report'->>'title','作品'),'account',item.account,
   'steps',(SELECT jsonb_agg(jsonb_build_object('id',s->>'id','title',s->>'title') ORDER BY n) FROM jsonb_array_elements(item.workflow->'steps') WITH ORDINALITY t(s,n))));
 END LOOP;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.agent_slice_open(uuid,uuid),public.agent_slice_targets(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.agent_slice_open(uuid,uuid),public.agent_slice_targets(uuid) TO service_role;
COMMIT;
