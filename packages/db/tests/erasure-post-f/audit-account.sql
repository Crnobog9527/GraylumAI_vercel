-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Read-only account erasure audit for ONE erased account (CORE-PATH-V2 F follow-up: erasure re-check on the core path).
-- One SELECT, no writes, no temp objects: it runs inside a READ ONLY transaction (check-account.mjs wraps it), so the same text can be
-- sent to a remote database with `supabase db query` without any risk of changing data. Contains no secrets and prints no content,
-- only counts. Placeholders (filled by check-account.mjs after it validated the values): __PROFILE_ID__ (uuid),
-- __COMPLETE__ (true once the whole erasure incl. Storage and Auth is expected to be finished, false for a local walk without them),
-- __POST_F__ (true once batch F has dropped the old Runtime/BILL2 tables).
-- Output: one row per check: section, check, expect, actual, ok. expect is 'zero' | 'one' | 'set' | 'info'; info rows never fail.
WITH p AS (SELECT '__PROFILE_ID__'::uuid AS id, __COMPLETE__::boolean AS complete, __POST_F__::boolean AS post_f),
req AS (SELECT r.* FROM account_erasure_requests r, p WHERE r.profile_id = p.id),
checks(section, name, expect, actual) AS (
  -- 1. The erasure record: the audit trail of the erasure itself.
  SELECT 'record', 'request_row_exists', 'one', (SELECT count(*) FROM req)
  UNION ALL SELECT 'record', 'profile_closed', 'one', (SELECT count(*) FROM profiles, p WHERE profiles.id = p.id
    AND status = 'deleted' AND is_deleted::text = 'true' AND deleted_at IS NOT NULL)
  UNION ALL SELECT 'record', 'profile_identity_cleared', 'zero', (SELECT count(*) FROM profiles, p WHERE profiles.id = p.id
    AND (email IS NOT NULL OR nickname IS NOT NULL OR avatar_url IS NOT NULL OR last_ip IS NOT NULL OR last_login_at IS NOT NULL))
  UNION ALL SELECT 'record', 'profile_scrubbed_at_set', 'set', (SELECT count(*) FROM req WHERE profile_scrubbed_at IS NOT NULL)
  UNION ALL SELECT 'record', 'local_cleaned_at_set', 'set', (SELECT count(*) FROM req WHERE local_cleaned_at IS NOT NULL)
  UNION ALL SELECT 'record', 'storage_verified_at_set', CASE WHEN (SELECT complete FROM p) THEN 'set' ELSE 'info' END,
    (SELECT count(*) FROM req WHERE storage_verified_at IS NOT NULL)
  UNION ALL SELECT 'record', 'auth_deleted_at_set', CASE WHEN (SELECT complete FROM p) THEN 'set' ELSE 'info' END,
    (SELECT count(*) FROM req WHERE auth_deleted_at IS NOT NULL)
  UNION ALL SELECT 'record', 'stage_completed', CASE WHEN (SELECT complete FROM p) THEN 'one' ELSE 'info' END,
    (SELECT count(*) FROM req WHERE stage = 'completed')
  UNION ALL SELECT 'record', 'manual_review_codes', 'zero', (SELECT coalesce(sum(cardinality(review_codes)), 0) FROM req)
  UNION ALL SELECT 'record', 'last_error_code_left', 'info', (SELECT count(*) FROM req WHERE last_error_code IS NOT NULL)
  UNION ALL SELECT 'record', 'off_db_manifest_unsynced', CASE WHEN (SELECT complete FROM p) THEN 'zero' ELSE 'info' END,
    (SELECT count(*) FROM erasure_manifest_outbox o, p WHERE o.profile_id = p.id AND o.synced_at IS NULL)
  -- The account's own audit log keeps its rows (who did what) but loses addresses and free text.
  UNION ALL SELECT 'record', 'activity_log_rows_kept', 'info', (SELECT count(*) FROM user_activity_logs l, p WHERE l.user_id = p.id)
  UNION ALL SELECT 'record', 'activity_log_not_erased', 'zero', (SELECT count(*) FROM user_activity_logs l, p
    WHERE l.user_id = p.id AND (l.content_erased_at IS NULL OR l.ip_address IS NOT NULL))
  -- 2. The database's own completion proofs. After F these functions are the ones batch F rewrites, so they cover the new tables.
  UNION ALL SELECT 'proof', 'account_erasure_body_remaining', 'zero', (SELECT account_erasure_body_remaining(p.id) FROM p)
  UNION ALL SELECT 'proof', 'account_erasure_local_remaining', 'zero', (SELECT account_erasure_local_remaining(p.id) FROM p)
  -- 3. Core-path tables: text and provider bodies gone, billing records kept.
  UNION ALL SELECT 'core_path', 'turn_call_raw_rows', 'zero', (SELECT count(*) FROM turn_call_raw r
    JOIN turn_calls c ON c.turn_id = r.turn_id AND c.seq = r.seq, p WHERE c.actor_id = p.id)
  UNION ALL SELECT 'core_path', 'session_messages_with_text_or_visible', 'zero', (SELECT count(*) FROM session_messages m
    JOIN runtime_sessions s ON s.id = m.session_id, p WHERE s.actor_id = p.id AND (m.content <> '' OR m.visible))
  UNION ALL SELECT 'core_path', 'session_messages_hash_of_text', 'zero', (SELECT count(*) FROM session_messages m
    JOIN runtime_sessions s ON s.id = m.session_id, p WHERE s.actor_id = p.id AND m.content_hash <> encode(sha256(''::bytea), 'hex'))
  UNION ALL SELECT 'core_path', 'session_messages_kept_emptied', 'info', (SELECT count(*) FROM session_messages m
    JOIN runtime_sessions s ON s.id = m.session_id, p WHERE s.actor_id = p.id)
  UNION ALL SELECT 'core_path', 'runtime_sessions_not_erased', 'zero', (SELECT count(*) FROM runtime_sessions s, p
    WHERE s.actor_id = p.id AND s.erased_at IS NULL)
  UNION ALL SELECT 'core_path', 'runtime_sessions_scope_or_payload_left', 'zero', (SELECT count(*) FROM runtime_sessions s, p
    WHERE s.actor_id = p.id AND (s.scope IS NOT NULL OR s.start_payload IS NOT NULL))
  UNION ALL SELECT 'core_path', 'fusion_turn_outputs_rows', 'zero', (SELECT count(*) FROM fusion_turn_outputs o, p WHERE o.actor_id = p.id)
  UNION ALL SELECT 'core_path', 'fusion_reviews_rows', 'zero', (SELECT count(*) FROM fusion_reviews o, p WHERE o.actor_id = p.id)
  UNION ALL SELECT 'core_path', 'fusion_compares_rows', 'zero', (SELECT count(*) FROM fusion_compares o, p WHERE o.actor_id = p.id)
  UNION ALL SELECT 'core_path', 'runtime_session_results_rows', 'zero', (SELECT count(*) FROM runtime_session_results o, p WHERE o.actor_id = p.id)
  UNION ALL SELECT 'core_path', 'runtime_session_names_rows', 'zero', (SELECT count(*) FROM runtime_session_names o, p WHERE o.actor_id = p.id)
  UNION ALL SELECT 'core_path', 'turns_still_open', 'zero', (SELECT count(*) FROM turns t, p WHERE t.actor_id = p.id AND t.state <> 'closed')
  UNION ALL SELECT 'core_path', 'turn_calls_cost_unsettled', 'zero', (SELECT count(*) FROM turn_calls c, p
    WHERE c.actor_id = p.id AND (c.status IN ('dispatched', 'identified') OR c.cost_pending))
  UNION ALL SELECT 'core_path', 'turns_billing_record_kept', 'info', (SELECT count(*) FROM turns t, p WHERE t.actor_id = p.id)
  UNION ALL SELECT 'core_path', 'turn_calls_billing_record_kept', 'info', (SELECT count(*) FROM turn_calls c, p WHERE c.actor_id = p.id)
  UNION ALL SELECT 'core_path', 'credit_transactions_kept', 'info', (SELECT count(*) FROM credit_transactions c, p WHERE c.user_id = p.id)
  -- 4. After batch F the old execution tables are gone (anything still there would hold old-path content).
  UNION ALL SELECT 'post_f', 'old_table_absent:' || t, 'zero', (to_regclass('public.' || t) IS NOT NULL)::int
    FROM p, unnest(ARRAY['runtime_executions', 'runtime_session_batches', 'runtime_session_history', 'runtime_tool_calls',
      'runtime_history_dependencies', 'bill2_runs', 'bill2_calls']) t WHERE p.post_f
), owned AS (
  -- 5. Every public table that names the account (first owner column of the table): for a human to read, never a failure.
  SELECT c.relname AS t, o.col, EXISTS (SELECT 1 FROM pg_attribute e WHERE e.attrelid = c.oid AND e.attname = 'erased_at'
    AND e.attnum > 0 AND NOT e.attisdropped) AS has_erased
  FROM pg_class c
  CROSS JOIN LATERAL (SELECT a.attname::text AS col FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    AND a.atttypid = 'uuid'::regtype AND a.attname IN ('actor_id', 'user_id', 'profile_id', 'owner_id')
    ORDER BY array_position(ARRAY['actor_id', 'user_id', 'profile_id', 'owner_id'], a.attname::text) LIMIT 1) o
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname <> 'profiles'
), tally AS (
  SELECT o.t, o.has_erased,
    (xpath('/row/c/text()', query_to_xml(format('select count(*) c from public.%I where %I = %L', o.t, o.col, p.id), false, true, '')))[1]::text::bigint AS total,
    CASE WHEN o.has_erased THEN (xpath('/row/c/text()', query_to_xml(
      format('select count(*) c from public.%I where %I = %L and erased_at is null', o.t, o.col, p.id), false, true, '')))[1]::text::bigint END AS unerased
  FROM owned o, p
)
SELECT section, name AS check_name, expect, actual,
  CASE expect WHEN 'zero' THEN actual = 0 WHEN 'one' THEN actual = 1 WHEN 'set' THEN actual >= 1 ELSE true END AS ok
FROM checks
UNION ALL
SELECT 'tables', t || CASE WHEN has_erased THEN ' (unerased rows: ' || unerased || ')' ELSE '' END, 'info', total, true
FROM tally WHERE total > 0
ORDER BY 1, 2;
