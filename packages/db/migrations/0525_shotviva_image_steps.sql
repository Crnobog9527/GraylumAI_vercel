-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- INTEGRATION-SHOTVIVA PR B (Owner 2026-11-12, "打通再上线"): a free chat can make an image through the user's linked Shotviva
-- account. Number 0525 assigned by the controller.
--   The image is kept with the reply the way its other steps are (turn_chat_steps_apply, called by turn_close for a delivered
--   completed chat turn): one step {tool:'image', state, job?, reason?}. `job` is the Shotviva job id, never the signed image
--   address (it expires after 7 days); the page reads a fresh one by the id. `reason` says why an image was not made, or that it
--   is still being made. Whole definition copied from packages/db/functions/turn and changed only by these three checks.
-- Compatibility: additive. Old code never sends an image step; steps saved before keep their shape and still pass.
-- Repeatable: CREATE OR REPLACE; running it twice changes nothing.
-- Recovery: re-apply the definition from packages/db/functions/turn at the staging commit before this migration; image steps
--   are then refused again (turn_close keeps going: a refused list is a warning, never a failed close).
BEGIN;

-- turn_chat_steps_apply(uuid,bigint,jsonb)
CREATE OR REPLACE FUNCTION public.turn_chat_steps_apply(p_actor_id uuid, p_turn_id bigint, p_steps jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE item jsonb; k text;
BEGIN
  IF p_steps IS NULL OR jsonb_typeof(p_steps) <> 'array' OR jsonb_array_length(p_steps) NOT BETWEEN 1 AND 16
     OR octet_length(p_steps::text) > 4096 THEN RETURN false; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_steps) LOOP
    IF jsonb_typeof(item) <> 'object' OR NOT (item ? 'id' AND item ? 'tool' AND item ? 'state') THEN RETURN false; END IF;
    FOR k IN SELECT jsonb_object_keys(item) LOOP
      IF k NOT IN ('id', 'tool', 'state', 'label', 'count', 'reason', 'job') THEN RETURN false; END IF;
    END LOOP;
    -- A saved step has ended: "running" is never kept.
    IF jsonb_typeof(item->'id') <> 'string' OR char_length(item->>'id') > 8
       OR jsonb_typeof(item->'tool') <> 'string' OR (item->>'tool') NOT IN ('load_skill', 'research', 'read_source', 'coach_review', 'image', 'other')
       OR jsonb_typeof(item->'state') <> 'string' OR (item->>'state') NOT IN ('done', 'failed', 'skipped') THEN RETURN false; END IF;
    IF item ? 'label' AND (jsonb_typeof(item->'label') <> 'string' OR char_length(item->>'label') > 80) THEN RETURN false; END IF;
    IF item ? 'count' AND (jsonb_typeof(item->'count') <> 'number' OR (item->>'count') !~ '^[0-9]{1,6}$') THEN RETURN false; END IF;
    IF item ? 'reason' AND (jsonb_typeof(item->'reason') <> 'string' OR NOT (
         (item->>'reason') = 'no_brand'
         -- INTEGRATION-SHOTVIVA: why an image was not made, or that it is still being made; only on an image step.
         OR (item->>'tool') = 'image' AND (item->>'reason') IN ('running', 'not_linked', 'membership_required', 'quota_exhausted',
           'IDENTITY_SWAP_REFUSED', 'content_rejected', 'invalid_input', 'rate_limited', 'generation_failed', 'link_revoked', 'unavailable')))
    THEN RETURN false; END IF;
    -- INTEGRATION-SHOTVIVA: the Shotviva job of an image step (the card reads a fresh address by it); never a URL.
    IF item ? 'job' AND ((item->>'tool') <> 'image' OR jsonb_typeof(item->'job') <> 'string'
         OR (item->>'job') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN RETURN false; END IF;
  END LOOP;
  UPDATE public.turns SET steps = p_steps WHERE actor_id = p_actor_id AND id = p_turn_id AND steps IS NULL;
  RETURN FOUND;
END $function$;

REVOKE ALL ON FUNCTION public.turn_chat_steps_apply(uuid, bigint, jsonb) FROM PUBLIC, anon, authenticated, service_role;
COMMIT;
