/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Additive foundation for the positioning-to-topic workspace decided by the
-- Owner (comment 5748406396, architecture 5.1/5.2/6):
--   * one persisted, actor-isolated binding per draft that freezes the
--     confirmed positioning version, the pinned method revision and its
--     declared topic resources, plus a dedicated Runtime Session;
--   * a topic turn identity (`opc_turns.purpose='topic'`) that authorizes only
--     that bound Session/Skill/Revision to reserve and dispatch through BILL2;
--   * fail closed when the pinned method declares no topic resources, so the
--     host never invents a topic Skill or silently degrades to plain chat.
-- The positioning draft Session, the existing plan request identity and the
-- existing paid requests are untouched. No new Runtime, ledger or billing
-- mechanism is introduced.
BEGIN;

-- A topic turn is a first-class OPC turn; the existing positioning turns keep
-- their own purposes and identities.
ALTER TABLE opc_turns DROP CONSTRAINT IF EXISTS opc_turns_purpose_check;
ALTER TABLE opc_turns ADD CONSTRAINT opc_turns_purpose_check CHECK(purpose IN ('step','mentor','plan','topic'));

CREATE TABLE IF NOT EXISTS opc_topic_workspaces (
 draft_id uuid PRIMARY KEY REFERENCES opc_drafts(draft_id),actor_id uuid NOT NULL REFERENCES profiles(id),
 request_id uuid NOT NULL,source_version_id uuid NOT NULL REFERENCES artifact_versions(id),source_hash text NOT NULL,
 module_id uuid NOT NULL,skill_id uuid NOT NULL,revision_id uuid NOT NULL,package_hash text NOT NULL,
 session_id uuid NOT NULL UNIQUE REFERENCES runtime_sessions(id),material_revision bigint NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE opc_topic_workspaces ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON opc_topic_workspaces FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS artifact_immutable ON opc_topic_workspaces;
CREATE TRIGGER artifact_immutable BEFORE UPDATE OR DELETE ON opc_topic_workspaces FOR EACH ROW EXECUTE FUNCTION artifact_immutable();

-- The topic Scope is allowed only for a draft the actor owns, and only while
-- its binding is either not yet created or still points at an allowed source.
DO $$ BEGIN
 IF to_regprocedure('bill2_scope_allowed_before_topic(uuid,jsonb)') IS NULL THEN ALTER FUNCTION bill2_scope_allowed(uuid,jsonb) RENAME TO bill2_scope_allowed_before_topic;END IF;
END $$;
CREATE OR REPLACE FUNCTION bill2_scope_allowed(a uuid,s jsonb) RETURNS boolean LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT bill2_scope_allowed_before_topic(a,s) OR (
  s->>'kind'='positioning_topic' AND (s?'draftId') AND NOT(s?'projectId') AND NOT(s?'workItemId') AND NOT(s?'account')
  AND EXISTS(
   SELECT 1 FROM opc_drafts d WHERE d.draft_id=(s->>'draftId')::uuid AND d.actor_id=a
   AND (NOT EXISTS(SELECT 1 FROM opc_topic_workspaces t WHERE t.draft_id=d.draft_id)
    OR EXISTS(SELECT 1 FROM opc_topic_workspaces t WHERE t.draft_id=d.draft_id AND t.actor_id=a AND opc_source_allowed(a,t.source_version_id)))))
$$;
REVOKE ALL ON FUNCTION bill2_scope_allowed_before_topic(uuid,jsonb),bill2_scope_allowed(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- Dispatch stays impossible unless this exact Session, turn, method revision
-- and frozen material revision agree. A revoked source, an unbound draft, a
-- substituted Skill or an ordinary model selection is refused before any
-- reservation is created.
DO $$ BEGIN
 IF to_regprocedure('runtime_direct_billing_allowed_before_topic(uuid,jsonb,uuid)') IS NULL THEN ALTER FUNCTION runtime_direct_billing_allowed(uuid,jsonb,uuid) RENAME TO runtime_direct_billing_allowed_before_topic;END IF;
END $$;
CREATE OR REPLACE FUNCTION runtime_direct_billing_allowed(a uuid,p jsonb,p_run_id uuid) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE t opc_topic_workspaces;
BEGIN
 PERFORM runtime_direct_billing_allowed_before_topic(a,p,p_run_id);
 IF p->'scope'->>'kind'='positioning_topic' THEN
  SELECT * INTO t FROM opc_topic_workspaces WHERE draft_id=(p->'scope'->>'draftId')::uuid AND actor_id=a;
  IF t.draft_id IS NULL THEN RAISE EXCEPTION 'OPC_TOPIC_UNBOUND';END IF;
  IF NOT opc_source_allowed(a,t.source_version_id) THEN RAISE EXCEPTION 'OPC_TOPIC_SOURCE_REVOKED';END IF;
  IF NOT EXISTS(SELECT 1 FROM opc_turns o WHERE o.draft_id=t.draft_id AND o.session_id=t.session_id AND o.purpose='topic'
   AND o.token::text=p->'input'->>'opcTurnToken' AND o.request_id::text=p->'input'->'request'->>'requestId'
   AND o.material_revision::text=p->'input'->'scopeMaterial'->>'revision'
   AND p->'input'->'scopeMaterial'->>'sessionId'=t.session_id::text) THEN RAISE EXCEPTION 'OPC_TOPIC_TURN_REQUIRED';END IF;
  IF p->>'moduleId' IS DISTINCT FROM t.module_id::text OR p->>'revisionId' IS DISTINCT FROM t.revision_id::text
   OR p->'input'->>'role' IS DISTINCT FROM 'skill' OR p->'scope'->>'draftId' IS DISTINCT FROM t.draft_id::text
   THEN RAISE EXCEPTION 'OPC_TOPIC_SKILL_REQUIRED';END IF;
 END IF;
END $$;
REVOKE ALL ON FUNCTION runtime_direct_billing_allowed_before_topic(uuid,jsonb,uuid),runtime_direct_billing_allowed(uuid,jsonb,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Bind the topic workspace of one draft. Idempotent on its own request id and
-- immutable afterwards: a different request or source is a definite conflict
-- instead of a silent rebind onto a newer positioning version.
CREATE OR REPLACE FUNCTION opc_topic_bind(p_actor_id uuid,p_draft_id uuid,p_request_id uuid,p_source_version_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d opc_drafts;ap artifact_projects;r artifact_rounds;v artifact_versions;w opc_topic_workspaces;s runtime_sessions;m runtime_scope_material;binding jsonb;mat jsonb;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 IF p_request_id IS NULL OR p_source_version_id IS NULL THEN RAISE EXCEPTION 'OPC_TOPIC_INPUT';END IF;
 SELECT * INTO d FROM opc_drafts WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
 IF d.draft_id IS NULL THEN RAISE EXCEPTION 'OPC_DENIED';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(d.draft_id::text,113));
 SELECT * INTO w FROM opc_topic_workspaces WHERE draft_id=d.draft_id;
 IF w.draft_id IS NOT NULL THEN
  IF w.request_id IS DISTINCT FROM p_request_id THEN RAISE EXCEPTION 'OPC_TOPIC_BOUND';END IF;
  IF w.source_version_id IS DISTINCT FROM p_source_version_id THEN RAISE EXCEPTION 'OPC_TOPIC_SOURCE_CHANGED';END IF;
  RETURN jsonb_build_object('bound',true,'sessionId',w.session_id,'sourceVersionId',w.source_version_id,'moduleId',w.module_id,'revisionId',w.revision_id,'materialRevision',w.material_revision);
 END IF;
 SELECT * INTO ap FROM artifact_projects WHERE id=d.project_id AND actor_id=p_actor_id;
 SELECT * INTO r FROM artifact_rounds WHERE id=d.round_id AND project_id=d.project_id;
 SELECT * INTO v FROM artifact_versions WHERE id=p_source_version_id AND project_id=d.project_id;
 IF ap.id IS NULL OR r.id IS NULL OR r.state<>'published' OR v.id IS NULL OR v.version<>ap.current_version
  OR NOT opc_source_allowed(p_actor_id,v.id) THEN RAISE EXCEPTION 'OPC_TOPIC_SOURCE_DENIED';END IF;
 -- The pinned method revision is the only authority for the topic resources.
 IF r.workflow->'planResources' IS NULL OR jsonb_typeof(r.workflow->'planResources') IS DISTINCT FROM 'array'
  OR jsonb_array_length(r.workflow->'planResources')=0 THEN RAISE EXCEPTION 'OPC_TOPIC_SKILL_MISSING';END IF;
 SELECT * INTO s FROM runtime_sessions WHERE actor_id=p_actor_id AND scope=jsonb_build_object('kind','positioning_topic','draftId',d.draft_id);
 IF s.id IS NULL THEN
  binding:=runtime_start(p_actor_id,p_request_id,jsonb_build_object('scope',jsonb_build_object('kind','positioning_topic','draftId',d.draft_id)));
  s.id:=(binding->>'sessionId')::uuid;
 END IF;
 SELECT * INTO m FROM runtime_scope_material WHERE session_id=s.id ORDER BY revision DESC LIMIT 1;
 IF m.session_id IS NULL THEN
  -- The concise confirmed positioning content is assembled server-side from the
  -- authorized version; the user never has to paste positioning again.
  mat:=runtime_material(p_actor_id,s.id,'save',p_request_id,0,jsonb_build_object('brief','topic:first-week','material',coalesce(opc_profile(v.id)::text,''),'roundId',NULL));
  m.revision:=(mat->>'revision')::bigint;
 ELSIF m.request_id IS DISTINCT FROM p_request_id THEN RAISE EXCEPTION 'OPC_TOPIC_BOUND';
 END IF;
 INSERT INTO opc_topic_workspaces(draft_id,actor_id,request_id,source_version_id,source_hash,module_id,skill_id,revision_id,package_hash,session_id,material_revision)
 VALUES(d.draft_id,p_actor_id,p_request_id,v.id,coalesce(v.report_hash,''),ap.module_id,ap.skill_id,r.revision_id,r.package_hash,s.id,m.revision)
 ON CONFLICT(draft_id) DO NOTHING RETURNING * INTO w;
 IF w.draft_id IS NULL THEN SELECT * INTO w FROM opc_topic_workspaces WHERE draft_id=d.draft_id;END IF;
 IF w.request_id IS DISTINCT FROM p_request_id OR w.source_version_id IS DISTINCT FROM p_source_version_id THEN RAISE EXCEPTION 'OPC_TOPIC_BOUND';END IF;
 RETURN jsonb_build_object('bound',true,'sessionId',w.session_id,'sourceVersionId',w.source_version_id,'moduleId',w.module_id,'revisionId',w.revision_id,'materialRevision',w.material_revision);
END $$;

-- Read the binding of one owned draft. Another actor's draft is a denied read,
-- never a different actor's workspace.
CREATE OR REPLACE FUNCTION opc_topic_read(p_actor_id uuid,p_draft_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d opc_drafts;w opc_topic_workspaces;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO d FROM opc_drafts WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
 IF d.draft_id IS NULL THEN RAISE EXCEPTION 'OPC_DENIED';END IF;
 SELECT * INTO w FROM opc_topic_workspaces WHERE draft_id=d.draft_id AND actor_id=p_actor_id;
 IF w.draft_id IS NULL THEN RETURN jsonb_build_object('bound',false);END IF;
 RETURN jsonb_build_object('bound',true,'sessionId',w.session_id,'sourceVersionId',w.source_version_id,
  'sourceAllowed',opc_source_allowed(p_actor_id,w.source_version_id),'moduleId',w.module_id,'revisionId',w.revision_id,
  'packageHash',w.package_hash,'materialRevision',w.material_revision,'createdAt',w.created_at,
  'profile',CASE WHEN opc_source_allowed(p_actor_id,w.source_version_id) THEN opc_profile(w.source_version_id) ELSE NULL END);
END $$;

-- Materialize the identity of one topic turn together with its provider-free
-- preflight: a bound workspace, an allowed source, the exact pinned material
-- revision and the bound module/revision. The returned turn token is the only
-- thing that lets the Runtime reserve this turn's billing run.
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
 SELECT * INTO m FROM runtime_scope_material WHERE session_id=w.session_id ORDER BY revision DESC LIMIT 1;
 IF m.session_id IS NULL OR m.revoked THEN RAISE EXCEPTION 'OPC_TOPIC_MATERIAL_MISSING';END IF;
 SELECT * INTO r FROM artifact_rounds WHERE id=(SELECT round_id FROM opc_drafts WHERE draft_id=w.draft_id);
 IF r.id IS NULL THEN RAISE EXCEPTION 'OPC_TOPIC_UNBOUND';END IF;
 INSERT INTO opc_turns(draft_id,session_id,request_id,round_id,step_id,purpose,material_revision,input_hash)
  VALUES(w.draft_id,w.session_id,p_request_id,r.id,'topic','topic',m.revision,h) RETURNING * INTO o;
 RETURN jsonb_build_object('revision',o.material_revision,'turnToken',o.token,'sessionId',w.session_id,
  'moduleId',w.module_id,'skillId',w.skill_id,'revisionId',w.revision_id,'sourceVersionId',w.source_version_id);
END $$;

DO $$ DECLARE f record;BEGIN
 FOR f IN SELECT oid::regprocedure sig,proname FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('opc_topic_bind','opc_topic_read','opc_topic_material') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.sig);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.sig);
 END LOOP;
END $$;
COMMIT;
