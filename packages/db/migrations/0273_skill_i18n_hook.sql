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
ALTER TABLE public.modules DROP CONSTRAINT IF EXISTS modules_display_translations_shape;
ALTER TABLE public.modules ADD CONSTRAINT modules_display_translations_shape CHECK (
 jsonb_typeof(display_translations)='object' AND octet_length(display_translations::text)<=65536);
-- Client roles have an explicit public-column allowlist; never grant this column to them.
REVOKE SELECT (display_translations), INSERT (display_translations), UPDATE (display_translations),
 REFERENCES (display_translations) ON public.modules FROM anon, authenticated;
COMMIT;
