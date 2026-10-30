-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-6 (number 0427 assigned by the controller): library_turn_read, the read_source tool of a turn on the core
-- path. Owner 2026-10-28 (ENGINEERING section 5 supplement, #1518): a free read tool may read the user's own material once
-- per call in the middle of a turn, read-only, by the owner's key, without locks or writes, counted against the turn's limit.
-- Every query carries the caller's actor key. So this function is STABLE: no row locks (no library_actor, no library_document_read, both of which lock), no inserts.
-- doc-N references are the turn's own: Node keeps the doc-N -> (document, version) map of this turn and passes the known
-- references in p_refs; a listing or a search returns documents without refs and Node numbers them.
--   ''/'library'           the first 10 ready documents (by file name)
--   'search:<1-5 words>'   the top 8 segments (at most 3 per document) matching the words, with short excerpts
--   'doc-N'                the segment titles of a known reference, 25 per page ('doc-N/page-P')
--   'doc-N/segment-S'      one segment's text (bounded)
-- A deleted or changed document is reported as unavailable, never read. A deleted conversation or an account being erased
-- reads nothing.
-- Also (V2-6 review P1): the stop-loss counts the whole known supplier cost of a research tool call. turn_close is replaced
-- whole on staging's latest definition (0426) with only its two stop-loss sums changed (turn_call_spent_usd, new).
-- Compatibility: library_turn_read is new and unused until the core path's free chat offers read_source; turn_close keeps its
-- signature, and its result differs only for tool receipts whose actual cost exceeds the user's base (none exist before V2-6).
-- Repeatable: CREATE OR REPLACE. Recovery: DROP FUNCTION public.library_turn_read(uuid,uuid,text,jsonb); restore turn_close from
-- 0426's definition (packages/db/functions/turn/turn_close.sql at that version), then DROP FUNCTION turn_call_spent_usd.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.library_turn_read(p_actor_id uuid, p_session_id uuid, p_query text, p_refs jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE q text := btrim(coalesce(p_query, '')); m text[]; ref jsonb; d library_documents; seg library_document_segments;
  terms text[]; pats text[]; body_pats text[]; result jsonb; page integer; total integer; cap integer;
BEGIN
 IF p_actor_id IS NULL OR p_session_id IS NULL OR octet_length(q) > 400 OR jsonb_typeof(coalesce(p_refs, '[]'::jsonb)) <> 'array'
   OR jsonb_array_length(coalesce(p_refs, '[]'::jsonb)) > 30 THEN
  RAISE EXCEPTION 'LIBRARY_TURN_READ_INVALID' USING ERRCODE='22023';
 END IF;
 -- Only the caller's own live conversation, and never while the account is being erased (the same checks as turn_tombstones).
 IF NOT EXISTS (SELECT 1 FROM runtime_sessions s WHERE s.id = p_session_id AND s.actor_id = p_actor_id
     AND s.content_deleted_at IS NULL AND s.erased_at IS NULL)
   OR EXISTS (SELECT 1 FROM account_erasure_requests r WHERE r.profile_id = p_actor_id) THEN
  RETURN jsonb_build_object('kind', 'unavailable', 'reason', 'source_deleted');
 END IF;

 IF q = '' OR q = 'library' THEN
  RETURN jsonb_build_object('kind', 'library_index', 'documents', coalesce((SELECT jsonb_agg(jsonb_build_object('documentId', x.id,
      'version', x.content_version, 'title', left(coalesce(x.filename, ''), 160)) ORDER BY x.filename, x.id)
    FROM (SELECT id, content_version, filename FROM library_documents WHERE actor_id = p_actor_id AND kind = 'document'
      AND status = 'ready' AND deleted_at IS NULL ORDER BY filename, id LIMIT 10) x), '[]'::jsonb),
   'hint', 'Up to 10 documents are listed. Use search:<words> to find any other document.');
 END IF;

 IF q LIKE 'search:%' THEN
  SELECT coalesce(array_agg(DISTINCT w), '{}') INTO terms FROM (
   SELECT btrim(x) w FROM unnest(regexp_split_to_array(substr(q, 8), '[\s,，、;；]+')) x) t WHERE w <> '';
  IF cardinality(terms) NOT BETWEEN 1 AND 5 OR EXISTS (SELECT 1 FROM unnest(terms) w WHERE char_length(w) NOT BETWEEN 1 AND 40) THEN
   RETURN jsonb_build_object('kind', 'unavailable', 'reason', 'unknown_query');
  END IF;
  -- Literal LIKE patterns the trigram indexes can serve; bodies are matched by words of 2 or more characters only.
  SELECT array_agg('%' || replace(replace(replace(w, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%'),
    coalesce(array_agg('%' || replace(replace(replace(w, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%')
      FILTER (WHERE char_length(w) >= 2), '{}')
    INTO pats, body_pats FROM unnest(terms) w;
  SELECT jsonb_build_object('kind', 'library_search', 'terms', to_jsonb(terms), 'hits', coalesce(jsonb_agg(jsonb_build_object(
      'documentId', r.document_id, 'version', r.content_version, 'title', left(coalesce(r.filename, ''), 160),
      'segment', r.ordinal + 1, 'segmentTitle', left(r.title, 160), 'pageNumber', r.page_number,
      'excerpt', substr(r.body, greatest(1, coalesce(r.pos, 1) - 80), 240))
     ORDER BY r.score DESC, r.similarity DESC, r.document_id, r.ordinal), '[]'::jsonb))
   INTO result
  FROM (
   SELECT * FROM (
    SELECT sg.document_id, sg.ordinal, sg.title, sg.page_number, sg.body, ld.filename, ld.content_version, mt.score, mt.similarity, mt.pos,
      row_number() OVER (PARTITION BY sg.document_id ORDER BY mt.score DESC, mt.similarity DESC, sg.ordinal) per_doc
    FROM (SELECT cs.document_id, cs.ordinal FROM library_document_segments cs
           WHERE cs.actor_id = p_actor_id AND (cs.body ILIKE ANY(body_pats) OR cs.title ILIKE ANY(pats))
          UNION
          SELECT cs.document_id, cs.ordinal FROM library_documents cd
           JOIN library_document_segments cs ON cs.document_id = cd.id AND cs.actor_id = cd.actor_id
           WHERE cd.actor_id = p_actor_id AND cd.kind = 'document' AND cd.status = 'ready' AND cd.deleted_at IS NULL
             AND cd.filename ILIKE ANY(pats)) c
    JOIN library_document_segments sg ON sg.document_id = c.document_id AND sg.ordinal = c.ordinal
    JOIN library_documents ld ON ld.id = sg.document_id AND ld.actor_id = sg.actor_id
    CROSS JOIN LATERAL (SELECT count(*)::int score, min(nullif(position(lower(w) IN lower(sg.body)), 0)) pos,
        max(greatest(extensions.similarity(w, sg.body), extensions.similarity(w, sg.title),
          extensions.similarity(w, coalesce(ld.filename, '')))) similarity
      FROM unnest(terms) w
      WHERE (char_length(w) >= 2 AND sg.body ILIKE '%' || replace(replace(replace(w, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%')
        OR sg.title ILIKE '%' || replace(replace(replace(w, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%'
        OR coalesce(ld.filename, '') ILIKE '%' || replace(replace(replace(w, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%') mt
    WHERE sg.actor_id = p_actor_id AND ld.kind = 'document' AND ld.status = 'ready' AND ld.deleted_at IS NULL AND mt.score > 0
   ) ranked WHERE per_doc <= 3 ORDER BY score DESC, similarity DESC, document_id, ordinal LIMIT 8) r;
  -- Keep the result small: drop the weakest hits until it fits 6,000 bytes.
  WHILE octet_length(result::text) > 6000 AND jsonb_array_length(result->'hits') > 1 LOOP
   result := jsonb_set(result, '{hits}', (result->'hits') - (jsonb_array_length(result->'hits') - 1));
  END LOOP;
  RETURN result;
 END IF;

 m := regexp_match(q, '^(doc-(?:[1-9]|[12][0-9]|30))(?:/(page|segment)-([1-9][0-9]{0,4}))?$');
 IF m IS NULL THEN RETURN jsonb_build_object('kind', 'unavailable', 'reason', 'unknown_query'); END IF;
 SELECT value INTO ref FROM jsonb_array_elements(coalesce(p_refs, '[]'::jsonb)) WHERE value->>'ref' = m[1] LIMIT 1;
 IF ref IS NULL OR (ref->>'documentId') !~ '^[0-9a-f-]{36}$' OR (ref->>'version') !~ '^[1-9][0-9]{0,9}$' THEN
  RETURN jsonb_build_object('kind', 'unavailable', 'reason', 'unknown_query');
 END IF;
 SELECT * INTO d FROM library_documents WHERE id = (ref->>'documentId')::uuid AND actor_id = p_actor_id;
 IF d.id IS NULL OR d.deleted_at IS NOT NULL OR d.status <> 'ready' THEN
  RETURN jsonb_build_object('kind', 'unavailable', 'reason', 'source_deleted', 'ref', m[1]);
 END IF;
 IF d.content_version <> (ref->>'version')::integer THEN
  RETURN jsonb_build_object('kind', 'unavailable', 'reason', 'source_changed', 'ref', m[1]);
 END IF;
 IF m[2] IS NULL OR m[2] = 'page' THEN
  page := coalesce(m[3]::integer, 1);
  SELECT count(*) INTO total FROM library_document_segments WHERE document_id = d.id AND actor_id = p_actor_id;
  SELECT jsonb_build_object('kind', 'library_directory', 'ref', m[1], 'version', d.content_version, 'page', page,
    'pages', greatest(1, (total + 24) / 25), 'total', total,
    'entries', coalesce(jsonb_agg(jsonb_build_object('segment', s.ordinal + 1, 'title', left(s.title, 160), 'pageNumber', s.page_number)
      ORDER BY s.ordinal), '[]'::jsonb))
   INTO result FROM (SELECT * FROM library_document_segments WHERE document_id = d.id AND actor_id = p_actor_id
    ORDER BY ordinal OFFSET (page - 1) * 25 LIMIT 25) s;
  RETURN result;
 END IF;
 SELECT * INTO seg FROM library_document_segments WHERE document_id = d.id AND actor_id = p_actor_id AND ordinal = m[3]::integer - 1;
 IF seg.document_id IS NULL THEN RETURN jsonb_build_object('kind', 'unavailable', 'reason', 'unknown_query'); END IF;
 -- Segments are at most 8,192 bytes; heavily escaped text is shortened so the result stays bounded.
 FOREACH cap IN ARRAY ARRAY[8192, 4000, 2000] LOOP
  result := jsonb_build_object('kind', 'library_segment', 'ref', m[1], 'version', d.content_version, 'segment', seg.ordinal + 1,
    'title', left(seg.title, 160), 'pageNumber', seg.page_number, 'body', left(seg.body, cap), 'truncated', char_length(seg.body) > cap);
  EXIT WHEN octet_length(to_jsonb(result::text)::text) <= 16384;
 END LOOP;
 RETURN result;
END $function$;

REVOKE ALL ON FUNCTION public.library_turn_read(uuid, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.library_turn_read(uuid, uuid, text, jsonb) TO service_role;

-- The stop-loss spend of one ok receipt: a research tool call settles the user's base (nominal_usd) over the subcalls that
-- returned data only, while actual_usd is every known supplier cost of the call (billed failures and empty answers are the
-- platform's, V2-6 review); the stop-loss counts the larger. A model call keeps its nominal cost as before.
CREATE OR REPLACE FUNCTION public.turn_call_spent_usd(p_call_kind text, p_nominal_usd numeric, p_actual_usd numeric)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT CASE WHEN p_call_kind = 'tool' THEN greatest(coalesce(p_nominal_usd, 0), coalesce(p_actual_usd, 0)) ELSE p_nominal_usd END
$function$;
REVOKE ALL ON FUNCTION public.turn_call_spent_usd(text, numeric, numeric) FROM PUBLIC, anon, authenticated;

-- turn_close: staging's definition (after 0426) unchanged except the two stop-loss sums, which use turn_call_spent_usd.
CREATE OR REPLACE FUNCTION public.turn_close(p_actor_id uuid, p_turn_id bigint, p_close_kind text, p_messages jsonb DEFAULT '[]'::jsonb, p_delivered boolean DEFAULT false, p_refund_all boolean DEFAULT false, p_failure_code text DEFAULT NULL::text, p_kind_result jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  t turns; s runtime_sessions; q numeric; n_total numeric; pending_upper numeric; credits integer; charge integer; h integer;
  v_kind text := p_close_kind; tomb jsonb; next_seq integer; msg jsonb; pending boolean; user_pending boolean;
  marker timestamptz; kind_result jsonb;
BEGIN
  IF p_close_kind NOT IN ('completed','stopped','failed','interrupted','expired','erased') THEN
    RAISE EXCEPTION 'TURN_CLOSE_INVALID' USING ERRCODE='22023';
  END IF;
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id;
  IF t.id IS NULL THEN RAISE EXCEPTION 'TURN_DENIED' USING ERRCODE='42501'; END IF;
  -- Lock order: the profile, the session, the turn, then the stop-loss bucket (as turn_open and the erasure functions). The
  -- profile also serializes the actor's closes (the free-stop count) before the settlement locks it again.
  PERFORM 1 FROM profiles WHERE id = p_actor_id FOR UPDATE;
  IF t.session_id IS NOT NULL THEN SELECT * INTO s FROM runtime_sessions WHERE id = t.session_id FOR UPDATE; END IF;
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id FOR UPDATE;
  IF t.state = 'closed' THEN
    -- Closed with a provider cost still unknown: calling turn_close again settles what has become known since (recovery, a late
    -- receipt). The close itself (kind, messages) is kept; each receipt is counted once, by settled_at after the last pass
    -- (both stamped with clock_timestamp under this turn's row lock, so a receipt and a pass never miss each other).
    IF t.settlement = 'pending' THEN
      marker := clock_timestamp();
      SELECT coalesce(sum(turn_call_spent_usd(call_kind, nominal_usd, actual_usd)) FILTER (WHERE status = 'ok'), 0) + coalesce(sum(actual_usd) FILTER (WHERE status = 'unusable'), 0),
             coalesce(sum(upper_usd), 0)
        INTO n_total, pending_upper
      FROM turn_calls WHERE turn_id = p_turn_id AND NOT cost_pending AND settled_at > t.updated_at;
      UPDATE daily_spend SET spent_usd = spent_usd + n_total, reserved_usd = greatest(reserved_usd - pending_upper, 0)
        WHERE day = (t.policy->>'day')::date AND bucket = (t.policy->>'bucket')::smallint;
      q := (t.policy->>'q')::numeric;
      -- The user's base is what it was at the close plus the late model receipts: a tool whose result was unknown at the close
      -- stays 0 to the user (2.5.2) however late its receipt comes; only its cost goes to the stop-loss above.
      SELECT ceil(q * coalesce(sum(nominal_usd * multiplier) FILTER (WHERE status = 'ok' AND call_kind <> 'decision'
               AND NOT (call_kind = 'tool' AND settled_at > t.closed_at)), 0))::integer,
             coalesce(bool_or(cost_pending), false), coalesce(bool_or(cost_pending AND call_kind = 'model'), false)
        INTO credits, pending, user_pending
      FROM turn_calls WHERE turn_id = p_turn_id;
      credits := credits + coalesce((t.policy->>'carriedCredits')::int, 0);
      IF t.charged_credits IS NULL AND NOT user_pending THEN
        charge := public.turn_user_charge(p_actor_id, p_turn_id, t.close_kind, t.delivered,
          coalesce((t.policy->>'closeRefundAll')::boolean, false), credits,
          t.reserved_credits + coalesce((t.policy->>'carriedCredits')::int, 0), (t.policy->>'fixedCredits')::int, t.closed_at);
        IF t.policy->>'holdId' IS NOT NULL THEN
          PERFORM public.turn_settle_credits(p_actor_id, (t.policy->>'holdId')::uuid, charge, p_turn_id);
        END IF;
        t.charged_credits := charge; t.absorbed_credits := greatest(credits - charge, 0);
      END IF;
      UPDATE turns SET charged_credits = t.charged_credits, absorbed_credits = t.absorbed_credits,
          settlement = CASE WHEN pending THEN 'pending' ELSE 'done' END, updated_at = marker
        WHERE actor_id = p_actor_id AND id = p_turn_id RETURNING * INTO t;
    END IF;
    RETURN jsonb_build_object('turnId', t.id, 'closeKind', t.close_kind, 'chargedCredits', t.charged_credits,
      'absorbedCredits', t.absorbed_credits, 'settlement', t.settlement, 'replay', true);
  END IF;
  -- Only a report can be stopped by its user (Owner 10-28).
  IF v_kind = 'stopped' AND t.kind <> 'report' THEN RAISE EXCEPTION 'TURN_STOP_NOT_ALLOWED' USING ERRCODE='42501'; END IF;
  IF p_refund_all AND v_kind NOT IN ('failed','expired','erased') THEN RAISE EXCEPTION 'TURN_CLOSE_INVALID' USING ERRCODE='22023'; END IF;
  -- A tombstone wins: nothing is saved and the turn closes as erased.
  tomb := turn_tombstones(p_actor_id, t.session_id, t.policy);
  IF v_kind IN ('completed','stopped') AND ((tomb->>'sessionTombstoned')::boolean OR (tomb->>'accountErasing')::boolean
    OR (tomb->>'voiceSourceRevoked')::boolean) THEN v_kind := 'erased'; END IF;
  -- The per-kind hook: what a kind keeps from its result (a draft, a report, a verdict) is written in the same transaction as the
  -- close, by that kind's own function (e.g. turn_mentor_apply(t, v_kind, p_kind_result)), one branch per kind:
  --   IF t.kind = '<kind>' THEN PERFORM public.turn_<kind>_apply(...); ELSE ... END IF;
  -- A kind without a branch has its result refused rather than dropped.
  IF p_kind_result IS NOT NULL THEN
    IF t.kind = 'mentor' THEN
      -- V2-5: the organizer's checklist patches; only a delivered completed turn applies them (an erased one saves nothing).
      IF v_kind = 'completed' AND p_delivered THEN kind_result := public.turn_mentor_apply(p_actor_id, p_turn_id, p_kind_result); END IF;
    ELSE
      RAISE EXCEPTION 'TURN_KIND_RESULT_UNSUPPORTED' USING ERRCODE='22023';
    END IF;
  END IF;

  -- Calls without a final receipt: their cost is unknown; it is never presumed zero and never retried (2.5.2).
  UPDATE turn_calls SET status = 'unknown', cost_pending = true
   WHERE turn_id = p_turn_id AND status IN ('dispatched','identified');
  q := (t.policy->>'q')::numeric;
  -- N = ceil(q x sum(n_i x m_i)) over the known receipts the user pays for (never the positioning check); n_total is the provider
  -- cost of every receipt, the positioning check and the platform-paid unusable results included, which the stop-loss counts; a
  -- tool receipt counts its whole known supplier cost (turn_call_spent_usd), the subcalls the user does not pay for included.
  SELECT ceil(q * coalesce(sum(nominal_usd * multiplier) FILTER (WHERE status = 'ok' AND call_kind <> 'decision'), 0))::integer,
         coalesce(sum(turn_call_spent_usd(call_kind, nominal_usd, actual_usd)) FILTER (WHERE status = 'ok'), 0) + coalesce(sum(actual_usd) FILTER (WHERE status = 'unusable'), 0),
         coalesce(sum(upper_usd) FILTER (WHERE cost_pending), 0),
         coalesce(bool_or(cost_pending), false),
         -- Only an unknown model call holds the user's settlement: a third-party tool whose result is unknown is 0 to the user
         -- (Owner 10-13, plan 2.5.2) and the positioning check is never theirs; both keep only the provider cost pending.
         coalesce(bool_or(cost_pending AND call_kind = 'model'), false)
    INTO credits, n_total, pending_upper, pending, user_pending
  FROM turn_calls WHERE turn_id = p_turn_id;
  -- Credits a resumed turn carried from the turn it continues (V2-8): settled here, once, under this turn's rule.
  credits := credits + coalesce((t.policy->>'carriedCredits')::int, 0);
  -- H: the whole hold, the carried credits included (reserved_credits leaves them out for the calls' own checks).
  h := t.reserved_credits + coalesce((t.policy->>'carriedCredits')::int, 0);

  -- Stop-loss: what is known is spent; the reservation of calls with an unknown cost stays until recovery settles them.
  UPDATE daily_spend SET spent_usd = spent_usd + n_total,
      reserved_usd = greatest(reserved_usd - (t.reserved_usd - pending_upper), 0)
    WHERE day = (t.policy->>'day')::date AND bucket = (t.policy->>'bucket')::smallint;

  -- What the user pays (turn_user_charge: D = min(N, H), the stop and fixed-price rules).
  -- One instant for this close, taken under the account lock: the stop count, closed_at and the settlement pass all use it, so a
  -- concurrent close of the same actor that committed first is always before it, and a later settlement counts the same.
  marker := clock_timestamp();
  charge := public.turn_user_charge(p_actor_id, p_turn_id, v_kind, p_delivered, p_refund_all, credits, h,
    (t.policy->>'fixedCredits')::int, marker);

  -- Credits: settled once; with an unknown model cost the whole freeze waits for recovery (one freeze is settled exactly once).
  -- settlement stays 'pending' while any provider cost is unknown, so recovery still settles the stop-loss; a repeated credit
  -- settlement of the same freeze returns the first one.
  IF NOT user_pending AND t.policy->>'holdId' IS NOT NULL THEN
    PERFORM public.turn_settle_credits(p_actor_id, (t.policy->>'holdId')::uuid, charge, p_turn_id);
  END IF;

  -- The messages of a delivered turn, appended in order.
  IF v_kind IN ('completed','stopped') AND t.session_id IS NOT NULL AND jsonb_typeof(p_messages) = 'array' THEN
    SELECT coalesce(max(seq), 0) INTO next_seq FROM session_messages WHERE session_id = t.session_id;
    FOR msg IN SELECT value FROM jsonb_array_elements(p_messages) LOOP
      next_seq := next_seq + 1;
      INSERT INTO session_messages (session_id, seq, role, turn_id, content, content_hash)
        VALUES (t.session_id, next_seq, msg->>'role', p_turn_id, msg->>'content', encode(sha256(convert_to(msg->>'content', 'UTF8')), 'hex'));
    END LOOP;
  END IF;

  -- updated_at marks this settlement pass (see the closed branch above); a full refund still owed is kept with the turn.
  UPDATE turns SET state = 'closed', pause_reason = NULL, close_kind = v_kind, closed_at = marker, updated_at = marker,
      policy = CASE WHEN user_pending AND p_refund_all THEN policy || '{"closeRefundAll": true}'::jsonb ELSE policy END,
      charged_credits = CASE WHEN user_pending THEN NULL ELSE charge END,
      absorbed_credits = CASE WHEN user_pending THEN NULL ELSE greatest(credits - charge, 0) END,
      settlement = CASE WHEN pending THEN 'pending' ELSE 'done' END,
      stopped_by_user = (v_kind = 'stopped'), delivered = p_delivered AND v_kind IN ('completed','stopped'),
      failure_code = p_failure_code
    WHERE actor_id = p_actor_id AND id = p_turn_id RETURNING * INTO t;
  IF s.id IS NOT NULL AND s.active_turn_id = p_turn_id THEN UPDATE runtime_sessions SET active_turn_id = NULL WHERE id = s.id; END IF;
  RETURN jsonb_build_object('turnId', t.id, 'closeKind', t.close_kind, 'chargedCredits', t.charged_credits,
    'absorbedCredits', t.absorbed_credits, 'settlement', t.settlement, 'replay', false, 'kindResult', kind_result) || tomb;
END $function$;

COMMIT;
