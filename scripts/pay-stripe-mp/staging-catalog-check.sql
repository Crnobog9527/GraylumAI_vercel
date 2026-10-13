-- PAY-STRIPE-MP staging catalog mapping: read-only check. Run before and after staging-catalog.sql.
-- Before: 4 rows (pro/gold x monthly/yearly, standard, subscription), all old prices (catalog = 'old').
-- After:  12 rows (11 prices + 1 coupon), current_rows = 1 everywhere, catalog = 'pay-stripe-mp' everywhere.
SELECT r.object_type, p.level, r.billing_cycle, r.offer_kind, r.price_usage, count(*) AS current_rows,
  CASE WHEN bool_and(r.external_id LIKE 'price_1UQ%' OR r.external_id = 'graylum_mp_gold_first_month')
    THEN 'pay-stripe-mp' ELSE 'old' END AS catalog
FROM payment_provider_refs r JOIN membership_plans p ON p.id = r.membership_plan_id
WHERE r.channel = 'stripe' AND r.mode = 'test' AND r.is_current AND r.object_type IN ('price', 'coupon')
GROUP BY 1, 2, 3, 4, 5 ORDER BY 2, 3, 4, 5, 1;
