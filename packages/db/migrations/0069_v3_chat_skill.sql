/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Additive conversation linkage. No model, account, credential or enable seeds.
BEGIN;
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS skill_mode boolean NOT NULL DEFAULT false;
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS module_id uuid REFERENCES public.modules(id);
CREATE TABLE IF NOT EXISTS public.artifact_chats (
 conversation_id uuid PRIMARY KEY REFERENCES public.conversations(id) ON DELETE CASCADE,
 project_id uuid NOT NULL REFERENCES public.artifact_projects(id),
 round_id uuid NOT NULL UNIQUE REFERENCES public.artifact_rounds(id),
 step_id text NOT NULL
);
CREATE TABLE IF NOT EXISTS public.artifact_chat_turns (
 request_id uuid PRIMARY KEY,
 conversation_id uuid NOT NULL REFERENCES public.artifact_chats(conversation_id) ON DELETE CASCADE,
 step_id text NOT NULL, body text NOT NULL CHECK(char_length(body) BETWEEN 1 AND 2000),
 evidence_ids jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.artifact_chat_turns ADD COLUMN IF NOT EXISTS context_turn_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.artifact_chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.artifact_chat_turns ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.artifact_chats,public.artifact_chat_turns FROM PUBLIC,anon,authenticated,service_role;
-- Chat transport history is deleted with its conversation; independent project
-- results and canonical generation/billing records retain their existing lifetime.
ALTER TABLE public.artifact_chats DROP CONSTRAINT IF EXISTS artifact_chats_conversation_id_fkey;
ALTER TABLE public.artifact_chats ADD CONSTRAINT artifact_chats_conversation_id_fkey FOREIGN KEY(conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;
ALTER TABLE public.artifact_chat_turns DROP CONSTRAINT IF EXISTS artifact_chat_turns_conversation_id_fkey;
ALTER TABLE public.artifact_chat_turns ADD CONSTRAINT artifact_chat_turns_conversation_id_fkey FOREIGN KEY(conversation_id) REFERENCES public.artifact_chats(conversation_id) ON DELETE CASCADE;
CREATE OR REPLACE FUNCTION public.artifact_chat_history_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF TG_TABLE_NAME='artifact_chat_turns' THEN
   IF NOT EXISTS(SELECT 1 FROM conversations WHERE id=OLD.conversation_id) THEN RETURN OLD; END IF;
  ELSIF TG_TABLE_NAME='artifact_chat_summaries' THEN
   IF NOT EXISTS(SELECT 1 FROM artifact_chat_turns WHERE request_id=OLD.turn_id) THEN RETURN OLD; END IF;
  END IF;
 END IF;
 RAISE EXCEPTION 'artifact history immutable';
END $$;
CREATE OR REPLACE FUNCTION public.artifact_chat_delete_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c public.artifact_chats%ROWTYPE;
BEGIN
 SELECT * INTO c FROM artifact_chats WHERE conversation_id=OLD.id;
 IF c.conversation_id IS NOT NULL THEN
  -- Skip a busy project: attach already locks project before conversation.
  -- Waiting here would reverse that order. Preserve unresolved
  -- request context. Returning NULL skips this row, not the rest of a purge.
  PERFORM 1 FROM artifact_projects WHERE id=c.project_id FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF EXISTS(SELECT 1 FROM artifact_generations WHERE project_id=c.project_id AND round_id=c.round_id AND state IN ('prepared','dispatched','unknown','responded')) THEN RETURN NULL; END IF;
 END IF;
 RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS artifact_chat_delete ON public.conversations;
CREATE TRIGGER artifact_chat_delete BEFORE DELETE ON public.conversations FOR EACH ROW EXECUTE FUNCTION public.artifact_chat_delete_guard();
REVOKE ALL ON FUNCTION public.artifact_chat_history_immutable(),public.artifact_chat_delete_guard() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS artifact_immutable ON public.artifact_chat_turns;
CREATE TRIGGER artifact_immutable BEFORE UPDATE OR DELETE ON public.artifact_chat_turns FOR EACH ROW EXECUTE FUNCTION public.artifact_chat_history_immutable();
CREATE OR REPLACE FUNCTION public.artifact_chat_conversation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.module_id IS DISTINCT FROM OLD.module_id THEN RAISE EXCEPTION 'module identity immutable' USING ERRCODE='42501'; END IF;
 IF OLD.skill_mode AND (NEW.skill_mode IS DISTINCT FROM true OR NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
  RAISE EXCEPTION 'skill conversation identity immutable' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS artifact_chat_identity ON public.conversations;
CREATE TRIGGER artifact_chat_identity BEFORE UPDATE ON public.conversations FOR EACH ROW EXECUTE FUNCTION public.artifact_chat_conversation_guard();
CREATE OR REPLACE FUNCTION public.artifact_chat_binding(c public.artifact_chats) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('conversationId',c.conversation_id,'projectId',c.project_id,'roundId',c.round_id,'stepId',c.step_id,'moduleId',p.module_id,'skillId',p.skill_id)
 FROM artifact_projects p WHERE p.id=c.project_id
$$;
CREATE OR REPLACE FUNCTION public.artifact_chat(p_actor_id uuid,p_action text,p_conversation_id uuid DEFAULT NULL,p_payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p public.artifact_projects%ROWTYPE; r public.artifact_rounds%ROWTYPE; c public.artifact_chats%ROWTYPE;
 t public.artifact_chat_turns%ROWTYPE; ids jsonb; turns jsonb; context_basis jsonb; frozen_turn_ids jsonb; result jsonb;
BEGIN
 IF p_payload IS NULL OR octet_length(p_payload::text)>32768 OR NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false') THEN RAISE EXCEPTION 'artifact denied' USING ERRCODE='42501'; END IF;
 IF p_action='stats' THEN
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('conversationId',ch.conversation_id,
   'messageCount',(SELECT count(*)+count(g.candidate_id) FROM artifact_chat_turns a LEFT JOIN artifact_generations g ON g.project_id=ch.project_id AND g.round_id=ch.round_id AND g.request_id=a.request_id WHERE a.conversation_id=ch.conversation_id),
   'creditsUsed',(SELECT coalesce(sum(total_credits),0) FROM token_stats ts JOIN artifact_generations g ON ts.artifact_generation_id=g.id WHERE g.project_id=ch.project_id AND g.round_id=ch.round_id))),'[]')
   FROM artifact_chats ch JOIN artifact_projects ap ON ap.id=ch.project_id WHERE ap.actor_id=p_actor_id);
 END IF;
 IF p_action='mode' THEN
  IF NOT EXISTS(SELECT 1 FROM modules m JOIN skills s ON s.id=m.skill_id WHERE m.id=(p_payload->>'moduleId')::uuid AND m.active AND s.status='published') THEN RAISE EXCEPTION 'module unavailable' USING ERRCODE='42501'; END IF;
  -- A disabled current workflow stays guided/unavailable: do not silently run
  -- its Skill as a plain text method. Historical bindings do not classify a new Skill.
  RETURN jsonb_build_object('guided',EXISTS(SELECT 1 FROM artifact_workflows w JOIN modules m ON m.id=w.module_id AND m.skill_id=w.skill_id WHERE w.module_id=(p_payload->>'moduleId')::uuid));
 END IF;
 IF p_action='attach' THEN
  SELECT * INTO p FROM artifact_projects WHERE id=(p_payload->>'projectId')::uuid AND actor_id=p_actor_id FOR UPDATE;
 ELSE
  SELECT * INTO c FROM artifact_chats WHERE conversation_id=p_conversation_id;
  SELECT * INTO p FROM artifact_projects WHERE id=c.project_id AND actor_id=p_actor_id FOR UPDATE;
 END IF;
 IF p.id IS NULL THEN RAISE EXCEPTION 'artifact denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM artifact_rounds WHERE id=CASE WHEN p_action='attach' THEN (p_payload->>'roundId')::uuid ELSE c.round_id END AND project_id=p.id;
 IF r.id IS NULL THEN RAISE EXCEPTION 'artifact denied' USING ERRCODE='42501'; END IF;
 IF p_action IN ('submit','context') THEN
  PERFORM read_skill_package(p_actor_id,p.module_id,p.skill_id,r.revision_id,r.package_hash,NULL);
 END IF;
 IF p_action='attach' THEN
  SELECT * INTO c FROM artifact_chats WHERE round_id=r.id;
  IF c.conversation_id IS NULL THEN
   INSERT INTO conversations(id,user_id,title,skill_mode,module_id) VALUES((p_payload->>'requestId')::uuid,p_actor_id,r.workflow->'report'->>'title',true,p.module_id);
   INSERT INTO artifact_chats VALUES((p_payload->>'requestId')::uuid,p.id,r.id,r.workflow->'steps'->0->>'id') RETURNING * INTO c;
  ELSE
   UPDATE conversations SET is_deleted='false',deleted_at=NULL WHERE id=c.conversation_id AND user_id=p_actor_id AND is_deleted='true';
  END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM conversations WHERE id=c.conversation_id AND user_id=p_actor_id AND skill_mode AND is_deleted='false') THEN RAISE EXCEPTION 'artifact denied' USING ERRCODE='42501'; END IF;
 IF p_action='attach' THEN RETURN artifact_chat_binding(c); END IF;
 IF p_action='select' THEN
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.workflow->'steps') s WHERE s->>'id'=p_payload->>'stepId') THEN RAISE EXCEPTION 'step denied' USING ERRCODE='42501'; END IF;
  UPDATE artifact_chats SET step_id=p_payload->>'stepId' WHERE conversation_id=c.conversation_id RETURNING * INTO c;
  RETURN artifact_chat_binding(c);
 END IF;
 IF p_action='submit' THEN
  SELECT * INTO t FROM artifact_chat_turns WHERE request_id=(p_payload->>'requestId')::uuid;
  IF t.request_id IS NOT NULL THEN
   IF t.conversation_id<>c.conversation_id OR t.step_id IS DISTINCT FROM p_payload->>'stepId' OR t.body IS DISTINCT FROM p_payload->>'body' THEN RAISE EXCEPTION 'turn conflict'; END IF;
   RETURN jsonb_build_object('requestId',t.request_id);
  END IF;
  PERFORM read_skill_package(p_actor_id,p.module_id,p.skill_id,r.revision_id,r.package_hash,NULL);
  IF r.state<>'draft' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.workflow->'steps') s WHERE s->>'id'=p_payload->>'stepId') OR artifact_text_length(p_payload->>'body')<1 OR char_length(p_payload->>'body')>2000 THEN RAISE EXCEPTION 'invalid turn'; END IF;
  IF (SELECT count(*) FROM artifact_chat_turns WHERE conversation_id=c.conversation_id)>=256 THEN RAISE EXCEPTION 'conversation capacity'; END IF;
  ids:=artifact_step_evidence(r.workflow,r.steps,p_payload->>'stepId');
  context_basis:=artifact_generation_basis(r.workflow,r.steps,p_payload->>'stepId');
  -- Freeze the actual preceding results as well as their sources. A reply that
  -- completes after submission cannot silently enter this turn's model context.
  SELECT coalesce(jsonb_agg(a.request_id),'[]') INTO frozen_turn_ids FROM artifact_chat_turns a
   JOIN artifact_generations g ON g.project_id=p.id AND g.round_id=r.id AND g.request_id=a.request_id
   WHERE a.conversation_id=c.conversation_id AND context_basis ? a.step_id AND g.state='succeeded'
    -- Removing a source from the rewritten step also removes dependent old
    -- discussion from new model context; readable history remains immutable.
    AND (a.evidence_ids||coalesce(g.evidence_ids,'[]')) <@ ids;
  -- Freeze sources from the same preceding discussions, including model replies.
  SELECT coalesce(jsonb_agg(DISTINCT e),'[]') INTO ids FROM (
   SELECT jsonb_array_elements(ids) e UNION ALL
   SELECT jsonb_array_elements(a.evidence_ids||coalesce(g.evidence_ids,'[]')) FROM artifact_chat_turns a LEFT JOIN artifact_generations g ON g.project_id=p.id AND g.round_id=r.id AND g.request_id=a.request_id WHERE a.conversation_id=c.conversation_id AND frozen_turn_ids ? a.request_id::text
  ) all_sources;
  IF NOT artifact_evidence_allowed(p.id,ids) THEN RAISE EXCEPTION 'evidence denied' USING ERRCODE='42501'; END IF;
  INSERT INTO artifact_chat_turns(request_id,conversation_id,step_id,body,evidence_ids,created_at,context_turn_ids) VALUES((p_payload->>'requestId')::uuid,c.conversation_id,p_payload->>'stepId',p_payload->>'body',ids,clock_timestamp(),frozen_turn_ids);
  UPDATE artifact_chats SET step_id=p_payload->>'stepId' WHERE conversation_id=c.conversation_id;
  RETURN jsonb_build_object('requestId',p_payload->>'requestId');
 END IF;
 IF p_action IN ('read','context') THEN
  IF p_action='context' THEN
   SELECT * INTO t FROM artifact_chat_turns WHERE request_id=(p_payload->>'requestId')::uuid AND conversation_id=c.conversation_id AND step_id=p_payload->>'stepId';
   IF t.request_id IS NULL OR NOT artifact_evidence_allowed(p.id,t.evidence_ids) THEN RAISE EXCEPTION 'turn denied' USING ERRCODE='42501'; END IF;
   context_basis:=artifact_generation_basis(r.workflow,r.steps,t.step_id);
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('requestId',a.request_id,'stepId',a.step_id,
   'body',CASE WHEN artifact_evidence_allowed(p.id,a.evidence_ids) THEN a.body ELSE NULL END,
   'answer',CASE WHEN artifact_evidence_allowed(p.id,a.evidence_ids||coalesce(g.evidence_ids,'[]')) THEN candidate.body ELSE NULL END,
   'available',artifact_evidence_allowed(p.id,a.evidence_ids||coalesce(g.evidence_ids,'[]')),
   'candidateId',g.candidate_id,'createdAt',a.created_at,'generationState',coalesce(g.state,'unsent'),'abandoned',EXISTS(SELECT 1 FROM artifact_requests ar WHERE ar.project_id=p.id AND ar.round_id=r.id AND ar.request_id=a.request_id AND ar.action='generation_abandoned')) ORDER BY a.created_at,a.request_id),'[]') INTO turns
  FROM artifact_chat_turns a LEFT JOIN artifact_generations g ON g.project_id=p.id AND g.round_id=r.id AND g.request_id=a.request_id
  LEFT JOIN artifact_candidates candidate ON candidate.id=g.candidate_id
  WHERE a.conversation_id=c.conversation_id AND (p_action='read' OR (context_basis ? a.step_id AND (a.created_at,a.request_id)<=(t.created_at,t.request_id) AND (a.request_id=t.request_id OR (t.context_turn_ids ? a.request_id::text AND g.state='succeeded'))));
  IF p_action='read' THEN RETURN jsonb_build_object('binding',artifact_chat_binding(c),'turns',turns); END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(turns) x WHERE x->>'available'='false') THEN RAISE EXCEPTION 'context restricted' USING ERRCODE='42501'; END IF;
  -- The current assistant response never becomes its own input on prepared retry.
  SELECT jsonb_agg(CASE WHEN x->>'requestId'=t.request_id::text THEN (x-'generationState'-'abandoned')||'{"answer":null,"candidateId":null}' ELSE x-'generationState'-'abandoned' END ORDER BY ord) INTO turns FROM jsonb_array_elements(turns) WITH ORDINALITY q(x,ord);
  RETURN jsonb_build_object('turns',turns,'evidenceIds',t.evidence_ids,'body',t.body,'binding',artifact_chat_binding(c));
 END IF;
 RAISE EXCEPTION 'invalid chat action';
END $$;
-- Bind the existing generation transaction to its persisted chat turn. Old
-- workbench requests remain valid; no second settlement or messages write exists.
CREATE OR REPLACE FUNCTION public.artifact_chat_generation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c public.artifact_chats%ROWTYPE; t public.artifact_chat_turns%ROWTYPE;
BEGIN
 IF NEW.input->>'conversationId' IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO c FROM artifact_chats WHERE conversation_id=(NEW.input->>'conversationId')::uuid AND project_id=NEW.project_id AND round_id=NEW.round_id;
 SELECT * INTO t FROM artifact_chat_turns WHERE conversation_id=c.conversation_id AND request_id=NEW.request_id AND step_id=NEW.step_id;
 IF c.conversation_id IS NULL OR t.request_id IS NULL OR NEW.input->>'instruction' IS DISTINCT FROM t.body OR NEW.input->>'turnId' IS DISTINCT FROM t.request_id::text THEN RAISE EXCEPTION 'chat generation denied' USING ERRCODE='42501'; END IF;
 IF TG_OP='INSERT' OR (NEW.state='dispatched' AND OLD.state='prepared') THEN
  IF NOT (t.evidence_ids <@ NEW.evidence_ids) OR NOT artifact_evidence_allowed(NEW.project_id,t.evidence_ids) THEN RAISE EXCEPTION 'chat evidence denied' USING ERRCODE='42501'; END IF;
  SELECT coalesce(jsonb_agg(DISTINCT e),'[]') INTO NEW.evidence_ids FROM jsonb_array_elements(NEW.evidence_ids||t.evidence_ids) e;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS artifact_chat_generation_guard ON public.artifact_generations;
CREATE TRIGGER artifact_chat_generation_guard BEFORE INSERT OR UPDATE ON public.artifact_generations FOR EACH ROW EXECUTE FUNCTION public.artifact_chat_generation_guard();
-- Ordinary message endpoints must never become an alternate guided write path.
CREATE OR REPLACE FUNCTION public.artifact_chat_message_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM conversations WHERE id=NEW.conversation_id AND skill_mode) THEN RAISE EXCEPTION 'guided messages require artifact turn' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS artifact_chat_message_guard ON public.messages;
CREATE TRIGGER artifact_chat_message_guard BEFORE INSERT OR UPDATE ON public.messages FOR EACH ROW EXECUTE FUNCTION public.artifact_chat_message_guard();
REVOKE ALL ON FUNCTION public.artifact_chat_message_guard() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.artifact_chat_conversation_guard(),public.artifact_chat_binding(public.artifact_chats),public.artifact_chat(uuid,text,uuid,jsonb),public.artifact_chat_generation_guard() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.artifact_chat(uuid,text,uuid,jsonb) TO service_role;
COMMIT;
