-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- SKILL-I18N-HOOK: the administrator's display translations for the Skill text users see (step names,
-- field names, the report title and report section titles). The published workflow stays in Simplified
-- Chinese, the only original; a missing translation falls back to it. No data is seeded. No remote application.
BEGIN;

-- Stored on modules like social_media_related (0219): editing a translation never republishes the Skill,
-- and artifact_workflows.workflow (immutable, frozen into each round) never changes.
-- Shape (checked by packages/api/src/shared/skillTranslations.ts):
--   {"en":{"reportTitle":{"original":"…","text":"…"},"steps":{"<stepId>":{"original":"…","text":"…"}},
--    "fields":{"<stepId>":{"<fieldId>":{"original":"…","text":"…"}}},"reportSections":{"<original>":"…"}}}
-- Each translation keeps the Chinese it was made for; after a republish changes that text it is not shown.
ALTER TABLE public.modules ADD COLUMN IF NOT EXISTS display_translations jsonb NOT NULL DEFAULT '{}'::jsonb;
COMMENT ON COLUMN public.modules.display_translations IS
 'SKILL-I18N-HOOK: per-locale display translations of user-visible Skill labels; the workflow stays the Chinese original.';
-- 2 MB covers the largest translation set the API accepts (32 steps x 24 fields, 64 report sections, each with a
-- 160-character original and translation), so a valid save never fails here.
ALTER TABLE public.modules DROP CONSTRAINT IF EXISTS modules_display_translations_shape;
ALTER TABLE public.modules ADD CONSTRAINT modules_display_translations_shape CHECK (
 jsonb_typeof(display_translations)='object' AND octet_length(display_translations::text)<=2097152);
-- Client roles have an explicit public-column allowlist; never grant this column to them.
REVOKE SELECT (display_translations), INSERT (display_translations), UPDATE (display_translations),
 REFERENCES (display_translations) ON public.modules FROM anon, authenticated;

-- The labels being translated come from the module's one enabled published workflow. artifact_workflows is closed
-- to every client role including service_role (0067), so administrators read it only through this function,
-- which returns that workflow and nothing else (no package files), or NULL before the first publication.
CREATE OR REPLACE FUNCTION public.admin_skill_display_workflow(p_actor_id uuid,p_module_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND role='admin' AND status='active' AND is_deleted='false') THEN
  RAISE EXCEPTION 'administrator required' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM modules WHERE id=p_module_id) THEN
  RAISE EXCEPTION 'SKILL_TRANSLATIONS_MODULE_NOT_FOUND' USING ERRCODE='P0001'; END IF;
 IF (SELECT count(*) FROM artifact_workflows WHERE module_id=p_module_id AND enabled)>1 THEN
  RAISE EXCEPTION 'ambiguous workflow' USING ERRCODE='P0001'; END IF;
 RETURN (SELECT workflow FROM artifact_workflows WHERE module_id=p_module_id AND enabled);
END $$;
REVOKE ALL ON FUNCTION public.admin_skill_display_workflow(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.admin_skill_display_workflow(uuid,uuid) TO service_role;
COMMIT;
