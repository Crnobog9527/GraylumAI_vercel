-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- DATA-ERASURE PR-B1a cases, run by run-db-baseline-replay.mjs --after on the database built from
-- the repository files (a disposable local database). Fixture rows are committed first with
-- session_replication_role=replica (test data only: parent rows are not built, so it skips
-- triggers and FK checks while seeding). Every assertion then runs with normal triggers and FK
-- checks in a second transaction that is rolled back.
BEGIN;
SET LOCAL session_replication_role = replica;
CREATE TEMP TABLE ids(k text PRIMARY KEY, v uuid);
INSERT INTO ids SELECT k, gen_random_uuid() FROM unnest(ARRAY[
  'closed', 'open', 'module', 'skill', 'revision',
  'c_project', 'c_round', 'c_evidence', 'c_version', 'c_conv', 'c_turn', 'c_gen_done', 'c_gen_live',
  'c_plan', 'c_op_done', 'c_op_live', 'c_draft', 'c_session', 'c_opc_plan', 'c_item', 'c_business',
  'o_project', 'o_round', 'o_evidence', 'o_draft', 'o_opc_plan', 'o_item', 'o_gen', 'o_business']) k;
CREATE TEMP VIEW i AS SELECT (SELECT v FROM ids WHERE k='closed') closed, (SELECT v FROM ids WHERE k='open') open;

INSERT INTO profiles(id, email, nickname, role, status, membership_level, credits, is_deleted)
SELECT v, k || '@example.test', k, 'user', CASE k WHEN 'closed' THEN 'deleted' ELSE 'active' END, 'free', 10,
  CASE k WHEN 'closed' THEN 'true' ELSE 'false' END FROM ids WHERE k IN ('closed', 'open');
INSERT INTO account_erasure_requests(profile_id, request_id) SELECT closed, gen_random_uuid() FROM i;

-- Two owners with the same shape of private content: 'c_*' (closed) and 'o_*' (open).
INSERT INTO artifact_projects(id, actor_id, module_id, skill_id, account, current_version, work_kind, work_title)
SELECT (SELECT v FROM ids WHERE k=p||'_project'), (SELECT v FROM ids WHERE k=o), (SELECT v FROM ids WHERE k='module'),
  (SELECT v FROM ids WHERE k='skill'), 'handle-' || p, 1, 'legacy', 'secret title ' || p
FROM (VALUES ('c', 'closed'), ('o', 'open')) x(p, o);
INSERT INTO artifact_rounds(id, project_id, revision_id, package_hash, workflow, workflow_hash, template_hash, state, steps)
SELECT (SELECT v FROM ids WHERE k=p||'_round'), (SELECT v FROM ids WHERE k=p||'_project'), (SELECT v FROM ids WHERE k='revision'),
  'pkg', '{}', 'wf', 'tpl', st, '[{"body":"private step"}]' FROM (VALUES ('c', 'published'), ('o', 'draft')) x(p, st);
INSERT INTO artifact_evidence(id, project_id, kind, payload, content_hash)
SELECT (SELECT v FROM ids WHERE k=p||'_evidence'), (SELECT v FROM ids WHERE k=p||'_project'), 'user', '{"text":"private"}', 'h'
FROM unnest(ARRAY['c', 'o']) p;
INSERT INTO artifact_confirmations(id, round_id, step_id, version, review_version, body, evidence_ids)
SELECT gen_random_uuid(), (SELECT v FROM ids WHERE k=p||'_round'), 's', 1, 1, 'confirmed text', '[]' FROM unnest(ARRAY['c', 'o']) p;
INSERT INTO artifact_candidates(id, round_id, step_id, body, evidence_ids)
SELECT gen_random_uuid(), (SELECT v FROM ids WHERE k=p||'_round'), 's', 'candidate text', '[]' FROM unnest(ARRAY['c', 'o']) p;
INSERT INTO artifact_versions(id, project_id, round_id, version, report, report_hash, evidence_ids)
SELECT (SELECT v FROM ids WHERE k='c_version'), (SELECT v FROM ids WHERE k='c_project'), (SELECT v FROM ids WHERE k='c_round'),
  1, '{"report":"private"}', 'rh', '[]';
INSERT INTO artifact_requests(project_id, request_id, round_id, action, payload, response)
SELECT (SELECT v FROM ids WHERE k=p||'_project'), gen_random_uuid(), (SELECT v FROM ids WHERE k=p||'_round'), 'candidate',
  jsonb_build_object('body', 'private', 'sliceExecution', p || '-exec', 'slicePhase', 'reply'), '{"body":"private"}'
FROM unnest(ARRAY['c', 'o']) p;
INSERT INTO artifact_chats(conversation_id, project_id, round_id, step_id)
SELECT (SELECT v FROM ids WHERE k='c_conv'), (SELECT v FROM ids WHERE k='c_project'), (SELECT v FROM ids WHERE k='c_round'), 's';
INSERT INTO artifact_chat_turns(request_id, conversation_id, step_id, body, evidence_ids, context_turn_ids, generation_mode)
SELECT (SELECT v FROM ids WHERE k='c_turn'), (SELECT v FROM ids WHERE k='c_conv'), 's', 'private question', '[]', '[]', 'legacy';
INSERT INTO artifact_generations(id, project_id, round_id, request_id, step_id, input, basis, evidence_ids, direct_ids,
  quote, pre_deduct_id, dispatch_token, state, result)
SELECT (SELECT v FROM ids WHERE k=g), (SELECT v FROM ids WHERE k=p||'_project'), (SELECT v FROM ids WHERE k=p||'_round'),
  gen_random_uuid(), 's', '{"instruction":"private"}', '{}', '[]', '[]', '{}', gen_random_uuid(), gen_random_uuid(), st,
  '{"body":"private answer","credits":3,"inputTokens":10,"outputTokens":20,"costUsd":0.01}'
FROM (VALUES ('c_gen_done', 'c', 'succeeded'), ('c_gen_live', 'c', 'dispatched'), ('o_gen', 'o', 'dispatched')) x(g, p, st);
INSERT INTO artifact_work_references(round_id, project_id, evidence_id, source_version_id, config_id, section_ids, source_hash,
  creation_request_id, creation_payload)
SELECT (SELECT v FROM ids WHERE k='c_round'), (SELECT v FROM ids WHERE k='c_project'), (SELECT v FROM ids WHERE k='c_evidence'),
  (SELECT v FROM ids WHERE k='c_version'), 'cfg', '[]', 'sh', gen_random_uuid(), '{"private":true}';
INSERT INTO agent_slice_links(round_id, evidence_id, source_version_id, source_hash, pair_id, section_ids, request_id)
SELECT (SELECT v FROM ids WHERE k='c_round'), (SELECT v FROM ids WHERE k='c_evidence'), (SELECT v FROM ids WHERE k='c_version'),
  'sh', 'pair', '[]', gen_random_uuid();
INSERT INTO agent_slice_executions(request_id, conversation_id, project_id, round_id, step_id, revision_id, pair_id, model_id,
  provider_model, budget_credits, evidence_ids, basis, preference_refs, input_hash, discussion_refs)
SELECT gen_random_uuid(), (SELECT v FROM ids WHERE k='c_conv'), (SELECT v FROM ids WHERE k='c_project'), (SELECT v FROM ids WHERE k='c_round'),
  's', (SELECT v FROM ids WHERE k='revision'), 'pair', gen_random_uuid(), 'm', 1, '[]', '{}', '[{"name":"tone"}]', 'ih', '[]';
INSERT INTO research_plans(id, actor_id, budget_units, max_operations, operations)
SELECT (SELECT v FROM ids WHERE k='c_plan'), closed, 10, 2, '[{"query":"private"},{"query":"private2"}]' FROM i;
INSERT INTO research_operations(id, plan_id, identity_hash, quote_units, dispatch_token, state, result)
SELECT (SELECT v FROM ids WHERE k=o), (SELECT v FROM ids WHERE k='c_plan'), repeat('a', 64), 1, gen_random_uuid(), st,
  '{"items":["private"],"cost":{"actual":0.2}}' FROM (VALUES ('c_op_done', 'succeeded'), ('c_op_live', 'unknown')) x(o, st);
INSERT INTO opc_drafts(draft_id, actor_id, project_id, round_id, session_id, request_id, registration, mode)
SELECT (SELECT v FROM ids WHERE k=p||'_draft'), (SELECT v FROM ids WHERE k=o), (SELECT v FROM ids WHERE k=p||'_project'),
  (SELECT v FROM ids WHERE k=p||'_round'), gen_random_uuid(), gen_random_uuid(), 'reg', 'mentor'
FROM (VALUES ('c', 'closed'), ('o', 'open')) x(p, o);
INSERT INTO opc_turns(token, draft_id, session_id, request_id, round_id, step_id, purpose, material_revision, input_hash)
SELECT gen_random_uuid(), (SELECT v FROM ids WHERE k='c_draft'), gen_random_uuid(), gen_random_uuid(), (SELECT v FROM ids WHERE k='c_round'),
  's', 'step', 1, 'ih';
INSERT INTO opc_plans(id, draft_id, version, source_version_id, request_id, request, body)
SELECT (SELECT v FROM ids WHERE k=p||'_opc_plan'), (SELECT v FROM ids WHERE k=p||'_draft'), 1, gen_random_uuid(), gen_random_uuid(),
  '{"private":1}', '{"plan":"private"}' FROM unnest(ARRAY['c', 'o']) p;
INSERT INTO opc_items(work_item_id, plan_id, item_key, account_project_id, source_version_id, brief, day)
SELECT (SELECT v FROM ids WHERE k=p||'_item'), (SELECT v FROM ids WHERE k=p||'_opc_plan'), gen_random_uuid(), gen_random_uuid(),
  gen_random_uuid(), 'private brief', current_date FROM unnest(ARRAY['c', 'o']) p;
INSERT INTO opc_item_edits(work_item_id, revision, title, brief, day)
SELECT (SELECT v FROM ids WHERE k=p||'_item'), 1, 'private title', 'private brief', current_date FROM unnest(ARRAY['c', 'o']) p;
INSERT INTO opc_work_ui(actor_id, work_item_id, display_name, pinned, archived, deleted, revision)
SELECT (SELECT v FROM ids WHERE k=o), (SELECT v FROM ids WHERE k=p||'_item'), 'private title', false, false, false, 1
FROM (VALUES ('c', 'closed'), ('o', 'open')) x(p, o);
INSERT INTO opc_handoffs(actor_id, request_id, draft_id, payload, result)
SELECT closed, gen_random_uuid(), (SELECT v FROM ids WHERE k='c_draft'), '{"p":1}', '{"r":1}' FROM i;
INSERT INTO opc_topic_workspaces(draft_id, actor_id, request_id, source_version_id, source_hash, module_id, skill_id, revision_id,
  package_hash, session_id, material_revision)
SELECT (SELECT v FROM ids WHERE k='c_draft'), closed, gen_random_uuid(), gen_random_uuid(), 'sh', gen_random_uuid(), gen_random_uuid(),
  gen_random_uuid(), 'pkg', gen_random_uuid(), 1 FROM i;
INSERT INTO opc_topic_openings(draft_id, request_id, input) SELECT (SELECT v FROM ids WHERE k='c_draft'), gen_random_uuid(), 'private opening';
INSERT INTO opc_topic_draft_versions(id, draft_id, actor_id, version, source_version_id, request_id, request, body)
SELECT gen_random_uuid(), (SELECT v FROM ids WHERE k='c_draft'), closed, 1, gen_random_uuid(), gen_random_uuid(), '{"q":1}', '["topic"]' FROM i;
INSERT INTO opc_library_requests(actor_id, request_id, payload, result)
SELECT (SELECT v FROM ids WHERE k=o), gen_random_uuid(), '{"name":"private"}', '{"ok":true}' FROM unnest(ARRAY['closed', 'open']) o;
INSERT INTO opc_content_versions(id, actor_id, work_item_id, kind, version, status, body, request_id, title)
SELECT gen_random_uuid(), (SELECT v FROM ids WHERE k=o), (SELECT v FROM ids WHERE k=p||'_item'), 'script', 1, 'draft', 'private script',
  gen_random_uuid(), 'private' FROM (VALUES ('c', 'closed'), ('o', 'open')) x(p, o);
INSERT INTO opc_businesses(id, actor_id, name, revision)
SELECT (SELECT v FROM ids WHERE k=p||'_business'), (SELECT v FROM ids WHERE k=o), 'private business', 1
FROM (VALUES ('c', 'closed'), ('o', 'open')) x(p, o);
INSERT INTO opc_accounts(project_id, actor_id, platform, account_key, source_version_id, revision, stage)
SELECT (SELECT v FROM ids WHERE k=p||'_project'), (SELECT v FROM ids WHERE k=o), 'douyin', 'handle-' || p, gen_random_uuid(), 1, 'unknown'
FROM (VALUES ('c', 'closed'), ('o', 'open')) x(p, o);
INSERT INTO opc_account_ui(actor_id, account_project_id, display_name, revision) SELECT closed, (SELECT v FROM ids WHERE k='c_project'), 'private', 1 FROM i;
INSERT INTO opc_publication_ui(actor_id, work_item_id, status, revision) SELECT closed, (SELECT v FROM ids WHERE k='c_item'), 'unpublished', 1 FROM i;
INSERT INTO agent_confirmed_preferences(actor_id, scope_key, name, value, version, active, source)
SELECT v, 'user', 'tone', 'warm', 1, true, 'explicit_user_confirmation' FROM ids WHERE k IN ('closed', 'open');
INSERT INTO agent_preference_requests(actor_id, request_id, payload_hash, version) SELECT closed, gen_random_uuid(), 'ph', 1 FROM i;
INSERT INTO artifact_accounts(actor_id, module_id, skill_id, account) SELECT closed, gen_random_uuid(), gen_random_uuid(), 'handle-c' FROM i;
INSERT INTO opc_result_links(evidence_id, execution_id, round_id, step_id)
SELECT (SELECT v FROM ids WHERE k='o_evidence'), gen_random_uuid(), (SELECT v FROM ids WHERE k='o_round'), 's';
COMMIT;
BEGIN;

-- Helper: the statement must fail (any error); used for guard and constraint refusals.
CREATE FUNCTION pg_temp.must_fail(stmt text, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE stmt; EXCEPTION WHEN OTHERS THEN RETURN; END;
  RAISE EXCEPTION 'expected failure: %', label;
END $$;

-- C1 Scrub refuses an open account (precondition written into the function).
SELECT pg_temp.must_fail(format('SELECT account_erasure_scrub_content(%L)', (SELECT open FROM i)), 'scrub open account');
DO $$ BEGIN
  PERFORM account_erasure_scrub_content((SELECT open FROM i));
EXCEPTION WHEN insufficient_privilege THEN
  IF SQLERRM <> 'ACCOUNT_ERASURE_NOT_CLOSED' THEN RAISE; END IF;
END $$;
SELECT 'PASS C1 scrub refuses an account that is not closed';

-- C2 Scrub of the closed account: counts, content gone, money keys and in-flight rows kept.
CREATE TEMP TABLE first_scrub ON COMMIT DROP AS SELECT account_erasure_scrub_content((SELECT closed FROM i)) AS r;
DO $$
DECLARE r jsonb := (SELECT r FROM first_scrub); counter text;
BEGIN
  FOREACH counter IN ARRAY ARRAY['artifact_chat_turns', 'artifact_generations', 'artifact_rounds', 'artifact_evidence',
    'artifact_confirmations', 'artifact_candidates', 'artifact_versions', 'artifact_requests', 'artifact_work_references',
    'agent_slice_links', 'agent_slice_executions', 'artifact_projects', 'research_operations', 'opc_turns', 'opc_plans',
    'opc_items', 'opc_item_edits', 'opc_handoffs', 'opc_topic_openings', 'opc_topic_workspaces', 'opc_topic_draft_versions',
    'opc_library_requests', 'opc_content_versions', 'opc_accounts', 'opc_businesses', 'opc_work_ui_deleted',
    'opc_account_ui_deleted', 'opc_publication_ui_deleted', 'agent_confirmed_preferences_deleted',
    'agent_preference_requests_deleted', 'artifact_accounts_deleted', 'artifact_generations_skipped',
    'research_operations_skipped'] LOOP
    IF (r ->> counter)::int <> 1 THEN RAISE EXCEPTION 'C2 % expected 1, got %', counter, r ->> counter; END IF;
  END LOOP;
  IF (r ->> 'research_plans')::int <> 0 THEN RAISE EXCEPTION 'C2 plan with a live operation must wait'; END IF;
END $$;
DO $$
DECLARE c uuid := (SELECT closed FROM i);
BEGIN
  IF EXISTS (SELECT 1 FROM artifact_projects WHERE actor_id = c AND (work_title IS NOT NULL OR account <> 'erased:' || id OR erased_at IS NULL))
  OR EXISTS (SELECT 1 FROM artifact_rounds WHERE id = (SELECT v FROM ids WHERE k='c_round') AND steps IS NOT NULL)
  OR EXISTS (SELECT 1 FROM artifact_evidence WHERE project_id = (SELECT v FROM ids WHERE k='c_project') AND (payload IS NOT NULL OR content_hash IS NOT NULL))
  OR EXISTS (SELECT 1 FROM artifact_chat_turns WHERE request_id = (SELECT v FROM ids WHERE k='c_turn') AND body IS NOT NULL)
  OR EXISTS (SELECT 1 FROM artifact_requests WHERE project_id = (SELECT v FROM ids WHERE k='c_project')
    AND (payload <> '{"sliceExecution":"c-exec","slicePhase":"reply"}' OR response IS NOT NULL))
  OR EXISTS (SELECT 1 FROM opc_content_versions WHERE actor_id = c AND (body IS NOT NULL OR title IS NOT NULL))
  OR EXISTS (SELECT 1 FROM opc_accounts WHERE actor_id = c AND account_key <> 'erased:' || project_id)
  OR EXISTS (SELECT 1 FROM opc_item_edits WHERE work_item_id = (SELECT v FROM ids WHERE k='c_item') AND (title IS NOT NULL OR brief IS NOT NULL))
  OR EXISTS (SELECT 1 FROM opc_work_ui WHERE actor_id = c) OR EXISTS (SELECT 1 FROM agent_confirmed_preferences WHERE actor_id = c)
  THEN RAISE EXCEPTION 'C2 closed-account content still present'; END IF;
  IF (SELECT result FROM artifact_generations WHERE id = (SELECT v FROM ids WHERE k='c_gen_done'))
      <> '{"credits":3,"inputTokens":10,"outputTokens":20,"costUsd":0.01}'
  OR (SELECT result FROM research_operations WHERE id = (SELECT v FROM ids WHERE k='c_op_done')) <> '{"cost":{"actual":0.2}}'
  THEN RAISE EXCEPTION 'C2 money keys must survive'; END IF;
  IF (SELECT erased_at FROM artifact_generations WHERE id = (SELECT v FROM ids WHERE k='c_gen_live')) IS NOT NULL
  OR (SELECT input FROM artifact_generations WHERE id = (SELECT v FROM ids WHERE k='c_gen_live')) IS NULL
  OR (SELECT erased_at FROM research_operations WHERE id = (SELECT v FROM ids WHERE k='c_op_live')) IS NOT NULL
  THEN RAISE EXCEPTION 'C2 in-flight rows must be skipped'; END IF;
  IF EXISTS (SELECT 1 FROM artifact_projects WHERE actor_id = (SELECT open FROM i) AND (erased_at IS NOT NULL OR work_title IS NULL))
  OR (SELECT count(*) FROM opc_content_versions WHERE actor_id = (SELECT open FROM i) AND body IS NOT NULL) <> 1
  OR (SELECT count(*) FROM agent_confirmed_preferences WHERE actor_id = (SELECT open FROM i)) <> 1
  OR (SELECT count(*) FROM opc_work_ui WHERE actor_id = (SELECT open FROM i)) <> 1
  THEN RAISE EXCEPTION 'C2 the open account must be untouched'; END IF;
END $$;
SELECT 'PASS C2 closed account scrubbed; money keys kept; in-flight skipped; open account untouched';

-- C3 Idempotent: a second run erases nothing new; after settlement the skipped rows follow.
DO $$
DECLARE r jsonb := account_erasure_scrub_content((SELECT closed FROM i)); counter text;
BEGIN
  FOR counter IN SELECT key FROM jsonb_each_text(r) WHERE key NOT LIKE '%skipped' LOOP
    IF (r ->> counter)::int <> 0 THEN RAISE EXCEPTION 'C3 second run changed %', counter; END IF;
  END LOOP;
  UPDATE artifact_generations SET state = 'succeeded' WHERE id = (SELECT v FROM ids WHERE k='c_gen_live');
  UPDATE research_operations SET state = 'failed' WHERE id = (SELECT v FROM ids WHERE k='c_op_live');
  r := account_erasure_scrub_content((SELECT closed FROM i));
  IF (r ->> 'artifact_generations')::int <> 1 OR (r ->> 'research_operations')::int <> 1 OR (r ->> 'research_plans')::int <> 1
    OR (r ->> 'artifact_generations_skipped')::int <> 0 OR (r ->> 'research_operations_skipped')::int <> 0 THEN
    RAISE EXCEPTION 'C3 settled rows not scrubbed: %', r;
  END IF;
END $$;
SELECT 'PASS C3 idempotent; settled rows scrubbed on the next run';

-- C4 Erased rows are final: no refill, no further change, no delete through history guards.
SELECT pg_temp.must_fail(format('UPDATE artifact_candidates SET body = %L WHERE round_id = %L', 'x', (SELECT v FROM ids WHERE k='c_round')), 'refill candidate');
SELECT pg_temp.must_fail(format('UPDATE opc_plans SET body = %L WHERE draft_id = %L', '{}', (SELECT v FROM ids WHERE k='c_draft')), 'refill opc plan');
SELECT pg_temp.must_fail(format('UPDATE artifact_chat_turns SET body = %L WHERE request_id = %L', 'x', (SELECT v FROM ids WHERE k='c_turn')), 'refill chat turn');
SELECT pg_temp.must_fail(format('UPDATE artifact_rounds SET steps = %L WHERE id = %L', '[]', (SELECT v FROM ids WHERE k='c_round')), 'refill round');
SELECT pg_temp.must_fail(format('UPDATE artifact_generations SET result = %L WHERE id = %L', '{"body":"x"}', (SELECT v FROM ids WHERE k='c_gen_done')), 'refill generation');
SELECT pg_temp.must_fail(format('UPDATE opc_item_edits SET revision = revision + 1 WHERE work_item_id = %L', (SELECT v FROM ids WHERE k='c_item')), 'touch erased edit');
SELECT pg_temp.must_fail(format('UPDATE opc_accounts SET account_key = %L WHERE actor_id = %L', 'handle-c', (SELECT closed FROM i)), 'restore account key');
SELECT pg_temp.must_fail(format('UPDATE artifact_evidence SET erased_at = now() WHERE project_id = %L', (SELECT v FROM ids WHERE k='c_project')), 'touch erased evidence');
SELECT pg_temp.must_fail(format('DELETE FROM artifact_versions WHERE id = %L', (SELECT v FROM ids WHERE k='c_version')), 'delete history');
SELECT 'PASS C4 erased rows cannot be refilled, changed or deleted by history guards';

-- C5 The one-way channel admits nothing else on live rows.
SELECT pg_temp.must_fail(format('UPDATE artifact_candidates SET body = %L WHERE round_id = %L', 'other text', (SELECT v FROM ids WHERE k='o_round')), 'replace live content');
SELECT pg_temp.must_fail(format('UPDATE artifact_candidates SET body = NULL WHERE round_id = %L', (SELECT v FROM ids WHERE k='o_round')), 'clear without marker');
SELECT pg_temp.must_fail(format('UPDATE artifact_candidates SET body = %L, erased_at = now() WHERE round_id = %L', 'other', (SELECT v FROM ids WHERE k='o_round')), 'marker with replaced content');
SELECT pg_temp.must_fail(format('UPDATE artifact_candidates SET body = NULL, erased_at = now(), step_id = %L WHERE round_id = %L', 'x', (SELECT v FROM ids WHERE k='o_round')), 'marker plus other column');
SELECT pg_temp.must_fail(format('UPDATE artifact_requests SET payload = %L, response = NULL, erased_at = now() WHERE project_id = %L', '{"sliceExecution":"o-exec","slicePhase":"reply","body":"kept"}', (SELECT v FROM ids WHERE k='o_project')), 'keys rule keeps extra key');
SELECT pg_temp.must_fail(format('UPDATE opc_accounts SET account_key = %L, erased_at = now() WHERE actor_id = %L', 'erased:wrong', (SELECT open FROM i)), 'wrong sentinel');
SELECT pg_temp.must_fail(format('UPDATE artifact_generations SET input = NULL, result = %L, erased_at = now() WHERE id = %L', '{"body":"x","credits":3}', (SELECT v FROM ids WHERE k='o_gen')), 'generation erase keeps body');
SELECT pg_temp.must_fail(format('UPDATE opc_result_links SET step_id = %L', 'x'), 'argument-free artifact_immutable still refuses');
SELECT pg_temp.must_fail(format('UPDATE artifact_rounds SET steps = NULL, erased_at = now(), state = %L WHERE id = %L', 'published', (SELECT v FROM ids WHERE k='o_round')), 'round erase plus state change');
SELECT 'PASS C5 live rows: no replacement, no partial erase, sentinel and key rules enforced';

-- C6 Constraints still hold for live rows and forbid content on erased rows.
SELECT pg_temp.must_fail(format('INSERT INTO artifact_chat_turns(request_id, conversation_id, step_id, body, evidence_ids, context_turn_ids, generation_mode) VALUES (gen_random_uuid(), %L, %L, %L, %L, %L, %L)', (SELECT v FROM ids WHERE k='c_conv'), 's', '', '[]', '[]', 'legacy'), 'empty chat body');
SELECT pg_temp.must_fail(format('INSERT INTO artifact_chat_turns(request_id, conversation_id, step_id, body, evidence_ids, context_turn_ids, generation_mode) VALUES (gen_random_uuid(), %L, %L, NULL, %L, %L, %L)', (SELECT v FROM ids WHERE k='c_conv'), 's', '[]', '[]', 'legacy'), 'null body without marker');
SELECT pg_temp.must_fail(format('INSERT INTO artifact_chat_turns(request_id, conversation_id, step_id, body, evidence_ids, context_turn_ids, generation_mode, erased_at) VALUES (gen_random_uuid(), %L, %L, %L, %L, %L, %L, now())', (SELECT v FROM ids WHERE k='c_conv'), 's', 'text', '[]', '[]', 'legacy'), 'erased row with content');
SELECT pg_temp.must_fail(format('INSERT INTO opc_content_versions(id, actor_id, work_item_id, kind, version, status, body, request_id) VALUES (gen_random_uuid(), %L, %L, %L, 9, %L, %L, gen_random_uuid())', (SELECT open FROM i), (SELECT v FROM ids WHERE k='o_item'), 'script', 'draft', ''), 'empty script body');
SELECT pg_temp.must_fail(format('INSERT INTO research_plans(id, actor_id, budget_units, max_operations, operations) VALUES (gen_random_uuid(), %L, 5, 2, %L)', (SELECT open FROM i), '[{}]'), 'operations length rule');
INSERT INTO artifact_chat_turns(request_id, conversation_id, step_id, body, evidence_ids, context_turn_ids, generation_mode)
VALUES (gen_random_uuid(), (SELECT v FROM ids WHERE k='c_conv'), 's', 'valid live body', '[]', '[]', 'legacy');
SELECT 'PASS C6 original CHECK/NOT NULL rules hold for live rows; erased rows cannot hold content';

-- C7 Normal write paths after the migration (P1 lesson): real SECURITY DEFINER function and the
-- state updates existing functions perform on the changed tables.
DO $$
DECLARE plan uuid := gen_random_uuid(); r jsonb;
BEGIN
  r := research_transition('create', plan, (SELECT open FROM i), NULL,
    '{"budgetUnits":10,"maxOperations":1,"operations":[{"query":"q"}]}');
  IF r <> '{"created":true}' THEN RAISE EXCEPTION 'C7 create returned %', r; END IF;
  PERFORM research_transition('cancel', plan, (SELECT open FROM i));
  IF NOT (SELECT cancelled FROM research_plans WHERE id = plan) THEN RAISE EXCEPTION 'C7 cancel did not apply'; END IF;
  UPDATE artifact_rounds SET steps = '[{"body":"edited draft"}]' WHERE id = (SELECT v FROM ids WHERE k='o_round');
  UPDATE artifact_generations SET state = 'succeeded' WHERE id = (SELECT v FROM ids WHERE k='o_gen');
  UPDATE opc_accounts SET revision = revision + 1, stage = 'growing' WHERE actor_id = (SELECT open FROM i);
  UPDATE opc_businesses SET name = 'renamed', revision = revision + 1 WHERE actor_id = (SELECT open FROM i);
  UPDATE opc_item_edits SET title = 'new title', revision = revision + 1 WHERE work_item_id = (SELECT v FROM ids WHERE k='o_item');
  IF (SELECT display_name FROM opc_work_ui WHERE work_item_id = (SELECT v FROM ids WHERE k='o_item')) <> 'new title' THEN
    RAISE EXCEPTION 'C7 title sync broken';
  END IF;
  UPDATE artifact_projects SET work_title = 'renamed work' WHERE actor_id = (SELECT open FROM i);
END $$;
SELECT 'PASS C7 real research_transition create/cancel and ordinary updates still work';

ROLLBACK;
