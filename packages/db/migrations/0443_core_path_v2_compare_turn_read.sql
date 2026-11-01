-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-10, read only: the compare cards of a conversation on the turn path.
--   fusion_compare_turn_list  the conversation's compares that have a turn (the old fusion_compare_list lists only BILL2 groups),
--                             newest 50, oldest first, with the same view fields the old list carries
--   fusion_compare_turn_read  one compare of the turn path: its state and, per column (the compare's models in order), the saved
--                             answer, the receipt's verdict and what the column cost, in the fields the card already reads
--                             (billing.closed / chargedCredits, call.verdict). A column is final when its turn is closed and
--                             settled; until then it holds its upper bound. Each column is rounded on its own, as turn_user_charge.
-- No table, no write; owner keys on every statement. Adoption is fusion_compare_turn_adopt (0436), unchanged.
-- Compatibility: new functions only; nothing calls them until the page reads a compare started on POST /api/turn/compare.
-- Repeatable: CREATE OR REPLACE. Recovery: DROP FUNCTION both.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.fusion_compare_turn_read(p_actor_id uuid, p_compare_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE fc fusion_compares; t turns; closed boolean; paid boolean; cols jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_actor_id AND status = 'active' AND is_deleted::text = 'false') THEN
    RAISE EXCEPTION 'TURN_ACCOUNT_DENIED' USING ERRCODE='42501';
  END IF;
  SELECT * INTO fc FROM fusion_compares WHERE id = p_compare_id AND actor_id = p_actor_id AND turn_id IS NOT NULL;
  IF fc.id IS NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM runtime_sessions WHERE id = fc.session_id AND actor_id = p_actor_id
      AND content_deleted_at IS NULL AND erased_at IS NULL) THEN RETURN NULL; END IF;
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = fc.turn_id;
  closed := t.state = 'closed' AND t.settlement IS DISTINCT FROM 'pending';
  -- A turn closed with nothing charged (refunded in full: failed, or no column delivered) shows no column cost either, whatever
  -- the receipts say: the columns follow the turn's own settlement, never a recomputation from the receipts alone.
  paid := closed AND coalesce(t.charged_credits, 0) > 0;
  SELECT coalesce(jsonb_agg(col ORDER BY idx), '[]'::jsonb) INTO cols FROM (
    SELECT i.idx, jsonb_build_object('column', i.idx, 'runId', coalesce(c.seq::text, i.idx::text), 'modelId', m.model_id,
      'body', CASE WHEN c.answer_verdict = 'usable' THEN o.body END,
      'billing', CASE WHEN c.seq IS NULL THEN jsonb_build_object('closed', closed, 'state', CASE WHEN closed THEN 'settled' ELSE 'held' END,
          'reservedCredits', 0, 'chargedCredits', 0, 'netChargedCredits', 0)
        ELSE jsonb_build_object('closed', closed, 'state', CASE WHEN closed THEN 'settled' ELSE 'held' END,
          'reservedCredits', ceil((t.policy->>'q')::numeric * c.upper_usd * c.multiplier)::integer,
          'chargedCredits', CASE WHEN paid AND c.status = 'ok' AND c.answer_verdict = 'usable'
            THEN ceil((t.policy->>'q')::numeric * c.nominal_usd * c.multiplier)::integer ELSE 0 END,
          'netChargedCredits', CASE WHEN paid AND c.status = 'ok' AND c.answer_verdict = 'usable'
            THEN ceil((t.policy->>'q')::numeric * c.nominal_usd * c.multiplier)::integer ELSE 0 END) END,
      'call', CASE WHEN c.seq IS NULL THEN NULL ELSE jsonb_build_object('callId', c.seq, 'state', c.status, 'dispatched', true,
        'settled', c.settled_at IS NOT NULL,
        'verdict', coalesce(c.answer_verdict, CASE WHEN c.status IN ('not_sent','rejected','no_charge_402','unusable') THEN 'unusable'
          WHEN c.status = 'ok' THEN 'no_delivery' END),
        'inFlight', c.status IN ('dispatched','identified')) END) col
    FROM jsonb_array_elements_text(fc.config->'models') WITH ORDINALITY AS m(model_id, ord)
    CROSS JOIN LATERAL (SELECT (m.ord - 1)::integer idx) i
    LEFT JOIN LATERAL (SELECT * FROM turn_calls x WHERE x.actor_id = p_actor_id AND x.turn_id = fc.turn_id AND x.call_kind = 'model'
      AND x.model_id = m.model_id::uuid ORDER BY x.seq DESC LIMIT 1) c ON true
    LEFT JOIN fusion_turn_outputs o ON o.actor_id = p_actor_id AND o.turn_id = fc.turn_id AND o.seq = c.seq AND o.verdict = 'usable'
  ) x(idx, col);
  RETURN fusion_compare_view(fc) || jsonb_build_object('turnId', fc.turn_id, 'question', fc.question, 'columns', cols,
    'chargedCredits', CASE WHEN closed THEN coalesce(t.charged_credits, 0) ELSE 0 END);
END $function$;

CREATE OR REPLACE FUNCTION public.fusion_compare_turn_list(p_actor_id uuid, p_session_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE cards jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_actor_id AND status = 'active' AND is_deleted::text = 'false') THEN
    RAISE EXCEPTION 'TURN_ACCOUNT_DENIED' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM runtime_sessions WHERE id = p_session_id AND actor_id = p_actor_id
      AND content_deleted_at IS NULL AND erased_at IS NULL) THEN RETURN '[]'::jsonb; END IF;
  SELECT coalesce(jsonb_agg(card ORDER BY created_at), '[]'::jsonb) INTO cards FROM (
    SELECT fusion_compare_view(fc) || jsonb_build_object('turnId', fc.turn_id, 'question', fc.question) card, fc.created_at
    FROM fusion_compares fc WHERE fc.actor_id = p_actor_id AND fc.session_id = p_session_id AND fc.turn_id IS NOT NULL
      AND fc.state IN ('running','finished','stopped') ORDER BY fc.created_at DESC LIMIT 50) x;
  RETURN cards;
END $function$;

REVOKE ALL ON FUNCTION public.fusion_compare_turn_read(uuid, uuid), public.fusion_compare_turn_list(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fusion_compare_turn_read(uuid, uuid), public.fusion_compare_turn_list(uuid, uuid) TO service_role;
COMMIT;
