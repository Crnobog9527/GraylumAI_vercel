-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- DATA-ERASURE PR-B1a: a one-way content erasure channel for artifact / agent / research / opc
-- tables, plus a service-only scrub for ONE CLOSED ACCOUNT (DATA-ERASURE §4, A.1 steps 2-3, 6).
-- Rows stay as content-free shells (ids, times, owner, platform hashes); physical deletion is
-- PR-C. Only accounts in account_erasure_requests can be scrubbed: erased content read back as
-- NULL is unsafe for an open account until PR-D fixes replay/read paths (single deletion, D7).
-- No money path changes: financial columns are untouched and in-flight rows are skipped.
-- Apply remotely only with Owner approval.
BEGIN;
-- Adds columns and rebuilds CHECKs/triggers on 26 tables (ACCESS EXCLUSIVE): fail fast, never queue.
SET LOCAL lock_timeout = '5s';

-- 1. Validator shared by every guard. specs: 'col' must become NULL; 'col=erased:idcol' must
-- become 'erased:'||idcol (NULL may stay NULL); 'col=keys:a,b' keeps only those keys of the old
-- object (NULL when none). Everything else, and an already erased row, must be unchanged.
CREATE OR REPLACE FUNCTION public.erasure_update_allowed(o jsonb, n jsonb, specs text[])
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  spec text; col text; rule text; cols text[] := '{}'; oldv jsonb; newv jsonb; kept jsonb;
BEGIN
  IF specs IS NULL OR cardinality(specs) = 0
    OR nullif(o -> 'erased_at', 'null'::jsonb) IS NOT NULL
    OR nullif(n -> 'erased_at', 'null'::jsonb) IS NULL THEN
    RETURN false;
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
END $$;

-- 2. Erasure marker on every table whose content can be cleared in place.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'artifact_projects', 'artifact_rounds', 'artifact_evidence', 'artifact_confirmations',
    'artifact_candidates', 'artifact_versions', 'artifact_requests', 'artifact_generations',
    'artifact_chat_turns', 'artifact_work_references', 'agent_slice_links', 'agent_slice_executions',
    'research_plans', 'research_operations', 'opc_accounts', 'opc_businesses', 'opc_plans',
    'opc_items', 'opc_handoffs', 'opc_topic_openings', 'opc_topic_workspaces', 'opc_turns',
    'opc_item_edits', 'opc_topic_draft_versions', 'opc_library_requests', 'opc_content_versions'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS erased_at timestamptz', t);
  END LOOP;
END $$;

-- 3. Constraints: NULL-able erasable columns and CHECKs that accept erased rows, found from the
-- catalog (no guessed names). Live rows keep every original rule; erased rows hold no content.
CREATE TEMP TABLE erasure_columns(tbl text, col text) ON COMMIT DROP;
INSERT INTO erasure_columns VALUES
  ('artifact_projects', 'work_title'), ('artifact_rounds', 'steps'),
  ('artifact_evidence', 'payload'), ('artifact_evidence', 'content_hash'),
  ('artifact_confirmations', 'body'), ('artifact_candidates', 'body'),
  ('artifact_versions', 'report'), ('artifact_versions', 'report_hash'),
  ('artifact_requests', 'payload'), ('artifact_requests', 'response'),
  ('artifact_generations', 'input'), ('artifact_generations', 'result'), ('artifact_chat_turns', 'body'),
  ('artifact_work_references', 'creation_payload'), ('artifact_work_references', 'source_hash'),
  ('agent_slice_links', 'source_hash'), ('agent_slice_executions', 'preference_refs'),
  ('agent_slice_executions', 'discussion_refs'), ('agent_slice_executions', 'input_hash'),
  ('research_plans', 'operations'), ('research_operations', 'result'),
  ('opc_businesses', 'name'), ('opc_plans', 'request'), ('opc_plans', 'body'),
  ('opc_items', 'brief'), ('opc_handoffs', 'payload'), ('opc_handoffs', 'result'),
  ('opc_topic_openings', 'input'), ('opc_topic_workspaces', 'source_hash'),
  ('opc_turns', 'input_hash'), ('opc_item_edits', 'title'), ('opc_item_edits', 'brief'),
  ('opc_topic_draft_versions', 'request'), ('opc_topic_draft_versions', 'body'),
  ('opc_library_requests', 'payload'), ('opc_library_requests', 'result'),
  ('opc_content_versions', 'body'), ('opc_content_versions', 'title');

DO $$
DECLARE r record; c record; cleared text;
BEGIN
  FOR r IN SELECT ec.tbl, ec.col, a.attnotnull FROM erasure_columns ec
    JOIN pg_attribute a ON a.attrelid = format('public.%I', ec.tbl)::regclass AND a.attname = ec.col LOOP
    IF r.attnotnull THEN
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I DROP NOT NULL', r.tbl, r.col);
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (erased_at IS NOT NULL OR %I IS NOT NULL)',
        r.tbl, 'erasure_present_' || substr(md5(r.tbl || '.' || r.col), 1, 16), r.col);
    END IF;
  END LOOP;
  FOR c IN SELECT DISTINCT con.conrelid::regclass AS rel, con.conname, pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con JOIN erasure_columns ec ON con.conrelid = format('public.%I', ec.tbl)::regclass
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attname = ec.col AND a.attnum = ANY (con.conkey)
    WHERE con.contype = 'c' AND con.conname NOT LIKE 'erasure\_%' AND pg_get_constraintdef(con.oid) NOT LIKE '%erased_at IS NOT NULL%' LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.rel, c.conname);
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I CHECK (erased_at IS NOT NULL OR (%s))',
      c.rel, c.conname, substr(c.def, 7));
  END LOOP;
  -- Columns that keep a whitelist of keys are exempt: artifact_requests.payload (slice identity,
  -- unique index 0086) and the money keys of generation / research results.
  FOR r IN SELECT tbl, string_agg(format('%I IS NULL', col), ' AND ' ORDER BY col) AS cols
    FROM erasure_columns WHERE (tbl, col) NOT IN (('artifact_requests', 'payload'),
      ('artifact_generations', 'result'), ('research_operations', 'result')) GROUP BY tbl LOOP
    cleared := 'erasure_cleared_' || substr(md5(r.tbl), 1, 16);
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = format('public.%I', r.tbl)::regclass
      AND conname = cleared) THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (erased_at IS NULL OR (%s))',
        r.tbl, cleared, r.cols);
    END IF;
  END LOOP;
END $$;

-- 4. Guards. artifact_immutable keeps refusing everything except the one-way erase its trigger
-- arguments allow; triggers without arguments are unchanged.
CREATE OR REPLACE FUNCTION public.artifact_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND TG_NARGS > 0
    AND public.erasure_update_allowed(to_jsonb(OLD), to_jsonb(NEW), TG_ARGV) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'artifact history immutable';
END $$;

CREATE OR REPLACE FUNCTION public.artifact_chat_history_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' AND TG_NARGS > 0
   AND public.erasure_update_allowed(to_jsonb(OLD), to_jsonb(NEW), TG_ARGV) THEN RETURN NEW; END IF;
 IF TG_OP='DELETE' THEN
  IF TG_TABLE_NAME='artifact_chat_turns' THEN
   IF NOT EXISTS(SELECT 1 FROM conversations WHERE id=OLD.conversation_id) THEN RETURN OLD; END IF;
  ELSIF TG_TABLE_NAME='artifact_chat_summaries' THEN
   IF NOT EXISTS(SELECT 1 FROM artifact_chat_turns WHERE request_id=OLD.turn_id) THEN RETURN OLD; END IF;
  END IF;
 END IF;
 RAISE EXCEPTION 'artifact history immutable';
END $$;

CREATE OR REPLACE FUNCTION public.artifact_round_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
 IF TG_NARGS > 0 AND public.erasure_update_allowed(to_jsonb(OLD), to_jsonb(NEW), TG_ARGV) THEN RETURN NEW; END IF;
 IF OLD.erased_at IS NOT NULL OR NEW.erased_at IS NOT NULL THEN RAISE EXCEPTION 'fixed round is immutable'; END IF;
 IF OLD.id IS DISTINCT FROM NEW.id OR OLD.project_id IS DISTINCT FROM NEW.project_id OR OLD.revision_id IS DISTINCT FROM NEW.revision_id
 OR OLD.package_hash IS DISTINCT FROM NEW.package_hash OR OLD.workflow IS DISTINCT FROM NEW.workflow OR OLD.workflow_hash IS DISTINCT FROM NEW.workflow_hash
 OR OLD.template_hash IS DISTINCT FROM NEW.template_hash OR OLD.created_at IS DISTINCT FROM NEW.created_at
 OR (OLD.state<>'draft' AND NEW IS DISTINCT FROM OLD) THEN RAISE EXCEPTION 'fixed round is immutable'; END IF;
 RETURN NEW;
END $$;

-- Body is the staging definition (pg_get_functiondef, identical to the replayed files) with only
-- the erase short-circuit added: an erased chat generation no longer matches its erased turn.
CREATE OR REPLACE FUNCTION public.artifact_chat_generation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
DECLARE c public.artifact_chats%ROWTYPE; t public.artifact_chat_turns%ROWTYPE;
BEGIN
 IF TG_OP='UPDATE' AND public.erasure_update_allowed(to_jsonb(OLD), to_jsonb(NEW),
   ARRAY['input','result=keys:credits,inputTokens,outputTokens,costUsd']) THEN RETURN NEW; END IF;
 IF NEW.input->>'conversationId' IS NULL THEN
  IF NEW.input->>'purpose' IS NOT NULL THEN RAISE EXCEPTION 'role denied' USING ERRCODE='42501'; END IF;
  RETURN NEW; END IF;
 SELECT * INTO c FROM artifact_chats WHERE conversation_id=(NEW.input->>'conversationId')::uuid AND project_id=NEW.project_id AND round_id=NEW.round_id;
 SELECT * INTO t FROM artifact_chat_turns WHERE conversation_id=c.conversation_id AND request_id=(NEW.input->>'turnId')::uuid AND step_id=NEW.step_id;
 IF c.conversation_id IS NULL OR t.request_id IS NULL OR NEW.input->>'instruction' IS DISTINCT FROM t.body OR NEW.input->>'turnId' IS DISTINCT FROM t.request_id::text THEN RAISE EXCEPTION 'chat generation denied' USING ERRCODE='42501'; END IF;
 IF t.generation_mode='legacy' THEN
  IF NEW.request_id<>t.request_id OR NEW.input->>'purpose' IS NOT NULL THEN RAISE EXCEPTION 'legacy role denied' USING ERRCODE='42501'; END IF;
 ELSIF NEW.input->>'purpose'='reply' THEN
  IF NEW.request_id<>t.request_id THEN RAISE EXCEPTION 'reply identity denied' USING ERRCODE='42501'; END IF;
 ELSIF NEW.input->>'purpose'='summary' THEN
  IF NOT EXISTS(SELECT 1 FROM artifact_chat_summaries s JOIN artifact_generations parent ON parent.project_id=NEW.project_id AND parent.round_id=NEW.round_id AND parent.request_id=s.turn_id
    WHERE s.turn_id=t.request_id AND s.request_id=NEW.request_id AND parent.state='succeeded' AND parent.input->>'purpose'='reply'
     AND parent.evidence_ids <@ NEW.evidence_ids) THEN RAISE EXCEPTION 'summary parent denied' USING ERRCODE='42501'; END IF;
 ELSE RAISE EXCEPTION 'role denied' USING ERRCODE='42501'; END IF;
 IF TG_OP='INSERT' OR (NEW.state='dispatched' AND OLD.state='prepared') THEN
  IF NEW.input->>'purpose'='summary' AND NOT EXISTS(SELECT 1 FROM artifact_generations parent WHERE parent.project_id=NEW.project_id AND parent.round_id=NEW.round_id AND parent.request_id=t.request_id AND parent.quote->>'modelId' <> NEW.quote->>'modelId' AND lower(trim(parent.quote->>'providerModel')) <> lower(trim(NEW.quote->>'providerModel')) AND artifact_evidence_allowed(NEW.project_id,parent.evidence_ids)) THEN RAISE EXCEPTION 'summary source denied' USING ERRCODE='42501'; END IF;
  IF NOT (t.evidence_ids <@ NEW.evidence_ids) OR NOT artifact_evidence_allowed(NEW.project_id,t.evidence_ids) THEN RAISE EXCEPTION 'chat evidence denied' USING ERRCODE='42501'; END IF;
  SELECT coalesce(jsonb_agg(DISTINCT e),'[]') INTO NEW.evidence_ids FROM jsonb_array_elements(NEW.evidence_ids||t.evidence_ids) e;
 END IF;
 RETURN NEW;
END $function$;

-- Staging body with one added line: an erase keeps only the money keys, so the receipt guard
-- must not write a '[来源已不可用]' body back into the erased result.
CREATE OR REPLACE FUNCTION public.artifact_reference_receipt_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $function$
DECLARE ref artifact_work_references%ROWTYPE;
BEGIN
 IF TG_OP='UPDATE' AND OLD.erased_at IS NULL AND NEW.erased_at IS NOT NULL THEN RETURN NEW; END IF;
 SELECT * INTO ref FROM artifact_work_references WHERE round_id=NEW.round_id;
 IF FOUND AND NEW.result IS NOT NULL AND NOT artifact_evidence_allowed(NEW.project_id,NEW.evidence_ids||jsonb_build_array(ref.evidence_id)) THEN
  NEW.result:=jsonb_set(NEW.result,'{body}','"[来源已不可用]"');
 END IF;
 RETURN NEW;
END $function$;

-- Tables without an immutability trigger: normal updates continue, but an erase must follow the
-- allow-list and an erased row can never be written again. DELETE stays possible (PR-C).
CREATE OR REPLACE FUNCTION public.erased_row_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.erased_at IS NOT NULL THEN
    RAISE EXCEPTION 'erased row is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.erased_at IS NOT NULL
    AND NOT public.erasure_update_allowed(to_jsonb(OLD), to_jsonb(NEW), TG_ARGV) THEN
    RAISE EXCEPTION 'erasure outside allow-list' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE g record;
BEGIN
  -- artifact_immutable triggers re-created with their allow-lists (same name, timing and events).
  FOR g IN SELECT * FROM (VALUES
    ('artifact_evidence', ARRAY['payload', 'content_hash']),
    ('artifact_confirmations', ARRAY['body']),
    ('artifact_candidates', ARRAY['body']),
    ('artifact_versions', ARRAY['report', 'report_hash']),
    ('artifact_requests', ARRAY['payload=keys:sliceExecution,slicePhase', 'response']),
    ('artifact_work_references', ARRAY['creation_payload', 'source_hash']),
    ('agent_slice_links', ARRAY['source_hash']),
    ('agent_slice_executions', ARRAY['preference_refs', 'discussion_refs', 'input_hash']),
    ('opc_plans', ARRAY['request', 'body']),
    ('opc_items', ARRAY['brief']),
    ('opc_handoffs', ARRAY['payload', 'result']),
    ('opc_topic_openings', ARRAY['input']),
    ('opc_topic_workspaces', ARRAY['source_hash']),
    ('opc_turns', ARRAY['input_hash']),
    ('opc_topic_draft_versions', ARRAY['request', 'body']),
    ('opc_library_requests', ARRAY['payload', 'result']),
    ('opc_content_versions', ARRAY['body', 'title'])
  ) AS v(tbl, specs) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = format('public.%I', g.tbl)::regclass
      AND tgname = 'artifact_immutable' AND tgfoid = 'public.artifact_immutable()'::regprocedure) THEN
      RAISE EXCEPTION 'DATA-ERASURE B1a: % lacks the artifact_immutable trigger', g.tbl;
    END IF;
    EXECUTE format('DROP TRIGGER artifact_immutable ON public.%I', g.tbl);
    EXECUTE format('CREATE TRIGGER artifact_immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW'
      ' EXECUTE FUNCTION public.artifact_immutable(%s)', g.tbl,
      (SELECT string_agg(quote_literal(s), ', ') FROM unnest(g.specs) s));
  END LOOP;
  -- Mutable tables get the erased-row guard with their allow-lists.
  FOR g IN SELECT * FROM (VALUES
    ('artifact_projects', ARRAY['work_title', 'account=erased:id']),
    ('artifact_generations', ARRAY['input', 'result=keys:credits,inputTokens,outputTokens,costUsd']),
    ('research_plans', ARRAY['operations']),
    ('research_operations', ARRAY['result=keys:cost']),
    ('opc_accounts', ARRAY['account_key=erased:project_id']),
    ('opc_businesses', ARRAY['name']),
    ('opc_item_edits', ARRAY['title', 'brief'])
  ) AS v(tbl, specs) LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS erased_row_guard ON public.%I', g.tbl);
    EXECUTE format('CREATE TRIGGER erased_row_guard BEFORE UPDATE ON public.%I FOR EACH ROW'
      ' EXECUTE FUNCTION public.erased_row_guard(%s)', g.tbl,
      (SELECT string_agg(quote_literal(s), ', ') FROM unnest(g.specs) s));
  END LOOP;
END $$;
DO $$
DECLARE t text;
BEGIN
  SELECT tgname INTO t FROM pg_trigger
  WHERE tgrelid = 'public.artifact_rounds'::regclass AND tgfoid = 'public.artifact_round_identity()'::regprocedure;
  IF t IS NULL THEN RAISE EXCEPTION 'DATA-ERASURE B1a: artifact_rounds lacks its identity trigger'; END IF;
  EXECUTE format('DROP TRIGGER %I ON public.artifact_rounds', t);
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.artifact_rounds FOR EACH ROW'
    ' EXECUTE FUNCTION public.artifact_round_identity(%L)', t, 'steps');
END $$;
DROP TRIGGER IF EXISTS artifact_immutable ON public.artifact_chat_turns;
CREATE TRIGGER artifact_immutable BEFORE UPDATE OR DELETE ON public.artifact_chat_turns
  FOR EACH ROW EXECUTE FUNCTION public.artifact_chat_history_immutable('body');

-- 5. Scrub every artifact / agent / research / opc row of one closed account. Idempotent; rows
-- whose money is still in flight are skipped and counted so PR-C can retry after settlement.
CREATE OR REPLACE FUNCTION public.account_erasure_scrub_content(p_profile_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  now_at timestamptz := clock_timestamp(); counts jsonb := '{}'; n bigint;
BEGIN
  IF p_profile_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM account_erasure_requests WHERE profile_id = p_profile_id) THEN
    RAISE EXCEPTION 'ACCOUNT_ERASURE_NOT_CLOSED' USING ERRCODE = '42501';
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
END $$;

-- Pure comparison, reads no table. Non-DEFINER guards call it as whoever runs the UPDATE, so every
-- API role may execute it (PUBLIC stays revoked); without this a future grant would break updates.
REVOKE ALL ON FUNCTION public.erasure_update_allowed(jsonb, jsonb, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.erasure_update_allowed(jsonb, jsonb, text[]) TO anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.erased_row_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.account_erasure_scrub_content(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_erasure_scrub_content(uuid) TO service_role;

COMMIT;
