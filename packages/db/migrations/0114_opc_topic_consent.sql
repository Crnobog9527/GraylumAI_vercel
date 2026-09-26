/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Explicit consent persists one first-turn intent per immutable workspace.
-- Existing bindings alone are not consent. Old turns and paid requests remain intact.
BEGIN;
CREATE TABLE IF NOT EXISTS opc_topic_openings (
 draft_id uuid PRIMARY KEY REFERENCES opc_topic_workspaces(draft_id),
 request_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
 input text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE opc_topic_openings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON opc_topic_openings FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS artifact_immutable ON opc_topic_openings;
CREATE TRIGGER artifact_immutable BEFORE UPDATE OR DELETE ON opc_topic_openings FOR EACH ROW EXECUTE FUNCTION artifact_immutable();

CREATE OR REPLACE FUNCTION opc_topic_consent(p_actor_id uuid,p_draft_id uuid,p_source_version_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE w opc_topic_workspaces; result jsonb;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 IF NOT EXISTS(SELECT 1 FROM opc_drafts WHERE draft_id=p_draft_id AND actor_id=p_actor_id) THEN RAISE EXCEPTION 'OPC_DENIED';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_draft_id::text,113));
 SELECT * INTO w FROM opc_topic_workspaces WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
 IF w.draft_id IS NOT NULL AND w.source_version_id IS DISTINCT FROM p_source_version_id THEN RAISE EXCEPTION 'OPC_TOPIC_SOURCE_CHANGED';END IF;
 IF NOT opc_source_allowed(p_actor_id,p_source_version_id) THEN RAISE EXCEPTION 'OPC_TOPIC_SOURCE_DENIED';END IF;
 result:=opc_topic_bind(p_actor_id,p_draft_id,coalesce(w.request_id,gen_random_uuid()),p_source_version_id);
 -- Upgraded workspaces with any prior topic turn already started their work.
 -- Do not append an automatic opening to an existing conversation.
 IF NOT EXISTS(SELECT 1 FROM opc_turns t JOIN opc_topic_workspaces b ON b.session_id=t.session_id WHERE b.draft_id=p_draft_id AND t.purpose='topic') THEN
  INSERT INTO opc_topic_openings(draft_id,input) VALUES(p_draft_id,'请根据已确认的定位和选题方法，提出第一周选题候选；区分已确认事实与建议，缺少必要信息时先问我。') ON CONFLICT(draft_id) DO NOTHING;
 END IF;
 RETURN opc_topic_read(p_actor_id,p_draft_id);
END $$;

DO $$ BEGIN
 IF to_regprocedure('opc_topic_read_before_opening(uuid,uuid)') IS NULL THEN ALTER FUNCTION opc_topic_read(uuid,uuid) RENAME TO opc_topic_read_before_opening;END IF;
END $$;
CREATE OR REPLACE FUNCTION opc_topic_read(p_actor_id uuid,p_draft_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;w opc_topic_workspaces;o opc_topic_openings;v artifact_versions;
BEGIN
 result:=opc_topic_read_before_opening(p_actor_id,p_draft_id);
 IF NOT (result->>'bound')::boolean THEN RETURN result;END IF;
 SELECT * INTO w FROM opc_topic_workspaces WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
 SELECT * INTO v FROM artifact_versions WHERE id=w.source_version_id;
 SELECT * INTO o FROM opc_topic_openings WHERE draft_id=p_draft_id;
 RETURN result||jsonb_build_object('sourceRoundId',v.round_id,'sourceVersion',v.version,
  'opening',CASE WHEN o.request_id IS NOT NULL THEN jsonb_build_object('draftId',p_draft_id,'requestId',o.request_id,'input',o.input,'executionId',(SELECT e.id FROM runtime_executions e WHERE e.session_id=w.session_id AND e.request_id=o.request_id)) ELSE NULL END);
END $$;
REVOKE ALL ON FUNCTION opc_topic_read_before_opening(uuid,uuid),opc_topic_read(uuid,uuid),opc_topic_consent(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION opc_topic_read(uuid,uuid),opc_topic_consent(uuid,uuid,uuid) TO service_role;
CREATE OR REPLACE FUNCTION opc_topic_material(p_actor_id uuid,p_draft_id uuid,p_request_id uuid,p_input text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE w opc_topic_workspaces;r artifact_rounds;m runtime_scope_material;o opc_turns;h text;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 IF p_request_id IS NULL OR p_input IS NULL OR char_length(p_input) NOT BETWEEN 1 AND 8000 THEN RAISE EXCEPTION 'OPC_TOPIC_INPUT';END IF;
 SELECT * INTO w FROM opc_topic_workspaces WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
 IF w.draft_id IS NULL THEN RAISE EXCEPTION 'OPC_TOPIC_UNBOUND';END IF;
 PERFORM 1 FROM runtime_sessions WHERE id=w.session_id AND actor_id=p_actor_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'OPC_TOPIC_UNBOUND';END IF;
 IF NOT opc_source_allowed(p_actor_id,w.source_version_id) THEN RAISE EXCEPTION 'OPC_TOPIC_SOURCE_REVOKED';END IF;
 h:=artifact_hash(to_jsonb(p_input));
 SELECT * INTO o FROM opc_turns WHERE session_id=w.session_id AND request_id=p_request_id;
 IF o.token IS NOT NULL THEN
  IF o.purpose IS DISTINCT FROM 'topic' OR o.draft_id IS DISTINCT FROM w.draft_id OR o.input_hash IS DISTINCT FROM h
   THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
  RETURN jsonb_build_object('revision',o.material_revision,'turnToken',o.token,'sessionId',w.session_id,
   'moduleId',w.module_id,'skillId',w.skill_id,'revisionId',w.revision_id,'sourceVersionId',w.source_version_id);
 END IF;
 SELECT * INTO m FROM runtime_scope_material WHERE session_id=w.session_id AND revision=w.material_revision;
 IF m.session_id IS NULL OR m.revoked THEN RAISE EXCEPTION 'OPC_TOPIC_MATERIAL_MISSING';END IF;
 SELECT * INTO r FROM artifact_rounds WHERE id=(SELECT round_id FROM artifact_versions WHERE id=w.source_version_id);
 IF r.id IS NULL THEN RAISE EXCEPTION 'OPC_TOPIC_UNBOUND';END IF;
 INSERT INTO opc_turns(draft_id,session_id,request_id,round_id,step_id,purpose,material_revision,input_hash)
  VALUES(w.draft_id,w.session_id,p_request_id,r.id,'topic','topic',m.revision,h) RETURNING * INTO o;
 RETURN jsonb_build_object('revision',o.material_revision,'turnToken',o.token,'sessionId',w.session_id,
  'moduleId',w.module_id,'skillId',w.skill_id,'revisionId',w.revision_id,'sourceVersionId',w.source_version_id);
END $$;

REVOKE ALL ON FUNCTION opc_topic_material(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION opc_topic_material(uuid,uuid,uuid,text) TO service_role;
COMMIT;
