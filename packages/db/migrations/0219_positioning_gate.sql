-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- POSITIONING-GATE PR1: the administrator's "与社交媒体相关" Skill flag and the one server-side
-- definition of "this user has a confirmed positioning". Nothing reads either yet (PR2 wires the
-- runtime gate). No configuration data is seeded. No remote application.
BEGIN;

-- Stored on modules, the unit administrators edit and Skill matching reads. Not in the published
-- workflow (that changes only by republishing a package) and not in modules.category/platform or
-- artifact_workflows.workflow->>'kind' ('social' there means "saved per account", not gating).
ALTER TABLE public.modules ADD COLUMN IF NOT EXISTS social_media_related boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.modules.social_media_related IS
 'POSITIONING-GATE: users without a confirmed positioning cannot use this Skill. Never set on the positioning Skill itself.';
-- Client roles have an explicit public-column allowlist; never grant this column to them.
REVOKE SELECT (social_media_related), INSERT (social_media_related), UPDATE (social_media_related),
 REFERENCES (social_media_related) ON public.modules FROM anon, authenticated;

-- A positioning counts once it is published (mentor flow, or the R15 "我已有定位" import after its
-- step-by-step confirmation): artifact_transition then sets current_source_version_id (0117).
-- Drafts in progress and erased businesses do not count. Selective content erasure (0201) erases the
-- published version and its project but keeps the business pointer, so both must still be live; deleting
-- the positioning session instead revokes its draft. The source must also pass opc_source_allowed, the
-- same check free conversation uses to read a confirmed positioning (0218), so "has a positioning" here
-- always means one the conversation can actually read. Any one such business is enough. The existing
-- UNIQUE(actor_id,id) index (0117) serves the lookup.
CREATE OR REPLACE FUNCTION public.opc_has_confirmed_positioning(p_actor_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM opc_businesses b
  JOIN artifact_versions v ON v.id=b.current_source_version_id AND v.erased_at IS NULL
  JOIN artifact_projects p ON p.id=v.project_id AND p.erased_at IS NULL AND p.actor_id=p_actor_id
  WHERE b.actor_id=p_actor_id AND b.erased_at IS NULL AND opc_source_allowed(p_actor_id,v.id));
$$;
REVOKE ALL ON FUNCTION public.opc_has_confirmed_positioning(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.opc_has_confirmed_positioning(uuid) TO service_role;
-- The positioning Skill can never be flagged, or users without a positioning could not create one.
-- A positioning workflow is one the positioning entry can start: every step declares information
-- fields and some field feeds the profile (isPositioningWorkflow in services/opc/positioningWorkflow.ts).
CREATE OR REPLACE FUNCTION public.opc_is_positioning_workflow(p_workflow jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT CASE
  WHEN coalesce(jsonb_typeof(p_workflow->'steps'),'')<>'array' OR jsonb_array_length(p_workflow->'steps')=0 THEN false
  WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(p_workflow->'steps') s WHERE CASE
   WHEN jsonb_typeof(s->'information')='array' THEN jsonb_array_length(s->'information')=0 ELSE true END) THEN false
  ELSE EXISTS(SELECT 1 FROM jsonb_array_elements(p_workflow->'steps') s,jsonb_array_elements(s->'information') f
   WHERE jsonb_typeof(f->'profileKey')='string' AND f->>'profileKey'<>'')
 END;
$$;
-- Only the guards below call it, as their owner.
REVOKE ALL ON FUNCTION public.opc_is_positioning_workflow(jsonb) FROM PUBLIC,anon,authenticated,service_role;
-- Both sides are checked, so neither "flag then publish" nor "publish then flag" can break it.
-- Concurrent flag saves and publications serialize on the module row: admin_publish_skill_module locks
-- it FOR UPDATE before inserting the workflow, and the flag UPDATE takes the same row lock; each check
-- then reads the other side's committed state.
CREATE OR REPLACE FUNCTION public.modules_social_media_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.social_media_related AND EXISTS(SELECT 1 FROM artifact_workflows WHERE module_id=NEW.id AND enabled
  AND opc_is_positioning_workflow(workflow)) THEN
  RAISE EXCEPTION 'SOCIAL_MEDIA_FLAG_POSITIONING_SKILL' USING ERRCODE='P0001'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.artifact_workflows_social_media_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.enabled AND opc_is_positioning_workflow(NEW.workflow)
  AND EXISTS(SELECT 1 FROM modules WHERE id=NEW.module_id AND social_media_related) THEN
  RAISE EXCEPTION 'SOCIAL_MEDIA_FLAG_POSITIONING_SKILL' USING ERRCODE='P0001'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.modules_social_media_guard(),public.artifact_workflows_social_media_guard()
 FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS modules_social_media_guard ON public.modules;
CREATE TRIGGER modules_social_media_guard BEFORE INSERT OR UPDATE OF social_media_related ON public.modules
 FOR EACH ROW EXECUTE FUNCTION public.modules_social_media_guard();
DROP TRIGGER IF EXISTS artifact_workflows_social_media_guard ON public.artifact_workflows;
CREATE TRIGGER artifact_workflows_social_media_guard BEFORE INSERT OR UPDATE OF enabled ON public.artifact_workflows
 FOR EACH ROW EXECUTE FUNCTION public.artifact_workflows_social_media_guard();
COMMIT;
