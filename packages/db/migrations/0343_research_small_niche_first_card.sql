-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- BENCHMARK-SHORTFALL small niche (Owner 2026-10-20 choice B; 0320): a keyword search that finds fewer than 8 selectable
-- accounts never showed a candidate card (0263 required 8–12 on a first card), so the user could select nothing, the
-- session never got a qualified benchmark and the shortfall choice (1 <= qualified < 3 after 2 rounds) was out of reach.
--   * research_card_create: a first candidate card may now offer 1–7 selectable accounts, but only for a discovery of
--     this session already saved as completed (searched to the end of its plan). A discovery still running keeps the
--     8–12 rule, so a partial scan can never stand in for a round. Picks stay 3–5, fewer only when fewer are offered
--     (0263's least(n,3), unchanged). Follow-up cards are unchanged.
-- No money: creating a card is free; fetching the accounts the user picks is billed per subcall as before.
-- Compatibility: older code never sends a first card below 8, so it behaves as before. Repeatable: marker-skipped patch.
-- Recovery: re-run 0263's research_card_create definition (drops the '-- 0343 small niche' condition); cards already
-- created stay valid rows (min_select/max_select checks are unchanged).
BEGIN;
SET LOCAL lock_timeout='5s';

DO $$ DECLARE definition text; t text; BEGIN
  definition:=pg_get_functiondef('public.research_card_create(uuid,uuid,uuid,uuid,jsonb)'::regprocedure);
  IF position('-- 0343 small niche' IN definition)=0 THEN
    t:=$x$   OR (k='candidates' AND p->'followUp' IS DISTINCT FROM 'true'::jsonb AND n NOT BETWEEN 8 AND 12)$x$;
    IF array_length(string_to_array(definition,t),1)<>2 THEN
      RAISE EXCEPTION 'RESEARCH_SMALL_CARD_SOURCE_MISMATCH: research_card_create';END IF;
    EXECUTE replace(definition,t,$x$   OR (k='candidates' AND p->'followUp' IS DISTINCT FROM 'true'::jsonb AND n NOT BETWEEN 8 AND 12
     -- 0343 small niche: a completed discovery found only 1–7, so its first card shows those.
     AND NOT (n BETWEEN 1 AND 7 AND EXISTS(SELECT 1 FROM research_discoveries d
       WHERE d.id=(p->>'discoveryId')::uuid AND d.session_id=s AND d.actor_id=a AND d.state='completed')))$x$);
  END IF;
END $$;

COMMIT;
