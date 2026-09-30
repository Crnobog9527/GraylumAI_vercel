-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Apply remotely only with Owner approval; implementation tests use local Docker only.
-- DATA-ERASURE B1b: closed-account-only, one-way runtime / legacy chat content erasure.
-- Only content-free shells remain. Money, state, identities and bill2_runs.session_ref stay.
-- In-flight rows / locked sessions and conversations are skipped and counted for PR-C retry.
-- PR-C follows B2; single deletion requires PR-D read/replay hardening. No remote execution here.
-- Clarifies 0149's "DELETE stays possible": the guard does not intercept DELETE itself, but
-- FK SET NULL/CASCADE UPDATEs still hit it. PR-C/D must delete snapshots before individual
-- messages, or delete the whole conversation; erased snapshot source links cannot be nulled.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- Legacy HTTP admission is disabled (#507). Also close the service-role RPC boundary.
-- This does not cancel already executing calls; drain pre-migration claims before scrubbing.
-- Existing requests keep ordinary_chat_transition; rollback restores the original claim grant.
REVOKE EXECUTE ON FUNCTION public.ordinary_chat_claim(uuid,uuid,jsonb,uuid) FROM service_role;

-- Refuse drift before any rewrite; both exact originals and exact reapplication are valid.
DO $$
BEGIN
  IF md5(pg_get_functiondef('public.erasure_update_allowed(jsonb,jsonb,text[])'::regprocedure)) NOT IN
    ('c020123940c8b3772b008f8cde8f38c6', '9b7020d74229529e6dba8340179cd38d') THEN
    RAISE EXCEPTION 'ERASURE_SOURCE_MISMATCH: erasure_update_allowed(jsonb,jsonb,text[])';
  END IF;
  IF md5(pg_get_functiondef('public.artifact_chat_message_guard()'::regprocedure)) NOT IN
    ('b562bbc4c69d1be9f73e22511aadb1fa', 'b21b622b3d45ababefa4254d2ec41e84') THEN
    RAISE EXCEPTION 'ERASURE_SOURCE_MISMATCH: artifact_chat_message_guard()';
  END IF;
  IF md5(pg_get_functiondef('public.account_erasure_scrub_content(uuid)'::regprocedure)) NOT IN
    ('3029c14ab84580323acba88565786281', '8e265cafaa36ba3735ea75897d210c0c') THEN
    RAISE EXCEPTION 'ERASURE_SOURCE_MISMATCH: account_erasure_scrub_content(uuid)';
  END IF;
END $$;

-- Staging originals supplied by the controller in PR #537; locally verified before rewriting.
-- artifact_chat_message_guard(): b562bbc4c69d1be9f73e22511aadb1fa
-- erasure_update_allowed(jsonb,jsonb,text[]): c020123940c8b3772b008f8cde8f38c6
-- CREATE OR REPLACE retains their existing owners and EXECUTE ACLs.
CREATE OR REPLACE FUNCTION public.erasure_update_allowed(o jsonb, n jsonb, specs text[])
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  spec text; col text; rule text; cols text[] := '{}'; oldv jsonb; newv jsonb; kept jsonb;
BEGIN
  IF specs IS NULL OR cardinality(specs) = 0
    OR nullif(o -> 'erased_at', 'null'::jsonb) IS NOT NULL
    OR nullif(n -> 'erased_at', 'null'::jsonb) IS NULL THEN
    RETURN false;
  END IF;
  -- Explicit marker-only mode; omitted arguments still fail closed. No mixed rules.
  IF 'marker-only' = ANY (specs) THEN
    RETURN cardinality(specs) = 1 AND (o - 'erased_at') = (n - 'erased_at');
  END IF;
  FOREACH spec IN ARRAY specs LOOP
    col := split_part(spec, '=', 1);
    rule := nullif(substr(spec, length(col) + 2), '');
    cols := cols || col;
    oldv := nullif(o -> col, 'null'::jsonb);
    newv := nullif(n -> col, 'null'::jsonb);
    IF rule IS NULL THEN
      IF newv IS NOT NULL THEN RETURN false; END IF;
    ELSIF rule LIKE 'erased:%' THEN
      IF NOT ((oldv IS NULL AND newv IS NULL)
        OR newv = to_jsonb('erased:' || (n ->> substr(rule, 8)))) THEN RETURN false; END IF;
    ELSIF rule LIKE 'keys:%' THEN
      SELECT jsonb_object_agg(e.key, e.value) INTO kept
      FROM jsonb_each(CASE WHEN jsonb_typeof(oldv) = 'object' THEN oldv ELSE '{}'::jsonb END) e
      WHERE e.key = ANY (string_to_array(substr(rule, 6), ','));
      IF newv IS DISTINCT FROM kept THEN RETURN false; END IF;
    ELSE
      RETURN false;
    END IF;
  END LOOP;
  RETURN (o - cols - 'erased_at') = (n - cols - 'erased_at');
END $function$;

CREATE OR REPLACE FUNCTION public.artifact_chat_message_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF TG_OP = 'UPDATE' AND erasure_update_allowed(to_jsonb(OLD), to_jsonb(NEW), ARRAY['content']) THEN
   RETURN NEW;
 END IF;
 IF EXISTS(SELECT 1 FROM conversations WHERE id=NEW.conversation_id AND skill_mode) THEN RAISE EXCEPTION 'guided messages require artifact turn' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $function$;

CREATE TEMP TABLE b1b_erasure_columns(tbl text, col text, keeps_keys boolean) ON COMMIT DROP;
INSERT INTO b1b_erasure_columns VALUES
  ('runtime_sessions', 'scope', false),
  ('runtime_sessions', 'start_payload', false),
  ('runtime_executions', 'payload', false),
  ('runtime_executions', 'result', false),
  ('runtime_executions', 'primary_result', false),
  ('runtime_executions', 'match_result', false),
  ('runtime_session_batches', 'items', false),
  ('runtime_session_history', 'item', false),
  ('runtime_tool_calls', 'arguments', false),
  ('runtime_tool_calls', 'result', false),
  ('runtime_scope_material', 'request', false),
  ('runtime_scope_material', 'content', false),
  ('runtime_scope_material', 'content_hash', false),
  ('conversations', 'title', false),
  ('conversations', 'summary', false),
  ('conversations', 'summary_metadata', false),
  ('messages', 'content', false),
  ('conversation_context_snapshots', 'content', false),
  ('conversation_context_snapshots', 'metadata', false),
  ('ordinary_chat_requests', 'writer_token', false),
  ('ordinary_chat_requests', 'input', false),
  ('ordinary_chat_requests', 'response_params', false),
  ('ordinary_chat_requests', 'partial_content', false),
  ('ordinary_chat_requests', 'failure_reason', false),
  ('ordinary_chat_requests', 'reservation', true),
  ('ordinary_chat_requests', 'billing_result', true);

DO $$
DECLARE t text; r record; c record;
BEGIN
  FOREACH t IN ARRAY ARRAY['runtime_sessions', 'runtime_executions', 'runtime_history_dependencies',
    'runtime_session_batches', 'runtime_session_history', 'runtime_tool_calls', 'runtime_scope_material',
    'conversations', 'messages', 'conversation_context_snapshots', 'ordinary_chat_requests'] LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS erased_at timestamptz', t);
  END LOOP;
  FOR r IN SELECT ec.tbl, ec.col, a.attnotnull FROM pg_temp.b1b_erasure_columns ec
    JOIN pg_attribute a ON a.attrelid = format('public.%I', ec.tbl)::regclass AND a.attname = ec.col LOOP
    IF r.attnotnull THEN
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I DROP NOT NULL', r.tbl, r.col);
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (erased_at IS NOT NULL OR %I IS NOT NULL)',
        r.tbl, 'erasure_present_' || substr(md5(r.tbl || '.' || r.col), 1, 16), r.col);
    END IF;
  END LOOP;
  FOR c IN SELECT DISTINCT con.conrelid::regclass AS rel, con.conname, pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con JOIN pg_temp.b1b_erasure_columns ec
      ON con.conrelid = format('public.%I', ec.tbl)::regclass
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attname = ec.col AND a.attnum = ANY (con.conkey)
    WHERE con.contype = 'c' AND con.conname NOT LIKE 'erasure\_%'
      AND pg_get_constraintdef(con.oid) NOT LIKE '%erased_at IS NOT NULL%' LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.rel, c.conname);
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I CHECK (erased_at IS NOT NULL OR (%s))',
      c.rel, c.conname, substr(c.def, 7));
  END LOOP;
  FOR r IN SELECT tbl, string_agg(format('%I IS NULL', col), ' AND ' ORDER BY col) AS cols
    FROM pg_temp.b1b_erasure_columns WHERE NOT keeps_keys GROUP BY tbl LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = format('public.%I', r.tbl)::regclass
      AND conname = 'erasure_cleared_' || substr(md5(r.tbl), 1, 16)) THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (erased_at IS NULL OR (%s))',
        r.tbl, 'erasure_cleared_' || substr(md5(r.tbl), 1, 16), r.cols);
    END IF;
  END LOOP;
END $$;

-- BEFORE INSERT precedes RLS: reject every erased INSERT before consulting account closure,
-- so another user's UUID cannot reveal whether that account has an erasure request.
-- Owner UPDATEs setting erased_at require closure; this definer does not widen client grants.
CREATE OR REPLACE FUNCTION public.erasure_closed_conversation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.erased_at IS NOT NULL THEN
    RAISE EXCEPTION 'ERASURE_INSERT_DENIED' USING ERRCODE = '42501';
  END IF;
  IF NEW.erased_at IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM account_erasure_requests WHERE profile_id = NEW.user_id) THEN
    RAISE EXCEPTION 'ACCOUNT_ERASURE_NOT_CLOSED' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.erasure_closed_conversation_guard() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS erasure_closed_account_guard ON public.conversations;
CREATE TRIGGER erasure_closed_account_guard BEFORE INSERT OR UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.erasure_closed_conversation_guard();

-- 0149 guards compare all columns outside their allow-list and freeze every erased row.
-- The explicit marker-only rule on dependency edges allows no identity changes.
DO $$
DECLARE g record; args text;
BEGIN
  FOR g IN SELECT * FROM (VALUES
    ('runtime_sessions', ARRAY['scope', 'start_payload']::text[]),
    ('runtime_executions', ARRAY['payload', 'result', 'primary_result', 'match_result']::text[]),
    ('runtime_history_dependencies', ARRAY['marker-only']::text[]),
    ('runtime_session_batches', ARRAY['items']::text[]),
    ('runtime_session_history', ARRAY['item']::text[]),
    ('runtime_tool_calls', ARRAY['arguments', 'result']::text[]),
    ('runtime_scope_material', ARRAY['request', 'content', 'content_hash']::text[]),
    ('conversations', ARRAY['title', 'summary', 'summary_metadata']::text[]),
    ('messages', ARRAY['content']::text[]),
    ('conversation_context_snapshots', ARRAY['content', 'metadata']::text[]),
    ('ordinary_chat_requests', ARRAY['writer_token', 'input', 'response_params', 'partial_content', 'failure_reason',
      'reservation=keys:pre_deduct_id,balance_before,balance_after,is_idempotent',
      'billing_result=keys:user_message_id,assistant_message_id,transaction_id,settle_id,refund_id,'
      'balance_after,refunded_credits,refund_amount']::text[])
  ) v(tbl, specs) LOOP
    SELECT string_agg(quote_literal(spec), ', ' ORDER BY n) INTO args FROM unnest(g.specs) WITH ORDINALITY x(spec, n);
    EXECUTE format('DROP TRIGGER IF EXISTS a_erased_row_guard ON public.%I', g.tbl);
    EXECUTE format('CREATE TRIGGER a_erased_row_guard BEFORE UPDATE ON public.%I FOR EACH ROW'
      ' EXECUTE FUNCTION public.erased_row_guard(%s)', g.tbl, coalesce(args, ''));
  END LOOP;
END $$;

-- No-active legacy finalizers may still INSERT after the admission barrier. Serialize these
-- inserts with the scrubber's parent FOR UPDATE, then reject an erased parent. Existing
-- in-flight conversations remain writable until eligible for scrub; no billing code changes.
-- Do not lock parents on ordinary content UPDATEs (the existing erased-row guard handles
-- those): child->parent locking there would invert the scrubber's parent->child lock order.
CREATE OR REPLACE FUNCTION public.erasure_conversation_child_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE parent_erased_at timestamptz;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.erased_at IS NOT NULL THEN
    RAISE EXCEPTION 'ERASURE_INSERT_DENIED' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.conversation_id IS NOT DISTINCT FROM OLD.conversation_id THEN
    RETURN NEW;
  END IF;
  SELECT erased_at INTO parent_erased_at FROM public.conversations
    WHERE id = NEW.conversation_id FOR SHARE;
  IF parent_erased_at IS NOT NULL THEN
    RAISE EXCEPTION 'ERASURE_PARENT_CLEARED' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.erasure_conversation_child_guard() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS b_erasure_parent_guard ON public.messages;
CREATE TRIGGER b_erasure_parent_guard BEFORE INSERT OR UPDATE OF conversation_id ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.erasure_conversation_child_guard();
DROP TRIGGER IF EXISTS b_erasure_parent_guard ON public.conversation_context_snapshots;
CREATE TRIGGER b_erasure_parent_guard BEFORE INSERT OR UPDATE OF conversation_id ON public.conversation_context_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.erasure_conversation_child_guard();

-- Pure row predicate: true for a NULL-state worker only means a candidate for the
-- later virtual-XID check, never proof that its transaction has ended. No stats or clocks here.
CREATE OR REPLACE FUNCTION public.account_erasure_activity_safe(
  p_backend_type text, p_state text, p_xact_start timestamptz,
  p_backend_xid xid, p_backend_xmin xid, p_cutoff timestamptz
) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(p_backend_type <> '' AND p_cutoff IS NOT NULL AND (
    (p_state IS NOT DISTINCT FROM 'idle' AND p_xact_start IS NULL)
    OR (p_state IN ('active', 'idle in transaction', 'idle in transaction (aborted)', 'fastpath function call')
      AND p_xact_start IS NOT NULL AND p_xact_start > p_cutoff)
    OR (p_backend_type <> 'client backend' AND p_state IS NULL AND p_xact_start IS NULL
      AND p_backend_xid IS NULL AND p_backend_xmin IS NULL)
  ), false)
$$;
REVOKE ALL ON FUNCTION public.account_erasure_activity_safe(text,text,timestamptz,xid,xid,timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;

-- Drain transactions that could have observed an active account before closure. Call only
-- AFTER verifying the erasure request. This is a read-only check, not a wait or cancellation.
-- Only core maintenance/launcher processes and pg_cron's scheduler are excluded. SQL-capable
-- workers (including pg_net) must pass the row predicate and, if NULL-state, the lock check.
CREATE OR REPLACE FUNCTION public.account_erasure_barrier() RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  cutoff timestamptz := clock_timestamp();
  activity_safe boolean; candidate_pids integer[];
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'ACCOUNT_ERASURE_ISOLATION_DENIED' USING ERRCODE = '25000';
  END IF;
  IF NOT pg_has_role(current_user, 'pg_read_all_stats', 'USAGE')
    OR current_setting('track_activities') <> 'on' THEN RETURN false; END IF;
  PERFORM pg_stat_clear_snapshot();
  SELECT coalesce(bool_and(public.account_erasure_activity_safe(
      a.backend_type, a.state, a.xact_start, a.backend_xid, a.backend_xmin, cutoff)), true),
    array_agg(a.pid) FILTER (WHERE a.backend_type <> 'client backend' AND a.state IS NULL)
    INTO activity_safe, candidate_pids
    FROM pg_stat_activity a WHERE a.pid <> pg_backend_pid()
      AND (a.backend_type IS NULL OR a.backend_type NOT IN (
        'archiver', 'autovacuum launcher', 'autovacuum worker', 'background writer',
        'checkpointer', 'logical replication launcher', 'walwriter', 'pg_cron launcher'));
  IF NOT activity_safe THEN RETURN false; END IF;
  -- A read-only statement can release its snapshot before the transaction ends: xid/xmin
  -- may both be NULL. Query locks AFTER capturing candidate PIDs; a still-running older
  -- transaction retains its virtual-XID lock. New post-cutoff transactions cannot pass admission.
  IF EXISTS (SELECT 1 FROM pg_locks WHERE pid = ANY(candidate_pids)
    AND locktype = 'virtualxid' AND mode = 'ExclusiveLock' AND granted) THEN RETURN false; END IF;
  -- A transaction can leave activity via PREPARE, so check prepared transactions LAST.
  -- Other databases cannot write this database's tables; retain every prepared xact here.
  RETURN NOT EXISTS (SELECT 1 FROM pg_prepared_xacts WHERE database = current_database());
END $$;
REVOKE ALL ON FUNCTION public.account_erasure_barrier() FROM PUBLIC, anon, authenticated, service_role;

-- Service-only; no broader table grants or mutable cleanup switch. No deletes (PR-C).
CREATE OR REPLACE FUNCTION public.account_erasure_scrub_runtime(p_profile_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  now_at timestamptz := clock_timestamp(); counts jsonb := '{}'; n bigint; g record;
  session_ids uuid[]; conversation_ids uuid[];
BEGIN
  IF p_profile_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM account_erasure_requests WHERE profile_id = p_profile_id) THEN
    RAISE EXCEPTION 'ACCOUNT_ERASURE_NOT_CLOSED' USING ERRCODE = '42501';
  END IF;
  IF NOT public.account_erasure_barrier() THEN
    RETURN jsonb_build_object('retry', true, 'reason', 'transactions_pending');
  END IF;
  -- confirm and scrub must use separate transactions. The service cannot backdate confirmed_at.
  -- Conservatively also retry a caller whose transaction predates a concurrent confirmation;
  -- this is not the barrier cutoff or proof of commit (the activity/prepared checks remain).
  IF EXISTS (SELECT 1 FROM account_erasure_requests WHERE profile_id = p_profile_id
    AND confirmed_at >= transaction_timestamp()) THEN
    RETURN jsonb_build_object('retry', true, 'reason', 'transactions_pending');
  END IF;
  -- Runtime writers lock session before execution. Never hold profile/run/project locks here.
  -- Do not wait on a busy session/conversation; counters include the omitted rows.
  session_ids := ARRAY(SELECT id FROM runtime_sessions WHERE actor_id = p_profile_id FOR UPDATE SKIP LOCKED);
  conversation_ids := ARRAY(SELECT id FROM conversations WHERE user_id = p_profile_id FOR UPDATE SKIP LOCKED);

  FOR g IN SELECT * FROM (VALUES
    ('runtime_executions',
      'payload = NULL, result = NULL, primary_result = NULL, match_result = NULL, erased_at = $2',
      't.actor_id = $1 AND EXISTS (SELECT 1 FROM runtime_sessions s WHERE s.id = t.session_id AND s.actor_id = $1)',
      't.session_id = ANY($3) AND t.state IN (''completed'',''cancelled'') AND (t.billing_run_id IS NULL OR EXISTS (SELECT 1 FROM bill2_runs b
      WHERE b.id = t.billing_run_id AND b.actor_id = $1 AND b.closed AND b.state IN (''settled'',''refunded'')))'),
    ('runtime_history_dependencies',
      'erased_at = $2',
      'EXISTS (SELECT 1 FROM runtime_executions e WHERE e.id = t.execution_id AND e.actor_id = $1)',
      'EXISTS (SELECT 1 FROM runtime_executions e WHERE e.id = t.execution_id AND e.actor_id = $1 AND e.session_id = ANY($3) AND e.state IN
      (''completed'',''cancelled'') AND (e.billing_run_id IS NULL OR EXISTS (SELECT 1 FROM bill2_runs b WHERE b.id = e.billing_run_id AND
      b.actor_id = $1 AND b.closed AND b.state IN (''settled'',''refunded''))) ) AND EXISTS (SELECT 1 FROM runtime_executions e WHERE e.id =
      t.dependency_id AND e.actor_id = $1 AND e.session_id = ANY($3) AND e.state IN (''completed'',''cancelled'') AND (e.billing_run_id IS NULL
      OR EXISTS (SELECT 1 FROM bill2_runs b WHERE b.id = e.billing_run_id AND b.actor_id = $1 AND b.closed AND b.state IN
      (''settled'',''refunded''))) )'),
    ('runtime_session_batches',
      'items = NULL, erased_at = $2',
      'EXISTS (SELECT 1 FROM runtime_sessions s WHERE s.id = t.session_id AND s.actor_id = $1)',
      'EXISTS (SELECT 1 FROM runtime_executions e WHERE e.id = t.execution_id AND e.actor_id = $1 AND e.session_id = ANY($3) AND e.state IN
      (''completed'',''cancelled'') AND (e.billing_run_id IS NULL OR EXISTS (SELECT 1 FROM bill2_runs b WHERE b.id = e.billing_run_id AND
      b.actor_id = $1 AND b.closed AND b.state IN (''settled'',''refunded''))) AND e.session_id = t.session_id)'),
    ('runtime_session_history',
      'item = NULL, erased_at = $2',
      'EXISTS (SELECT 1 FROM runtime_sessions s WHERE s.id = t.session_id AND s.actor_id = $1)',
      'EXISTS (SELECT 1 FROM runtime_executions e WHERE e.id = t.execution_id AND e.actor_id = $1 AND e.session_id = ANY($3) AND e.state IN
      (''completed'',''cancelled'') AND (e.billing_run_id IS NULL OR EXISTS (SELECT 1 FROM bill2_runs b WHERE b.id = e.billing_run_id AND
      b.actor_id = $1 AND b.closed AND b.state IN (''settled'',''refunded''))) AND e.session_id = t.session_id)'),
    ('runtime_tool_calls',
      'arguments = NULL, result = NULL, erased_at = $2',
      'EXISTS (SELECT 1 FROM runtime_executions e WHERE e.id = t.execution_id AND e.actor_id = $1)',
      'EXISTS (SELECT 1 FROM runtime_executions e WHERE e.id = t.execution_id AND e.actor_id = $1 AND e.session_id = ANY($3) AND e.state IN
      (''completed'',''cancelled'') AND (e.billing_run_id IS NULL OR EXISTS (SELECT 1 FROM bill2_runs b WHERE b.id = e.billing_run_id AND
      b.actor_id = $1 AND b.closed AND b.state IN (''settled'',''refunded''))) )'),
    ('runtime_scope_material',
      'request = NULL, content = NULL, content_hash = NULL, erased_at = $2',
      'EXISTS (SELECT 1 FROM runtime_sessions s WHERE s.id = t.session_id AND s.actor_id = $1)',
      't.session_id = ANY($3) AND NOT EXISTS (SELECT 1 FROM runtime_executions e WHERE e.session_id = t.session_id AND NOT (e.state IN
      (''completed'',''cancelled'') AND (e.billing_run_id IS NULL OR EXISTS (SELECT 1 FROM bill2_runs b WHERE b.id = e.billing_run_id AND
      b.actor_id = $1 AND b.closed AND b.state IN (''settled'',''refunded'')))))'),
    ('runtime_sessions',
      'scope = NULL, start_payload = NULL, erased_at = $2',
      't.actor_id = $1',
      't.id = ANY($3) AND NOT EXISTS (SELECT 1 FROM runtime_executions e WHERE e.session_id = t.id AND NOT (e.state IN
      (''completed'',''cancelled'') AND (e.billing_run_id IS NULL OR EXISTS (SELECT 1 FROM bill2_runs b WHERE b.id = e.billing_run_id AND
      b.actor_id = $1 AND b.closed AND b.state IN (''settled'',''refunded'')))))'),
    ('ordinary_chat_requests',
      'writer_token = NULL, input = NULL, response_params = NULL, partial_content = NULL, failure_reason = NULL,
      reservation = (SELECT jsonb_object_agg(x.key,
      x.value) FROM jsonb_each(CASE WHEN jsonb_typeof(t.reservation) = ''object'' THEN t.reservation ELSE ''{}''::jsonb END) x WHERE x.key IN
      (''pre_deduct_id'', ''balance_before'', ''balance_after'', ''is_idempotent'')), billing_result = (SELECT jsonb_object_agg(x.key, x.value)
      FROM jsonb_each(CASE WHEN jsonb_typeof(t.billing_result) = ''object'' THEN t.billing_result ELSE ''{}''::jsonb END) x WHERE x.key IN
      (''user_message_id'', ''assistant_message_id'', ''transaction_id'', ''settle_id'', ''refund_id'', ''balance_after'', ''refunded_credits'',
      ''refund_amount'')), erased_at = $2',
      't.user_id = $1 AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = t.conversation_id AND c.user_id = $1)',
      't.conversation_id = ANY($4) AND t.state IN (''succeeded'',''failed'')'),
    ('messages',
      'content = NULL, erased_at = $2',
      'EXISTS (SELECT 1 FROM conversations c WHERE c.id = t.conversation_id AND c.user_id = $1)',
      't.conversation_id = ANY($4) AND NOT EXISTS (SELECT 1 FROM ordinary_chat_requests r WHERE r.conversation_id = t.conversation_id AND r.state
      NOT IN (''succeeded'',''failed'')) AND NOT EXISTS (SELECT 1 FROM artifact_chats ch JOIN artifact_generations ag ON ag.project_id =
      ch.project_id AND ag.round_id = ch.round_id WHERE ch.conversation_id = t.conversation_id AND ag.state NOT IN
      (''succeeded'',''refunded''))'),
    ('conversation_context_snapshots',
      'content = NULL, metadata = NULL, erased_at = $2',
      'EXISTS (SELECT 1 FROM conversations c WHERE c.id = t.conversation_id AND c.user_id = $1)',
      't.conversation_id = ANY($4) AND NOT EXISTS (SELECT 1 FROM ordinary_chat_requests r WHERE r.conversation_id = t.conversation_id AND r.state
      NOT IN (''succeeded'',''failed'')) AND NOT EXISTS (SELECT 1 FROM artifact_chats ch JOIN artifact_generations ag ON ag.project_id =
      ch.project_id AND ag.round_id = ch.round_id WHERE ch.conversation_id = t.conversation_id AND ag.state NOT IN
      (''succeeded'',''refunded''))'),
    ('conversations',
      'title = NULL, summary = NULL, summary_metadata = NULL, erased_at = $2',
      't.user_id = $1',
      't.id = ANY($4) AND NOT EXISTS (SELECT 1 FROM ordinary_chat_requests r WHERE r.conversation_id = t.id AND r.state NOT IN
      (''succeeded'',''failed'')) AND NOT EXISTS (SELECT 1 FROM artifact_chats ch JOIN artifact_generations ag ON ag.project_id = ch.project_id
      AND ag.round_id = ch.round_id WHERE ch.conversation_id = t.id AND ag.state NOT IN (''succeeded'',''refunded''))')
  ) v(tbl, assignment, owned, ready) LOOP
    EXECUTE format('UPDATE public.%I t SET %s WHERE (%s) AND t.erased_at IS NULL AND (%s)',
      g.tbl, g.assignment, g.owned, g.ready) USING p_profile_id, now_at, session_ids, conversation_ids;
    GET DIAGNOSTICS n = ROW_COUNT;
    counts := counts || jsonb_build_object(g.tbl, n);
    EXECUTE format('SELECT count(*) FROM public.%I t WHERE (%s) AND t.erased_at IS NULL',
      g.tbl, g.owned) INTO n USING p_profile_id;
    counts := counts || jsonb_build_object(g.tbl || '_skipped', n);
  END LOOP;
  RETURN counts;
END $$;
REVOKE ALL ON FUNCTION public.account_erasure_scrub_runtime(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.account_erasure_scrub_runtime(uuid) TO service_role;
-- Exact staging original verified by server MD5 3029c14ab84580323acba88565786281.
-- Only the early read-only barrier is added; ownership and ACL remain unchanged.
CREATE OR REPLACE FUNCTION public.account_erasure_scrub_content(p_profile_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  now_at timestamptz := clock_timestamp(); counts jsonb := '{}'; n bigint;
BEGIN
  IF p_profile_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM account_erasure_requests WHERE profile_id = p_profile_id) THEN
    RAISE EXCEPTION 'ACCOUNT_ERASURE_NOT_CLOSED' USING ERRCODE = '42501';
  END IF;
  IF NOT public.account_erasure_barrier() THEN
    RETURN jsonb_build_object('retry', true, 'reason', 'transactions_pending');
  END IF;
  -- confirm and scrub must use separate transactions. The service cannot backdate confirmed_at.
  -- Conservatively also retry a caller whose transaction predates a concurrent confirmation;
  -- this is not the barrier cutoff or proof of commit (the activity/prepared checks remain).
  IF EXISTS (SELECT 1 FROM account_erasure_requests WHERE profile_id = p_profile_id
    AND confirmed_at >= transaction_timestamp()) THEN
    RETURN jsonb_build_object('retry', true, 'reason', 'transactions_pending');
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS erasure_scope(kind text, id uuid) ON COMMIT DROP;
  DELETE FROM pg_temp.erasure_scope;
  INSERT INTO pg_temp.erasure_scope SELECT 'project', id FROM artifact_projects WHERE actor_id = p_profile_id;
  INSERT INTO pg_temp.erasure_scope SELECT 'round', r.id FROM artifact_rounds r
    JOIN pg_temp.erasure_scope s ON s.kind = 'project' AND s.id = r.project_id;
  INSERT INTO pg_temp.erasure_scope SELECT 'draft', draft_id FROM opc_drafts WHERE actor_id = p_profile_id;
  INSERT INTO pg_temp.erasure_scope SELECT 'plan', p.id FROM opc_plans p
    JOIN pg_temp.erasure_scope s ON s.kind = 'draft' AND s.id = p.draft_id;
  INSERT INTO pg_temp.erasure_scope SELECT 'item', i.work_item_id FROM opc_items i
    JOIN pg_temp.erasure_scope s ON s.kind = 'plan' AND s.id = i.plan_id;

  -- artifact chat turns first: the generation guard compares a live instruction with its turn.
  UPDATE artifact_chat_turns t SET body = NULL, erased_at = now_at
  FROM artifact_chats c JOIN pg_temp.erasure_scope s ON s.kind = 'project' AND s.id = c.project_id
  WHERE t.conversation_id = c.conversation_id AND t.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('artifact_chat_turns', n);

  -- Result keeps only its money keys; provider_observations is financial evidence (PR-B2).
  UPDATE artifact_generations g SET input = NULL, erased_at = now_at,
    result = (SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each(
      CASE WHEN jsonb_typeof(g.result) = 'object' THEN g.result ELSE '{}'::jsonb END) e
      WHERE e.key IN ('credits', 'inputTokens', 'outputTokens', 'costUsd'))
  FROM pg_temp.erasure_scope s WHERE s.kind = 'project' AND s.id = g.project_id AND g.erased_at IS NULL
    AND g.state IN ('succeeded', 'refunded');
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('artifact_generations', n);
  SELECT count(*) INTO n FROM artifact_generations g JOIN pg_temp.erasure_scope s ON s.kind = 'project' AND s.id = g.project_id
  WHERE g.erased_at IS NULL;
  counts := counts || jsonb_build_object('artifact_generations_skipped', n);

  UPDATE artifact_rounds r SET steps = NULL, erased_at = now_at
  FROM pg_temp.erasure_scope s WHERE s.kind = 'round' AND s.id = r.id AND r.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('artifact_rounds', n);
  UPDATE artifact_evidence e SET payload = NULL, content_hash = NULL, erased_at = now_at
  FROM pg_temp.erasure_scope s WHERE s.kind = 'project' AND s.id = e.project_id AND e.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('artifact_evidence', n);
  UPDATE artifact_confirmations c SET body = NULL, erased_at = now_at
  FROM pg_temp.erasure_scope s WHERE s.kind = 'round' AND s.id = c.round_id AND c.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('artifact_confirmations', n);
  UPDATE artifact_candidates c SET body = NULL, erased_at = now_at
  FROM pg_temp.erasure_scope s WHERE s.kind = 'round' AND s.id = c.round_id AND c.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('artifact_candidates', n);
  UPDATE artifact_versions v SET report = NULL, report_hash = NULL, erased_at = now_at
  FROM pg_temp.erasure_scope s WHERE s.kind = 'project' AND s.id = v.project_id AND v.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('artifact_versions', n);
  UPDATE artifact_requests q SET response = NULL, erased_at = now_at,
    payload = (SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each(
      CASE WHEN jsonb_typeof(q.payload) = 'object' THEN q.payload ELSE '{}'::jsonb END) e
      WHERE e.key IN ('sliceExecution', 'slicePhase'))
  FROM pg_temp.erasure_scope s WHERE s.kind = 'project' AND s.id = q.project_id AND q.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('artifact_requests', n);
  UPDATE artifact_work_references w SET creation_payload = NULL, source_hash = NULL, erased_at = now_at
  FROM pg_temp.erasure_scope s WHERE s.kind = 'project' AND s.id = w.project_id AND w.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('artifact_work_references', n);
  UPDATE agent_slice_links l SET source_hash = NULL, erased_at = now_at
  FROM pg_temp.erasure_scope s WHERE s.kind = 'round' AND s.id = l.round_id AND l.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('agent_slice_links', n);
  UPDATE agent_slice_executions x SET preference_refs = NULL, discussion_refs = NULL, input_hash = NULL, erased_at = now_at
  FROM pg_temp.erasure_scope s WHERE s.kind = 'project' AND s.id = x.project_id AND x.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('agent_slice_executions', n);
  UPDATE artifact_projects p SET work_title = NULL, erased_at = now_at,
    account = CASE WHEN p.account IS NULL THEN NULL ELSE 'erased:' || p.id END
  WHERE p.actor_id = p_profile_id AND p.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('artifact_projects', n);

  UPDATE research_operations o SET erased_at = now_at,
    result = (SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each(
      CASE WHEN jsonb_typeof(o.result) = 'object' THEN o.result ELSE '{}'::jsonb END) e WHERE e.key = 'cost')
  FROM research_plans p WHERE p.actor_id = p_profile_id AND o.plan_id = p.id AND o.erased_at IS NULL
    AND o.state IN ('succeeded', 'failed', 'cancelled');
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('research_operations', n);
  SELECT count(*) INTO n FROM research_operations o JOIN research_plans p ON p.id = o.plan_id
  WHERE p.actor_id = p_profile_id AND o.erased_at IS NULL;
  counts := counts || jsonb_build_object('research_operations_skipped', n);
  UPDATE research_plans p SET operations = NULL, erased_at = now_at
  WHERE p.actor_id = p_profile_id AND p.erased_at IS NULL AND NOT EXISTS (
    SELECT 1 FROM research_operations o WHERE o.plan_id = p.id AND o.erased_at IS NULL);
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('research_plans', n);

  UPDATE opc_turns t SET input_hash = NULL, erased_at = now_at
  FROM pg_temp.erasure_scope s WHERE s.kind = 'draft' AND s.id = t.draft_id AND t.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_turns', n);
  UPDATE opc_plans p SET request = NULL, body = NULL, erased_at = now_at
  FROM pg_temp.erasure_scope s WHERE s.kind = 'draft' AND s.id = p.draft_id AND p.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_plans', n);
  UPDATE opc_items i SET brief = NULL, erased_at = now_at
  FROM pg_temp.erasure_scope s WHERE s.kind = 'item' AND s.id = i.work_item_id AND i.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_items', n);
  UPDATE opc_item_edits e SET title = NULL, brief = NULL, erased_at = now_at
  FROM pg_temp.erasure_scope s WHERE s.kind = 'item' AND s.id = e.work_item_id AND e.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_item_edits', n);
  UPDATE opc_handoffs h SET payload = NULL, result = NULL, erased_at = now_at
  WHERE h.actor_id = p_profile_id AND h.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_handoffs', n);
  UPDATE opc_topic_openings o SET input = NULL, erased_at = now_at
  FROM opc_topic_workspaces w WHERE w.actor_id = p_profile_id AND o.draft_id = w.draft_id AND o.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_topic_openings', n);
  UPDATE opc_topic_workspaces w SET source_hash = NULL, erased_at = now_at
  WHERE w.actor_id = p_profile_id AND w.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_topic_workspaces', n);
  UPDATE opc_topic_draft_versions v SET request = NULL, body = NULL, erased_at = now_at
  WHERE v.actor_id = p_profile_id AND v.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_topic_draft_versions', n);
  UPDATE opc_library_requests r SET payload = NULL, result = NULL, erased_at = now_at
  WHERE r.actor_id = p_profile_id AND r.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_library_requests', n);
  UPDATE opc_content_versions c SET body = NULL, title = NULL, erased_at = now_at
  WHERE c.actor_id = p_profile_id AND c.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_content_versions', n);
  UPDATE opc_accounts a SET account_key = 'erased:' || a.project_id, erased_at = now_at
  WHERE a.actor_id = p_profile_id AND a.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_accounts', n);
  UPDATE opc_businesses b SET name = NULL, erased_at = now_at
  WHERE b.actor_id = p_profile_id AND b.erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_businesses', n);

  -- Private settings with no inbound references are removed outright.
  DELETE FROM opc_work_ui WHERE actor_id = p_profile_id;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_work_ui_deleted', n);
  DELETE FROM opc_account_ui WHERE actor_id = p_profile_id;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_account_ui_deleted', n);
  DELETE FROM opc_publication_ui WHERE actor_id = p_profile_id;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('opc_publication_ui_deleted', n);
  DELETE FROM agent_confirmed_preferences WHERE actor_id = p_profile_id;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('agent_confirmed_preferences_deleted', n);
  DELETE FROM agent_preference_requests WHERE actor_id = p_profile_id;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('agent_preference_requests_deleted', n);
  DELETE FROM artifact_accounts WHERE actor_id = p_profile_id;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('artifact_accounts_deleted', n);
  RETURN counts;
END $function$;

COMMIT;
