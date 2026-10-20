-- Local empty-database contract test for the service_role-only fixed-fee summary RPC.
BEGIN;
INSERT INTO public.profiles(id) VALUES ('00000000-0000-4000-8000-000000000001');

INSERT INTO public.report_fees(execution_id,actor_id,credits,pre_deduct_id,state,charged_credits,settle_reason,settled_at)
VALUES
  ('00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000001',500,'00000000-0000-4000-8000-000000000110','charged',500,'complete','2026-03-10T12:00:00Z'),
  ('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000001',500,'00000000-0000-4000-8000-000000000111','charged',500,'complete','2026-03-10T12:00:00Z'),
  ('00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000001',500,'00000000-0000-4000-8000-000000000112','refunded',0,'incomplete','2026-03-10T12:00:00Z'),
  ('00000000-0000-4000-8000-000000000013','00000000-0000-4000-8000-000000000001',500,'00000000-0000-4000-8000-000000000113','charged',500,'complete','2026-03-11T12:00:00Z'),
  ('00000000-0000-4000-8000-000000000014','00000000-0000-4000-8000-000000000001',500,'00000000-0000-4000-8000-000000000114','held',NULL,NULL,NULL);

INSERT INTO public.fusion_review_fees(review_id,actor_id,credits,pre_deduct_id,state,charged_credits,settle_reason,settled_at)
VALUES
  ('00000000-0000-4000-8000-000000000020','00000000-0000-4000-8000-000000000001',1500,'00000000-0000-4000-8000-000000000120','charged',1500,'revised','2026-03-10T12:00:00Z'),
  ('00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000001',1500,'00000000-0000-4000-8000-000000000121','charged',1500,'revised','2026-03-10T12:00:00Z'),
  ('00000000-0000-4000-8000-000000000022','00000000-0000-4000-8000-000000000001',1500,'00000000-0000-4000-8000-000000000122','charged',1500,'revised','2026-03-10T12:00:00Z'),
  ('00000000-0000-4000-8000-000000000023','00000000-0000-4000-8000-000000000001',1500,'00000000-0000-4000-8000-000000000123','charged',1500,'revised','2026-03-10T12:00:00Z'),
  ('00000000-0000-4000-8000-000000000024','00000000-0000-4000-8000-000000000001',1500,'00000000-0000-4000-8000-000000000124','charged',1500,'revised','2026-03-10T12:00:00Z'),
  ('00000000-0000-4000-8000-000000000025','00000000-0000-4000-8000-000000000001',1500,'00000000-0000-4000-8000-000000000125','refunded',0,'incomplete','2026-03-10T12:00:00Z'),
  ('00000000-0000-4000-8000-000000000026','00000000-0000-4000-8000-000000000001',1500,'00000000-0000-4000-8000-000000000126','held',NULL,NULL,NULL);

SET LOCAL ROLE service_role;
SELECT set_config('billing_test.fixed_price_summary',
  public.daily_billing_fixed_price_summary('2026-03-10T00:00:00Z','2026-03-11T00:00:00Z')::text,true);
RESET ROLE;

DO $$
DECLARE summary jsonb:=current_setting('billing_test.fixed_price_summary')::jsonb;
BEGIN
  IF summary->>'reportFixedPriceCredits' IS DISTINCT FROM '1000'
    OR summary->>'fusionReviewFixedPriceCredits' IS DISTINCT FROM '7500' THEN
    RAISE EXCEPTION 'fixed-price summary mismatch: %',summary;
  END IF;
  IF has_table_privilege('service_role','public.report_fees','SELECT')
    OR has_table_privilege('service_role','public.fusion_review_fees','SELECT') THEN
    RAISE EXCEPTION 'service_role unexpectedly has direct fixed-fee table access';
  END IF;
  IF NOT has_function_privilege('service_role','public.daily_billing_fixed_price_summary(timestamptz,timestamptz)','EXECUTE')
    OR has_function_privilege('anon','public.daily_billing_fixed_price_summary(timestamptz,timestamptz)','EXECUTE')
    OR has_function_privilege('authenticated','public.daily_billing_fixed_price_summary(timestamptz,timestamptz)','EXECUTE') THEN
    RAISE EXCEPTION 'fixed-price summary RPC grants are incorrect';
  END IF;
END $$;
ROLLBACK;
