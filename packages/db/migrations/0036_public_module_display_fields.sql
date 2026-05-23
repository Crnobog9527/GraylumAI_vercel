-- Migration: public module display fields
-- Description: Codifies public display-only module columns and grants them
-- without exposing prompt internals.

ALTER TABLE public.modules
  ADD COLUMN IF NOT EXISTS image_url text,
  ADD COLUMN IF NOT EXISTS badge_type text,
  ADD COLUMN IF NOT EXISTS badge_text text,
  ADD COLUMN IF NOT EXISTS credits_display text,
  ADD COLUMN IF NOT EXISTS link_url text,
  ADD COLUMN IF NOT EXISTS link_module_id uuid;

COMMENT ON COLUMN public.modules.image_url IS 'Public display image URL for featured module cards';
COMMENT ON COLUMN public.modules.badge_type IS 'Public display badge type for featured module cards';
COMMENT ON COLUMN public.modules.badge_text IS 'Public display badge text for featured module cards';
COMMENT ON COLUMN public.modules.credits_display IS 'Public display credit text for featured module cards';
COMMENT ON COLUMN public.modules.link_url IS 'Public display link URL for featured module cards';
COMMENT ON COLUMN public.modules.link_module_id IS 'Public display linked module id for featured module cards';

REVOKE SELECT ON TABLE public.modules FROM anon, authenticated;
REVOKE SELECT (
  model_id,
  prompt_content,
  system_prompt,
  user_prompt_template,
  created_by
) ON TABLE public.modules FROM anon, authenticated;

GRANT SELECT (
  id,
  title,
  description,
  full_description,
  icon,
  category,
  platform,
  features,
  examples,
  preparation_questions,
  usage_count,
  credits_multiplier,
  sort_order,
  is_featured,
  active,
  created_at,
  updated_at,
  image_url,
  badge_type,
  badge_text,
  credits_display,
  link_url,
  link_module_id
) ON TABLE public.modules TO anon, authenticated;
