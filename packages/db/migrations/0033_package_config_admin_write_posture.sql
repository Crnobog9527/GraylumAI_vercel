-- Migration: Package config admin write posture
-- Description: Restores privileged write posture for package and membership admin saves.

GRANT INSERT, UPDATE, DELETE ON TABLE public.credit_packages TO service_role;
GRANT INSERT, UPDATE, DELETE ON TABLE public.membership_plans TO service_role;

-- Keep direct client writes closed by default, but define admin-only RLS write
-- policies for authenticated admin sessions if the table grants are expanded in
-- the future. The API admin router still writes through service_role.

DO $$
BEGIN
  IF to_regclass('public.credit_packages') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "credit_packages_admin_insert" ON public.credit_packages';
    EXECUTE 'DROP POLICY IF EXISTS "credit_packages_admin_update" ON public.credit_packages';
    EXECUTE 'DROP POLICY IF EXISTS "credit_packages_admin_delete" ON public.credit_packages';

    EXECUTE $policy$
      CREATE POLICY "credit_packages_admin_insert"
        ON public.credit_packages FOR INSERT
        TO authenticated
        WITH CHECK (
          EXISTS (
            SELECT 1
            FROM public.profiles p
            WHERE p.id = auth.uid()
              AND p.role = 'admin'
              AND p.status = 'active'
          )
        )
    $policy$;

    EXECUTE $policy$
      CREATE POLICY "credit_packages_admin_update"
        ON public.credit_packages FOR UPDATE
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
        WITH CHECK (
          EXISTS (
            SELECT 1
            FROM public.profiles p
            WHERE p.id = auth.uid()
              AND p.role = 'admin'
              AND p.status = 'active'
          )
        )
    $policy$;

    EXECUTE $policy$
      CREATE POLICY "credit_packages_admin_delete"
        ON public.credit_packages FOR DELETE
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

DO $$
BEGIN
  IF to_regclass('public.membership_plans') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "membership_plans_admin_insert" ON public.membership_plans';
    EXECUTE 'DROP POLICY IF EXISTS "membership_plans_admin_update" ON public.membership_plans';
    EXECUTE 'DROP POLICY IF EXISTS "membership_plans_admin_delete" ON public.membership_plans';

    EXECUTE $policy$
      CREATE POLICY "membership_plans_admin_insert"
        ON public.membership_plans FOR INSERT
        TO authenticated
        WITH CHECK (
          EXISTS (
            SELECT 1
            FROM public.profiles p
            WHERE p.id = auth.uid()
              AND p.role = 'admin'
              AND p.status = 'active'
          )
        )
    $policy$;

    EXECUTE $policy$
      CREATE POLICY "membership_plans_admin_update"
        ON public.membership_plans FOR UPDATE
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
        WITH CHECK (
          EXISTS (
            SELECT 1
            FROM public.profiles p
            WHERE p.id = auth.uid()
              AND p.role = 'admin'
              AND p.status = 'active'
          )
        )
    $policy$;

    EXECUTE $policy$
      CREATE POLICY "membership_plans_admin_delete"
        ON public.membership_plans FOR DELETE
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
