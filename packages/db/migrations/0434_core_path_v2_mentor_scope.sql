-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-5d: the mentor path without the old permission chain in turn_open / turn_close (docs/launch/tasks/CORE-PATH-V2.md 3.1).
--   turn_mentor_draft_allowed  the narrow check on the hot path: the draft is the actor's, not revoked, its project not tombstoned.
--   turn_mentor_source_live    on turn_close and the refresh read: an account-strategy draft's source drafts not revoked.
--   mentor_source_check        the whole old check, unchanged (bill2_scope_allowed, opc_business_context), as its own read. Node calls
--                              it only for a draft that has an account-strategy binding or a business source, before turn_open and
--                              again after the last model call before turn_close, so plain drafts pay no round trip. turn_open
--                              refuses such a draft (TURN_SOURCE_CHECK_REQUIRED) unless the policy says it was checked.
--   mentor_skill_available     the Skill checks of turn_mentor_context, read through the Skill catalog cache.
--   session_view_allowed       the whole old scope check of the refresh-recovery read, called first by view.ts.
--   turn_mentor_context, turn_mentor_apply, turn_session_view  full bodies, with the old chain replaced as above; the business
--                              context's source is filled in from mentor_source_check.
-- Compatibility: three new functions plus three replaced bodies. The new path takes no user traffic until V2-10 (core_path_v2.enabled),
-- so the usual order holds: apply, then merge; between the two, an old Node's mentor turn on the new path would refuse the new field.
-- Idempotent: CREATE OR REPLACE. Recovery: re-apply the bodies of 0428 and of the migration before it; no data changes.
CREATE OR REPLACE FUNCTION public.turn_mentor_draft_allowed(p_actor_id uuid, p_draft_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (SELECT 1 FROM bill2_drafts WHERE id = p_draft_id AND actor_id = p_actor_id AND NOT revoked)
    AND NOT EXISTS (SELECT 1 FROM opc_drafts d JOIN artifact_projects p ON p.id = d.project_id
      WHERE d.draft_id = p_draft_id AND p.actor_id = p_actor_id AND p.erased_at IS NOT NULL)
$function$;

-- An account-strategy draft's own sources, in the same transaction as what the check guards: a source draft revoked after
-- mentor_source_check still stops the close write and the refresh read (the deep evidence checks stay in mentor_source_check).
CREATE OR REPLACE FUNCTION public.turn_mentor_source_live(p_draft_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT NOT EXISTS (SELECT 1 FROM opc_account_strategy_drafts a
    JOIN artifact_versions v ON v.id IN (a.base_source_version_id, a.root_source_version_id)
    JOIN opc_drafts sd ON sd.project_id = v.project_id JOIN bill2_drafts b ON b.id = sd.draft_id
    WHERE a.draft_id = p_draft_id AND (b.revoked OR v.erased_at IS NOT NULL))
$function$;

CREATE OR REPLACE FUNCTION public.mentor_source_check(p_actor_id uuid, p_session_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE d opc_drafts;
BEGIN
  SELECT * INTO d FROM opc_drafts WHERE actor_id = p_actor_id AND session_id = p_session_id;
  IF d.draft_id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id, jsonb_build_object('kind','positioning_draft','draftId',d.draft_id)), false)
  THEN RETURN jsonb_build_object('allowed', false); END IF;
  -- The source drafts behind an account-strategy draft: turn_open refuses them if revoked since this read (same table as its own check).
  RETURN jsonb_build_object('allowed', true, 'businessContext', opc_business_context(p_actor_id, p_session_id, d.round_id),
    'sourceDrafts', (SELECT coalesce(jsonb_agg(DISTINCT sd.draft_id), '[]'::jsonb) FROM opc_account_strategy_drafts a
      JOIN artifact_versions v ON v.id IN (a.base_source_version_id, a.root_source_version_id)
      JOIN opc_drafts sd ON sd.project_id = v.project_id WHERE a.draft_id = d.draft_id));
END $function$;

-- The Skill revision of a round, under the same rules as read_skill_package: an active module of that Skill, a published directory
-- Skill, the round's exact package, not revoked. Administrator-written catalog rows: Node reads this through catalogRead (group
-- skills), whose version every one of these tables raises.
CREATE OR REPLACE FUNCTION public.mentor_skill_available(p_module_id uuid, p_skill_id uuid, p_revision_id uuid, p_package_hash text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (SELECT 1 FROM modules WHERE id = p_module_id AND skill_id = p_skill_id AND active IS TRUE)
    AND EXISTS (SELECT 1 FROM skills WHERE id = p_skill_id AND status = 'published' AND content_kind = 'directory')
    AND EXISTS (SELECT 1 FROM skill_packages WHERE skill_id = p_skill_id AND revision_id = p_revision_id AND package_hash = p_package_hash)
    AND NOT EXISTS (SELECT 1 FROM skill_revision_revocations WHERE revision_id = p_revision_id)
$function$;

CREATE OR REPLACE FUNCTION public.session_view_allowed(p_actor_id uuid, p_session_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT coalesce(bill2_scope_allowed(p_actor_id, s.scope), false) FROM runtime_sessions s WHERE s.id = p_session_id AND s.actor_id = p_actor_id
$function$;

CREATE OR REPLACE FUNCTION public.turn_mentor_context(p_actor_id uuid, p_session_id uuid, p_mentor jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE d opc_drafts; p artifact_projects; r artifact_rounds; spec jsonb; v_step text := p_mentor->>'stepId';
  b opc_businesses; st jsonb; step_id text; field_id text; metas jsonb; steps jsonb; suggestions jsonb := '{}';
  suggestion jsonb;
BEGIN
  SELECT * INTO d FROM opc_drafts WHERE actor_id = p_actor_id AND session_id = p_session_id;
  IF d.draft_id IS NULL THEN RAISE EXCEPTION 'TURN_MENTOR_DENIED' USING ERRCODE='42501'; END IF;
  -- The draft's own scope, narrow: revoked or tombstoned is refused here. What needs the whole source and evidence chain (an
  -- account-strategy draft, a business with a source) is mentor_source_check, which Node calls before this turn opens; a draft that needs it is refused unless it ran.
  IF NOT turn_mentor_draft_allowed(p_actor_id, d.draft_id) THEN RAISE EXCEPTION 'TURN_MENTOR_DENIED' USING ERRCODE='42501'; END IF;
  IF EXISTS (SELECT 1 FROM bill2_drafts WHERE actor_id = p_actor_id AND revoked
      AND id IN (SELECT value::uuid FROM jsonb_array_elements_text(coalesce(p_mentor->'sourceDrafts', '[]')))) THEN
    RAISE EXCEPTION 'TURN_MENTOR_DENIED' USING ERRCODE='42501';
  END IF;
  -- An archived business is read-only (as opc_assert_business_writable, without its row lock).
  SELECT x.* INTO b FROM opc_draft_businesses db JOIN opc_businesses x ON x.id = db.business_id AND x.actor_id = p_actor_id
   WHERE db.draft_id = d.draft_id;
  IF b.archived_at IS NOT NULL THEN RAISE EXCEPTION 'TURN_MENTOR_ARCHIVED' USING ERRCODE='42501'; END IF;
  IF p_mentor->'sourceChecked' IS DISTINCT FROM 'true'::jsonb AND (b.current_source_version_id IS NOT NULL
      OR EXISTS (SELECT 1 FROM opc_account_strategy_drafts WHERE draft_id = d.draft_id)) THEN
    RAISE EXCEPTION 'TURN_SOURCE_CHECK_REQUIRED' USING ERRCODE='42501';
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
  -- The Skill revision of the round is mentor_skill_available, read through the Skill catalog cache before any model call.
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
  RETURN jsonb_build_object('draftId', d.draft_id, 'projectId', p.id, 'roundId', r.id, 'mode', d.mode, 'moduleId', p.module_id,
    'skillId', p.skill_id, 'revisionId', r.revision_id, 'packageHash', r.package_hash, 'steps', r.workflow->'steps',
    'suggestions', suggestions,
    'work', jsonb_build_object('projectId', p.id, 'roundId', r.id, 'revisionId', r.revision_id, 'packageHash', r.package_hash,
      'steps', steps, 'source', NULL) || CASE WHEN b.id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('businessContext',
      jsonb_build_object('version', 'opc-business-context.v1', 'businessId', b.id,
        'name', CASE WHEN b.name = '未命名业务' THEN NULL ELSE b.name END, 'source', NULL)) END);
END $function$;;

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
 exec_id uuid; exec_at timestamptz; business_id uuid; written boolean := false;
BEGIN
 SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id;
 IF t.id IS NULL OR t.kind <> 'mentor' THEN RAISE EXCEPTION 'TURN_MENTOR_DENIED' USING ERRCODE='42501'; END IF;
 exec_id := t.request_id; exec_at := t.opened_at;
 SELECT * INTO d FROM opc_drafts WHERE actor_id = p_actor_id AND session_id = t.session_id;
 -- scopeDenied: Node's mentor_source_check before this close (the whole chain, for a draft that needs it).
 IF d.draft_id IS NULL OR NOT turn_mentor_draft_allowed(p_actor_id, d.draft_id) OR NOT turn_mentor_source_live(d.draft_id)
  OR p_result->'scopeDenied' = 'true'::jsonb
 THEN RETURN jsonb_build_object('result', 'denied_binding'); END IF;
 SELECT db.business_id INTO business_id FROM opc_draft_businesses db WHERE db.draft_id = d.draft_id;
 -- No lock of its own (main-path rule: only the actor's profile and the session row). turn_close holds this draft's session
 -- row, which opc_information and opc_capture_resolve now take first too (below), so those writers and this one are serialized.
 -- Any other writer of the round (a revision, an erasure) is caught by the optimistic write: the checklist is written only if
 -- it is still exactly what this pass read; otherwise the pass is computed again on the new state (at most three passes).
 FOR attempt IN 1..3 LOOP
 -- An archived business is read-only (opc_capture_apply's opc_assert_business_writable): nothing is written, and the turn
 -- itself still settles and keeps its reply. Checked again on every pass.
 IF business_id IS NOT NULL AND EXISTS (SELECT 1 FROM opc_businesses WHERE id = business_id AND actor_id = p_actor_id AND archived_at IS NOT NULL) THEN
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
END $function$;;

CREATE OR REPLACE FUNCTION public.turn_session_view(p_actor_id uuid, p_session_id uuid, p_after_seq integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s runtime_sessions; a turns; l turns;
BEGIN
  -- A disabled or deleted account reads nothing, as every other read (bill2_actor) and turn_open refuse it.
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_actor_id AND status = 'active' AND is_deleted::text = 'false') THEN
    RAISE EXCEPTION 'TURN_ACCOUNT_DENIED' USING ERRCODE='42501';
  END IF;
  SELECT * INTO s FROM runtime_sessions WHERE id = p_session_id AND actor_id = p_actor_id;
  IF s.id IS NULL THEN RAISE EXCEPTION 'TURN_SESSION_DENIED' USING ERRCODE='42501'; END IF;
  IF s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL THEN RAISE EXCEPTION 'TURN_SESSION_ERASED' USING ERRCODE='42501'; END IF;
  -- The conversation's whole scope is session_view_allowed, called first by Node (view.ts); a draft revoked since then is refused
  -- here, in the same snapshot as the messages.
  IF s.scope->>'kind' = 'positioning_draft' AND NOT (turn_mentor_draft_allowed(p_actor_id, (s.scope->>'draftId')::uuid)
      AND turn_mentor_source_live((s.scope->>'draftId')::uuid)) THEN
    RAISE EXCEPTION 'TURN_SESSION_DENIED' USING ERRCODE='42501';
  END IF;
  IF s.active_turn_id IS NOT NULL THEN SELECT * INTO a FROM turns WHERE actor_id = p_actor_id AND id = s.active_turn_id; END IF;
  SELECT * INTO l FROM turns WHERE session_id = p_session_id AND actor_id = p_actor_id AND state = 'closed'
    ORDER BY opened_at DESC LIMIT 1;
  RETURN jsonb_build_object(
    'activeTurn', CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object('turnId', a.id, 'kind', a.kind, 'state', a.state,
      'pauseReason', a.pause_reason, 'openedAt', a.opened_at, 'updatedAt', a.updated_at) END,
    'lastTurn', CASE WHEN l.id IS NULL THEN NULL ELSE jsonb_build_object('turnId', l.id, 'kind', l.kind, 'closeKind', l.close_kind,
      'failureCode', l.failure_code, 'settlement', l.settlement, 'chargedCredits', l.charged_credits, 'closedAt', l.closed_at) END,
    'messages', (SELECT coalesce(jsonb_agg(jsonb_build_object('seq', m.seq, 'role', m.role, 'turnId', m.turn_id, 'content', m.content)
        ORDER BY m.seq), '[]'::jsonb)
      FROM (SELECT seq, role, turn_id, content FROM session_messages
            WHERE session_id = p_session_id AND visible AND deleted_at IS NULL AND seq > greatest(coalesce(p_after_seq, 0), 0)
            ORDER BY seq LIMIT 50) m));
END $function$;;

DO $$
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public.turn_mentor_draft_allowed(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role';
  EXECUTE 'REVOKE ALL ON FUNCTION public.turn_mentor_source_live(uuid) FROM PUBLIC, anon, authenticated, service_role';
  EXECUTE 'REVOKE ALL ON FUNCTION public.mentor_source_check(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.mentor_source_check(uuid,uuid) TO service_role';
  EXECUTE 'REVOKE ALL ON FUNCTION public.mentor_skill_available(uuid,uuid,uuid,text) FROM PUBLIC, anon, authenticated, service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.mentor_skill_available(uuid,uuid,uuid,text) TO service_role';
  EXECUTE 'REVOKE ALL ON FUNCTION public.session_view_allowed(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.session_view_allowed(uuid,uuid) TO service_role';
END $$;
