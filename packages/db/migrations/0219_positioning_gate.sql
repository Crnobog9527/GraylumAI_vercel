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
-- published version and its project but keeps the business pointer, so both must still be live.
-- Any one confirmed business is enough. The existing UNIQUE(actor_id,id) index (0117) serves the lookup.
CREATE OR REPLACE FUNCTION public.opc_has_confirmed_positioning(p_actor_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM opc_businesses b
  JOIN artifact_versions v ON v.id=b.current_source_version_id AND v.erased_at IS NULL
  JOIN artifact_projects p ON p.id=v.project_id AND p.erased_at IS NULL AND p.actor_id=p_actor_id
  WHERE b.actor_id=p_actor_id AND b.erased_at IS NULL);
$$;
REVOKE ALL ON FUNCTION public.opc_has_confirmed_positioning(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.opc_has_confirmed_positioning(uuid) TO service_role;
COMMIT;
