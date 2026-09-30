-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Apply remotely only with Owner approval; implementation tests use local Docker only.
-- DATA-ERASURE B1b: closed-account-only, one-way runtime / legacy chat content erasure.
-- Only content-free shells remain. Money, state, identities and bill2_runs.session_ref stay.
-- In-flight rows / locked sessions and conversations are skipped and counted for PR-C retry.
-- PR-C follows B2; single deletion requires PR-D read/replay hardening. No remote execution here.
BEGIN;
SET LOCAL lock_timeout = '5s';

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

-- conversations still permits owner UPDATEs through RLS. A client cannot mark an open
-- account's row erased, including through INSERT. The catalog-only guard runs as its owner;
-- it reads the protected request table without widening client grants.
CREATE OR REPLACE FUNCTION public.erasure_closed_conversation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
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
    ('ordinary_chat_requests', ARRAY['input', 'response_params', 'partial_content', 'failure_reason',
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
      'input = NULL, response_params = NULL, partial_content = NULL, failure_reason = NULL, reservation = (SELECT jsonb_object_agg(x.key,
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
COMMIT;
