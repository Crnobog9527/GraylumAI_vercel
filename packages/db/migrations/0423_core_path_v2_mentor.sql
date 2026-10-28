-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-5 (kind=mentor, the positioning mentor; docs/launch/tasks/CORE-PATH-V2.md 2.3, 2.7, 4.2, 6.1).
-- Number 0423 assigned by the controller; after 0422 (start threshold), whose turn_open it extends.
--   turn_mentor_context  read inside turn_open: the draft of this session, its current round, the step's workflow and the
--                        work projection (checklist values, field provenance, business context; runtime_work_projection's
--                        fields without its runtime_executions join) the mentor's prompt
--                        is built from, plus the checked Skill package identity. Replaces opc_query, the workbench read,
--                        artifact_query resolve, runtime_session_context and opc_step_material of the old path (one round
--                        trip instead of about ten). Refuses a session without a positioning draft, a module other than the
--                        one the turn was quoted for, a step that is not open, unconfirmed dependencies, an archived
--                        business and an unavailable Skill revision.
--   turn_mentor_apply    called by turn_close for a completed mentor turn: the organizer's patches and withdrawals applied to
--                        the round's checklist in the same transaction that settles the turn and saves its messages (the
--                        old path ran opc_capture_apply later from runtime_executions). The rules are opc_capture_apply's,
--                        copied unchanged; the turn's request id stands where the execution id stood (field provenance,
--                        suggestion order, the idempotent artifact_requests row), so opc_information and the protection
--                        checks that read artifact_requests keep working on both paths.
--   opc_information,     unchanged except one lock: the draft's session row before its project, so a manual checklist save,
--   opc_capture_resolve, a suggestion decision or an old-path capture serializes with a mentor close (which holds that session
--   opc_capture_apply    row) instead of overwriting its capture or being overwritten (review of #1520).
--   turn_open            0422 (start threshold) with the mentor branch of its per-kind hook: kindContext = turn_mentor_context(p_policy->'mentor').
--   turn_close           0421 with the mentor branch of its per-kind hook (turn_mentor_apply on p_kind_result), and the
--                        capture response returned under kindResult.
-- Locks: neither mentor function takes an explicit row lock (main-path rule 5); opc_information, opc_capture_resolve and
-- opc_capture_apply now lock the draft's session row before its project, so they serialize with a mentor close, which holds
-- that session row. turn_mentor_apply writes the round's checklist with an optimistic check (the UPDATE applies only if the checklist is unchanged since it was read; otherwise it computes again), so a
-- close never waits on opc_information's project lock while holding the session and account locks; only the UPDATE's own row
-- lock on artifact_rounds remains, for the length of a concurrent single-statement edit.
-- Compatibility: no signature changes; turn_open and turn_close only gain the mentor branches and a returned key. Nothing calls
-- the mentor kind until core_path_v2 is enabled and the page uses /api/turn (V2-10). Repeatable: CREATE OR REPLACE throughout.
-- Recovery: re-apply 0422 (start threshold)'s turn_open and 0421's turn_close and drop the two mentor functions; no stored data depends on them.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.turn_mentor_context(p_actor_id uuid, p_session_id uuid, p_mentor jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE d opc_drafts; p artifact_projects; r artifact_rounds; m modules; spec jsonb; v_step text := p_mentor->>'stepId';
  business uuid; st jsonb; step_id text; field_id text; metas jsonb; steps jsonb; context jsonb; suggestions jsonb := '{}';
  suggestion jsonb;
BEGIN
  SELECT * INTO d FROM opc_drafts WHERE actor_id = p_actor_id AND session_id = p_session_id;
  IF d.draft_id IS NULL THEN RAISE EXCEPTION 'TURN_MENTOR_DENIED' USING ERRCODE='42501'; END IF;
  -- The draft's scope as the old path checked it (runtime_material / runtime_work_projection): an account-strategy draft whose
  -- base source was withdrawn or deleted, or whose evidence is no longer allowed, is refused.
  IF NOT coalesce(bill2_scope_allowed(p_actor_id, jsonb_build_object('kind','positioning_draft','draftId',d.draft_id)), false) THEN
    RAISE EXCEPTION 'TURN_MENTOR_DENIED' USING ERRCODE='42501';
  END IF;
  -- An archived business is read-only (as opc_assert_business_writable, without its row lock).
  business := opc_target_business(p_actor_id, jsonb_build_object('draftId', d.draft_id));
  IF business IS NOT NULL AND EXISTS (SELECT 1 FROM opc_businesses WHERE id = business AND actor_id = p_actor_id AND archived_at IS NOT NULL) THEN
    RAISE EXCEPTION 'TURN_MENTOR_ARCHIVED' USING ERRCODE='42501';
  END IF;
  SELECT * INTO p FROM artifact_projects WHERE id = d.project_id AND actor_id = p_actor_id;
  SELECT * INTO r FROM artifact_rounds WHERE id = d.round_id AND project_id = p.id;
  IF p.id IS NULL OR r.id IS NULL OR p.erased_at IS NOT NULL OR p.content_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'TURN_MENTOR_DENIED' USING ERRCODE='42501';
  END IF;
  -- The turn was quoted for this module's model: any other module is refused.
  IF p.module_id::text IS DISTINCT FROM p_mentor->>'moduleId' THEN RAISE EXCEPTION 'TURN_MENTOR_DENIED' USING ERRCODE='42501'; END IF;
  SELECT x INTO spec FROM jsonb_array_elements(r.workflow->'steps') x WHERE x->>'id' = v_step;
  IF r.state <> 'draft' OR spec IS NULL OR NOT (r.steps ? v_step) THEN RAISE EXCEPTION 'TURN_MENTOR_STEP_DENIED' USING ERRCODE='42501'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(spec->'dependsOn', '[]')) dep
             WHERE (r.steps->dep->>'valid')::boolean IS DISTINCT FROM true) THEN
    RAISE EXCEPTION 'TURN_MENTOR_DEPENDENCIES_UNCONFIRMED' USING ERRCODE='42501';
  END IF;
  -- The Skill revision of the round, under the same rules as read_skill_package: an active module of that Skill, a published
  -- directory Skill, the round's exact package, not revoked. The package itself is then read by content hash (process cache).
  SELECT * INTO m FROM modules WHERE id = p.module_id AND skill_id = p.skill_id AND active IS TRUE;
  IF m.id IS NULL
    OR NOT EXISTS (SELECT 1 FROM skills WHERE id = p.skill_id AND status = 'published' AND content_kind = 'directory')
    OR NOT EXISTS (SELECT 1 FROM skill_packages WHERE skill_id = p.skill_id AND revision_id = r.revision_id AND package_hash = r.package_hash)
    OR EXISTS (SELECT 1 FROM skill_revision_revocations WHERE revision_id = r.revision_id) THEN
    RAISE EXCEPTION 'TURN_SKILL_UNAVAILABLE' USING ERRCODE='42501';
  END IF;
  -- The work projection the mentor sees: runtime_work_projection's per-field provenance and protection, computed here without
  -- its runtime_executions/opc_turns join (V2-12 drops those): a pending suggestion is one the field still carries.
  steps := r.steps;
  FOR step_id, st IN SELECT key, value FROM jsonb_each(r.steps) LOOP
    metas := '{}';
    FOR field_id IN SELECT f->>'id' FROM jsonb_array_elements(r.workflow->'steps') s, jsonb_array_elements(s->'information') f
                    WHERE s->>'id' = step_id LOOP
      -- The organizer sees a pending suggestion's content (to keep or withdraw it, captureFrozenInformation); the mentor sees
      -- only that one exists. Kept apart from the work projection, which goes to the mentor.
      suggestion := st#>ARRAY['fieldMeta',field_id,'suggestion'];
      IF jsonb_typeof(suggestion) = 'object' AND jsonb_typeof(suggestion->'value') = 'string' AND btrim(suggestion->>'value') <> '' THEN
        suggestions := jsonb_set(suggestions, ARRAY[step_id], coalesce(suggestions->step_id, '{}') || jsonb_build_object(field_id,
          jsonb_build_object('value', suggestion->'value', 'nature', suggestion->'nature', 'basis', suggestion->'basis')));
      END IF;
      metas := metas || jsonb_build_object(field_id, jsonb_build_object(
        'source', coalesce(st#>>ARRAY['fieldMeta',field_id,'source'], 'unknown'),
        'basis', coalesce(st#>>ARRAY['fieldMeta',field_id,'basis'], 'unknown'),
        'executionId', st#>ARRAY['fieldMeta',field_id,'executionId'],
        'origin', st#>ARRAY['fieldMeta',field_id,'origin'], 'createdAt', st#>ARRAY['fieldMeta',field_id,'createdAt'],
        'hasPendingSuggestion', jsonb_typeof(st#>ARRAY['fieldMeta',field_id,'suggestion']) = 'object',
        'protected', NOT coalesce(NOT coalesce((st->>'valid')::boolean,false)
 AND coalesce(st->'information'->(field_id)->>'status','unknown') NOT IN ('confirmed','deferred') AND (
  (st->'fieldMeta'->(field_id)->>'source'='capture' AND st->'fieldMeta'->(field_id)->>'fp'=artifact_hash(st->'information'->(field_id))
   AND EXISTS(SELECT 1 FROM artifact_requests cap WHERE cap.project_id=d.project_id AND cap.round_id=r.id
    AND cap.request_id=overlay(md5('opc_capture:'||(st->'fieldMeta'->(field_id)->>'executionId')) placing 'f' from 13 for 1)::uuid
    AND cap.action='opc_capture' AND cap.payload->>'executionId'=st->'fieldMeta'->(field_id)->>'executionId'
    AND cap.response->'versions' ? (step_id)
    AND NOT EXISTS(SELECT 1 FROM artifact_requests manual WHERE manual.project_id=d.project_id AND manual.round_id=r.id
     AND manual.action='opc_information' AND manual.payload->>'stepId'=(step_id)
     AND (manual.payload->>'expectedVersion')::integer >= (cap.response->'versions'->>(step_id))::integer
     AND artifact_hash(manual.payload->'values'->(field_id)) IS DISTINCT FROM st->'fieldMeta'->(field_id)->>'fp')))
  OR (st->'fieldMeta'->(field_id)->>'source' IS NULL AND coalesce(st->'information'->(field_id)->>'value','')='' AND coalesce(st->'information'->(field_id)->>'status','unknown')='unknown'
   AND NOT EXISTS(SELECT 1 FROM artifact_requests history WHERE history.project_id=d.project_id AND history.round_id=r.id
    AND ((history.action='opc_information' AND history.payload->>'stepId'=(step_id)
      AND coalesce(history.payload->'values'->(field_id)->>'value','')<>'')
     OR (history.action='opc_capture' AND history.response->'fields'->(step_id) ? (field_id)))))
 ),false)));
    END LOOP;
    steps := jsonb_set(steps, ARRAY[step_id], st || jsonb_build_object('fieldMeta', metas));
  END LOOP;
  context := opc_business_context(p_actor_id, p_session_id, r.id);
  RETURN jsonb_build_object('draftId', d.draft_id, 'projectId', p.id, 'roundId', r.id, 'mode', d.mode, 'moduleId', p.module_id,
    'skillId', p.skill_id, 'revisionId', r.revision_id, 'packageHash', r.package_hash, 'steps', r.workflow->'steps',
    'suggestions', suggestions,
    'work', jsonb_build_object('projectId', p.id, 'roundId', r.id, 'revisionId', r.revision_id, 'packageHash', r.package_hash,
      'steps', steps, 'source', NULL) || CASE WHEN context IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('businessContext', context) END);
END $function$;

-- opc_capture_apply's single-execution branch, with the turn in place of the runtime execution (see the header).
-- p_result: {roundId, versions: {stepId: version} as the turn read them, organizerInput: the object the organizer was given,
-- output: the organizer's JSON object or null}.
CREATE OR REPLACE FUNCTION public.turn_mentor_apply(p_actor_id uuid, p_turn_id bigint, p_result jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t turns; d opc_drafts; r artifact_rounds; p artifact_projects; req artifact_requests;
 response jsonb; payload jsonb; capture_request_id uuid;
 output jsonb; code text; patch jsonb; step_id text; field_id text; st jsonb; meta jsonb; value jsonb; candidate jsonb;
 changed jsonb:='{}'; fields jsonb:='{}'; discarded jsonb:='[]'; versions jsonb:='{}'; old_steps jsonb;
 protected boolean; material_changed boolean; seq jsonb; suggestion jsonb; patch_index integer:=0;
 withdrawal jsonb; withdrawn jsonb:='{}'; withdraw_index integer:=0; withdraw_reason text; organizer_input jsonb;
 exec_id uuid; exec_at timestamptz; business uuid; written boolean := false;
BEGIN
 SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id;
 IF t.id IS NULL OR t.kind <> 'mentor' THEN RAISE EXCEPTION 'TURN_MENTOR_DENIED' USING ERRCODE='42501'; END IF;
 exec_id := t.request_id; exec_at := t.opened_at;
 SELECT * INTO d FROM opc_drafts WHERE actor_id = p_actor_id AND session_id = t.session_id;
 IF d.draft_id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id, jsonb_build_object('kind','positioning_draft','draftId',d.draft_id)), false)
 THEN RETURN jsonb_build_object('result', 'denied_binding'); END IF;
 business := opc_target_business(p_actor_id, jsonb_build_object('draftId', d.draft_id));
 -- No lock of its own (main-path rule: only the actor's profile and the session row). turn_close holds this draft's session
 -- row, which opc_information and opc_capture_resolve now take first too (below), so those writers and this one are serialized.
 -- Any other writer of the round (a revision, an erasure) is caught by the optimistic write: the checklist is written only if
 -- it is still exactly what this pass read; otherwise the pass is computed again on the new state (at most three passes).
 FOR attempt IN 1..3 LOOP
 -- An archived business is read-only (opc_capture_apply's opc_assert_business_writable): nothing is written, and the turn
 -- itself still settles and keeps its reply. Checked again on every pass.
 IF business IS NOT NULL AND EXISTS (SELECT 1 FROM opc_businesses WHERE id = business AND actor_id = p_actor_id AND archived_at IS NOT NULL) THEN
  RETURN jsonb_build_object('result', 'archived');
 END IF;
 changed:='{}'; fields:='{}'; discarded:='[]'; versions:='{}'; withdrawn:='{}'; patch_index:=0; withdraw_index:=0;
 SELECT * INTO d FROM opc_drafts WHERE draft_id = d.draft_id AND actor_id = p_actor_id;
 SELECT * INTO p FROM artifact_projects WHERE id = d.project_id;
 SELECT * INTO r FROM artifact_rounds WHERE id = d.round_id;
 old_steps := r.steps;
 capture_request_id := overlay(md5('opc_capture:'||exec_id::text) placing 'f' from 13 for 1)::uuid;
 payload := jsonb_build_object('executionId', exec_id, 'ruleVersion', 1);
 SELECT * INTO req FROM artifact_requests WHERE project_id = d.project_id AND artifact_requests.request_id = capture_request_id;
 IF FOUND THEN
  IF req.action IS DISTINCT FROM 'opc_capture' OR req.payload IS DISTINCT FROM payload THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT'; END IF;
  RETURN req.response;
 END IF;
 code := NULL;
 organizer_input := p_result->'organizerInput';
 IF jsonb_typeof(organizer_input) IS DISTINCT FROM 'object' OR organizer_input->>'captureFormat' IS DISTINCT FROM 'v2' THEN code := 'skipped_format'; END IF;
 IF code IS NULL AND (p.module_id::text IS DISTINCT FROM t.policy->'mentor'->>'moduleId' OR r.revision_id::text IS DISTINCT FROM p_result->>'revisionId')
  THEN code := 'denied_binding'; END IF;
 IF code IS NULL AND (r.id::text IS DISTINCT FROM p_result->>'roundId' OR r.state <> 'draft') THEN code := 'stale_round'; END IF;
 IF code IS NULL THEN
  output := p_result->'output';
  IF jsonb_typeof(output) IS DISTINCT FROM 'object'
   OR coalesce(output->>'inputKind','') NOT IN ('answer','acknowledgement','uncertainty','request','revision_request')
   OR jsonb_typeof(output->'patches') IS DISTINCT FROM 'array'
   OR jsonb_typeof(output->'notes') IS DISTINCT FROM 'array'
   THEN code:='invalid_output';
  ELSIF jsonb_array_length(output->'patches')>12 THEN code:='invalid_output';
  ELSIF output ? 'withdrawals' AND jsonb_typeof(output->'withdrawals') IS DISTINCT FROM 'array' THEN code:='invalid_output';
  ELSIF jsonb_array_length(coalesce(output->'withdrawals','[]'))>12 THEN code:='invalid_output';END IF;
 END IF;
 IF code IS NULL THEN
  material_changed:=EXISTS(SELECT 1 FROM jsonb_each(r.steps) s
   WHERE s.value->'version' IS DISTINCT FROM p_result->'versions'->s.key);
  FOR patch IN SELECT * FROM jsonb_array_elements(output->'patches') LOOP
   patch_index:=patch_index+1;
   step_id:=patch->>'stepId';field_id:=patch->>'fieldId';st:=r.steps->step_id;
   IF jsonb_typeof(patch) IS DISTINCT FROM 'object' OR jsonb_typeof(patch->'value') IS DISTINCT FROM 'string'
    OR char_length(btrim(coalesce(patch->>'value','')))=0 OR char_length(patch->>'value')>400
    OR coalesce(patch->>'status','') NOT IN ('provisional','unclear')
    OR coalesce(patch->>'nature','') NOT IN ('fact','decision','hypothesis','unknown')
    OR coalesce(patch->>'basis','') NOT IN ('user_statement','agent_proposal')
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.workflow->'steps') s,jsonb_array_elements(s->'information') f
      WHERE s->>'id'=step_id AND f->>'id'=field_id)
   THEN discarded:=discarded||jsonb_build_array(jsonb_build_object('index',patch_index,'reason','invalid_patch'));CONTINUE;END IF;
   -- Host notifications contain no user statement. Preserve only concrete mentor proposals
   -- for fields explicitly declared as agent-owned by this pinned workflow.
   IF (organizer_input#>>'{hostEvent,kind}')='checklist_updated'
    AND (patch->>'basis'<>'agent_proposal' OR position('HOST_CHECKLIST_UPDATED:' in (patch->>'value'))>0
     OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.workflow->'steps') s,
      jsonb_array_elements(s->'information') f WHERE s->>'id'=step_id AND f->>'id'=field_id
       AND f->>'elicitation'='agent_proposal'))
   THEN discarded:=discarded||jsonb_build_array(jsonb_build_object('index',patch_index,'reason','host_checklist_updated'));
    CONTINUE;END IF;
   value:=patch-ARRAY['stepId','fieldId','basis'];
   value:=jsonb_build_object('value',value->'value','status',value->'status','nature',value->'nature');
   meta:=coalesce(st->'fieldMeta'->field_id,'{}');
   protected:=NOT coalesce(NOT coalesce((st->>'valid')::boolean,false)
 AND coalesce(st->'information'->(field_id)->>'status','unknown') NOT IN ('confirmed','deferred') AND (
  (st->'fieldMeta'->(field_id)->>'source'='capture' AND st->'fieldMeta'->(field_id)->>'fp'=artifact_hash(st->'information'->(field_id))
   AND EXISTS(SELECT 1 FROM artifact_requests cap WHERE cap.project_id=d.project_id AND cap.round_id=r.id
    AND cap.request_id=overlay(md5('opc_capture:'||(st->'fieldMeta'->(field_id)->>'executionId')) placing 'f' from 13 for 1)::uuid
    AND cap.action='opc_capture' AND cap.payload->>'executionId'=st->'fieldMeta'->(field_id)->>'executionId'
    AND cap.response->'versions' ? (step_id)
    AND NOT EXISTS(SELECT 1 FROM artifact_requests manual WHERE manual.project_id=d.project_id AND manual.round_id=r.id
     AND manual.action='opc_information' AND manual.payload->>'stepId'=(step_id)
     AND (manual.payload->>'expectedVersion')::integer >= (cap.response->'versions'->>(step_id))::integer
     AND artifact_hash(manual.payload->'values'->(field_id)) IS DISTINCT FROM st->'fieldMeta'->(field_id)->>'fp')))
  OR (st->'fieldMeta'->(field_id)->>'source' IS NULL AND coalesce(st->'information'->(field_id)->>'value','')='' AND coalesce(st->'information'->(field_id)->>'status','unknown')='unknown'
   AND NOT EXISTS(SELECT 1 FROM artifact_requests history WHERE history.project_id=d.project_id AND history.round_id=r.id
    AND ((history.action='opc_information' AND history.payload->>'stepId'=(step_id)
      AND coalesce(history.payload->'values'->(field_id)->>'value','')<>'')
     OR (history.action='opc_capture' AND history.response->'fields'->(step_id) ? (field_id)))))
 ),false);
   candidate:=coalesce(st->'information','{}')||jsonb_build_object(field_id,value);
   IF NOT material_changed AND NOT protected AND octet_length(candidate::text)<=12000 THEN
    IF st->'information'->field_id IS DISTINCT FROM value THEN
     st:=st||jsonb_build_object('information',candidate,'informationUpdatedAt',clock_timestamp());
     changed:=changed||jsonb_build_object(step_id,true);
     fields:=jsonb_set(fields,ARRAY[step_id],coalesce(fields->step_id,'[]')||to_jsonb(field_id));
     meta:=jsonb_build_object('source','capture','basis',patch->'basis','executionId',exec_id,'fp',artifact_hash(value),
   'createdAt',clock_timestamp());
    END IF;
   ELSE
    seq:=jsonb_build_array(exec_at,exec_id);
    suggestion:=jsonb_build_object('executionId',exec_id,'seq',seq,'value',value->'value',
     'status',value->'status','nature',value->'nature','basis',patch->'basis');
    suggestion:=suggestion||jsonb_build_object('createdAt',clock_timestamp());
    suggestion:=suggestion||jsonb_build_object('hash',artifact_hash(suggestion));
    -- v3: a turn older than the user's withdrawal can neither revive advice nor erase the withdrawn record.
    IF (meta->'suggestion' IS NULL OR ((meta#>>'{suggestion,seq,0}')::timestamptz,(meta#>>'{suggestion,seq,1}')::uuid) < (exec_at,exec_id))
     AND (meta->'withdrawnSuggestion' IS NULL OR ((meta#>>'{withdrawnSuggestion,withdrawnSeq,0}')::timestamptz,
      (meta#>>'{withdrawnSuggestion,withdrawnSeq,1}')::uuid) < (exec_at,exec_id))
    THEN meta:=(meta-'withdrawnSuggestion')||jsonb_build_object('suggestion',suggestion);END IF;
   END IF;
   st:=st||jsonb_build_object('fieldMeta',coalesce(st->'fieldMeta','{}')||jsonb_build_object(field_id,meta));
   r.steps:=jsonb_set(r.steps,ARRAY[step_id],st);
  END LOOP;
  -- v3 suggestion withdraw: a real user turn may clear a pending suggestion older than this turn.
  FOR withdrawal IN SELECT * FROM jsonb_array_elements(coalesce(output->'withdrawals','[]')) LOOP
   withdraw_index:=withdraw_index+1;
   step_id:=withdrawal->>'stepId';field_id:=withdrawal->>'fieldId';meta:=r.steps#>ARRAY[step_id,'fieldMeta',field_id];
   IF jsonb_typeof(withdrawal) IS DISTINCT FROM 'object' OR step_id IS NULL OR field_id IS NULL
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.workflow->'steps') s,jsonb_array_elements(s->'information') f
     WHERE s->>'id'=step_id AND f->>'id'=field_id) THEN withdraw_reason:='invalid_withdrawal';
   ELSIF organizer_input ? 'hostEvent' OR coalesce(btrim(organizer_input->>'userInput'),'') IN ('','HOST_OPEN_CURRENT_QUESTION')
    THEN withdraw_reason:='no_user_turn';
   ELSIF jsonb_typeof(meta->'suggestion') IS DISTINCT FROM 'object' THEN withdraw_reason:='no_suggestion';
   -- Bind to the complete suggestion the organizer was shown (value, nature, basis): a replacement stays.
   ELSIF jsonb_strip_nulls(jsonb_build_object('value',meta#>'{suggestion,value}','nature',meta#>'{suggestion,nature}',
    'basis',meta#>'{suggestion,basis}')) IS DISTINCT FROM (SELECT jsonb_strip_nulls(fld->'pendingSuggestion')
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(organizer_input->'checklist')='array' THEN organizer_input->'checklist' ELSE '[]' END) stp,
     jsonb_array_elements(CASE WHEN jsonb_typeof(stp->'fields')='array' THEN stp->'fields' ELSE '[]' END) fld
    WHERE stp->>'id'=step_id AND fld->>'id'=field_id LIMIT 1) THEN withdraw_reason:='not_shown';
   ELSIF ((meta#>>'{suggestion,seq,0}')::timestamptz,(meta#>>'{suggestion,seq,1}')::uuid) >= (exec_at,exec_id)
    THEN withdraw_reason:='superseded';
   ELSE withdraw_reason:=NULL;END IF;
   IF withdraw_reason IS NOT NULL THEN
    discarded:=discarded||jsonb_build_array(jsonb_build_object('withdrawal',withdraw_index,'reason',withdraw_reason));CONTINUE;END IF;
   meta:=(meta-'suggestion')||jsonb_build_object('withdrawnSuggestion',(meta->'suggestion')||jsonb_build_object('withdrawnBy',exec_id,
    'withdrawnSeq',jsonb_build_array(exec_at,exec_id)));
   r.steps:=jsonb_set(r.steps,ARRAY[step_id,'fieldMeta',field_id],meta);
   withdrawn:=jsonb_set(withdrawn,ARRAY[step_id],coalesce(withdrawn->step_id,'[]')||to_jsonb(field_id));
  END LOOP;
  FOR step_id IN SELECT jsonb_object_keys(changed) LOOP
   r.steps:=jsonb_set(r.steps,ARRAY[step_id,'version'],to_jsonb((old_steps->step_id->>'version')::integer+1));
   r.steps:=artifact_invalidate(r.workflow,r.steps,step_id);
   versions:=versions||jsonb_build_object(step_id,r.steps->step_id->'version');
  END LOOP;
  UPDATE artifact_rounds SET steps=r.steps WHERE id=r.id AND steps IS NOT DISTINCT FROM old_steps;
  -- Someone else changed the checklist since this pass read it: compute again on the new state.
  IF NOT FOUND THEN CONTINUE; END IF;
  code:=CASE WHEN changed='{}' THEN 'suggested' ELSE 'applied' END;
 END IF;
 written := true;
 EXIT;
 END LOOP;
 -- Three passes each overtaken by a concurrent edit: nothing is written; the turn still settles (a rare, recorded miss).
 IF NOT written THEN RETURN jsonb_build_object('executionId', exec_id, 'result', 'conflict'); END IF;
 response:=jsonb_build_object('executionId',exec_id,'result',code,'ruleVersion',1,'versions',versions,'fields',fields,'discarded',discarded);
 response:=response||CASE WHEN withdrawn='{}' THEN '{}'::jsonb ELSE jsonb_build_object('withdrawn',withdrawn) END;
 INSERT INTO artifact_requests VALUES(d.project_id,capture_request_id,r.id,'opc_capture',payload,response);
 RETURN response;
END $function$;

-- turn_open: 0422 (the start threshold) unchanged except the mentor branch of kindContext.
CREATE OR REPLACE FUNCTION public.turn_open(p_actor_id uuid, p_session_id uuid, p_request_id uuid, p_kind text, p_policy jsonb, p_resume_of bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  s runtime_sessions; t turns; prof profiles; existing turns;
  v_day date := (now() AT TIME ZONE 'UTC')::date; v_bucket smallint; total numeric; band numeric;
  u_turn numeric; g integer; h integer; available integer; hold uuid; frozen jsonb; history jsonb;
BEGIN
  IF p_kind NOT IN ('chat','mentor','report','compare','jury','jury_adopt','review') THEN
    RAISE EXCEPTION 'TURN_KIND_INVALID' USING ERRCODE='22023';
  END IF;
  IF p_resume_of IS NOT NULL THEN RAISE EXCEPTION 'TURN_RESUME_NOT_SUPPORTED' USING ERRCODE='0A000'; END IF;
  IF jsonb_typeof(p_policy) <> 'object'
    OR jsonb_typeof(p_policy->'q') <> 'number' OR (p_policy->>'q')::numeric <= 0
    OR jsonb_typeof(p_policy->'uTurnUsd') <> 'number' OR (p_policy->>'uTurnUsd')::numeric < 0
    OR jsonb_typeof(p_policy->'gCredits') <> 'number' OR (p_policy->>'gCredits')::numeric <> floor((p_policy->>'gCredits')::numeric)
    OR (p_policy->>'gCredits')::numeric < 0
    OR jsonb_typeof(p_policy->'minCredits') <> 'number' OR (p_policy->>'minCredits')::numeric < 0
    OR jsonb_typeof(p_policy->'historyItems') <> 'number' OR (p_policy->>'historyItems')::numeric NOT BETWEEN 0 AND 200
    OR jsonb_typeof(p_policy->'limits') <> 'object'
    OR coalesce((p_policy->'limits'->>'model')::numeric, 0) < 1
    OR coalesce((p_policy->'limits'->>'paidTools')::numeric, -1) < 0
    OR coalesce((p_policy->'limits'->>'freeTools')::numeric, -1) < 0
    OR coalesce((p_policy->'limits'->>'decisions')::numeric, 0) < 0
    OR jsonb_typeof(p_policy->'stopLoss') <> 'object'
    OR coalesce((p_policy->'stopLoss'->>'limitUsd')::numeric, 0) <= 0
    OR coalesce((p_policy->'stopLoss'->>'p')::numeric, 0) < 1
    OR coalesce((p_policy->'stopLoss'->>'poolSize')::numeric, 0) < 1
    OR coalesce((p_policy->'stopLoss'->>'uFastUsd')::numeric, -1) < 0
    OR coalesce((p_policy->'stopLoss'->>'uBigUsd')::numeric, -1) < 0
    OR p_policy ?| ARRAY['day','bucket','holdId','heldCredits'] THEN
    RAISE EXCEPTION 'TURN_POLICY_INVALID' USING ERRCODE='22023';
  END IF;

  -- 1. The account row first, then the session: one turn at a time per conversation (3a). The account comes first as in the
  -- erasure functions (they hold it before the session), so an open and a deletion of the same conversation never deadlock.
  SELECT * INTO prof FROM profiles WHERE id = p_actor_id FOR UPDATE;
  SELECT * INTO s FROM runtime_sessions WHERE id = p_session_id AND actor_id = p_actor_id FOR UPDATE;
  IF s.id IS NULL THEN RAISE EXCEPTION 'TURN_SESSION_DENIED' USING ERRCODE='42501'; END IF;
  -- 2. The same request again: the turn it opened, unchanged.
  SELECT * INTO existing FROM turns WHERE actor_id = p_actor_id AND request_id = p_request_id;
  IF existing.id IS NOT NULL THEN
    IF existing.session_id IS DISTINCT FROM p_session_id OR existing.kind <> p_kind THEN
      RAISE EXCEPTION 'TURN_REQUEST_CONFLICT' USING ERRCODE='22023';
    END IF;
    -- A replay reads the history too: a deleted conversation or an erasing account is refused here as for a new request,
    -- so the same old request can never read back deleted content (as runtime_session_context).
    IF s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL THEN RAISE EXCEPTION 'TURN_SESSION_ERASED' USING ERRCODE='42501'; END IF;
    IF prof.id IS NULL OR prof.status IS DISTINCT FROM 'active' OR prof.is_deleted::text IS DISTINCT FROM 'false'
      OR EXISTS (SELECT 1 FROM account_erasure_requests WHERE profile_id = p_actor_id) THEN
      RAISE EXCEPTION 'TURN_ACCOUNT_ERASING' USING ERRCODE='42501';
    END IF;
    t := existing;
  ELSE
    IF s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL THEN RAISE EXCEPTION 'TURN_SESSION_ERASED' USING ERRCODE='42501'; END IF;
    IF EXISTS (SELECT 1 FROM account_erasure_requests WHERE profile_id = p_actor_id) THEN
      RAISE EXCEPTION 'TURN_ACCOUNT_ERASING' USING ERRCODE='42501';
    END IF;
    IF s.active_turn_id IS NOT NULL THEN RAISE EXCEPTION 'TURN_SESSION_BUSY' USING ERRCODE='55P03'; END IF;
    -- The same account check as bill2_actor: active and not deleted.
    IF prof.id IS NULL OR prof.status IS DISTINCT FROM 'active' OR prof.is_deleted::text IS DISTINCT FROM 'false' THEN
      RAISE EXCEPTION 'TURN_ACCOUNT_DENIED' USING ERRCODE='42501';
    END IF;

    -- 3. Stop-loss (2.5.1): reserve U_turn on the own bucket row first, then read the day's sum, then check with the band B.
    IF (p_policy->'stopLoss'->>'p')::int < (p_policy->'stopLoss'->>'poolSize')::int THEN
      RAISE EXCEPTION 'TURN_STOP_LOSS_CONFIG' USING ERRCODE='22023';
    END IF;
    u_turn := (p_policy->>'uTurnUsd')::numeric;
    v_bucket := CASE WHEN p_kind IN ('report','compare','jury','jury_adopt') THEN -1 ELSE abs(hashtext(p_actor_id::text)) % 16 END;
    INSERT INTO daily_spend AS d (day, bucket, reserved_usd) VALUES (v_day, v_bucket, u_turn)
      ON CONFLICT (day, bucket) DO UPDATE SET reserved_usd = d.reserved_usd + excluded.reserved_usd;
    SELECT sum(reserved_usd + spent_usd) INTO total FROM daily_spend WHERE daily_spend.day = v_day;
    band := ((p_policy->'stopLoss'->>'p')::numeric - 1) * (p_policy->'stopLoss'->>'uFastUsd')::numeric
      + (p_policy->'stopLoss'->>'uBigUsd')::numeric;
    IF total + band > (p_policy->'stopLoss'->>'limitUsd')::numeric THEN
      RAISE EXCEPTION 'STOP_LOSS_REACHED' USING ERRCODE='P0001';
    END IF;

    -- 4. Credits: H = min(G_turn, available); below the start threshold the turn does not open. The balance is read under the
    -- account lock taken first: two sessions of one account in different stop-loss buckets never size H on the same balance.
    -- The account is checked again here (same lock) before anything is frozen.
    SELECT * INTO prof FROM profiles WHERE id = p_actor_id;
    IF prof.status IS DISTINCT FROM 'active' OR prof.is_deleted::text IS DISTINCT FROM 'false'
      OR EXISTS (SELECT 1 FROM account_erasure_requests WHERE profile_id = p_actor_id) THEN
      RAISE EXCEPTION 'TURN_ACCOUNT_ERASING' USING ERRCODE='42501';
    END IF;
    g := (p_policy->>'gCredits')::int;
    available := greatest(public.credit_available(p_actor_id), 0);
    -- The balance, not the freeze, is held against the start threshold L (as bill2_payg_claim): a balance that covers one
    -- normal turn starts it, and the freeze H may be below L when one call's bound G is (Owner 10-28, restating 10-01).
    IF available < (p_policy->>'minCredits')::int THEN RAISE EXCEPTION 'TURN_INSUFFICIENT_CREDITS' USING ERRCODE='P0001'; END IF;
    h := least(g, available);
    IF h > 0 THEN
      SELECT pre_deduct_id INTO hold FROM public.atomic_pre_deduct(p_actor_id, h, 'AI turn freeze', p_request_id);
    END IF;

    frozen := p_policy || jsonb_build_object('day', v_day, 'bucket', v_bucket, 'holdId', hold, 'heldCredits', h);
    INSERT INTO turns (actor_id, session_id, request_id, kind, state, policy, reserved_credits, reserved_usd, input_bytes)
      VALUES (p_actor_id, p_session_id, p_request_id, p_kind, 'running', frozen, h, u_turn,
        (p_policy->>'inputBytes')::int)
      RETURNING * INTO t;
    UPDATE runtime_sessions SET active_turn_id = t.id WHERE id = s.id;
  END IF;

  -- 5. The visible history, newest N in order.
  SELECT coalesce(jsonb_agg(jsonb_build_object('seq', m.seq, 'role', m.role, 'content', m.content, 'contentHash', m.content_hash)
    ORDER BY m.seq), '[]'::jsonb) INTO history
  FROM (SELECT seq, role, content, content_hash FROM session_messages
        WHERE session_id = p_session_id AND visible AND deleted_at IS NULL
        ORDER BY seq DESC LIMIT (t.policy->>'historyItems')::int) m;
  -- 6. What the turn's prompt needs from the account, read here instead of in more round trips: the reply language and, for a
  -- free chat, the positioning gate (confirmed positioning; refusals in 24 hours, counted on the turns refused for it).
  RETURN jsonb_build_object('turnId', t.id, 'state', t.state, 'replay', existing.id IS NOT NULL,
    'reservedCredits', t.reserved_credits, 'reservedUsd', t.reserved_usd, 'history', history,
    'replyLanguage', prof.reply_language,
    'positioning', CASE WHEN p_kind = 'chat' THEN jsonb_build_object(
      'positioned', public.opc_has_confirmed_positioning(p_actor_id),
      'refusals24h', (SELECT count(*) FROM turns r WHERE r.actor_id = p_actor_id AND r.failure_code = 'positioning_required'
        AND r.closed_at > now() - interval '24 hours')) END,
    -- Per-kind context for the prompt (2.7). Each kind reads its input from p_policy->'<kind>' and adds its own branch here
    -- (CASE p_kind WHEN '<kind>' THEN public.turn_<kind>_context(...) END); no kind has one yet.
    'kindContext', CASE p_kind WHEN 'mentor' THEN public.turn_mentor_context(p_actor_id, p_session_id, p_policy->'mentor') END);
END $function$;

-- turn_close: 0421 unchanged except the mentor branch of the per-kind hook and kindResult in what it returns.
CREATE OR REPLACE FUNCTION public.turn_close(p_actor_id uuid, p_turn_id bigint, p_close_kind text, p_messages jsonb DEFAULT '[]'::jsonb,
  p_delivered boolean DEFAULT false, p_refund_all boolean DEFAULT false, p_failure_code text DEFAULT NULL,
  p_kind_result jsonb DEFAULT NULL)
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
      SELECT coalesce(sum(nominal_usd) FILTER (WHERE status = 'ok'), 0) + coalesce(sum(actual_usd) FILTER (WHERE status = 'unusable'), 0),
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
      IF t.charged_credits IS NULL AND NOT user_pending THEN
        charge := public.turn_user_charge(p_actor_id, p_turn_id, t.close_kind, t.delivered,
          coalesce((t.policy->>'closeRefundAll')::boolean, false), credits, t.reserved_credits, (t.policy->>'fixedCredits')::int, t.closed_at);
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
  -- cost of every receipt, the positioning check and the platform-paid unusable results included, which the stop-loss counts.
  SELECT ceil(q * coalesce(sum(nominal_usd * multiplier) FILTER (WHERE status = 'ok' AND call_kind <> 'decision'), 0))::integer,
         coalesce(sum(nominal_usd) FILTER (WHERE status = 'ok'), 0) + coalesce(sum(actual_usd) FILTER (WHERE status = 'unusable'), 0),
         coalesce(sum(upper_usd) FILTER (WHERE cost_pending), 0),
         coalesce(bool_or(cost_pending), false),
         -- Only an unknown model call holds the user's settlement: a third-party tool whose result is unknown is 0 to the user
         -- (Owner 10-13, plan 2.5.2) and the positioning check is never theirs; both keep only the provider cost pending.
         coalesce(bool_or(cost_pending AND call_kind = 'model'), false)
    INTO credits, n_total, pending_upper, pending, user_pending
  FROM turn_calls WHERE turn_id = p_turn_id;
  h := t.reserved_credits;

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

-- opc_information and opc_capture_resolve: unchanged except that they lock the draft's session row before the project (see
-- turn_mentor_apply), the order content_erasure_confirm and report_document_source already use (sessions, then projects).
CREATE OR REPLACE FUNCTION public.opc_information(p_actor_id uuid, p_draft_id uuid, p_step_id text, p_request_id uuid, p_expected_version integer, p_values jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- R9 manual provenance

DECLARE d opc_drafts;r artifact_rounds;step jsonb;field jsonb;value jsonb;st jsonb;req artifact_requests;payload jsonb;
BEGIN
 -- 0324 archived business guard
 IF true THEN PERFORM opc_assert_business_writable(p_actor_id,jsonb_build_object('draftId',p_draft_id)); END IF;

 PERFORM bill2_actor(p_actor_id);
 IF substr(p_request_id::text,15,1)='f' THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
 SELECT * INTO d FROM opc_drafts WHERE actor_id=p_actor_id AND draft_id=p_draft_id;
 IF d.draft_id IS NULL OR NOT bill2_scope_allowed(p_actor_id,jsonb_build_object('kind','positioning_draft','draftId',p_draft_id)) THEN RAISE EXCEPTION 'OPC_DENIED';END IF;
 -- V2-5: the draft's session row first, the lock a mentor turn's close holds while it writes this checklist (the main-path
 -- serialization point), so a manual save and a mentor capture never overwrite each other; then the project, as before.
 PERFORM 1 FROM runtime_sessions WHERE id=d.session_id AND actor_id=p_actor_id FOR UPDATE;
 PERFORM 1 FROM artifact_projects WHERE id=d.project_id FOR UPDATE;
 SELECT * INTO r FROM artifact_rounds WHERE id=d.round_id;
 PERFORM read_skill_package(p_actor_id,(SELECT module_id FROM artifact_projects WHERE id=d.project_id),(SELECT skill_id FROM artifact_projects WHERE id=d.project_id),r.revision_id,r.package_hash,NULL);
 payload:=jsonb_build_object('stepId',p_step_id,'expectedVersion',p_expected_version,'values',p_values);
 SELECT * INTO req FROM artifact_requests WHERE project_id=d.project_id AND request_id=p_request_id;
 IF FOUND THEN IF req.action<>'opc_information' OR req.payload<>payload THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
  RETURN req.response||jsonb_build_object('values',req.payload->'values');END IF;
 SELECT x INTO step FROM jsonb_array_elements(r.workflow->'steps') x WHERE x->>'id'=p_step_id;
 st:=r.steps->p_step_id;
 IF r.state<>'draft' OR step IS NULL OR p_request_id IS NULL OR (st->>'version')::int IS DISTINCT FROM p_expected_version OR jsonb_typeof(p_values) IS DISTINCT FROM 'object' OR octet_length(p_values::text)>12000 THEN RAISE EXCEPTION 'OPC_INFORMATION_CONFLICT';END IF;
 FOR field IN SELECT * FROM jsonb_array_elements(step->'information') LOOP
  value:=p_values->(field->>'id');
  IF value IS NULL OR value-ARRAY['status','value','nature']<>'{}' OR coalesce(value->>'status','') NOT IN ('unknown','unclear','provisional','confirmed','deferred') OR coalesce(value->>'nature','') NOT IN ('fact','decision','hypothesis','unknown') OR char_length(coalesce(value->>'value',''))>400 OR (value->>'status' IN ('confirmed','deferred') AND char_length(btrim(coalesce(value->>'value','')))=0) THEN RAISE EXCEPTION 'OPC_INFORMATION_INVALID';END IF;
 END LOOP;
 IF (SELECT count(*) FROM jsonb_object_keys(p_values))<>jsonb_array_length(step->'information') THEN RAISE EXCEPTION 'OPC_INFORMATION_INVALID';END IF;
 FOR field IN SELECT * FROM jsonb_array_elements(step->'information') LOOP
  value:=p_values->(field->>'id');
  IF st->'information'->(field->>'id') IS DISTINCT FROM value THEN
   st:=st||jsonb_build_object('fieldMeta',coalesce(st->'fieldMeta','{}')||jsonb_build_object(field->>'id',
    (coalesce(st->'fieldMeta'->(field->>'id'),'{}')-ARRAY['executionId','basis','acceptedAt'])
    ||jsonb_build_object('source','user','basis','user_statement','fp',artifact_hash(value),'createdAt',clock_timestamp(),
     'origin',coalesce(st#>ARRAY['fieldMeta',field->>'id','origin'],
      jsonb_strip_nulls(jsonb_build_object('executionId',st#>ARRAY['fieldMeta',field->>'id','executionId'],
       'basis',st#>ARRAY['fieldMeta',field->>'id','basis']))))));
  END IF;
 END LOOP;
 st:=st||jsonb_build_object('information',p_values,'informationUpdatedAt',clock_timestamp(),'version',p_expected_version+1);
 UPDATE artifact_rounds SET steps=artifact_invalidate(r.workflow,jsonb_set(r.steps,ARRAY[p_step_id],st),p_step_id) WHERE id=r.id;
 INSERT INTO artifact_requests VALUES(d.project_id,p_request_id,r.id,'opc_information',payload,jsonb_build_object('version',p_expected_version+1,'values',p_values));RETURN jsonb_build_object('version',p_expected_version+1,'values',p_values);
END $function$;

CREATE OR REPLACE FUNCTION public.opc_capture_resolve(p_actor_id uuid, p_draft_id uuid, p_request_id uuid, p_step_id text, p_field_id text, p_execution_id uuid, p_hash text, p_action text, p_expected_version integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- R9 accepted provenance

DECLARE d opc_drafts;r artifact_rounds;req artifact_requests;payload jsonb;st jsonb;meta jsonb;suggestion jsonb;
 value jsonb;information jsonb;version integer;response jsonb;e runtime_executions;t opc_turns;
BEGIN
 -- 0324 archived business guard
 IF true THEN PERFORM opc_assert_business_writable(p_actor_id,jsonb_build_object('draftId',p_draft_id)); END IF;

 PERFORM bill2_actor(p_actor_id);
 IF substr(p_request_id::text,15,1)='f' THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
 SELECT * INTO d FROM opc_drafts WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
 IF d.draft_id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,jsonb_build_object('kind','positioning_draft','draftId',p_draft_id)),false)
 THEN RAISE EXCEPTION 'OPC_CAPTURE_DENIED';END IF;
 -- V2-5: the draft's session row first, the lock a mentor turn's close holds while it writes this checklist (the main-path
 -- serialization point), so a manual save and a mentor capture never overwrite each other; then the project, as before.
 PERFORM 1 FROM runtime_sessions WHERE id=d.session_id AND actor_id=p_actor_id FOR UPDATE;
 PERFORM 1 FROM artifact_projects WHERE id=d.project_id FOR UPDATE;
 SELECT * INTO d FROM opc_drafts WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
 SELECT * INTO r FROM artifact_rounds WHERE id=d.round_id;
 payload:=jsonb_build_object('stepId',p_step_id,'fieldId',p_field_id,'executionId',p_execution_id,
  'hash',p_hash,'action',p_action,'expectedVersion',p_expected_version);
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND session_id=d.session_id AND actor_id=p_actor_id;
 SELECT * INTO t FROM opc_turns WHERE session_id=d.session_id AND request_id=e.request_id;
 IF e.id IS NULL OR t.token::text IS DISTINCT FROM e.payload->>'opcTurnToken' OR t.purpose IS DISTINCT FROM 'mentor'
  OR NOT runtime_history_available(e.id) THEN RAISE EXCEPTION 'OPC_CAPTURE_DENIED';END IF;
 SELECT * INTO req FROM artifact_requests WHERE project_id=d.project_id AND request_id=p_request_id;
 IF FOUND THEN
  IF req.action IS DISTINCT FROM 'opc_capture_resolve' OR req.payload IS DISTINCT FROM payload THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
  RETURN req.response;
 END IF;
 st:=r.steps->p_step_id;meta:=st->'fieldMeta'->p_field_id;
 -- v3 suggestion withdraw: dismiss binds to the withdrawn record; accept/ignore to the pending one.
 suggestion:=CASE WHEN p_action='dismiss' THEN meta->'withdrawnSuggestion' ELSE meta->'suggestion' END;
 IF suggestion->>'executionId' IS DISTINCT FROM p_execution_id::text OR suggestion->>'hash' IS DISTINCT FROM p_hash
  OR suggestion IS NULL OR r.state<>'draft' OR t.round_id<>r.id THEN RAISE EXCEPTION 'OPC_SUGGESTION_CHANGED';END IF;
 IF p_request_id IS NULL OR p_hash IS NULL OR p_action IS NULL OR p_action NOT IN ('accept','ignore','dismiss')
 THEN RAISE EXCEPTION 'OPC_CAPTURE_DENIED';END IF;
 version:=(st->>'version')::integer;
 IF p_action='accept' THEN
  IF version IS DISTINCT FROM p_expected_version THEN RAISE EXCEPTION 'OPC_INFORMATION_CONFLICT';END IF;
  value:=jsonb_build_object('value',suggestion->'value','status',suggestion->'status','nature',suggestion->'nature');
  information:=st->'information'||jsonb_build_object(p_field_id,value);
  IF octet_length(information::text)>12000 THEN RAISE EXCEPTION 'OPC_INFORMATION_CONFLICT';END IF;
  IF st->'information'->p_field_id IS DISTINCT FROM value THEN
   version:=version+1;
   st:=st||jsonb_build_object('information',information,'version',version,'informationUpdatedAt',clock_timestamp());
  END IF;
  meta:=jsonb_build_object('source','user','fp',artifact_hash(value),'basis',suggestion->'basis',
   'executionId',p_execution_id,'acceptedAt',clock_timestamp(),'createdAt',suggestion->'createdAt');
 ELSIF p_action='dismiss' THEN meta:=meta-'withdrawnSuggestion';
 ELSE meta:=meta-'suggestion';END IF;
 IF meta='{}' THEN st:=st #- ARRAY['fieldMeta',p_field_id];
 ELSE st:=jsonb_set(st,ARRAY['fieldMeta',p_field_id],meta);END IF;
 r.steps:=jsonb_set(r.steps,ARRAY[p_step_id],st);
 IF p_action='accept' AND version<>p_expected_version THEN r.steps:=artifact_invalidate(r.workflow,r.steps,p_step_id);END IF;
 UPDATE artifact_rounds SET steps=r.steps WHERE id=r.id;
 response:=jsonb_build_object('version',version,'result',p_action);
 INSERT INTO artifact_requests VALUES(d.project_id,p_request_id,r.id,'opc_capture_resolve',payload,response);
 RETURN response;
END $function$;

-- opc_capture_apply (the old path's organizer capture): unchanged except the same session-row lock before the project.
CREATE OR REPLACE FUNCTION public.opc_capture_apply(p_actor_id uuid, p_draft_id uuid, p_execution_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- R9 suggestion time

-- R9 capture provenance

DECLARE d opc_drafts;r artifact_rounds;p artifact_projects;e runtime_executions;t opc_turns;req artifact_requests;
 ids uuid[];available_ids uuid[];execution_id uuid;processed jsonb:='[]';response jsonb;payload jsonb;capture_request_id uuid;
 output jsonb;code text;patch jsonb;step_id text;field_id text;st jsonb;meta jsonb;value jsonb;candidate jsonb;
 changed jsonb:='{}';fields jsonb:='{}';discarded jsonb:='[]';versions jsonb:='{}';old_steps jsonb;
 protected boolean;material_changed boolean;seq jsonb;suggestion jsonb;remaining integer;patch_index integer:=0;
 withdrawal jsonb;withdrawn jsonb:='{}';withdraw_index integer:=0;withdraw_reason text;organizer_input jsonb;
BEGIN
 -- 0324 archived business guard
 IF true THEN PERFORM opc_assert_business_writable(p_actor_id,jsonb_build_object('draftId',p_draft_id,'executionId',p_execution_id)); END IF;

 -- Lock order: the draft's session row, then the project (V2-5: the session row is the one serialization point every checklist
 -- writer shares with a mentor turn's close, which holds it; opc_information and opc_capture_resolve take it the same way).
 -- Never a run update lock.
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO d FROM opc_drafts WHERE actor_id=p_actor_id AND (draft_id=p_draft_id OR
  (p_draft_id IS NULL AND session_id=(SELECT session_id FROM runtime_executions WHERE id=p_execution_id AND actor_id=p_actor_id)));
 IF d.draft_id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,jsonb_build_object('kind','positioning_draft','draftId',d.draft_id)),false)
 THEN RAISE EXCEPTION 'OPC_CAPTURE_DENIED';END IF;
 PERFORM 1 FROM runtime_sessions WHERE id=d.session_id AND actor_id=p_actor_id FOR UPDATE;
 SELECT * INTO p FROM artifact_projects WHERE id=d.project_id FOR UPDATE;
 -- Refresh the draft after waiting: a concurrent revision may have advanced it.
 SELECT * INTO d FROM opc_drafts WHERE draft_id=d.draft_id AND actor_id=p_actor_id;
 SELECT * INTO r FROM artifact_rounds WHERE id=d.round_id;
 IF p_execution_id IS NULL THEN
  SELECT coalesce(array_agg(ex.id ORDER BY ex.created_at,ex.id),'{}') INTO ids
  FROM opc_turns turn JOIN runtime_executions ex ON ex.session_id=turn.session_id AND ex.request_id=turn.request_id
  WHERE turn.session_id=d.session_id AND turn.draft_id=d.draft_id AND turn.round_id=r.id AND turn.purpose='mentor'
   AND ex.actor_id=p_actor_id AND ex.state='completed'
   AND CASE WHEN (ex.payload#>>'{attachedOrganizer,input}') IS JSON OBJECT
    THEN (ex.payload#>>'{attachedOrganizer,input}')::jsonb->>'captureFormat'='v2' ELSE false END
   AND NOT EXISTS(SELECT 1 FROM artifact_requests a WHERE a.project_id=d.project_id
    AND a.request_id=overlay(md5('opc_capture:'||ex.id::text) placing 'f' from 13 for 1)::uuid AND a.action='opc_capture'
    AND a.payload=jsonb_build_object('executionId',ex.id,'ruleVersion',1));
  SELECT coalesce(array_agg(x.id ORDER BY x.ord),'{}') INTO available_ids
  FROM unnest(ids) WITH ORDINALITY x(id,ord)
  JOIN runtime_history_availability(ids) a ON a.execution_id=x.id AND a.available;
  -- Recursive calls share this transaction: any storage error rolls back ALL five.
  FOREACH execution_id IN ARRAY available_ids[1:5] LOOP
   response:=opc_capture_apply(p_actor_id,p_draft_id,execution_id);
   processed:=processed||jsonb_build_array(jsonb_build_object('executionId',execution_id,'result',response->>'result'));
  END LOOP;
  SELECT count(*)::integer INTO remaining FROM unnest(available_ids) x(id)
  WHERE NOT EXISTS(SELECT 1 FROM artifact_requests a WHERE a.project_id=d.project_id
   AND a.request_id=overlay(md5('opc_capture:'||x.id::text) placing 'f' from 13 for 1)::uuid);
  RETURN jsonb_build_object('processed',processed,'remaining',remaining,'hasMore',remaining>0);
 END IF;
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND session_id=d.session_id AND actor_id=p_actor_id;
 IF e.id IS NULL THEN RAISE EXCEPTION 'OPC_CAPTURE_DENIED';END IF;
 capture_request_id:=overlay(md5('opc_capture:'||e.id::text) placing 'f' from 13 for 1)::uuid;
 payload:=jsonb_build_object('executionId',e.id,'ruleVersion',1);
 SELECT * INTO req FROM artifact_requests WHERE project_id=d.project_id AND artifact_requests.request_id=capture_request_id;
 IF FOUND THEN
  IF req.action IS DISTINCT FROM 'opc_capture' OR req.payload IS DISTINCT FROM payload THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
  IF NOT runtime_history_available(e.id) THEN RETURN jsonb_build_object('result','unavailable');END IF;
  RETURN req.response;
 END IF;
 IF e.state<>'completed' THEN RETURN jsonb_build_object('result','not_ready');END IF;
 code:=NULL;
 IF NOT coalesce((CASE WHEN (e.payload#>>'{attachedOrganizer,input}') IS JSON OBJECT
  THEN (e.payload#>>'{attachedOrganizer,input}')::jsonb->>'captureFormat'='v2' ELSE false END),false)
 THEN code:='skipped_format';END IF;
 SELECT * INTO t FROM opc_turns WHERE session_id=d.session_id AND request_id=e.request_id;
 IF code IS NULL AND (t.token IS NULL OR t.token::text IS DISTINCT FROM e.payload->>'opcTurnToken'
  OR t.draft_id<>d.draft_id OR t.purpose<>'mentor'
  OR e.payload->>'revisionId' IS DISTINCT FROM (SELECT revision_id::text FROM artifact_rounds WHERE id=t.round_id)
  OR e.payload->>'moduleId' IS DISTINCT FROM p.module_id::text) THEN code:='denied_binding';END IF;
 IF code IS NULL AND (t.round_id<>r.id OR e.payload#>>'{scopeMaterial,content,work,roundId}' IS DISTINCT FROM r.id::text
  OR r.state<>'draft') THEN code:='stale_round';END IF;
 IF code IS NULL AND NOT runtime_history_available(e.id) THEN RETURN jsonb_build_object('result','unavailable');END IF;
 IF code IS NULL THEN
  -- Only malformed JSON is caught. Storage, permission, lock and transaction errors escape.
  BEGIN output:=(e.result->>'summary')::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN output:=NULL;END;
  IF jsonb_typeof(output) IS DISTINCT FROM 'object'
   OR coalesce(output->>'inputKind','') NOT IN ('answer','acknowledgement','uncertainty','request','revision_request')
   OR jsonb_typeof(output->'patches') IS DISTINCT FROM 'array'
   OR jsonb_typeof(output->'notes') IS DISTINCT FROM 'array'
   THEN code:='invalid_output';
  ELSIF jsonb_array_length(output->'patches')>12 THEN code:='invalid_output';
  ELSIF output ? 'withdrawals' AND jsonb_typeof(output->'withdrawals') IS DISTINCT FROM 'array' THEN code:='invalid_output';
  ELSIF jsonb_array_length(coalesce(output->'withdrawals','[]'))>12 THEN code:='invalid_output';END IF;
 END IF;
 IF code IS NULL THEN
  old_steps:=r.steps;
  material_changed:=EXISTS(SELECT 1 FROM jsonb_each(r.steps) s
   WHERE s.value->'version' IS DISTINCT FROM e.payload#>ARRAY['scopeMaterial','content','work','steps',s.key,'version']);
  FOR patch IN SELECT * FROM jsonb_array_elements(output->'patches') LOOP
   patch_index:=patch_index+1;
   step_id:=patch->>'stepId';field_id:=patch->>'fieldId';st:=r.steps->step_id;
   IF jsonb_typeof(patch) IS DISTINCT FROM 'object' OR jsonb_typeof(patch->'value') IS DISTINCT FROM 'string'
    OR char_length(btrim(coalesce(patch->>'value','')))=0 OR char_length(patch->>'value')>400
    OR coalesce(patch->>'status','') NOT IN ('provisional','unclear')
    OR coalesce(patch->>'nature','') NOT IN ('fact','decision','hypothesis','unknown')
    OR coalesce(patch->>'basis','') NOT IN ('user_statement','agent_proposal')
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.workflow->'steps') s,jsonb_array_elements(s->'information') f
      WHERE s->>'id'=step_id AND f->>'id'=field_id)
   THEN discarded:=discarded||jsonb_build_array(jsonb_build_object('index',patch_index,'reason','invalid_patch'));CONTINUE;END IF;
   -- Host notifications contain no user statement. Preserve only concrete mentor proposals
   -- for fields explicitly declared as agent-owned by this pinned workflow.
   IF ((e.payload#>>'{attachedOrganizer,input}')::jsonb#>>'{hostEvent,kind}')='checklist_updated'
    AND (patch->>'basis'<>'agent_proposal' OR position('HOST_CHECKLIST_UPDATED:' in (patch->>'value'))>0
     OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.workflow->'steps') s,
      jsonb_array_elements(s->'information') f WHERE s->>'id'=step_id AND f->>'id'=field_id
       AND f->>'elicitation'='agent_proposal'))
   THEN discarded:=discarded||jsonb_build_array(jsonb_build_object('index',patch_index,'reason','host_checklist_updated'));
    CONTINUE;END IF;
   value:=patch-ARRAY['stepId','fieldId','basis'];
   value:=jsonb_build_object('value',value->'value','status',value->'status','nature',value->'nature');
   meta:=coalesce(st->'fieldMeta'->field_id,'{}');
   protected:=NOT coalesce(NOT coalesce((st->>'valid')::boolean,false)
 AND coalesce(st->'information'->(field_id)->>'status','unknown') NOT IN ('confirmed','deferred') AND (
  (st->'fieldMeta'->(field_id)->>'source'='capture' AND st->'fieldMeta'->(field_id)->>'fp'=artifact_hash(st->'information'->(field_id))
   AND EXISTS(SELECT 1 FROM artifact_requests cap WHERE cap.project_id=d.project_id AND cap.round_id=r.id
    AND cap.request_id=overlay(md5('opc_capture:'||(st->'fieldMeta'->(field_id)->>'executionId')) placing 'f' from 13 for 1)::uuid
    AND cap.action='opc_capture' AND cap.payload->>'executionId'=st->'fieldMeta'->(field_id)->>'executionId'
    AND cap.response->'versions' ? (step_id)
    AND NOT EXISTS(SELECT 1 FROM artifact_requests manual WHERE manual.project_id=d.project_id AND manual.round_id=r.id
     AND manual.action='opc_information' AND manual.payload->>'stepId'=(step_id)
     AND (manual.payload->>'expectedVersion')::integer >= (cap.response->'versions'->>(step_id))::integer
     AND artifact_hash(manual.payload->'values'->(field_id)) IS DISTINCT FROM st->'fieldMeta'->(field_id)->>'fp')))
  OR (st->'fieldMeta'->(field_id)->>'source' IS NULL AND coalesce(st->'information'->(field_id)->>'value','')='' AND coalesce(st->'information'->(field_id)->>'status','unknown')='unknown'
   AND NOT EXISTS(SELECT 1 FROM artifact_requests history WHERE history.project_id=d.project_id AND history.round_id=r.id
    AND ((history.action='opc_information' AND history.payload->>'stepId'=(step_id)
      AND coalesce(history.payload->'values'->(field_id)->>'value','')<>'')
     OR (history.action='opc_capture' AND history.response->'fields'->(step_id) ? (field_id)))))
 ),false);
   candidate:=coalesce(st->'information','{}')||jsonb_build_object(field_id,value);
   IF NOT material_changed AND NOT protected AND octet_length(candidate::text)<=12000 THEN
    IF st->'information'->field_id IS DISTINCT FROM value THEN
     st:=st||jsonb_build_object('information',candidate,'informationUpdatedAt',clock_timestamp());
     changed:=changed||jsonb_build_object(step_id,true);
     fields:=jsonb_set(fields,ARRAY[step_id],coalesce(fields->step_id,'[]')||to_jsonb(field_id));
     meta:=jsonb_build_object('source','capture','basis',patch->'basis','executionId',e.id,'fp',artifact_hash(value),
   'createdAt',clock_timestamp());
    END IF;
   ELSE
    seq:=jsonb_build_array(e.created_at,e.id);
    suggestion:=jsonb_build_object('executionId',e.id,'seq',seq,'value',value->'value',
     'status',value->'status','nature',value->'nature','basis',patch->'basis');
    suggestion:=suggestion||jsonb_build_object('createdAt',clock_timestamp());
    suggestion:=suggestion||jsonb_build_object('hash',artifact_hash(suggestion));
    -- v3: a turn older than the user's withdrawal can neither revive advice nor erase the withdrawn record.
    IF (meta->'suggestion' IS NULL OR ((meta#>>'{suggestion,seq,0}')::timestamptz,(meta#>>'{suggestion,seq,1}')::uuid) < (e.created_at,e.id))
     AND (meta->'withdrawnSuggestion' IS NULL OR ((meta#>>'{withdrawnSuggestion,withdrawnSeq,0}')::timestamptz,
      (meta#>>'{withdrawnSuggestion,withdrawnSeq,1}')::uuid) < (e.created_at,e.id))
    THEN meta:=(meta-'withdrawnSuggestion')||jsonb_build_object('suggestion',suggestion);END IF;
   END IF;
   st:=st||jsonb_build_object('fieldMeta',coalesce(st->'fieldMeta','{}')||jsonb_build_object(field_id,meta));
   r.steps:=jsonb_set(r.steps,ARRAY[step_id],st);
  END LOOP;
  -- v3 suggestion withdraw: a real user turn may clear a pending suggestion older than this turn.
  -- The record moves to withdrawnSuggestion so the page can show it; information is never read or written.
  organizer_input:=(e.payload#>>'{attachedOrganizer,input}')::jsonb;
  FOR withdrawal IN SELECT * FROM jsonb_array_elements(coalesce(output->'withdrawals','[]')) LOOP
   withdraw_index:=withdraw_index+1;
   step_id:=withdrawal->>'stepId';field_id:=withdrawal->>'fieldId';meta:=r.steps#>ARRAY[step_id,'fieldMeta',field_id];
   IF jsonb_typeof(withdrawal) IS DISTINCT FROM 'object' OR step_id IS NULL OR field_id IS NULL
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.workflow->'steps') s,jsonb_array_elements(s->'information') f
     WHERE s->>'id'=step_id AND f->>'id'=field_id) THEN withdraw_reason:='invalid_withdrawal';
   ELSIF organizer_input ? 'hostEvent' OR coalesce(btrim(organizer_input->>'userInput'),'') IN ('','HOST_OPEN_CURRENT_QUESTION')
    THEN withdraw_reason:='no_user_turn';
   ELSIF jsonb_typeof(meta->'suggestion') IS DISTINCT FROM 'object' THEN withdraw_reason:='no_suggestion';
   -- Bind to the complete suggestion the organizer was shown (value, nature, basis): a replacement stays.
   ELSIF jsonb_strip_nulls(jsonb_build_object('value',meta#>'{suggestion,value}','nature',meta#>'{suggestion,nature}',
    'basis',meta#>'{suggestion,basis}')) IS DISTINCT FROM (SELECT jsonb_strip_nulls(fld->'pendingSuggestion')
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(organizer_input->'checklist')='array' THEN organizer_input->'checklist' ELSE '[]' END) stp,
     jsonb_array_elements(CASE WHEN jsonb_typeof(stp->'fields')='array' THEN stp->'fields' ELSE '[]' END) fld
    WHERE stp->>'id'=step_id AND fld->>'id'=field_id LIMIT 1) THEN withdraw_reason:='not_shown';
   ELSIF ((meta#>>'{suggestion,seq,0}')::timestamptz,(meta#>>'{suggestion,seq,1}')::uuid) >= (e.created_at,e.id)
    THEN withdraw_reason:='superseded';
   ELSE withdraw_reason:=NULL;END IF;
   IF withdraw_reason IS NOT NULL THEN
    discarded:=discarded||jsonb_build_array(jsonb_build_object('withdrawal',withdraw_index,'reason',withdraw_reason));CONTINUE;END IF;
   meta:=(meta-'suggestion')||jsonb_build_object('withdrawnSuggestion',(meta->'suggestion')||jsonb_build_object('withdrawnBy',e.id,
    'withdrawnSeq',jsonb_build_array(e.created_at,e.id)));
   r.steps:=jsonb_set(r.steps,ARRAY[step_id,'fieldMeta',field_id],meta);
   withdrawn:=jsonb_set(withdrawn,ARRAY[step_id],coalesce(withdrawn->step_id,'[]')||to_jsonb(field_id));
  END LOOP;
  FOR step_id IN SELECT jsonb_object_keys(changed) LOOP
   r.steps:=jsonb_set(r.steps,ARRAY[step_id,'version'],to_jsonb((old_steps->step_id->>'version')::integer+1));
   r.steps:=artifact_invalidate(r.workflow,r.steps,step_id);
   versions:=versions||jsonb_build_object(step_id,r.steps->step_id->'version');
  END LOOP;
  UPDATE artifact_rounds SET steps=r.steps WHERE id=r.id;
  code:=CASE WHEN changed='{}' THEN 'suggested' ELSE 'applied' END;
 END IF;
 response:=jsonb_build_object('executionId',e.id,'result',code,'ruleVersion',1,'versions',versions,'fields',fields,'discarded',discarded);
 response:=response||CASE WHEN withdrawn='{}' THEN '{}'::jsonb ELSE jsonb_build_object('withdrawn',withdrawn) END;
 INSERT INTO artifact_requests VALUES(d.project_id,capture_request_id,r.id,'opc_capture',payload,response);
 RETURN response;
END $function$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['turn_mentor_context(uuid,uuid,jsonb)', 'turn_mentor_apply(uuid,bigint,jsonb)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated, service_role', f);
  END LOOP;
END $$;

COMMIT;
