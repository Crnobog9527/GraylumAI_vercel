/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

-- Migration: reconcile public module grants
-- Description:
--   Grants-only reconciliation for public.modules anon/authenticated access.
--   This migration does not change data, schema columns, RLS policies, prompt
--   tables, or seed data. Execution against staging or production requires
--   separate owner authorization and an environment-specific preflight/postflight.

DO $$
DECLARE
  module_columns text;
  sensitive_columns text;
BEGIN
  IF to_regclass('public.modules') IS NOT NULL THEN
    EXECUTE 'REVOKE SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.modules FROM anon, authenticated';

    SELECT string_agg(format('%I', attname), ', ' ORDER BY attnum)
      INTO module_columns
    FROM pg_attribute
    WHERE attrelid = 'public.modules'::regclass
      AND attnum > 0
      AND NOT attisdropped;

    IF module_columns IS NOT NULL THEN
      EXECUTE format('REVOKE INSERT (%s) ON TABLE public.modules FROM anon, authenticated', module_columns);
      EXECUTE format('REVOKE UPDATE (%s) ON TABLE public.modules FROM anon, authenticated', module_columns);
      EXECUTE format('REVOKE REFERENCES (%s) ON TABLE public.modules FROM anon, authenticated', module_columns);
    END IF;

    SELECT string_agg(format('%I', attname), ', ' ORDER BY attnum)
      INTO sensitive_columns
    FROM pg_attribute
    WHERE attrelid = 'public.modules'::regclass
      AND attnum > 0
      AND NOT attisdropped
      AND attname::text = ANY (
        ARRAY[
          'model_id',
          'prompt_content',
          'system_prompt',
          'user_prompt_template',
          'created_by'
        ]
      );

    IF sensitive_columns IS NOT NULL THEN
      EXECUTE format('REVOKE SELECT (%s) ON TABLE public.modules FROM anon, authenticated', sensitive_columns);
    END IF;

    EXECUTE $grant$
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
      ) ON TABLE public.modules TO anon, authenticated
    $grant$;
  END IF;
END $$;
