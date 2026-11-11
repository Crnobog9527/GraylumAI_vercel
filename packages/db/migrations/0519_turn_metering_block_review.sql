-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 metering block: the way out (deep review 2026-11-11, finding 10).
-- turn_call_record marks a model receipt whose cost went above the bound frozen for it (budget_conflict, 0422 / 0510), and
-- turn_call_begin then refuses every user's call to that model (TURN_MODEL_METERING_BLOCKED) "until an administrator has checked its
-- price and metering" (Owner item 27: only a real cost above the estimate stops new calls). But nothing ever wrote
-- conflict_reviewed_at: no function and no admin action. One over-bound receipt kept a model off for the whole site until someone
-- edited the production table by hand, and nobody was told.
--   admin_metering_blocks(): read-only. One entry per model that has over-bound receipts not reviewed yet: how many, since when,
--     and the receipt furthest above its bound (bound, nominal cost, actual cost, turn id). No user content, no actor id.
--   admin_metering_review(model, admin, request): the admin action "已核对价格，恢复调用". Marks that model's unreviewed
--     over-bound receipts reviewed, so turn_call_begin lets the model through again; a later over-bound receipt blocks it again. It
--     changes no price, no charge and no settlement: the receipts keep their costs. Checks the admin again; idempotent (a repeat or a
--     race finds nothing left and writes nothing); one audit row per review that changed something (user_activity_logs, id = the
--     request id).
-- turn_call_begin and turn_call_record are not changed. Not main-path functions: admin only, and named admin_* (functions/other) because the
--   review marks every blocked receipt of a model, across turns and users, which a main-path function may never do (ENGINEERING 5).
-- Compatible: two new functions, nothing replaced; code deployed before this migration never calls them, and the admin card reads
--   "unavailable" (never "none") until they exist. Repeatable: CREATE OR REPLACE and REVOKE / GRANT only.
-- Recovery: DROP the two functions. Receipts already reviewed stay reviewed; to block a model again by hand, set
--   conflict_reviewed_at back to NULL on its budget_conflict rows.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.admin_metering_blocks()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 -- Index turn_calls_budget_conflict (model_id) WHERE budget_conflict AND conflict_reviewed_at IS NULL: normally empty.
 SELECT coalesce(jsonb_agg(jsonb_build_object('modelId', g.model_id, 'model', m.name, 'calls', g.calls,
     'firstAt', g.first_at, 'lastAt', g.last_at, 'turnId', w.turn_id, 'upperUsd', w.upper_usd::text,
     'nominalUsd', w.nominal_usd::text, 'actualUsd', w.actual_usd::text) ORDER BY g.first_at, g.model_id), '[]'::jsonb)
 FROM (
  SELECT c.model_id, count(*) AS calls, min(c.settled_at) AS first_at, max(c.settled_at) AS last_at
  FROM turn_calls c WHERE c.budget_conflict AND c.conflict_reviewed_at IS NULL GROUP BY c.model_id
 ) g
 LEFT JOIN ai_models m ON m.id = g.model_id
 CROSS JOIN LATERAL (
  SELECT c.turn_id, c.upper_usd, c.nominal_usd, c.actual_usd FROM turn_calls c
  WHERE c.model_id = g.model_id AND c.budget_conflict AND c.conflict_reviewed_at IS NULL
  ORDER BY greatest(coalesce(c.nominal_usd, 0), coalesce(c.actual_usd, 0)) - c.upper_usd DESC, c.turn_id, c.seq LIMIT 1
 ) w
$function$;

CREATE OR REPLACE FUNCTION public.admin_metering_review(p_model_id uuid, p_admin_id uuid, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE n integer; at_time timestamptz := clock_timestamp();
BEGIN
  IF p_admin_id IS NULL OR p_request_id IS NULL OR NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_admin_id AND role = 'admin' AND status = 'active' AND is_deleted = 'false') THEN
    RAISE EXCEPTION 'TURN_ADMIN_DENIED' USING ERRCODE='42501';
  END IF;
  IF p_model_id IS NULL THEN RAISE EXCEPTION 'TURN_METERING_REVIEW_INVALID' USING ERRCODE='22023'; END IF;
  -- Two admins at once: the second waits for the first's row locks, then finds every row reviewed and changes nothing.
  UPDATE turn_calls SET conflict_reviewed_at = at_time
    WHERE model_id = p_model_id AND budget_conflict AND conflict_reviewed_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    INSERT INTO user_activity_logs(id, user_id, admin_id, action, action_type, details)
      VALUES (p_request_id, NULL, p_admin_id, 'admin_metering_review', 'admin',
        jsonb_build_object('modelId', p_model_id, 'calls', n, 'reviewedAt', at_time))
      ON CONFLICT (id) DO NOTHING;
  END IF;
  RETURN jsonb_build_object('modelId', p_model_id, 'reviewed', n);
END $function$;

REVOKE ALL ON FUNCTION public.admin_metering_blocks() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_metering_blocks() TO service_role;
REVOKE ALL ON FUNCTION public.admin_metering_review(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_metering_review(uuid, uuid, uuid) TO service_role;

COMMIT;
