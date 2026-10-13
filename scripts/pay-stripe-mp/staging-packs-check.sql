-- PAY-STRIPE-MP staging credit packs: read-only check. Run before and after staging-packs.sql.
-- Before: the 4 old test packs are active (100/500/1500/5000 cents) with no Pro/Gold member prices.
-- After:  exactly 3 active packs, 990/2990/9990 cents with 990/2990/9990 credits and 0/0/1000 bonus;
--         pro_prices = 1 and gold_prices = 1 on each, all pay-stripe-mp sandbox prices.
SELECT c.name, c.price, c.credits_amount, c.bonus_credits, c.sort_order,
  count(r.*) FILTER (WHERE r.package_tier = 'pro') AS pro_prices,
  count(r.*) FILTER (WHERE r.package_tier = 'gold') AS gold_prices,
  coalesce(bool_and(r.external_id LIKE 'price_1UQ4%'), false) AS new_prices
FROM credit_packages c
LEFT JOIN payment_provider_refs r ON r.credit_package_id = c.id AND r.channel = 'stripe' AND r.mode = 'test'
  AND r.object_type = 'price' AND r.is_current AND r.package_tier IN ('pro', 'gold')
WHERE c.active = 'true'
GROUP BY c.id ORDER BY c.price;
