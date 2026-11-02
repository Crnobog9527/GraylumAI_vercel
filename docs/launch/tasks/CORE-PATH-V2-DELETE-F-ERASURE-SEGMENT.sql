-- Format: whole-function CREATE OR REPLACE plus 6 DROP FUNCTION IF EXISTS; no BEGIN/COMMIT; safe to run twice. The generator splices it in after
-- billing_reconcile_day and before DO $guard$. It touches only the 24 functions named below (no other function, table or trigger).
-- CORE-PATH-V2 V2-12 batch F, pre-drop rewrite segment: account erasure and content deletion (R2c, 24 functions).
-- Goes into CORE-PATH-V2-DELETE-F-DRAFT.sql after the other pre-drop rewrites (billing_reconcile_day) and BEFORE the self-check guard, in the same
-- transaction. After it no account/content erasure function names an old table (runtime_executions, runtime_session_history,
-- runtime_history_dependencies, runtime_tool_calls, runtime_session_batches, runtime_*_references, bill2_runs/calls/receipts,
-- fusion_billing_groups, report_fees, fusion_review_fees) or calls a function that F drops.
--   Rewritten as whole functions (18): account_erasure_{preview,note_error,financial_proof,financial_batch,work_batch,body_remaining,
--     scrub_runtime,scrub_content,prune_business}, erasure_business_owner, content_erasure_{ledger_owned,capture_steps,artifact_readable,
--     saved_readable,parent_guard,mark_session,scope,confirm}.
--   Dropped here (6; their only callers are old-path functions that F drops): account_erasure_{detach_runtime,scrub_run,scrub_calls,scrub_receipts},
--     content_erasure_{financial_allowed,runtime_check}.
-- Protection is not loosened: an open or unsettled core-path turn still keeps an erasing account in billing_pending and blocks Auth removal;
-- content deletion still waits for open turns; every kept content table is still scrubbed/deleted. What goes away is only the handling of
-- rows that no longer exist (old runs, executions, history, receipts, fees).

CREATE OR REPLACE FUNCTION public.account_erasure_preview(p_profile_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'credits', coalesce((SELECT p.credits FROM public.profiles p WHERE p.id = p_profile_id), 0),
    'subscriptionRenewing', public.account_erasure_renewing(p_profile_id),
    'renewalChannels', public.account_erasure_renewal_channels(p_profile_id),
    'subscriptionActiveUntil', (
      SELECT max(s.current_period_end) FROM public.user_subscriptions s
      WHERE s.user_id = p_profile_id
        AND lower(s.status) IN ('active', 'trialing', 'past_due', 'incomplete', 'unpaid', 'paused')),
    'pendingPayments', (SELECT count(*) FROM public.payment_orders o
      WHERE o.user_id = p_profile_id AND o.status = 'pending'),
    -- CORE-PATH-V2 V2-12 F: the core-path turns still open or settling are the only money in flight.
    'runsInFlight', (SELECT count(*) FROM public.turns t WHERE t.actor_id = p_profile_id AND (t.state <> 'closed' OR t.settlement = 'pending')),
    'closed', EXISTS (SELECT 1 FROM public.account_erasure_requests e WHERE e.profile_id = p_profile_id)
  );
$function$;

CREATE OR REPLACE FUNCTION public.account_erasure_note_error(p_profile_id uuid, p_code text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE billing boolean:=p_code LIKE 'BILLING_%';pending boolean;
BEGIN
 IF billing AND p_code NOT IN ('BILLING_PENDING','BILLING_NO_PROVIDER_ID','BILLING_EXPIRED',
  'BILLING_ATTEMPTS_EXHAUSTED','BILLING_CONFLICT','BILLING_LOOKUP_UNSUPPORTED',
  'BILLING_CREDENTIAL_UNAVAILABLE','BILLING_RECOVERY_FAILED','BILLING_CLEAR') THEN
  RAISE EXCEPTION 'ERASURE_BILLING_CODE_INVALID' USING ERRCODE='22023';
 END IF;
 IF billing THEN
  IF NOT EXISTS(SELECT 1 FROM profiles p JOIN account_erasure_requests a ON a.profile_id=p.id
   WHERE p.id=p_profile_id AND p.status='deleted' AND p.is_deleted='true') THEN
   RAISE EXCEPTION 'ERASURE_BATCH_ACTOR_DENIED' USING ERRCODE='42501';
  END IF;
  -- CORE-PATH-V2 V2-12 F: an open or unsettled core-path turn is money in flight.
  SELECT EXISTS(SELECT 1 FROM turns t WHERE t.actor_id=p_profile_id AND (t.state<>'closed' OR t.settlement='pending')) INTO pending;
  IF p_code='BILLING_CLEAR' AND pending THEN
   RAISE EXCEPTION 'ERASURE_BILLING_STILL_PENDING';
  END IF;
 END IF;
 UPDATE account_erasure_requests SET
  stage=CASE WHEN billing AND pending THEN 'billing_pending'
   WHEN billing AND stage='billing_pending' THEN 'closed' ELSE stage END,
  -- Finance progress must not hide an outstanding Auth ban failure.
  last_error_code=CASE WHEN billing AND last_error_code='AUTH_BAN_FAILED' THEN last_error_code
   WHEN p_code='BILLING_CLEAR' THEN NULL ELSE p_code END,
  retry_count=retry_count+1,stage_updated_at=clock_timestamp()
 WHERE profile_id=p_profile_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'ACCOUNT_ERASURE_REQUEST_MISSING' USING ERRCODE='P0002';END IF;
END $function$;

CREATE OR REPLACE FUNCTION public.account_erasure_financial_proof(p_profile_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE pending bigint:=0; manual bigint:=0; n bigint; entry record;
BEGIN
 -- CORE-PATH-V2 V2-12 F: the account's core-path turns still open or settling (a frozen hold, an unsettled close).
 SELECT count(*) INTO pending FROM turns WHERE actor_id=p_profile_id AND (state<>'closed' OR settlement='pending');
 SELECT count(*) INTO n FROM payment_orders WHERE user_id=p_profile_id
  AND (NOT erasure_payment_terminal(to_jsonb(payment_orders))
    OR (refund_approval IS NOT NULL AND coalesce(refund_approval->>'status','') NOT IN ('rejected','succeeded','failed')));
 pending:=pending+n+CASE WHEN account_erasure_renewing(p_profile_id) THEN 1 ELSE 0 END;
 SELECT count(*) INTO n FROM payment_orders WHERE user_id=p_profile_id AND (
  (status IN ('completed','refunded','partially_refunded') AND (amount_total IS NULL OR currency IS NULL))
  OR jsonb_path_exists(metadata,'$.**.reviewRequired ? (@ == true)')
  OR metadata->'paymentConflicts' IS NOT NULL AND metadata->'paymentConflicts'<>'[]'::jsonb
  OR jsonb_path_exists(payment_amount_facts,'$[*] ? (@.amount == null)'));
 manual:=manual+n;
 SELECT count(*) INTO n FROM subscription_credit_grants WHERE user_id=p_profile_id
  AND accounting_state IS DISTINCT FROM 'trusted';
 manual:=manual+n;
 FOR entry IN SELECT * FROM (VALUES
  ('credit_transactions','user_id'),('billing_history','user_id'),('token_stats','user_id'),('ai_usage_logs','user_id')
 ) v(tbl,owner_col) LOOP
  EXECUTE format('SELECT count(*) FROM public.%I WHERE %I=$1 AND content_erased_at IS NULL',entry.tbl,entry.owner_col)
   INTO n USING p_profile_id;
  manual:=manual+n;
 END LOOP;
 FOR entry IN SELECT unnest(ARRAY['payment_orders','user_subscriptions','subscription_credit_grants']) tbl LOOP
  EXECUTE format('SELECT count(*) FROM public.%I WHERE user_id=$1 AND
   (metadata_scrubbed_at IS NULL OR (erasure_payment_metadata(metadata,%L)->>''manualReview'')::int>0)',entry.tbl,entry.tbl)
   INTO n USING p_profile_id;
  manual:=manual+n;
 END LOOP;
 SELECT count(*) INTO n FROM payment_orders WHERE user_id=p_profile_id AND
  ((request_erased_at IS NULL AND (checkout_request IS NOT NULL OR purchase_change_request IS NOT NULL)) OR (refund_approval IS NOT NULL AND NOT monthly_refund_erasure_safe(refund_approval)));
 manual:=manual+n;
 -- Older generations/slices have original provider evidence not covered by a projection.
 -- Do not infer that a terminal state proves those arbitrary objects contain no private body.
 SELECT count(*) INTO n FROM artifact_generations g JOIN artifact_projects p ON p.id=g.project_id WHERE p.actor_id=p_profile_id;
 manual:=manual+n;
 SELECT count(*) INTO n FROM agent_slice_calls c JOIN agent_slice_executions x ON x.request_id=c.execution_id
  JOIN artifact_projects p ON p.id=x.project_id WHERE p.actor_id=p_profile_id;
 manual:=manual+n;
 SELECT count(*) INTO n FROM research_operations o JOIN research_plans p ON p.id=o.plan_id
  -- 0263 runtime research: a settled runtime search is finished money.
  WHERE p.actor_id=p_profile_id AND (o.erased_at IS NULL OR NOT research_operation_settled(o));
 pending:=pending+n;
 RETURN jsonb_build_object('financialPending',pending,'manualReview',manual);
END $function$;

CREATE OR REPLACE FUNCTION public.account_erasure_financial_batch(p_limit integer DEFAULT 20, p_profile_id uuid DEFAULT NULL::uuid, p_after_run_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE result jsonb;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
  RAISE EXCEPTION 'ERASURE_BATCH_LIMIT_INVALID' USING ERRCODE='22023';
 END IF;
 IF p_profile_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM account_erasure_requests a
  JOIN profiles p ON p.id=a.profile_id WHERE p.id=p_profile_id
  AND p.status='deleted' AND p.is_deleted='true') THEN
  RAISE EXCEPTION 'ERASURE_BATCH_ACTOR_DENIED' USING ERRCODE='42501';
 END IF;
 WITH open_turns AS (
  -- CORE-PATH-V2 V2-12 F: a deleted account's core-path turns still open or settling are the pending money; turn recovery settles them
  -- (it does not look at the account's status), so they are reported here and never listed as work.
  SELECT count(*) n,min(a.confirmed_at) oldest FROM account_erasure_requests a JOIN profiles p ON p.id=a.profile_id
  JOIN turns t ON t.actor_id=p.id
  WHERE p.status='deleted' AND p.is_deleted='true' AND (p_profile_id IS NULL OR p.id=p_profile_id)
   AND (t.state<>'closed' OR t.settlement='pending')
 )
 SELECT jsonb_build_object(
  'selectedActorId',NULL,
  'items','[]'::jsonb,
  'nextRunId',NULL,
  'totalPending',(SELECT n FROM open_turns),
  'oldestPendingAt',(SELECT oldest FROM open_turns),
  'reasons',CASE WHEN (SELECT n FROM open_turns)>0
   THEN jsonb_build_object('BILLING_PENDING',(SELECT n FROM open_turns)) ELSE '{}'::jsonb END) INTO result;
 RETURN result;
END $function$;

CREATE OR REPLACE FUNCTION public.account_erasure_work_batch(p_profile_id uuid, p_limit integer DEFAULT 20, p_after_run_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE request public.account_erasure_requests; proof jsonb;
BEGIN
 PERFORM account_erasure_assert_closed(p_profile_id);
 IF p_limit IS NULL OR p_limit<1 OR p_limit>20 THEN RAISE EXCEPTION 'ERASURE_BATCH_LIMIT_INVALID'; END IF;
 SELECT * INTO request FROM account_erasure_requests WHERE profile_id=p_profile_id;
 proof:=account_erasure_financial_proof(p_profile_id);
 RETURN proof||jsonb_build_object('requestId',request.request_id,'stage',request.stage,
  'runs','[]'::jsonb,'nextRunId',NULL);
END $function$;

CREATE OR REPLACE FUNCTION public.account_erasure_body_remaining(p_profile_id uuid)
 RETURNS bigint
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- 0338 account results proof

-- 0232 account name proof

-- R9 account proof

DECLARE entry record; n bigint; total bigint:=(SELECT count(*) FROM opc_data_events WHERE actor_id=p_profile_id)
  +(SELECT count(*) FROM fusion_call_outputs WHERE actor_id=p_profile_id)+(SELECT count(*) FROM fusion_reviews WHERE actor_id=p_profile_id)+(SELECT count(*) FROM fusion_compares WHERE actor_id=p_profile_id)
  +(SELECT count(*) FROM runtime_session_results WHERE actor_id=p_profile_id)
  +(SELECT count(*) FROM runtime_session_names WHERE actor_id=p_profile_id)
  -- CORE-PATH-V2 (account_erasure_scrub_turns): message text and provider response bodies still held.
  +(SELECT count(*) FROM session_messages m JOIN runtime_sessions s ON s.id=m.session_id
     WHERE s.actor_id=p_profile_id AND (m.content<>'' OR m.visible))
  +(SELECT count(*) FROM turn_call_raw r JOIN turn_calls c ON c.turn_id=r.turn_id AND c.seq=r.seq WHERE c.actor_id=p_profile_id);
BEGIN
 FOR entry IN SELECT * FROM (VALUES
  ('runtime_sessions','t.actor_id=$1'),
  ('artifact_projects','t.actor_id=$1'),
  ('opc_accounts','t.actor_id=$1'),
  ('opc_businesses','t.actor_id=$1'),
  ('opc_handoffs','t.actor_id=$1'),
  ('opc_content_versions','t.actor_id=$1'),
  ('opc_library_requests','t.actor_id=$1'),
  ('opc_topic_workspaces','t.actor_id=$1'),
  ('opc_topic_draft_versions','t.actor_id=$1'),
  ('research_plans','t.actor_id=$1'),
  ('conversations','t.user_id=$1'),
  -- 0271 legacy chat tables
  ('messages','EXISTS(SELECT 1 FROM conversations p WHERE p.id=t.conversation_id AND p.user_id=$1)'),
  ('conversation_context_snapshots','EXISTS(SELECT 1 FROM conversations p WHERE p.id=t.conversation_id AND p.user_id=$1)'),
  ('runtime_scope_material','EXISTS(SELECT 1 FROM runtime_sessions p WHERE p.id=t.session_id AND p.actor_id=$1)'),
  ('artifact_rounds','EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=t.project_id AND p.actor_id=$1)'),
  ('artifact_evidence','EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=t.project_id AND p.actor_id=$1)'),
  ('artifact_versions','EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=t.project_id AND p.actor_id=$1)'),
  ('artifact_requests','EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=t.project_id AND p.actor_id=$1)'),
  ('artifact_generations','EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=t.project_id AND p.actor_id=$1)'),
  ('artifact_work_references','EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=t.project_id AND p.actor_id=$1)'),
  ('agent_slice_executions','EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=t.project_id AND p.actor_id=$1)'),
  ('artifact_confirmations','EXISTS(SELECT 1 FROM artifact_rounds r JOIN artifact_projects p ON p.id=r.project_id WHERE r.id=t.round_id AND p.actor_id=$1)'),
  ('artifact_candidates','EXISTS(SELECT 1 FROM artifact_rounds r JOIN artifact_projects p ON p.id=r.project_id WHERE r.id=t.round_id AND p.actor_id=$1)'),
  ('agent_slice_links','EXISTS(SELECT 1 FROM artifact_rounds r JOIN artifact_projects p ON p.id=r.project_id WHERE r.id=t.round_id AND p.actor_id=$1)'),
  ('artifact_chat_turns','EXISTS(SELECT 1 FROM conversations p WHERE p.id=t.conversation_id AND p.user_id=$1)'),
  ('research_operations','EXISTS(SELECT 1 FROM research_plans p WHERE p.id=t.plan_id AND p.actor_id=$1)'),
  ('opc_plans','EXISTS(SELECT 1 FROM opc_drafts p WHERE p.draft_id=t.draft_id AND p.actor_id=$1)'),
  ('opc_turns','EXISTS(SELECT 1 FROM opc_drafts p WHERE p.draft_id=t.draft_id AND p.actor_id=$1)'),
  ('opc_topic_openings','EXISTS(SELECT 1 FROM opc_drafts p WHERE p.draft_id=t.draft_id AND p.actor_id=$1)'),
  ('opc_items','EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=t.work_item_id AND p.actor_id=$1)'),
  ('opc_item_edits','EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=t.work_item_id AND p.actor_id=$1)')
 ) AS v(tbl,predicate) LOOP
  EXECUTE format('SELECT count(*) FROM public.%I t WHERE (%s) AND t.erased_at IS NULL',entry.tbl,entry.predicate)
   INTO n USING p_profile_id;
  total:=total+n;
 END LOOP;
 RETURN total;
END $function$;

CREATE OR REPLACE FUNCTION public.account_erasure_scrub_runtime(p_profile_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
    ('runtime_scope_material',
      'request = NULL, content = NULL, content_hash = NULL, erased_at = $2',
      'EXISTS (SELECT 1 FROM runtime_sessions s WHERE s.id = t.session_id AND s.actor_id = $1)',
      -- CORE-PATH-V2 V2-12 F: material goes with its conversation once no turn is open on it.
      't.session_id = ANY($3) AND NOT EXISTS (SELECT 1 FROM runtime_sessions s WHERE s.id = t.session_id AND s.active_turn_id IS NOT NULL)'),
    ('runtime_sessions',
      'scope = NULL, start_payload = NULL, erased_at = $2',
      't.actor_id = $1',
      -- CORE-PATH-V2: a session with a turn still open is erased once the turn closes (it releases active_turn_id there).
      't.id = ANY($3) AND t.active_turn_id IS NULL'),
    -- 0271 legacy chat tables
    ('messages',
      'content = NULL, erased_at = $2',
      'EXISTS (SELECT 1 FROM conversations c WHERE c.id = t.conversation_id AND c.user_id = $1)',
      't.conversation_id = ANY($4) AND NOT EXISTS (SELECT 1 FROM artifact_chats ch JOIN artifact_generations ag ON ag.project_id =
      ch.project_id AND ag.round_id = ch.round_id WHERE ch.conversation_id = t.conversation_id AND ag.state NOT IN
      (''succeeded'',''refunded''))'),
    ('conversation_context_snapshots',
      'content = NULL, metadata = NULL, erased_at = $2',
      'EXISTS (SELECT 1 FROM conversations c WHERE c.id = t.conversation_id AND c.user_id = $1)',
      't.conversation_id = ANY($4) AND NOT EXISTS (SELECT 1 FROM artifact_chats ch JOIN artifact_generations ag ON ag.project_id =
      ch.project_id AND ag.round_id = ch.round_id WHERE ch.conversation_id = t.conversation_id AND ag.state NOT IN
      (''succeeded'',''refunded''))'),
    ('conversations',
      'title = NULL, summary = NULL, summary_metadata = NULL, erased_at = $2',
      't.user_id = $1',
      't.id = ANY($4) AND NOT EXISTS (SELECT 1 FROM artifact_chats ch JOIN artifact_generations ag ON ag.project_id = ch.project_id
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
END $function$;

CREATE OR REPLACE FUNCTION public.account_erasure_scrub_content(p_profile_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- 0338 account results scrub

-- 0232 account name scrub

-- R9 account scrub

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
  TRUNCATE TABLE pg_temp.erasure_scope;
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
    AND research_operation_settled(o);
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
  -- 0271 legacy chat tables
  DELETE FROM artifact_accounts WHERE actor_id = p_profile_id;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('artifact_accounts_deleted', n);
  DELETE FROM opc_data_events WHERE actor_id=p_profile_id;
  GET DIAGNOSTICS n=ROW_COUNT;counts:=counts||jsonb_build_object('opc_data_events',n);
  DELETE FROM runtime_session_names WHERE actor_id=p_profile_id;
  GET DIAGNOSTICS n=ROW_COUNT;counts:=counts||jsonb_build_object('runtime_session_names_deleted',n);
  DELETE FROM fusion_call_outputs WHERE actor_id=p_profile_id;
  GET DIAGNOSTICS n=ROW_COUNT;counts := counts || jsonb_build_object('fusion_call_outputs', n);
  DELETE FROM fusion_reviews WHERE actor_id=p_profile_id;
  GET DIAGNOSTICS n=ROW_COUNT;
  counts := counts || jsonb_build_object('fusion_reviews', n);
  -- 0338 session results
  DELETE FROM runtime_session_results WHERE actor_id=p_profile_id;
  GET DIAGNOSTICS n=ROW_COUNT;counts:=counts||jsonb_build_object('runtime_session_results_deleted',n);
  -- 0320 shortfall
  DELETE FROM research_benchmark_shortfalls WHERE actor_id=p_profile_id;
  GET DIAGNOSTICS n=ROW_COUNT;counts:=counts||jsonb_build_object('research_benchmark_shortfalls_deleted',n);
  -- 0268 benchmarks
  DELETE FROM research_benchmarks WHERE actor_id=p_profile_id;
  GET DIAGNOSTICS n=ROW_COUNT;counts:=counts||jsonb_build_object('research_benchmarks_deleted',n);
  -- 0263 runtime research
  DELETE FROM research_selection_cards WHERE actor_id=p_profile_id;
  GET DIAGNOSTICS n=ROW_COUNT;counts:=counts||jsonb_build_object('research_selection_cards_deleted',n);
  DELETE FROM research_account_fetches WHERE actor_id=p_profile_id;
  GET DIAGNOSTICS n=ROW_COUNT;counts:=counts||jsonb_build_object('research_account_fetches_deleted',n);
  DELETE FROM research_refresh_grants WHERE actor_id=p_profile_id;
  GET DIAGNOSTICS n=ROW_COUNT;counts:=counts||jsonb_build_object('research_refresh_grants_deleted',n);
  DELETE FROM research_discoveries WHERE actor_id=p_profile_id;
  GET DIAGNOSTICS n=ROW_COUNT;counts:=counts||jsonb_build_object('research_discoveries_deleted',n);
  DELETE FROM fusion_compares WHERE actor_id=p_profile_id;
  GET DIAGNOSTICS n=ROW_COUNT;
  counts := counts || jsonb_build_object('fusion_compares', n);
  RETURN counts;
END $function$;

CREATE OR REPLACE FUNCTION public.account_erasure_prune_business(p_profile_id uuid, p_limit integer DEFAULT 100)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t text; item record; n integer; removed integer:=0; legacy_evidence boolean; failed text[]:='{}'; code text;
BEGIN
 PERFORM account_erasure_assert_closed(p_profile_id);
 IF p_limit IS NULL OR p_limit<1 OR p_limit>100 THEN RAISE EXCEPTION 'ERASURE_BATCH_LIMIT_INVALID'; END IF;
 IF NOT account_erasure_barrier() THEN RETURN 0; END IF;
 legacy_evidence:=EXISTS(SELECT 1 FROM artifact_generations g JOIN artifact_projects p ON p.id=g.project_id
  WHERE p.actor_id=p_profile_id) OR EXISTS(SELECT 1 FROM agent_slice_executions x JOIN artifact_projects p ON p.id=x.project_id
  WHERE p.actor_id=p_profile_id);
 UPDATE runtime_test_windows SET actor_ids=array_remove(actor_ids,p_profile_id),
  enabled=enabled AND cardinality(array_remove(actor_ids,p_profile_id))>0
  WHERE id IN (SELECT id FROM runtime_test_windows WHERE p_profile_id=ANY(actor_ids) LIMIT 100 FOR UPDATE SKIP LOCKED);
 -- Financial rows are never deleted. The existing guard permits only unchanged metadata;
 -- ordinary direct nullable content links may be safely severed on a closed, scrubbed row.
 UPDATE token_stats SET erased_conversation_id=conversation_id,erased_message_id=message_id,conversation_id=NULL,message_id=NULL WHERE ctid IN
  (SELECT ctid FROM token_stats WHERE user_id=p_profile_id AND content_erased_at IS NOT NULL
   AND conversation_id IS NOT NULL LIMIT p_limit FOR UPDATE SKIP LOCKED);
 -- LIB-2a public erasure
 -- PUBLISH-MONITOR erasure
 PERFORM publish_monitor_erasure_scrub(p_profile_id);
 -- 0262 library references
 -- PAY-FOUNDER erasure
 -- PAY-NOTIFY erasure
 -- ANALYTICS erasure
 -- VOICE erasure
 -- VOICE references
 FOREACH t IN ARRAY ARRAY[
  'voice_profiles','voice_profile_versions','voice_billing_scrubs',
  'analytics_checkout_ids','analytics_consent_withdrawals',
  'payment_notices',
  'founder_wall_entries','founder_community_status',
  'social_metric_snapshots','social_posts','social_review_runs','social_publish_jobs',
  'social_connect_requests','social_connections','social_monitor_settings',
  'library_document_segments','library_recognition_units','library_documents',
  'opc_video_material_bindings','opc_account_strategy_request_bases','opc_result_links','opc_content_versions',
  'opc_item_edits','opc_items','opc_plans','opc_turns',
  'opc_topic_openings','opc_topic_draft_versions','opc_topic_workspaces','opc_handoffs',
  'opc_account_strategy_drafts','opc_draft_businesses','opc_accounts','opc_businesses',
  'opc_drafts','opc_library_requests','runtime_scope_material',
  -- 0271 legacy chat tables
  'runtime_sessions','conversation_context_snapshots','messages',
  'conversations','agent_slice_links','artifact_work_references','artifact_evidence_restrictions',
  'artifact_confirmations','artifact_candidates','artifact_versions','artifact_requests',
  'artifact_evidence','artifact_rounds','artifact_projects'
 ] LOOP
  EXIT WHEN removed>=p_limit;
  -- Legacy financial evidence is not covered by a projection: keep its original context
  -- identities (already body-scrubbed by B1) until the financial review is resolved.
  IF legacy_evidence AND (t LIKE 'artifact_%' OR t IN ('agent_slice_links','opc_result_links')) THEN CONTINUE; END IF;
  FOR item IN EXECUTE format('SELECT ctid AS row_tid,to_jsonb(x) AS body FROM public.%I x
   WHERE public.erasure_business_owner(%L,to_jsonb(x))=$1 LIMIT $2 FOR UPDATE SKIP LOCKED',t)
   USING p_profile_id,p_limit-removed LOOP
   -- Body-bearing rows must have passed B1. Conversation deletion also retains its original
   -- legacy guards, and a RETURN NULL is observed as zero affected rows, never completion.
   IF t LIKE 'library_%' AND (
     EXISTS(SELECT 1 FROM library_upload_reservations WHERE actor_id=p_profile_id)
     OR EXISTS(SELECT 1 FROM library_recognition_units WHERE actor_id=p_profile_id AND bill2_request_id IS NOT NULL)
    ) THEN CONTINUE; END IF;
   IF t LIKE 'social_%' AND public.publish_monitor_erasure_retained(t,item.body) THEN CONTINUE; END IF;
   IF item.body ? 'erased_at' AND item.body->>'erased_at' IS NULL THEN CONTINUE; END IF;
   BEGIN
    EXECUTE format('DELETE FROM public.%I WHERE ctid=$1',t) USING item.row_tid;
    GET DIAGNOSTICS n=ROW_COUNT;removed:=removed+n;
   -- A retained financial parent or a shared dependency stays. No cascade/trigger bypass.
   EXCEPTION WHEN foreign_key_violation OR check_violation THEN
    -- 0395 prune diagnostics
    code:='ERASURE_PRUNE_'||SQLSTATE||'_'||upper(t);
    IF cardinality(failed)<5 AND code<>ALL(failed) THEN failed:=failed||code; END IF;
   WHEN lock_not_available THEN
    NULL; -- another writer holds the row; the next round retries it
   END;
  END LOOP;
 END LOOP;
 -- 0395: a failed delete while business work remains is why the request cannot finish; report it on this
 -- executor round (executor_finish keeps it). Review codes and completion are unchanged.
 IF cardinality(failed)>0 AND account_erasure_business_remaining(p_profile_id)>0 THEN
  UPDATE account_erasure_requests SET executor_error_codes=executor_error_codes||ARRAY(SELECT c FROM unnest(failed) c
   WHERE c<>ALL(executor_error_codes)) WHERE profile_id=p_profile_id;
 END IF;
 RETURN removed;
END $function$;

CREATE OR REPLACE FUNCTION public.erasure_business_owner(t text, j jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE result uuid;
BEGIN
 -- LIB-2a public erasure
 -- PUBLISH-MONITOR erasure
 -- 0262 library references
 -- PAY-FOUNDER erasure
 -- PAY-NOTIFY erasure
 -- ANALYTICS erasure
 -- VOICE erasure
 -- VOICE references
 CASE
 WHEN t IN ('voice_profiles','voice_profile_versions','voice_billing_scrubs') THEN RETURN (j->>'actor_id')::uuid;
 WHEN t IN ('analytics_checkout_ids','analytics_consent_withdrawals') THEN RETURN (j->>'user_id')::uuid;
 WHEN t='payment_notices' THEN RETURN (j->>'user_id')::uuid;
 WHEN t IN ('founder_wall_entries','founder_community_status') THEN RETURN (j->>'user_id')::uuid;
 WHEN t IN ('social_monitor_settings','social_connections','social_posts',
  'social_metric_snapshots','social_review_runs','social_connect_requests','social_publish_jobs')
  THEN RETURN (j->>'actor_id')::uuid;
 WHEN t IN ('library_documents','library_document_segments',
  'library_upload_reservations','library_recognition_units') THEN RETURN (j->>'actor_id')::uuid;
 WHEN t IN ('opc_content_versions','opc_handoffs','opc_library_requests','opc_topic_workspaces',
  'opc_topic_draft_versions','opc_video_material_bindings','opc_account_strategy_request_bases',
  'opc_account_strategy_drafts','opc_accounts','opc_businesses','opc_drafts','artifact_projects',
  'runtime_sessions') THEN RETURN (j->>'actor_id')::uuid;
 -- 0271 legacy chat tables
 WHEN t='conversations' THEN RETURN (j->>'user_id')::uuid;
 WHEN t IN ('messages','conversation_context_snapshots','artifact_chat_turns','artifact_chats') THEN
  SELECT user_id INTO result FROM conversations WHERE id=(j->>'conversation_id')::uuid;
 WHEN t IN ('artifact_versions','artifact_requests','artifact_evidence','artifact_work_references','artifact_rounds') THEN
  SELECT actor_id INTO result FROM artifact_projects WHERE id=(j->>'project_id')::uuid;
 WHEN t IN ('artifact_confirmations','artifact_candidates','agent_slice_links') THEN
  SELECT p.actor_id INTO result FROM artifact_rounds r JOIN artifact_projects p ON p.id=r.project_id
   WHERE r.id=(j->>'round_id')::uuid;
 -- CORE-PATH-V2 V2-7a2: a report finalized from a turn names its owner on the link.
 WHEN t='opc_result_links' AND j->>'turn_actor_id' IS NOT NULL THEN RETURN (j->>'turn_actor_id')::uuid;
 -- CORE-PATH-V2 V2-12 F: a link made from an old execution (no turn) is owned through the project of its evidence.
 WHEN t='opc_result_links' THEN
  SELECT p.actor_id INTO result FROM artifact_evidence ev JOIN artifact_projects p ON p.id=ev.project_id
   WHERE ev.id=(j->>'evidence_id')::uuid;
 WHEN t='runtime_scope_material' THEN
  SELECT actor_id INTO result FROM runtime_sessions WHERE id=(j->>'session_id')::uuid;
 WHEN t IN ('opc_turns','opc_topic_openings','opc_plans','opc_draft_businesses') THEN
  SELECT actor_id INTO result FROM opc_drafts WHERE draft_id=(j->>'draft_id')::uuid;
 WHEN t IN ('opc_items','opc_item_edits') THEN
  SELECT actor_id INTO result FROM artifact_projects WHERE id=(j->>'work_item_id')::uuid;
 WHEN t='artifact_evidence_restrictions' THEN
  SELECT p.actor_id INTO result FROM artifact_evidence e JOIN artifact_projects p ON p.id=e.project_id
   WHERE e.id=(j->>'evidence_id')::uuid;
 ELSE RETURN NULL;
 END CASE;
 RETURN result;
END $function$;

CREATE OR REPLACE FUNCTION public.content_erasure_ledger_owned(j jsonb)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 -- CORE-PATH-V2 V2-12 F: a ledger row was owned through one of the account's content-deleted BILL2 runs; those runs are gone,
 -- and the core-path turns keep their own receipts. Account erasure still closes every ledger row of a deleted account.
 SELECT false;
$function$;

CREATE OR REPLACE FUNCTION public.content_erasure_capture_steps(steps jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- R9 erase provenance

DECLARE st record;f record;v jsonb;meta jsonb;result jsonb:=steps;changed boolean;information_changed boolean;ids uuid[]:='{}';
BEGIN
 -- CORE-PATH-V2 V2-12 F: the old executions that provenance could name are gone, so no capture field names a deleted one.
 IF jsonb_typeof(steps) IS DISTINCT FROM 'object' THEN RETURN steps; END IF;
 FOR st IN SELECT * FROM jsonb_each(steps) LOOP
  v:=st.value;changed:=false;information_changed:=false;
  FOR f IN SELECT * FROM jsonb_each(coalesce(v->'fieldMeta','{}')) LOOP
   meta:=f.value;
   IF meta->>'source'='capture' AND lower(meta->>'executionId')=ANY(ids::text[]) THEN
    IF meta->>'fp'=artifact_hash(v#>ARRAY['information',f.key]) THEN
     v:=jsonb_set(v,ARRAY['information',f.key],'{"value":"","status":"unknown","nature":"unknown"}');
     information_changed:=true;
    END IF;
    meta:=meta-ARRAY['source','executionId','fp'];changed:=true;
   END IF;
   IF content_erasure_references(meta->'suggestion',ids) THEN meta:=meta-'suggestion';changed:=true; END IF;
   IF content_erasure_references(meta->'withdrawnSuggestion',ids) THEN meta:=meta-'withdrawnSuggestion';changed:=true; END IF;
   IF content_erasure_references(meta->'suggestions',ids) THEN
    meta:=jsonb_set(meta,'{suggestions}',(SELECT coalesce(jsonb_agg(x),'[]') FROM jsonb_array_elements(meta->'suggestions') x
     WHERE NOT content_erasure_references(x,ids)));changed:=true;
   END IF;
   IF meta->>'source'='user' AND (content_erasure_references(meta->'executionId',ids)
    OR content_erasure_references(meta->'origin',ids)) THEN
    meta:=(meta-ARRAY['executionId','origin'])||jsonb_build_object('sourceAvailable',false);changed:=true;
   END IF;
   v:=jsonb_set(v,ARRAY['fieldMeta',f.key],meta);
  END LOOP;
  IF changed THEN
   IF information_changed THEN
    v:=v||jsonb_build_object('valid',false,'version',coalesce((v->>'version')::integer,0)+1);
   END IF;
   result:=jsonb_set(result,ARRAY[st.key],v);
  END IF;
 END LOOP;
 RETURN result;
END $function$;

CREATE OR REPLACE FUNCTION public.content_erasure_artifact_readable(a uuid, vid uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v artifact_versions;p artifact_projects;r artifact_rounds;eid text;
BEGIN
 SELECT * INTO v FROM artifact_versions WHERE id=vid AND erased_at IS NULL;
 SELECT * INTO p FROM artifact_projects WHERE id=v.project_id AND actor_id=a AND erased_at IS NULL;
 SELECT * INTO r FROM artifact_rounds WHERE id=v.round_id AND erased_at IS NULL AND state='published';
 IF v.id IS NULL OR p.id IS NULL OR r.id IS NULL THEN RETURN false; END IF;
 PERFORM bill2_actor(a);
 PERFORM read_skill_package(a,p.module_id,p.skill_id,r.revision_id,r.package_hash,NULL);
 IF artifact_evidence_allowed(p.id,v.evidence_ids) THEN RETURN true; END IF;
 FOR eid IN SELECT jsonb_array_elements_text(v.evidence_ids) LOOP
  IF EXISTS(SELECT 1 FROM artifact_evidence_restrictions WHERE evidence_id::text=eid
   AND (deleted OR expires_at<=clock_timestamp())) THEN RETURN false; END IF;
  IF NOT artifact_evidence_allowed(p.id,jsonb_build_array(eid)) AND NOT EXISTS(
   -- CORE-PATH-V2 V2-7a2: a report finalized from a turn stays readable when its conversation is deleted.
   SELECT 1 FROM opc_result_links l JOIN turns t ON t.actor_id=l.turn_actor_id AND t.id=l.turn_id JOIN runtime_sessions s ON s.id=t.session_id
    JOIN artifact_evidence ev ON ev.id=l.evidence_id
   WHERE l.evidence_id::text=eid AND ev.project_id=p.id AND t.actor_id=a AND s.content_deleted_at IS NOT NULL
   UNION ALL
   SELECT 1 FROM artifact_work_references ref JOIN artifact_versions src ON src.id=ref.source_version_id
    JOIN artifact_projects owner ON owner.id=src.project_id
   WHERE ref.evidence_id::text=eid AND ref.project_id=p.id AND owner.actor_id=a AND owner.content_deleted_at IS NOT NULL
  ) THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN insufficient_privilege OR raise_exception THEN RETURN false;
END $function$;

CREATE OR REPLACE FUNCTION public.content_erasure_saved_readable(a uuid, cid uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE c opc_content_versions;p artifact_projects;v artifact_versions;r artifact_rounds;
 current_id uuid:=cid;seen uuid[]:='{}';first_row boolean:=true;
BEGIN
 IF opc_content_allowed(a,cid) THEN RETURN true; END IF;
 LOOP
  IF current_id IS NULL THEN RETURN true; END IF;
  IF current_id=ANY(seen) THEN RETURN false; END IF;
  SELECT * INTO c FROM opc_content_versions WHERE id=current_id AND actor_id=a;
  IF NOT FOUND OR (first_row AND c.erased_at IS NOT NULL) THEN RETURN false; END IF;
  SELECT * INTO p FROM artifact_projects WHERE id=c.work_item_id AND actor_id=a;
  IF NOT FOUND OR (first_row AND p.erased_at IS NOT NULL) THEN RETURN false; END IF;
  SELECT av.* INTO v FROM opc_items i JOIN artifact_versions av ON av.id=i.source_version_id WHERE i.work_item_id=p.id;
  SELECT * INTO p FROM artifact_projects WHERE id=v.project_id AND actor_id=a;
  SELECT * INTO r FROM artifact_rounds WHERE id=v.round_id AND state='published';
  IF p.id IS NULL OR r.id IS NULL THEN RETURN false; END IF;
  -- Retain current package/actor authorization even when the source body is gone.
  PERFORM read_skill_package(a,p.module_id,p.skill_id,r.revision_id,r.package_hash,NULL);
  IF v.erased_at IS NULL AND NOT opc_source_allowed(a,v.id) THEN RETURN false; END IF;
  -- CORE-PATH-V2 V2-12 F: a version saved from an old execution has no execution to read from any more.
  IF c.execution_id IS NOT NULL THEN RETURN false; END IF;
  -- A deleted conversation leaves the version readable; an account being erased does not.
  IF c.turn_id IS NOT NULL AND EXISTS(SELECT 1 FROM turns t WHERE t.actor_id=a AND t.id=c.turn_id
    AND (turn_tombstones(a,t.session_id,'{}'::jsonb)->>'accountErasing')::boolean) THEN RETURN false; END IF;
  seen:=array_append(seen,current_id);current_id:=c.source_content_id;first_row:=false;
 END LOOP;
EXCEPTION WHEN insufficient_privilege OR raise_exception THEN RETURN false;
END $function$;

CREATE OR REPLACE FUNCTION public.content_erasure_parent_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE j jsonb:=to_jsonb(NEW);sid uuid;pid uuid;deleted boolean;
BEGIN
 IF TG_TABLE_NAME='runtime_scope_material' THEN
  sid:=(j->>'session_id')::uuid;
  SELECT erased_at IS NOT NULL OR content_deleted_at IS NOT NULL INTO deleted FROM runtime_sessions WHERE id=sid FOR SHARE;
  IF deleted THEN RAISE EXCEPTION 'CONTENT_ERASED' USING ERRCODE='42501'; END IF;
 END IF;
 IF TG_TABLE_NAME IN ('artifact_rounds','artifact_versions','artifact_requests','artifact_evidence','artifact_generations','artifact_chats') THEN
  pid:=(j->>'project_id')::uuid;
 ELSIF TG_TABLE_NAME IN ('artifact_candidates','artifact_confirmations') THEN
  SELECT project_id INTO pid FROM artifact_rounds WHERE id=(j->>'round_id')::uuid;
 ELSIF TG_TABLE_NAME='artifact_chat_turns' THEN
  SELECT project_id INTO pid FROM artifact_chats WHERE conversation_id=(j->>'conversation_id')::uuid;
 ELSIF TG_TABLE_NAME='artifact_chat_summaries' THEN
  SELECT c.project_id INTO pid FROM artifact_chats c JOIN artifact_chat_turns t ON t.conversation_id=c.conversation_id
   WHERE t.request_id=(j->>'turn_id')::uuid;
 ELSIF TG_TABLE_NAME IN ('opc_content_versions','opc_work_ui','opc_publication_ui') THEN pid:=(j->>'work_item_id')::uuid;
 ELSIF TG_TABLE_NAME IN ('opc_account_ui','opc_account_strategy_drafts') THEN pid:=(j->>'account_project_id')::uuid;
 END IF;
 IF pid IS NOT NULL THEN
  SELECT erased_at IS NOT NULL OR content_deleted_at IS NOT NULL INTO deleted FROM artifact_projects WHERE id=pid FOR SHARE;
  IF deleted THEN RAISE EXCEPTION 'CONTENT_ERASED' USING ERRCODE='42501'; END IF;
 END IF;
 IF TG_TABLE_NAME='opc_content_versions' AND j->>'source_content_id' IS NOT NULL THEN
  -- Source reads stay denied; independently saved existing bodies are not new source grants.
  IF NOT opc_content_allowed((j->>'actor_id')::uuid,(j->>'source_content_id')::uuid) THEN RAISE EXCEPTION 'CONTENT_ERASED' USING ERRCODE='42501'; END IF;
 END IF;
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.content_erasure_mark_session(a uuid, target uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s runtime_sessions; deleted boolean; scope jsonb; ids uuid[]; refs uuid[]; local boolean; stamp timestamptz; unbound boolean;
BEGIN
 PERFORM bill2_actor(a);
 -- Same order as content_erasure_confirm (profile, then session). A short wait instead of
 -- NOWAIT lets a reply commit that holds this session for a moment finish first.
 PERFORM set_config('lock_timeout','2000',true);
 PERFORM id FROM profiles WHERE id=a FOR SHARE;
 PERFORM bill2_actor(a);
 SELECT * INTO s FROM runtime_sessions WHERE id=target AND actor_id=a FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND' USING ERRCODE='42501'; END IF;
 deleted:=s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL;
 IF deleted THEN
  RETURN jsonb_build_object('kind','session','id',target,'status','deleted','alreadyDeleted',true,
   'preservedSavedVersions',0,'financialReviewCount',0);
 END IF;
 -- Read-only scope (no account-wide locks). The marker alone is enough only when nothing outside
 -- this conversation holds a copy: a free conversation (no work, draft or topic binding), every scoped
 -- execution in it, no saved content, work, data event, result link, captured field, library
 -- request or other conversation's frozen material referencing it. Anything else, or any doubt,
 -- runs the full cleanup now so no derived copy stays readable after this call returns.
 -- ERASE-SPEED bound first: a conversation bound to a draft or a topic workspace (the same two conditions as
 -- below) is never cleaned by the marker alone; only for it is the scope not computed here.
 unbound:=NOT EXISTS(SELECT 1 FROM opc_drafts d WHERE d.session_id=target)
  AND NOT EXISTS(SELECT 1 FROM opc_topic_workspaces t WHERE t.session_id=target);
 IF unbound THEN
  scope:=content_erasure_scope(a,'session',target);
  SELECT coalesce(array_agg(v::uuid),'{}') INTO ids FROM jsonb_array_elements_text(scope->'executions') v;
  refs:=ids||target;
 END IF;
 local:=unbound AND s.scope->>'kind'='positioning_draft' AND s.scope->>'workItemId' IS NULL
  AND NOT EXISTS(SELECT 1 FROM opc_drafts d WHERE d.session_id=target)
  AND NOT EXISTS(SELECT 1 FROM opc_topic_workspaces t WHERE t.session_id=target)
  AND NOT EXISTS(SELECT 1 FROM fusion_compares fcmp WHERE fcmp.session_id=target)
  AND jsonb_array_length(scope->'projects')=0 AND jsonb_array_length(scope->'versions')=0
  AND jsonb_array_length(scope->'contents')=0 AND jsonb_array_length(scope->'affectedSources')=0
  AND NOT EXISTS(SELECT 1 FROM opc_content_versions c WHERE c.actor_id=a AND c.execution_id=ANY(ids))
  AND NOT EXISTS(SELECT 1 FROM opc_content_versions c JOIN turns t ON t.actor_id=c.turn_actor_id AND t.id=c.turn_id WHERE t.actor_id=a AND t.session_id=target)
  AND NOT EXISTS(SELECT 1 FROM opc_data_events d WHERE d.actor_id=a AND d.execution_id=ANY(ids))
  AND NOT EXISTS(SELECT 1 FROM opc_data_events d JOIN turns t ON t.actor_id=d.turn_actor_id AND t.id=d.turn_id WHERE t.actor_id=a AND t.session_id=target)
  AND NOT EXISTS(SELECT 1 FROM opc_result_links l WHERE l.execution_id=ANY(ids))
  AND NOT EXISTS(SELECT 1 FROM opc_result_links l JOIN turns t ON t.actor_id=l.turn_actor_id AND t.id=l.turn_id WHERE t.actor_id=a AND t.session_id=target)
  AND NOT EXISTS(SELECT 1 FROM artifact_rounds r JOIN artifact_projects p ON p.id=r.project_id
   WHERE p.actor_id=a AND r.erased_at IS NULL AND content_erasure_references(r.steps,refs))
  AND NOT EXISTS(SELECT 1 FROM opc_library_requests q WHERE q.actor_id=a AND q.erased_at IS NULL
   AND (content_erasure_references(q.payload,refs) OR content_erasure_references(q.result,refs)))
  AND NOT EXISTS(SELECT 1 FROM runtime_scope_material m JOIN runtime_sessions o ON o.id=m.session_id
   WHERE o.actor_id=a AND m.session_id<>target AND m.erased_at IS NULL
    AND (content_erasure_references(m.request,refs) OR content_erasure_references(m.content,refs)));
 UPDATE runtime_sessions SET content_deleted_at=clock_timestamp() WHERE id=target RETURNING content_deleted_at INTO stamp;
 -- CORE-PATH-V2: the conversation's messages leave the visible history now (one indexed update, still under the session
 -- lock turn_close appends under); their text is cleared with the rest of the conversation by content_erasure_confirm.
 UPDATE session_messages SET visible=false,deleted_at=stamp WHERE session_id=target AND (visible OR deleted_at IS NULL);
 -- Off-database erasure manifest (0227): recorded at the marker's time, in the same transaction;
 -- the later cleanup's own note keeps this first time.
 PERFORM erasure_manifest_note('session',target,a,stamp);
 IF NOT local THEN
  -- Same transaction: the marked-session cleanup locks only rows in scope. If it is busy the
  -- marker rolls back with it and the caller reports the conversation as not deleted.
  RETURN content_erasure_confirm(a,'session',target,NULL)||jsonb_build_object('alreadyDeleted',false);
 END IF;
 -- Content is unreadable from here on. Money facts stay on their original runs; the
 -- background cleanup reports any financial review.
 RETURN jsonb_build_object('kind','session','id',target,'status','deleted','alreadyDeleted',false,
  'preservedSavedVersions',0,'financialReviewCount',0);
EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
 RAISE EXCEPTION 'CONTENT_ERASURE_BUSY' USING ERRCODE='55P03';
END $function$;

CREATE OR REPLACE FUNCTION public.content_erasure_scope(a uuid, k text, target uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- R9 erasure preview

DECLARE sessions uuid[]:='{}'; executions uuid[]:='{}'; projects uuid[]:='{}'; versions uuid[]:='{}';
 content_ids uuid[]:='{}'; refs uuid[]:='{}'; turn_ids bigint[]:='{}';
 root_s runtime_sessions;root_p artifact_projects;root_c opc_content_versions;
 deleted boolean:=false;more uuid[];n integer;preserved bigint;dependents jsonb;
BEGIN
 IF a IS NULL OR target IS NULL THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND' USING ERRCODE='42501'; END IF;
 IF k='answer' THEN
  -- CORE-PATH-V2 V2-12 F: an answer was one old execution; none exists any more.
  RAISE EXCEPTION 'CONTENT_NOT_FOUND' USING ERRCODE='42501';
 ELSIF k='session' THEN
  SELECT * INTO root_s FROM runtime_sessions WHERE id=target AND actor_id=a;
  IF NOT FOUND THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND' USING ERRCODE='42501'; END IF;
  sessions:=ARRAY[root_s.id];deleted:=root_s.content_deleted_at IS NOT NULL OR root_s.erased_at IS NOT NULL;
 ELSIF k='artifact' THEN
  SELECT * INTO root_p FROM artifact_projects WHERE id=target AND actor_id=a;
  IF NOT FOUND THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND' USING ERRCODE='42501'; END IF;
  projects:=ARRAY[root_p.id];deleted:=root_p.content_deleted_at IS NOT NULL OR root_p.erased_at IS NOT NULL;
  -- Account-specific strategy drafts are private copies in separate projects.
  projects:=projects||ARRAY(SELECT d.project_id FROM opc_account_strategy_drafts b
   JOIN opc_drafts d ON d.draft_id=b.draft_id JOIN artifact_projects p ON p.id=d.project_id
   WHERE b.account_project_id=root_p.id AND b.actor_id=a AND d.actor_id=a AND p.actor_id=a);
  versions:=ARRAY(SELECT id FROM artifact_versions WHERE project_id=ANY(projects) ORDER BY id);
  content_ids:=ARRAY(SELECT id FROM opc_content_versions WHERE actor_id=a AND work_item_id=ANY(projects) ORDER BY id);
 ELSIF k='content' THEN
  SELECT * INTO root_c FROM opc_content_versions WHERE id=target AND actor_id=a;
  IF NOT FOUND THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND' USING ERRCODE='42501'; END IF;
  content_ids:=ARRAY(SELECT id FROM opc_content_versions WHERE actor_id=a AND work_item_id=root_c.work_item_id AND kind=root_c.kind);
  deleted:=NOT EXISTS(SELECT 1 FROM opc_content_versions WHERE id=ANY(content_ids) AND erased_at IS NULL);
 ELSE RAISE EXCEPTION 'CONTENT_TARGET_INVALID' USING ERRCODE='22023'; END IF;
 -- The original producing execution predates the saved content UUID. Follow its
 -- persisted identity for the selected family only, not independent descendants.
 executions:=executions||ARRAY(SELECT execution_id FROM opc_content_versions
  WHERE actor_id=a AND id=ANY(content_ids) AND execution_id IS NOT NULL);
 -- Independent saved descendants stay intact, while their copied source contexts are invalidated.
 WITH RECURSIVE descendants(id) AS (
  SELECT id FROM opc_content_versions WHERE id=ANY(content_ids)
  UNION SELECT c.id FROM opc_content_versions c JOIN descendants d ON c.source_content_id=d.id WHERE c.actor_id=a
 ) SELECT coalesce(array_agg(id ORDER BY id),'{}') INTO refs FROM descendants;
 refs:=refs||executions||sessions||projects||versions||content_ids||
  ARRAY(SELECT id FROM artifact_evidence WHERE project_id=ANY(projects))||
  ARRAY(SELECT operation_id FROM artifact_evidence WHERE project_id=ANY(projects) AND operation_id IS NOT NULL)||
  ARRAY(SELECT draft_id FROM opc_drafts WHERE actor_id=a AND project_id=ANY(projects))||
  ARRAY(SELECT conversation_id FROM artifact_chats WHERE project_id=ANY(projects))||
  ARRAY(SELECT work_item_id FROM opc_items WHERE source_version_id=ANY(versions))||
  ARRAY(SELECT session_id FROM opc_topic_workspaces WHERE actor_id=a AND source_version_id=ANY(versions))||ARRAY(SELECT id FROM artifact_rounds WHERE project_id=ANY(projects));
 -- CORE-PATH-V2 V2-12 F: the executions are only the ids a saved version still names (rows of other tables keep them as plain values).
 -- CORE-PATH-V2 V2-10b C2: the turns of the same dependency, by what a turn can hold: the producing turn of a selected version, a turn
 -- given a script as material (any turn that read a claimed revision) or as source, every turn of a conversation in scope; then
 -- every later turn of those conversations, whose history held the reply.
 turn_ids:=ARRAY(SELECT t.id FROM turns t WHERE t.actor_id=a AND (t.session_id=ANY(sessions)
   OR t.id IN (SELECT c.turn_id FROM opc_content_versions c WHERE c.actor_id=a AND c.id=ANY(content_ids) AND c.turn_id IS NOT NULL)
   OR t.request_id IN (SELECT b.request_id FROM opc_video_material_bindings b WHERE b.actor_id=a AND b.source_script_id=ANY(refs))
   OR EXISTS(SELECT 1 FROM opc_video_material_bindings b WHERE b.actor_id=a AND b.session_id=t.session_id AND b.source_script_id=ANY(refs)
    AND b.material_revision::text=t.policy#>>'{workMaterial,revision}')
   OR t.policy#>>'{workSource,contentId}'=ANY(refs::text[])
   OR t.session_id IN (SELECT rs.id FROM runtime_sessions rs WHERE rs.actor_id=a AND content_erasure_references(rs.scope,refs)))
  ORDER BY t.id);
 -- A resumed turn's raw responses before the pause are on the turns it continues.
 WITH RECURSIVE chain(id,resume_of) AS (SELECT t.id,t.resume_of FROM turns t WHERE t.actor_id=a AND t.id=ANY(turn_ids)
   UNION SELECT p.id,p.resume_of FROM chain c JOIN turns p ON p.actor_id=a AND p.id=c.resume_of)
 SELECT coalesce(array_agg(id ORDER BY id),'{}') INTO turn_ids FROM chain;
 turn_ids:=ARRAY(SELECT t.id FROM turns t WHERE t.actor_id=a AND EXISTS(SELECT 1 FROM turns src
   WHERE src.actor_id=a AND src.id=ANY(turn_ids) AND src.session_id=t.session_id AND src.id<=t.id) ORDER BY t.id);
 SELECT count(*) INTO preserved FROM opc_content_versions c0 WHERE c0.actor_id=a AND c0.erased_at IS NULL
  AND NOT c0.id=ANY(content_ids) AND (c0.execution_id=ANY(executions) OR c0.turn_id=ANY(turn_ids) OR c0.source_content_id=ANY(content_ids));
 preserved:=preserved+(SELECT count(*) FROM artifact_versions v WHERE NOT v.project_id=ANY(projects)
  AND EXISTS(SELECT 1 FROM artifact_projects p0 WHERE p0.id=v.project_id AND p0.actor_id=a)
  AND (EXISTS(SELECT 1 FROM artifact_work_references r WHERE r.project_id=v.project_id AND r.source_version_id=ANY(versions))
   OR EXISTS(SELECT 1 FROM opc_result_links l WHERE l.round_id=v.round_id AND l.execution_id=ANY(executions))
   -- CORE-PATH-V2 V2-7a2: the same for a report finalized from a turn of these conversations.
   OR EXISTS(SELECT 1 FROM opc_result_links l JOIN turns t ON t.actor_id=l.turn_actor_id AND t.id=l.turn_id
    WHERE l.round_id=v.round_id AND t.actor_id=a AND t.session_id=ANY(sessions))));
 SELECT coalesce(jsonb_agg(jsonb_build_object('kind',kind,'id',id) ORDER BY kind,id),'[]') INTO dependents FROM (
  SELECT 'account' kind,p.project_id id FROM opc_accounts p WHERE p.actor_id=a AND p.source_version_id=ANY(versions)
  UNION SELECT 'work_item',i.work_item_id FROM opc_items i JOIN artifact_projects p ON p.id=i.work_item_id
   WHERE p.actor_id=a AND i.source_version_id=ANY(versions)
  UNION SELECT 'reference',r.project_id FROM artifact_work_references r JOIN artifact_projects p ON p.id=r.project_id
   WHERE p.actor_id=a AND r.source_version_id=ANY(versions)
  UNION SELECT 'content',c.id FROM opc_content_versions c WHERE c.actor_id=a AND NOT c.id=ANY(content_ids)
   AND (c.execution_id=ANY(executions) OR c.turn_id=ANY(turn_ids) OR c.id=ANY(refs))
 ) affected;
 -- Canonical sets make the preview hash independent of query plans and physical row order.
 SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}') INTO sessions FROM unnest(sessions) id WHERE id IS NOT NULL;
 SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}') INTO executions FROM unnest(executions) id WHERE id IS NOT NULL;
 SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}') INTO projects FROM unnest(projects) id WHERE id IS NOT NULL;
 SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}') INTO versions FROM unnest(versions) id WHERE id IS NOT NULL;
 SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}') INTO content_ids FROM unnest(content_ids) id WHERE id IS NOT NULL;
 SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}') INTO refs FROM unnest(refs) id WHERE id IS NOT NULL;
 RETURN jsonb_build_object('kind',k,'id',target,'alreadyDeleted',deleted,
  'sessions',to_jsonb(sessions),'executions',to_jsonb(executions),'turns',to_jsonb(turn_ids),'projects',to_jsonb(projects),
  'versions',to_jsonb(versions),'contents',to_jsonb(content_ids),'references',to_jsonb(refs),
  'affectedSources',dependents,'preservedSavedVersions',preserved,
  'dataEvents',coalesce((SELECT jsonb_agg(jsonb_build_array(request_id,item_key,created_at) ORDER BY request_id,item_key)
   FROM opc_data_events WHERE actor_id=a AND (execution_id=ANY(executions) OR project_id=ANY(projects)
    OR turn_id IN (SELECT t.id FROM turns t WHERE t.actor_id=a AND t.session_id=ANY(sessions))
    OR target_project_id=ANY(projects) OR source_version_id=ANY(versions))),'[]'::jsonb));
END $function$;

CREATE OR REPLACE FUNCTION public.content_erasure_confirm(a uuid, k text, target uuid, expected_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- 0338 conversation results erasure

-- 0232 conversation name erasure

-- R9 erasure content

DECLARE scope jsonb; turn_ids bigint[]; ids uuid[]; sessions uuid[]; projects uuid[]; versions uuid[]; contents uuid[];
 refs uuid[]; rounds uuid[]; chats uuid[]; research_ids uuid[]; research_plan_ids uuid[]; stamp timestamptz:=clock_timestamp();
 remaining bigint:=0; deleted boolean; linked uuid[];
BEGIN
 PERFORM bill2_actor(a);
 -- Runtime writers use session -> execution -> run. NOWAIT prevents inverse
 -- legacy/project lock orders from turning erasure into a cross-domain deadlock.
 PERFORM id FROM profiles WHERE id=a FOR SHARE NOWAIT;
 PERFORM bill2_actor(a);
 -- 0231 marked session locks
 IF k='session' AND EXISTS(SELECT 1 FROM runtime_sessions WHERE id=target AND actor_id=a AND content_deleted_at IS NOT NULL) THEN
  scope:=content_erasure_scope(a,k,target);
  SELECT coalesce(array_agg(v::uuid),'{}') INTO ids FROM jsonb_array_elements_text(scope->'executions') v;
  SELECT coalesce(array_agg(v::uuid),'{}') INTO sessions FROM jsonb_array_elements_text(scope->'sessions') v;
  rounds:=ARRAY(SELECT DISTINCT s0.id FROM runtime_sessions s0 WHERE s0.actor_id=a AND s0.id=ANY(sessions) ORDER BY s0.id);
  PERFORM id FROM runtime_sessions WHERE id=ANY(rounds) ORDER BY id FOR UPDATE NOWAIT;
  -- Works these conversations feed (draft, topic workspace or captured field): capture locks the
  -- project before writing, so holding it here serializes capture with this cleanup.
  PERFORM id FROM artifact_projects WHERE actor_id=a AND (id IN (SELECT d0.project_id FROM opc_drafts d0 WHERE d0.session_id=ANY(rounds))
   OR id IN (SELECT d1.project_id FROM opc_topic_workspaces t1 JOIN opc_drafts d1 ON d1.draft_id=t1.draft_id WHERE t1.session_id=ANY(rounds))
   OR id IN (SELECT r0.project_id FROM artifact_rounds r0 JOIN artifact_projects p0 ON p0.id=r0.project_id
    WHERE p0.actor_id=a AND content_erasure_references(r0.steps,ids))) ORDER BY id FOR UPDATE NOWAIT;
  scope:=content_erasure_scope(a,k,target);
  SELECT coalesce(array_agg(v::uuid),'{}') INTO ids FROM jsonb_array_elements_text(scope->'executions') v;
  SELECT coalesce(array_agg(v::uuid),'{}') INTO sessions FROM jsonb_array_elements_text(scope->'sessions') v;
  IF NOT sessions<@rounds OR jsonb_array_length(scope->'projects')>0 THEN
   RAISE EXCEPTION 'CONTENT_ERASURE_BUSY' USING ERRCODE='55P03';
  END IF;
 ELSE
  PERFORM id FROM runtime_sessions WHERE actor_id=a ORDER BY id FOR UPDATE NOWAIT;
  PERFORM id FROM artifact_projects WHERE actor_id=a ORDER BY id FOR UPDATE NOWAIT;
  scope:=content_erasure_scope(a,k,target);
 END IF;
 deleted:=(scope->>'alreadyDeleted')::boolean;
 -- 0227 erasure manifest
 PERFORM erasure_manifest_note(k,target,a,stamp);
 IF NOT deleted AND expected_hash IS DISTINCT FROM encode(sha256(convert_to(scope::text,'utf8')),'hex') THEN
  RAISE EXCEPTION 'CONTENT_ERASURE_PREVIEW_CHANGED' USING ERRCODE='40001';
 END IF;
 SELECT coalesce(array_agg(v::uuid),'{}') INTO ids FROM jsonb_array_elements_text(scope->'executions') v;
 SELECT coalesce(array_agg(v::uuid),'{}') INTO sessions FROM jsonb_array_elements_text(scope->'sessions') v;
 SELECT coalesce(array_agg(v::uuid),'{}') INTO projects FROM jsonb_array_elements_text(scope->'projects') v;
 SELECT coalesce(array_agg(v::uuid),'{}') INTO versions FROM jsonb_array_elements_text(scope->'versions') v;
 SELECT coalesce(array_agg(v::uuid),'{}') INTO contents FROM jsonb_array_elements_text(scope->'contents') v;
 SELECT coalesce(array_agg(v::bigint),'{}') INTO turn_ids FROM jsonb_array_elements_text(scope->'turns') v;
 -- Existing UI writers lock their item/account before updating private settings.
 PERFORM work_item_id FROM opc_items WHERE work_item_id=ANY(projects) ORDER BY work_item_id FOR UPDATE NOWAIT;
 PERFORM project_id FROM opc_accounts WHERE project_id=ANY(projects) ORDER BY project_id FOR UPDATE NOWAIT;
 PERFORM work_item_id FROM opc_work_ui WHERE actor_id=a AND work_item_id=ANY(projects) ORDER BY work_item_id FOR UPDATE NOWAIT;
 PERFORM account_project_id FROM opc_account_ui WHERE actor_id=a AND account_project_id=ANY(projects) ORDER BY account_project_id FOR UPDATE NOWAIT;
 PERFORM work_item_id FROM opc_publication_ui WHERE actor_id=a AND work_item_id=ANY(projects) ORDER BY work_item_id FOR UPDATE NOWAIT;
 rounds:=ARRAY(SELECT id FROM artifact_rounds WHERE project_id=ANY(projects));
 chats:=ARRAY(SELECT c.conversation_id FROM artifact_chats c JOIN conversations v ON v.id=c.conversation_id
  WHERE c.project_id=ANY(projects) AND v.user_id=a);
 PERFORM id FROM conversations WHERE id=ANY(chats) ORDER BY id FOR UPDATE NOWAIT;
 -- CORE-PATH-V2 V2-7a2: evidence linked to these runs, or to a turn of these conversations.
 linked:=ARRAY(SELECT evidence_id FROM opc_result_links WHERE execution_id=ANY(ids))
  ||ARRAY(SELECT l.evidence_id FROM opc_result_links l JOIN turns t ON t.actor_id=l.turn_actor_id AND t.id=l.turn_id WHERE t.actor_id=a AND t.session_id=ANY(sessions));
 research_ids:=ARRAY(SELECT DISTINCT o.id FROM research_operations o JOIN research_plans p ON p.id=o.plan_id
  JOIN artifact_evidence e ON e.operation_id=o.id WHERE p.actor_id=a AND
   (e.project_id=ANY(projects) OR e.id=ANY(linked)));
 -- 0263 runtime research: conversation searches have no artifact evidence.
 research_plan_ids:=ARRAY(SELECT p.id FROM research_plans p WHERE p.actor_id=a AND (p.session_id=ANY(sessions) OR p.execution_id=ANY(ids) OR p.discovery_id IN (
   SELECT d.id FROM research_discoveries d JOIN research_selection_cards c ON c.confirmation_id=d.keyword_confirmation_id
   WHERE c.actor_id=a AND (c.session_id=ANY(sessions) OR c.execution_id=ANY(ids)))));
 research_ids:=research_ids||ARRAY(SELECT o.id FROM research_operations o
  WHERE o.plan_id=ANY(research_plan_ids) AND NOT o.id=ANY(research_ids));
 research_plan_ids:=research_plan_ids||ARRAY(SELECT DISTINCT plan_id FROM research_operations WHERE id=ANY(research_ids));

 -- Research RPCs serialize on the plan. NOWAIT avoids their plan -> project lock inversion.
 PERFORM id FROM research_plans WHERE id=ANY(research_plan_ids) ORDER BY id FOR UPDATE NOWAIT;
 PERFORM id FROM research_operations WHERE id=ANY(research_ids) ORDER BY id FOR UPDATE NOWAIT;
 IF EXISTS(SELECT 1 FROM research_operations WHERE id=ANY(research_ids) AND erased_at IS NULL AND
   (NOT research_operation_settled(research_operations) OR (pre_deduct_id IS NOT NULL AND charged_credits IS NULL))) THEN
  RAISE EXCEPTION 'CONTENT_ERASURE_BUSY' USING ERRCODE='55P03';
 END IF;
 SELECT coalesce(array_agg(v::uuid),'{}') INTO refs FROM jsonb_array_elements_text(scope->'references') v;
 refs:=refs||ids||sessions||projects||versions||contents||rounds;
 -- CORE-PATH-V2 V2-7a2: a report turn's request id is its executionId in the edit and publish requests, which hold the edited text.
 refs:=refs||ARRAY(SELECT request_id FROM turns WHERE actor_id=a AND session_id=ANY(sessions) AND kind='report');
 -- CORE-PATH-V2 V2-10b: a topic turn's request id is its executionId in the topic drafts and the adoption requests.
 refs:=refs||ARRAY(SELECT t.request_id FROM turns t JOIN opc_topic_workspaces w ON w.session_id=t.session_id AND w.actor_id=a
  WHERE t.actor_id=a AND t.session_id=ANY(sessions) AND t.kind='chat');
 -- CORE-PATH-V2 turns: after the account row and their sessions, the order turn_close takes them. A receipt holding one either committed its
 -- response body before this (removed below) or runs after and sees the tombstone (turn_call_record stores no body then).
 PERFORM 1 FROM turns WHERE actor_id=a AND session_id=ANY(sessions) ORDER BY id FOR UPDATE NOWAIT;
 IF EXISTS(SELECT 1 FROM artifact_generations g WHERE g.state NOT IN ('succeeded','refunded')
  AND (g.project_id=ANY(projects) OR content_erasure_references(g.input,refs))) THEN
  RAISE EXCEPTION 'CONTENT_ERASURE_BUSY' USING ERRCODE='55P03';
 END IF;
 UPDATE runtime_sessions SET content_deleted_at=stamp WHERE id=ANY(sessions) AND content_deleted_at IS NULL;
 UPDATE artifact_projects SET content_deleted_at=stamp WHERE id=ANY(projects) AND content_deleted_at IS NULL;
 -- 0290 fusion compares
 PERFORM fc.id FROM fusion_compares fc WHERE fc.actor_id=a AND (fc.session_id=ANY(sessions)
  OR fc.session_id IN (SELECT d.session_id FROM opc_drafts d WHERE d.actor_id=a AND d.project_id=ANY(projects))
  OR content_erasure_references(fc.workspace_dependencies,refs)) ORDER BY fc.id FOR UPDATE NOWAIT;
 DELETE FROM fusion_call_outputs o USING fusion_compares fc
  WHERE o.group_id=fc.group_id AND fc.actor_id=a AND content_erasure_references(fc.workspace_dependencies,refs);
 DELETE FROM fusion_compares fc WHERE fc.actor_id=a AND (fc.session_id=ANY(sessions)
  OR fc.session_id IN (SELECT d.session_id FROM opc_drafts d WHERE d.actor_id=a AND d.project_id=ANY(projects))
  OR content_erasure_references(fc.workspace_dependencies,refs));
 -- 0236 fusion reviews
 -- NOWAIT like the session/project/run locks: a claim holding a review row fails this fast (retryable
 -- CONTENT_ERASURE_BUSY) instead of a deadlock (#955 review).
 PERFORM fr.id FROM fusion_reviews fr WHERE fr.actor_id=a AND (fr.project_id=ANY(projects) OR fr.source_session_id=ANY(sessions)
  OR fr.source_version_id=ANY(versions)) ORDER BY fr.id FOR UPDATE NOWAIT;
 DELETE FROM fusion_reviews fr WHERE fr.actor_id=a AND (fr.project_id=ANY(projects) OR fr.source_session_id=ANY(sessions)
  OR fr.source_version_id=ANY(versions));
 UPDATE runtime_scope_material m SET request=NULL,content=NULL,content_hash=NULL,erased_at=stamp
  WHERE m.erased_at IS NULL AND EXISTS(SELECT 1 FROM runtime_sessions s WHERE s.id=m.session_id AND s.actor_id=a)
   AND (m.session_id=ANY(refs) OR m.request_id=ANY(refs)
    OR EXISTS(SELECT 1 FROM runtime_sessions rs WHERE rs.id=m.session_id AND content_erasure_references(rs.scope,refs))
    OR content_erasure_references(m.request,refs) OR content_erasure_references(m.content,refs)
    OR EXISTS(SELECT 1 FROM opc_video_material_bindings b WHERE b.session_id=m.session_id AND b.material_revision=m.revision AND b.source_script_id=ANY(refs)));
 UPDATE bill2_drafts SET revoked=true WHERE actor_id=a AND id IN
  (SELECT (rs.scope->>'draftId')::uuid FROM runtime_sessions rs WHERE rs.id=ANY(sessions) AND rs.scope->>'kind' IN ('positioning_draft','positioning_topic'));
 DELETE FROM runtime_session_names WHERE session_id=ANY(sessions);
 -- A session with a turn still open keeps its (tombstoned, content-free) shell until that turn closes: an erased row is
 -- immutable and the closing turn releases active_turn_id on it. The sweep erases it on a later pass.
 UPDATE runtime_sessions SET scope=NULL,start_payload=NULL,erased_at=stamp WHERE id=ANY(sessions) AND erased_at IS NULL
  AND active_turn_id IS NULL;
 -- CORE-PATH-V2 conversation content: the provider response bodies of its turns and its message text. The turns and their
 -- receipts are billing records and keep their billing fields (plan 4.6).
 DELETE FROM turn_call_raw r USING turns t WHERE t.actor_id=a AND t.session_id=ANY(sessions) AND r.turn_id=t.id;
 UPDATE session_messages SET content='',content_hash=encode(sha256(''::bytea),'hex'),visible=false,deleted_at=coalesce(deleted_at,stamp)
  WHERE session_id=ANY(sessions) AND (content<>'' OR visible);
 -- The turns behind deleted content (content_erasure_scope), in conversations that stay. One still running would write its receipt and
 -- reply after this cleanup, and the conversation has no tombstone to stop it: the delete waits for it (retryable).
 IF EXISTS(SELECT 1 FROM turns t WHERE t.actor_id=a AND t.id=ANY(turn_ids) AND t.state<>'closed' AND NOT t.session_id=ANY(sessions)) THEN
  RAISE EXCEPTION 'CONTENT_ERASURE_BUSY' USING ERRCODE='55P03';
 END IF;
 DELETE FROM turn_call_raw r USING turns t WHERE t.actor_id=a AND t.id=ANY(turn_ids) AND r.turn_id=t.id;
 UPDATE session_messages m SET content='',content_hash=encode(sha256(''::bytea),'hex'),visible=false,deleted_at=coalesce(m.deleted_at,stamp)
  FROM turns t WHERE t.actor_id=a AND t.id=ANY(turn_ids) AND m.session_id=t.session_id AND m.turn_id=t.id AND (m.content<>'' OR m.visible);
 UPDATE opc_content_versions SET body=NULL,title=NULL,erased_at=stamp WHERE id=ANY(contents) AND erased_at IS NULL;
 -- System capture fields and suggestions carry exact execution provenance. Preserve
 -- unrelated manual fields and independently saved published bodies.
 UPDATE artifact_rounds r SET steps=content_erasure_capture_steps(r.steps)
  WHERE r.erased_at IS NULL AND NOT r.id=ANY(rounds)
  AND EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=r.project_id AND p.actor_id=a)
  AND content_erasure_references(r.steps,ids)
  AND r.steps IS DISTINCT FROM content_erasure_capture_steps(r.steps);
 UPDATE artifact_generations g SET input=NULL,result=(SELECT jsonb_object_agg(key,value)
  FROM jsonb_each(coalesce(g.result,'{}')) WHERE key IN ('credits','inputTokens','outputTokens','costUsd')),erased_at=stamp
  WHERE g.erased_at IS NULL AND g.state IN ('succeeded','refunded') AND
   (g.project_id=ANY(projects) OR content_erasure_references(g.input,refs));
 UPDATE agent_slice_executions SET preference_refs=NULL,discussion_refs=NULL,input_hash=NULL,erased_at=stamp
  WHERE erased_at IS NULL AND project_id=ANY(projects);
 UPDATE agent_slice_links SET source_hash=NULL,erased_at=stamp WHERE erased_at IS NULL AND round_id=ANY(rounds);
 UPDATE opc_library_requests SET payload=NULL,result=NULL,erased_at=stamp WHERE actor_id=a AND erased_at IS NULL
  AND (request_id IN (SELECT request_id FROM opc_content_versions WHERE id=ANY(contents))
   OR result->>'id'=ANY(contents::text[]) OR content_erasure_references(payload,refs) OR content_erasure_references(result,refs));
 UPDATE opc_handoffs SET payload=NULL,result=NULL,erased_at=stamp WHERE actor_id=a AND erased_at IS NULL
  AND (content_erasure_references(payload,refs) OR content_erasure_references(result,refs));
 UPDATE opc_topic_draft_versions SET request=NULL,body=NULL,erased_at=stamp WHERE actor_id=a AND erased_at IS NULL
  AND (source_version_id=ANY(versions) OR request_id=ANY(refs)
   OR content_erasure_references(request,refs) OR content_erasure_references(body,refs)
   OR request_id IN (SELECT event.request_id FROM opc_data_events event WHERE event.actor_id=a
    AND event.action='topic_draft' AND (event.execution_id=ANY(ids)
     OR event.turn_id IN (SELECT t.id FROM turns t WHERE t.actor_id=a AND t.session_id=ANY(sessions)))));
 DELETE FROM opc_data_events WHERE actor_id=a AND (execution_id=ANY(ids) OR project_id=ANY(projects)
  OR turn_id IN (SELECT t.id FROM turns t WHERE t.actor_id=a AND t.session_id=ANY(sessions))
  OR target_project_id=ANY(projects) OR source_version_id=ANY(versions));
 -- Frozen source bodies and request caches are system copies, not independent saved content.
 UPDATE opc_turns t SET input_hash=NULL,erased_at=stamp WHERE t.erased_at IS NULL AND
  (t.session_id=ANY(sessions) OR t.round_id=ANY(rounds));
 UPDATE opc_topic_workspaces SET source_hash=NULL,erased_at=stamp WHERE actor_id=a AND erased_at IS NULL
  AND (session_id=ANY(sessions) OR source_version_id=ANY(versions));
 UPDATE opc_topic_openings SET input=NULL,erased_at=stamp WHERE erased_at IS NULL AND draft_id IN
  (SELECT draft_id FROM opc_drafts WHERE actor_id=a AND (session_id=ANY(sessions) OR project_id=ANY(projects)));
 UPDATE opc_plans SET request=NULL,body=NULL,erased_at=stamp WHERE erased_at IS NULL AND source_version_id=ANY(versions);
 -- Same private-setting removal as account erasure, restricted to the selected family.
 DELETE FROM opc_work_ui WHERE actor_id=a AND work_item_id=ANY(projects);
 DELETE FROM opc_account_ui WHERE actor_id=a AND account_project_id=ANY(projects);
 DELETE FROM opc_publication_ui WHERE actor_id=a AND work_item_id=ANY(projects);
 UPDATE opc_item_edits SET title=NULL,brief=NULL,erased_at=stamp WHERE erased_at IS NULL AND work_item_id=ANY(projects);
 UPDATE opc_items SET brief=NULL,erased_at=stamp WHERE erased_at IS NULL AND work_item_id=ANY(projects);
 UPDATE opc_accounts SET account_key='erased:'||project_id,erased_at=stamp WHERE erased_at IS NULL AND project_id=ANY(projects);
 -- Guided Skill chats belong to the selected artifact family. Clear snapshots
 -- before message bodies and retain content-free identity shells for accounting.
 UPDATE conversation_context_snapshots SET content=NULL,metadata=NULL,erased_at=stamp
  WHERE conversation_id=ANY(chats) AND erased_at IS NULL;
 UPDATE messages SET content=NULL,erased_at=stamp WHERE conversation_id=ANY(chats) AND erased_at IS NULL;
 UPDATE artifact_chat_turns SET body=NULL,erased_at=stamp WHERE conversation_id=ANY(chats) AND erased_at IS NULL;
 UPDATE conversations SET is_deleted='true',deleted_at=stamp WHERE id=ANY(chats) AND erased_at IS NULL;
 UPDATE conversations SET title=NULL,summary=NULL,summary_metadata=NULL,erased_at=stamp WHERE id=ANY(chats) AND erased_at IS NULL;
 UPDATE artifact_versions SET report=NULL,report_hash=NULL,erased_at=stamp WHERE project_id=ANY(projects) AND erased_at IS NULL;
 UPDATE artifact_candidates SET body=NULL,erased_at=stamp WHERE round_id=ANY(rounds) AND erased_at IS NULL;
 UPDATE artifact_confirmations SET body=NULL,erased_at=stamp WHERE round_id=ANY(rounds) AND erased_at IS NULL;
 -- Bound plans include approved operations that were never reserved; erasing them prevents late reserve.
 UPDATE research_plans p SET operations=NULL,erased_at=stamp WHERE p.actor_id=a AND p.erased_at IS NULL AND (p.session_id=ANY(sessions) OR p.execution_id=ANY(ids) OR p.discovery_id IN (
   SELECT d.id FROM research_discoveries d JOIN research_selection_cards c ON c.confirmation_id=d.keyword_confirmation_id
   WHERE c.actor_id=a AND (c.session_id=ANY(sessions) OR c.execution_id=ANY(ids))));
 WITH removed AS (
  DELETE FROM research_discoveries d WHERE d.actor_id=a AND (d.session_id=ANY(sessions) OR d.execution_id=ANY(ids)
   OR d.keyword_confirmation_id IN (SELECT confirmation_id FROM research_selection_cards
    WHERE actor_id=a AND (session_id=ANY(sessions) OR execution_id=ANY(ids)))) RETURNING id
 ) DELETE FROM research_selection_cards WHERE actor_id=a AND
  (session_id=ANY(sessions) OR execution_id=ANY(ids) OR discovery_id IN (SELECT id FROM removed));
 -- Deleting only the answer of a later refresh keeps the earlier success of a remaining answer: the record goes back
 -- to that success (the refresh attempt is dropped and can never finish), so it is reused and never paid for again.
 UPDATE research_account_fetches SET state=CASE WHEN state='failed_charged' THEN state ELSE 'succeeded' END,execution_id=last_success_execution_id,evidence=last_success,
   attempt=gen_random_uuid(),refresh_id=NULL,updated_at=clock_timestamp()
 WHERE actor_id=a AND execution_id=ANY(ids) AND last_success IS NOT NULL
   AND NOT coalesce(last_success_execution_id=ANY(ids),false) AND NOT coalesce(session_id=ANY(sessions),false);
 -- A sent charged/unknown result must not become payable again when only its answer is removed.
 -- Retain only the session-scoped digest and terminal state; revoke late completion tokens and all private payload.
 UPDATE research_account_fetches SET execution_id=NULL,account=NULL,evidence=NULL,last_success=NULL,
   last_success_execution_id=NULL,refresh_id=NULL,attempt=gen_random_uuid(),updated_at=stamp
 WHERE actor_id=a AND state IN ('failed_charged','unknown')
   AND (execution_id=ANY(ids) OR last_success_execution_id=ANY(ids)) AND NOT coalesce(session_id=ANY(sessions),false);
 DELETE FROM research_account_fetches WHERE actor_id=a AND (session_id=ANY(sessions) OR execution_id=ANY(ids)
   OR last_success_execution_id=ANY(ids));
 DELETE FROM research_refresh_grants WHERE actor_id=a AND (session_id=ANY(sessions)
   OR used_execution_id=ANY(ids) OR source_execution_id=ANY(ids));
 DELETE FROM research_discoveries WHERE actor_id=a AND (session_id=ANY(sessions) OR execution_id=ANY(ids));
 -- 0338 session results: a saved result goes with its conversation; erasing only its source reply keeps it (shown as source unavailable).
 DELETE FROM runtime_session_results WHERE actor_id=a AND session_id=ANY(sessions);
 -- 0320 shortfall: the choice card goes with its answer or conversation.
 DELETE FROM research_benchmark_shortfalls WHERE actor_id=a AND (session_id=ANY(sessions) OR execution_id=ANY(ids));
 -- 0268 benchmarks: derived numbers go with their answer, conversation or evidence.
 DELETE FROM research_benchmarks WHERE actor_id=a AND (session_id=ANY(sessions) OR execution_id=ANY(ids)
   OR operation_ids && research_ids);
 -- Same terminal-result cost projection as account erasure; original amounts and charge IDs stay intact.
 UPDATE research_operations o SET erased_at=stamp,
  result=(SELECT jsonb_object_agg(e.key,e.value) FROM jsonb_each(
   CASE WHEN jsonb_typeof(o.result)='object' THEN o.result ELSE '{}'::jsonb END) e WHERE e.key='cost')
 WHERE o.id=ANY(research_ids) AND o.erased_at IS NULL;
 -- Plans contain approved operation IDs/hashes/quote ceilings, never query text. Preserve
 -- mixed plans for unrelated operations; clear only when every approved operation is erased.
 UPDATE research_plans p SET operations=NULL,erased_at=stamp WHERE p.id=ANY(research_plan_ids)
  AND p.erased_at IS NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.operations) item
   WHERE NOT EXISTS(SELECT 1 FROM research_operations o WHERE o.plan_id=p.id
    AND o.id::text=item->>'operationId' AND o.erased_at IS NOT NULL));
 UPDATE artifact_evidence SET payload=NULL,content_hash=NULL,erased_at=stamp WHERE erased_at IS NULL AND
  (project_id=ANY(projects) OR id=ANY(linked));
 UPDATE artifact_requests SET payload=(SELECT jsonb_object_agg(key,value) FROM jsonb_each(coalesce(payload,'{}'))
  WHERE key IN ('sliceExecution','slicePhase')),response=NULL,erased_at=stamp WHERE erased_at IS NULL AND
  EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=artifact_requests.project_id AND p.actor_id=a)
  AND (project_id=ANY(projects) OR content_erasure_references(payload,refs) OR content_erasure_references(response,refs));
 UPDATE artifact_rounds SET steps=NULL,erased_at=stamp WHERE id=ANY(rounds) AND erased_at IS NULL;
 UPDATE artifact_work_references SET creation_payload=NULL,source_hash=NULL,erased_at=stamp WHERE erased_at IS NULL AND
  (project_id=ANY(projects) OR source_version_id=ANY(versions));
 UPDATE artifact_projects SET work_title=NULL,account='erased:'||id,erased_at=stamp WHERE id=ANY(projects) AND erased_at IS NULL;
 -- This status is about content. The core-path turns keep their own receipts; no old run is left to leave money pending.
 RETURN jsonb_build_object('kind',k,'id',target,'status',CASE WHEN remaining>0 THEN 'review_required' ELSE 'deleted' END,
  'alreadyDeleted',deleted,'preservedSavedVersions',scope->'preservedSavedVersions','financialReviewCount',remaining);
EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
 RAISE EXCEPTION 'CONTENT_ERASURE_BUSY' USING ERRCODE='55P03';
END $function$;

DROP FUNCTION IF EXISTS public.account_erasure_detach_runtime(p_profile_id uuid, p_run_id uuid);
DROP FUNCTION IF EXISTS public.account_erasure_scrub_calls(p_profile_id uuid, p_run_id uuid);
DROP FUNCTION IF EXISTS public.account_erasure_scrub_receipts(p_profile_id uuid, p_run_id uuid, p_limit integer);
DROP FUNCTION IF EXISTS public.account_erasure_scrub_run(p_profile_id uuid, p_run_id uuid);
DROP FUNCTION IF EXISTS public.content_erasure_financial_allowed(a uuid, pre uuid);
DROP FUNCTION IF EXISTS public.content_erasure_runtime_check(a uuid, eid uuid);
