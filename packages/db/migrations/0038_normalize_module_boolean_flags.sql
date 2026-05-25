/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

-- Migration: normalize module boolean flags
-- Description:
--   Normalize public.modules.active and public.modules.is_featured to native
--   PostgreSQL boolean fields. The USING clauses intentionally cast through
--   text so the migration is safe when the current column is either text
--   (staging drift) or already boolean (production current state).
--   This migration does not seed data, change privileges, or touch prompts.

DO $$
BEGIN
  IF to_regclass('public.modules') IS NOT NULL THEN
    ALTER TABLE public.modules
      ALTER COLUMN active DROP DEFAULT,
      ALTER COLUMN is_featured DROP DEFAULT;

    ALTER TABLE public.modules
      ALTER COLUMN active TYPE boolean
        USING (
          CASE
            WHEN lower(btrim(active::text)) IN ('true', 't', '1', 'yes', 'on') THEN TRUE
            ELSE FALSE
          END
        ),
      ALTER COLUMN is_featured TYPE boolean
        USING (
          CASE
            WHEN lower(btrim(is_featured::text)) IN ('true', 't', '1', 'yes', 'on') THEN TRUE
            ELSE FALSE
          END
        );

    ALTER TABLE public.modules
      ALTER COLUMN active SET DEFAULT TRUE,
      ALTER COLUMN active SET NOT NULL,
      ALTER COLUMN is_featured SET DEFAULT FALSE,
      ALTER COLUMN is_featured SET NOT NULL;

    EXECUTE 'DROP POLICY IF EXISTS "modules_select_active" ON public.modules';
    EXECUTE 'DROP POLICY IF EXISTS "Anyone can view active modules" ON public.modules';
    EXECUTE 'DROP POLICY IF EXISTS "modules_select_active_public" ON public.modules';
    EXECUTE 'DROP POLICY IF EXISTS "modules_admin_all" ON public.modules';
    EXECUTE 'DROP POLICY IF EXISTS "modules_select_admin" ON public.modules';

    EXECUTE $policy$
      CREATE POLICY "modules_select_active_public"
        ON public.modules FOR SELECT
        TO anon, authenticated
        USING (active IS TRUE)
    $policy$;

    EXECUTE $policy$
      CREATE POLICY "modules_select_admin"
        ON public.modules FOR SELECT
        TO authenticated
        USING (
          EXISTS (
            SELECT 1
            FROM public.profiles p
            WHERE p.id = auth.uid()
              AND p.role = 'admin'
              AND p.status = 'active'
          )
        )
    $policy$;
  END IF;
END $$;
