/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- B1: a PAYG call may carry up to three tool definitions (question card, Skill file and
-- the R4 history read), restoring AGENT-CORE R4 under PAYG after #945. Only the absolute
-- ceiling in the quote check moves from 2 to 3; each frozen run still applies its own
-- profile maxTools, so runs frozen with 2 keep refusing a third tool. Prices, the frozen
-- upper bound (it already counts the request bytes, tool definitions included) and every
-- other limit are unchanged.
BEGIN;
DO $$ DECLARE definition text;needle text;
BEGIN
 definition:=pg_get_functiondef('public.bill2_payg_validate_quote(bill2_runs,jsonb)'::regprocedure);
 IF position('-- 0250 three tools' IN definition)=0 THEN
  needle:=$n$ OR (v->>'tools')::int>least((q->>'maxTools')::int,2)$n$;
  IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN
   RAISE EXCEPTION 'BILL2_PAYG_QUOTE_SOURCE_MISMATCH: 0250'; END IF;
  EXECUTE replace(definition,needle,$r$ -- 0250 three tools
 OR (v->>'tools')::int>least((q->>'maxTools')::int,3)$r$);
 END IF;
END $$;
COMMIT;
