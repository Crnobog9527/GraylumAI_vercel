-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- BENCHMARK-COVERAGE keywords (Owner 2026-10-23, Master Plan 2.1: "1 选 A…", plan BENCHMARK_COVERAGE_PLAN §2.1): a keyword
-- card may offer 3–10 keywords (was 3–5: the niche term, synonyms, related terms, the target market's language) and the
-- user may confirm up to 10 of them (max_select was 5, so a 6–10 card could not be confirmed whole).
--   * research_card_create: the keyword option count 3–5 → 3–10; a keyword card's max_select 5 → 10. Candidate cards
--     are unchanged (8–12 / follow-ups, 0343's small-niche rule).
-- No money: a card is free; each keyword's searches are billed per subcall as before, within the discovery ceiling.
-- Compatibility: older code never proposes more than 5, so it behaves as before; cards already created keep their
-- stored max_select. Repeatable: marker-skipped patch.
-- Recovery: re-run the previous research_card_create definition (drops the '-- 0356 keywords' changes); cards already
-- created stay valid rows (the table's own check is max_select <= 12).
BEGIN;
SET LOCAL lock_timeout='5s';

DO $$ DECLARE definition text; t text; u text; BEGIN
  definition:=pg_get_functiondef('public.research_card_create(uuid,uuid,uuid,uuid,jsonb)'::regprocedure);
  IF position('-- 0356 keywords' IN definition)=0 THEN
    t:=$x$   OR (k='keywords' AND n NOT BETWEEN 3 AND 5)$x$;
    u:=$x$CASE WHEN k='keywords' THEN 5 ELSE least(n,5) END$x$;
    IF array_length(string_to_array(definition,t),1)<>2 OR array_length(string_to_array(definition,u),1)<>2 THEN
      RAISE EXCEPTION 'RESEARCH_KEYWORDS_SOURCE_MISMATCH: research_card_create';END IF;
    definition:=replace(definition,t,$x$   -- 0356 keywords: 3–10 keywords on a card (BENCHMARK-COVERAGE).
   OR (k='keywords' AND n NOT BETWEEN 3 AND 10)$x$);
    EXECUTE replace(definition,u,$x$CASE WHEN k='keywords' THEN 10 ELSE least(n,5) END$x$);
  END IF;
END $$;

COMMIT;
