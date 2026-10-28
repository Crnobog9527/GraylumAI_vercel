-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- DB-RW-D (number 0420 assigned by the controller; design: db-rw-chain-branch-plan). BEHIND A SWITCH, default off.
-- runtime_rw_v2.chainBranch (the helper runtime_rw_flag, 0416). While the flag is absent or not true every function below runs
-- exactly the statements it ran before (they are the ELSE / unchanged branches). With {"chainBranch": true} the permission chain
-- (bill2_execution_allowed -> runtime_billing_allowed, runtime_context_allowed, opc_assert_business_writable) stops planning tables
-- its scope cannot reach. PostgreSQL locks every table, and every index of it, that a statement mentions when it plans the
-- statement, even in a branch that never runs; the layered SQL functions bill2_scope_allowed_before_* are one inlined statement
-- that names artifact_projects, artifact_work_references, library_documents, opc_drafts, opc_topic_workspaces,
-- opc_account_strategy_drafts, opc_items and opc_accounts for every scope kind, and opc_target_business names five tables in one
-- statement. A plain turn paid ~35 relation locks for tables its scope never touches, on every step that walks the chain.
-- Skipped checks and why each skip cannot change the answer:
--  * bill2_scope_allowed_branch (new; bill2_scope_allowed calls it instead of bill2_scope_allowed_before_memo when the flag is on):
--    - kind library_document: the same expression as before_memo.
--    - kind not one of positioning_draft / work_item / positioning_topic (and not NULL): every layer answers false for it.
--    - the projectId/workItemId tombstone lookup runs only when the scope carries one of them (p.id::text = NULL is never true).
--    - the draft tombstone looks the OPC draft up once; artifact_projects is read only when that draft has a project.
--    - positioning_draft: the topic and work-item clauses require another kind, so the answer is the before_opc clause and the
--      strategy-binding clause; the binding table is read only when the scope's draft is an OPC draft of this account.
--    - work_item: before_opc and the topic clause both require "no draftId"; positioning_topic: only the topic clause can hold.
--    - a scope that is not an object, or has no kind, goes to the old layers (their answer can be NULL; it is kept).
--  * opc_target_business: the three ways to a business are looked up one after the other, each only when its key is non-NULL
--    (a comparison with NULL is never true); the draft route needs an OPC draft of the account (checked on opc_drafts, which the
--    scope check already planned). The old statement had no ORDER BY, so any matching business was an equally valid answer;
--    the new order is businessId, draft, account.
--  * runtime_context_allowed: the saved-source loop only sees tool calls of an execution of this very request, so it is
--    skipped when the request has no execution (a first admission never has one).
-- The unchanged checks keep their place and their errors. bill2_payg_claim and bill2_dispatch walk the chain again before any
-- money moves, in the same mode.
-- Compatibility: same signatures, results and privileges; old and new application code are interchangeable.
-- Repeatable: CREATE OR REPLACE only. Recovery: set the flag to anything but true (or delete the key), or re-apply the three
-- changed functions from packages/db/functions as of 0419; bill2_scope_allowed_branch can stay or be dropped.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.bill2_scope_allowed_branch(a uuid, s jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE kind text;did uuid;dproject uuid;dactor uuid;known boolean:=false;
BEGIN
 -- A scope that is not an object with a kind keeps going through the layered functions it always went through
 -- (their result may be NULL, which callers read as "not allowed"; that is kept exactly).
 IF s IS NULL OR jsonb_typeof(s) IS DISTINCT FROM 'object' OR s->>'kind' IS NULL THEN
  RETURN bill2_scope_allowed_before_memo(a,s);
 END IF;
 kind:=s->>'kind';
 IF kind='library_document' THEN
  RETURN (SELECT array_agg(x ORDER BY x) FROM jsonb_object_keys(s) x)=ARRAY['documentId','kind']
   AND coalesce(s->>'documentId','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND EXISTS(SELECT 1 FROM library_documents d WHERE d.id=(s->>'documentId')::uuid AND d.actor_id=a
    AND d.kind='document' AND d.format IN ('pdf','docx') AND d.status IN ('processing','ready') AND d.deleted_at IS NULL);
 END IF;
 -- The layers below answer false for any other kind than these three.
 IF kind NOT IN ('positioning_draft','work_item','positioning_topic') THEN RETURN false; END IF;
 -- D7 scope tombstones: an erased project named by the scope, or the project of the OPC draft the scope names.
 IF s->>'projectId' IS NOT NULL OR s->>'workItemId' IS NOT NULL THEN
  IF EXISTS(SELECT 1 FROM artifact_projects p WHERE p.actor_id=a AND p.erased_at IS NOT NULL
   AND (p.id::text=s->>'projectId' OR p.id::text=s->>'workItemId')) THEN RETURN false; END IF;
 END IF;
 IF s->>'draftId' IS NOT NULL THEN
  SELECT d.draft_id,d.project_id,d.actor_id INTO did,dproject,dactor FROM opc_drafts d WHERE d.draft_id::text=s->>'draftId';
  IF did IS NOT NULL AND dproject IS NOT NULL
   AND EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=dproject AND p.actor_id=a AND p.erased_at IS NOT NULL) THEN RETURN false; END IF;
 END IF;
 IF kind='positioning_draft' THEN
  IF NOT(NOT(s ? 'projectId' OR s ? 'workItemId') AND EXISTS(SELECT 1 FROM bill2_drafts WHERE id=(s->>'draftId')::uuid AND actor_id=a AND NOT revoked))
  THEN RETURN false; END IF;
  -- A strategy binding on the account's OPC draft needs its base source and evidence to be allowed.
  IF did IS NOT NULL AND dactor=a AND EXISTS(SELECT 1 FROM opc_account_strategy_drafts binding WHERE binding.draft_id=did
   AND (NOT opc_source_allowed(a,binding.base_source_version_id) OR NOT artifact_evidence_allowed(dproject,'[]'))) THEN RETURN false; END IF;
  RETURN true;
 ELSIF kind='work_item' THEN
  IF s ? 'draftId' THEN RETURN false; END IF;
  RETURN EXISTS(
   SELECT 1 FROM artifact_projects w JOIN artifact_projects p ON p.id=w.source_project_id
   WHERE w.id=(s->>'workItemId')::uuid AND p.id=(s->>'projectId')::uuid
   AND w.actor_id=a AND p.actor_id=a AND w.work_kind='script' AND p.work_kind='legacy'
   AND (p.account IS NULL OR EXISTS(SELECT 1 FROM artifact_work_references ref WHERE ref.project_id=w.id AND artifact_reference_available(ref.evidence_id))))
   OR EXISTS(
   SELECT 1 FROM opc_items i JOIN artifact_projects w ON w.id=i.work_item_id JOIN opc_accounts ac ON ac.project_id=i.account_project_id
   WHERE w.id=(s->>'workItemId')::uuid AND ac.project_id=(s->>'projectId')::uuid AND w.source_project_id=ac.project_id
   AND w.actor_id=a AND ac.actor_id=a AND opc_source_allowed(a,i.source_version_id));
 END IF;
 -- positioning_topic
 RETURN (s ? 'draftId') AND NOT(s ? 'projectId') AND NOT(s ? 'workItemId') AND NOT(s ? 'account')
  AND EXISTS(SELECT 1 FROM opc_drafts d WHERE d.draft_id=(s->>'draftId')::uuid AND d.actor_id=a
   AND (NOT EXISTS(SELECT 1 FROM opc_topic_workspaces t WHERE t.draft_id=d.draft_id)
    OR EXISTS(SELECT 1 FROM opc_topic_workspaces t WHERE t.draft_id=d.draft_id AND t.actor_id=a AND opc_source_allowed(a,t.source_version_id))));
END $function$;

CREATE OR REPLACE FUNCTION public.bill2_scope_allowed(a uuid, s jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE k text:=md5('bill2_scope_allowed|'||coalesce(a::text,'')||'|'||coalesce(s::text,''));hit text;result boolean;
BEGIN
 hit:=runtime_check_memo_get(k);
 IF hit IS NOT NULL THEN RETURN CASE hit WHEN 'n' THEN NULL ELSE hit::boolean END; END IF;
 IF runtime_rw_flag('chainBranch') THEN result:=bill2_scope_allowed_branch(a,s); ELSE result:=bill2_scope_allowed_before_memo(a,s); END IF;
 PERFORM runtime_check_memo_put(k,coalesce(result::text,'n'));
 RETURN result;
END $function$;

CREATE OR REPLACE FUNCTION public.opc_target_business(a uuid, t jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE scope jsonb;bid uuid;pid uuid;did uuid;
BEGIN
 IF t->>'runId' IS NOT NULL THEN
  SELECT coalesce(s.scope,r.scope) INTO scope FROM bill2_runs r
   LEFT JOIN fusion_billing_groups g ON g.id=r.fusion_group_id AND g.actor_id=a
   LEFT JOIN runtime_sessions s ON s.id=g.source_session_id AND s.actor_id=a
   WHERE r.id=(t->>'runId')::uuid AND r.actor_id=a;
 ELSIF t->>'groupId' IS NOT NULL THEN
  SELECT s.scope INTO scope FROM fusion_billing_groups g
   JOIN runtime_sessions s ON s.id=g.source_session_id AND s.actor_id=a
   WHERE g.id=(t->>'groupId')::uuid AND g.actor_id=a;
 ELSIF t->>'executionId' IS NOT NULL THEN
  SELECT s.scope INTO scope FROM runtime_executions e JOIN runtime_sessions s ON s.id=e.session_id
   WHERE e.id=(t->>'executionId')::uuid AND e.actor_id=a AND s.actor_id=a;
 ELSIF t->>'sessionId' IS NOT NULL THEN
  SELECT s.scope INTO scope FROM runtime_sessions s WHERE s.id=(t->>'sessionId')::uuid AND s.actor_id=a;
 ELSE scope:=t; END IF;
 did:=coalesce(scope->>'draftId',t->>'draftId')::uuid;
 pid:=coalesce(scope->>'workItemId',scope->>'projectId')::uuid;
 IF runtime_rw_flag('chainBranch') THEN
  -- Each way a business can be reached is looked up only when the scope carries its key (a comparison with NULL is never true),
  -- and the draft route only when the account has an OPC draft at all; the statement above planned all five tables every time.
  IF t->>'businessId' IS NOT NULL THEN
   SELECT b.id INTO bid FROM opc_businesses b WHERE b.actor_id=a AND b.id=(t->>'businessId')::uuid;
   IF bid IS NOT NULL THEN RETURN bid; END IF;
  END IF;
  IF (did IS NOT NULL OR pid IS NOT NULL)
   AND EXISTS(SELECT 1 FROM opc_drafts d WHERE d.actor_id=a AND (d.draft_id=did OR d.project_id=pid)) THEN
   SELECT b.id INTO bid FROM opc_businesses b WHERE b.actor_id=a AND EXISTS(
    SELECT 1 FROM opc_draft_businesses db JOIN opc_drafts d ON d.draft_id=db.draft_id
     WHERE db.business_id=b.id AND d.actor_id=a AND (d.draft_id=did OR d.project_id=pid));
   IF bid IS NOT NULL THEN RETURN bid; END IF;
  END IF;
  IF pid IS NOT NULL THEN
   SELECT b.id INTO bid FROM opc_businesses b WHERE b.actor_id=a AND EXISTS(
    SELECT 1 FROM opc_accounts ac WHERE ac.business_id=b.id AND ac.actor_id=a
     AND (ac.project_id=pid OR EXISTS(SELECT 1 FROM opc_items i WHERE i.account_project_id=ac.project_id AND i.work_item_id=pid)));
  END IF;
  RETURN bid;
 END IF;
 SELECT b.id INTO bid FROM opc_businesses b WHERE b.actor_id=a AND (
  b.id=(t->>'businessId')::uuid OR EXISTS(
   SELECT 1 FROM opc_draft_businesses db JOIN opc_drafts d ON d.draft_id=db.draft_id
    WHERE db.business_id=b.id AND d.actor_id=a AND (d.draft_id=did OR d.project_id=pid)) OR EXISTS(
   SELECT 1 FROM opc_accounts ac WHERE ac.business_id=b.id AND ac.actor_id=a
    AND (ac.project_id=pid OR EXISTS(SELECT 1 FROM opc_items i
     WHERE i.account_project_id=ac.project_id AND i.work_item_id=pid))));
 RETURN bid;
END $function$;

CREATE OR REPLACE FUNCTION public.runtime_context_allowed(p_actor_id uuid, p_context jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE dep text;
BEGIN
 PERFORM runtime_context_allowed_before_workspace(p_actor_id,p_context);
 IF p_context ? 'reportGeneration' THEN
  IF NOT artifact_evidence_allowed((p_context#>>'{reportGeneration,projectId}')::uuid,
    coalesce(p_context#>'{reportGeneration,evidenceIds}','[]'::jsonb)) THEN
   RAISE EXCEPTION 'RUNTIME_SOURCE_DENIED';END IF;
  PERFORM report_source_for_read(p_actor_id,(p_context#>>'{request,sessionId}')::uuid,
   (p_context#>>'{reportGeneration,projectId}')::uuid,(p_context#>>'{reportGeneration,roundId}')::uuid);
 END IF;

 IF p_context->>'workspaceContext'='true' THEN
  IF NOT runtime_workspace_session(p_actor_id,(p_context->'request'->>'sessionId')::uuid) THEN RAISE EXCEPTION 'RUNTIME_WORKSPACE_DENIED';END IF;
  -- Retrieved snapshots remain immutable, but source revocation invalidates both
  -- replay and descendant history through the existing context dependency check.
  -- The loop below only ever sees tool calls of an execution of this very request; a request that has no execution yet
  -- (every first admission) has none, and then runtime_tool_calls need not be planned at all.
  IF NOT runtime_rw_flag('chainBranch') OR EXISTS(SELECT 1 FROM runtime_executions e WHERE e.actor_id=p_actor_id
   AND e.request_id=(p_context->'request'->>'requestId')::uuid AND e.session_id=(p_context->'request'->>'sessionId')::uuid) THEN
   FOR dep IN SELECT jsonb_array_elements_text(t.result->'dependencies')
    FROM runtime_executions e JOIN runtime_tool_calls t ON t.execution_id=e.id
    WHERE e.actor_id=p_actor_id AND e.request_id=(p_context->'request'->>'requestId')::uuid AND e.session_id=(p_context->'request'->>'sessionId')::uuid
     AND t.name='read_source' AND t.result IS NOT NULL
   LOOP
    IF NOT opc_source_allowed(p_actor_id,dep::uuid) THEN RAISE EXCEPTION 'RUNTIME_WORKSPACE_SOURCE_REVOKED';END IF;
   END LOOP;
  END IF;
 END IF;
END $function$;

REVOKE ALL ON FUNCTION public.bill2_scope_allowed_branch(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;

COMMIT;
