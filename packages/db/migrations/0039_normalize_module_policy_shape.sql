/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

-- Migration: normalize module policy shape
-- Description:
--   Reconcile public.modules RLS policy names and expressions after the
--   boolean flag normalization in 0038. This migration is policy-only: it
--   does not alter columns, change privileges, insert rows, touch prompts, or
--   move data between environments.

DO $$
BEGIN
  IF to_regclass('public.modules') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "modules_select_active" ON public.modules';
    EXECUTE 'DROP POLICY IF EXISTS "Anyone can view active modules" ON public.modules';
    EXECUTE 'DROP POLICY IF EXISTS "modules_select_active_public" ON public.modules';
    EXECUTE 'DROP POLICY IF EXISTS "modules_admin_all" ON public.modules';
    EXECUTE 'DROP POLICY IF EXISTS "modules_select_admin" ON public.modules';
    EXECUTE 'DROP POLICY IF EXISTS "Admins can manage modules" ON public.modules';
    EXECUTE 'DROP POLICY IF EXISTS "Allow read access to modules" ON public.modules';

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
