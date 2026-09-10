-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- New AI admission reads only the caller's settled consumption, never billing
-- metadata. Apply together with the runtime contract; no business rows change.
BEGIN;

GRANT SELECT (user_id, operation_type, amount, created_at)
  ON TABLE public.billing_history TO authenticated;

-- The restrictive companion keeps old permissive/admin policies from widening
-- this client read. Application administrators use the same own-user boundary.
DROP POLICY IF EXISTS ai_consumption_select_own ON public.billing_history;
CREATE POLICY ai_consumption_select_own ON public.billing_history
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS ai_consumption_select_own_boundary ON public.billing_history;
CREATE POLICY ai_consumption_select_own_boundary ON public.billing_history
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

DO $$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.billing_history'::regclass) THEN
    RAISE EXCEPTION 'AI consumption read requires billing_history RLS';
  END IF;
  IF has_table_privilege('authenticated','public.billing_history','SELECT')
    OR EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.billing_history'::regclass
      AND attnum>0 AND NOT attisdropped
      AND attname NOT IN ('user_id','operation_type','amount','created_at')
      AND has_column_privilege('authenticated','public.billing_history',attname,'SELECT'))
    OR has_any_column_privilege('anon','public.billing_history','SELECT') THEN
    RAISE EXCEPTION 'AI consumption read found an unexpected broad client grant';
  END IF;
END $$;

-- Recovery: a reviewed forward migration may revoke these four column grants
-- and remove these two policies. New execution then fails closed; existing
-- result recovery uses its unchanged service-role request/settlement RPCs.
COMMIT;
