-- BILL-PAYG: expose only settled fixed-price totals to the daily billing reconciler.
-- The source tables intentionally revoke direct access from service_role; keep those grants closed.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.daily_billing_fixed_price_summary(p_start timestamptz,p_end timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end)
    OR p_end<p_start OR p_end-p_start>interval '31 days' THEN
    RAISE EXCEPTION 'invalid reconciliation window';
  END IF;
  RETURN jsonb_build_object(
    'reportFixedPriceCredits', coalesce((SELECT sum(charged_credits) FROM report_fees
      WHERE state='charged' AND settled_at>=p_start AND settled_at<p_end),0),
    'fusionReviewFixedPriceCredits', coalesce((SELECT sum(charged_credits) FROM fusion_review_fees
      WHERE state='charged' AND settled_at>=p_start AND settled_at<p_end),0));
END $$;
REVOKE ALL ON FUNCTION public.daily_billing_fixed_price_summary(timestamptz,timestamptz)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.daily_billing_fixed_price_summary(timestamptz,timestamptz) TO service_role;

COMMIT;
