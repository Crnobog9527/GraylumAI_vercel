-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Reverts 0200_opc_suggestion_withdraw. Requires separate authorization remotely.
-- Remove the API withdraw/dismiss callers first. Pending suggestions, values, versions and history are untouched.
-- Withdrawn suggestion records are derived, user-dismissible text; the old opc_query would return them
-- without the history-availability filter, so they are discarded here.
-- Only definitions carrying the 0200 marker are reverted; drift or an already reverted state is rejected.
BEGIN;
DO $$
DECLARE marker text:='-- v3 suggestion withdraw';
 entry record; source text; i integer;
BEGIN
 FOR entry IN SELECT * FROM (VALUES
  ('public.opc_capture_apply(uuid,uuid,uuid)',ARRAY[
   $r$protected boolean;material_changed boolean;seq jsonb;suggestion jsonb;remaining integer;patch_index integer:=0;
 withdrawal jsonb;withdrawn jsonb:='{}';withdraw_index integer:=0;withdraw_reason text;organizer_input jsonb;$r$,
   $r$  ELSIF jsonb_array_length(output->'patches')>12 THEN code:='invalid_output';
  ELSIF output ? 'withdrawals' AND jsonb_typeof(output->'withdrawals') IS DISTINCT FROM 'array' THEN code:='invalid_output';
  ELSIF jsonb_array_length(coalesce(output->'withdrawals','[]'))>12 THEN code:='invalid_output';END IF;$r$,
   $r$    THEN meta:=(meta-'withdrawnSuggestion')||jsonb_build_object('suggestion',suggestion);END IF;$r$,
   $r$  -- v3 suggestion withdraw: a real user turn may clear a pending suggestion older than this turn.
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
   -- Bind to the text the organizer was shown: a suggestion replaced after its input was frozen stays.
   ELSIF meta#>>'{suggestion,value}' IS DISTINCT FROM (SELECT fld#>>'{pendingSuggestion,value}'
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(organizer_input->'checklist')='array' THEN organizer_input->'checklist' ELSE '[]' END) stp,
     jsonb_array_elements(CASE WHEN jsonb_typeof(stp->'fields')='array' THEN stp->'fields' ELSE '[]' END) fld
    WHERE stp->>'id'=step_id AND fld->>'id'=field_id LIMIT 1) THEN withdraw_reason:='not_shown';
   ELSIF ((meta#>>'{suggestion,seq,0}')::timestamptz,(meta#>>'{suggestion,seq,1}')::uuid) >= (e.created_at,e.id)
    THEN withdraw_reason:='superseded';
   ELSE withdraw_reason:=NULL;END IF;
   IF withdraw_reason IS NOT NULL THEN
    discarded:=discarded||jsonb_build_array(jsonb_build_object('withdrawal',withdraw_index,'reason',withdraw_reason));CONTINUE;END IF;
   meta:=(meta-'suggestion')||jsonb_build_object('withdrawnSuggestion',(meta->'suggestion')||jsonb_build_object('withdrawnBy',e.id));
   r.steps:=jsonb_set(r.steps,ARRAY[step_id,'fieldMeta',field_id],meta);
   withdrawn:=jsonb_set(withdrawn,ARRAY[step_id],coalesce(withdrawn->step_id,'[]')||to_jsonb(field_id));
  END LOOP;
  FOR step_id IN SELECT jsonb_object_keys(changed) LOOP$r$,
   $r$ response:=jsonb_build_object('executionId',e.id,'result',code,'ruleVersion',1,'versions',versions,'fields',fields,'discarded',discarded);
 response:=response||CASE WHEN withdrawn='{}' THEN '{}'::jsonb ELSE jsonb_build_object('withdrawn',withdrawn) END;$r$],ARRAY[
   $n$protected boolean;material_changed boolean;seq jsonb;suggestion jsonb;remaining integer;patch_index integer:=0;$n$,
   $n$  ELSIF jsonb_array_length(output->'patches')>12 THEN code:='invalid_output';END IF;$n$,
   $n$    THEN meta:=meta||jsonb_build_object('suggestion',suggestion);END IF;$n$,
   $n$  FOR step_id IN SELECT jsonb_object_keys(changed) LOOP$n$,
   $n$ response:=jsonb_build_object('executionId',e.id,'result',code,'ruleVersion',1,'versions',versions,'fields',fields,'discarded',discarded);$n$]),
  ('public.opc_capture_resolve(uuid,uuid,uuid,text,text,uuid,text,text,integer)',ARRAY[
   $r$st:=r.steps->p_step_id;meta:=st->'fieldMeta'->p_field_id;
 -- v3 suggestion withdraw: dismiss binds to the withdrawn record; accept/ignore to the pending one.
 suggestion:=CASE WHEN p_action='dismiss' THEN meta->'withdrawnSuggestion' ELSE meta->'suggestion' END;$r$,
   $r$p_action NOT IN ('accept','ignore','dismiss')$r$,
   $r$ ELSIF p_action='dismiss' THEN meta:=meta-'withdrawnSuggestion';
 ELSE meta:=meta-'suggestion';END IF;$r$],ARRAY[
   $n$st:=r.steps->p_step_id;meta:=st->'fieldMeta'->p_field_id;suggestion:=meta->'suggestion';$n$,
   $n$p_action NOT IN ('accept','ignore')$n$,
   $n$ ELSE meta:=meta-'suggestion';END IF;$n$]),
  ('public.opc_query(uuid,uuid)',ARRAY[
   $r$     WHERE e.id::text IN (m.value#>>'{suggestion,executionId}',m.value#>>'{withdrawnSuggestion,executionId}'));$r$,
   $r$    THEN meta:=meta-'suggestion';END IF;
    -- v3 suggestion withdraw: hide a withdrawn record whose source conversation is unavailable.
    IF meta ? 'withdrawnSuggestion' AND NOT coalesce((meta#>>'{withdrawnSuggestion,executionId}')=ANY(available_ids::text[]),false)
    THEN meta:=meta-'withdrawnSuggestion';END IF;$r$],ARRAY[
   $n$     WHERE m.value#>>'{suggestion,executionId}'=e.id::text);$n$,
   $n$    THEN meta:=meta-'suggestion';END IF;$n$])
 ) v(sig,patched,original) LOOP
  source:=pg_get_functiondef(entry.sig::regprocedure);
  IF position(marker IN source)=0 THEN RAISE EXCEPTION 'OPC_WITHDRAW_ROLLBACK_SOURCE_MISMATCH: %',entry.sig;END IF;
  FOR i IN 1..array_length(entry.patched,1) LOOP
   IF length(source)-length(replace(source,entry.patched[i],''))<>length(entry.patched[i])
   THEN RAISE EXCEPTION 'OPC_WITHDRAW_ROLLBACK_SOURCE_MISMATCH: % %',entry.sig,i;END IF;
   source:=replace(source,entry.patched[i],entry.original[i]);
  END LOOP;
  IF position(marker IN source)>0 THEN RAISE EXCEPTION 'OPC_WITHDRAW_ROLLBACK_SOURCE_MISMATCH: %',entry.sig;END IF;
  EXECUTE source;
 END LOOP;
END $$;
UPDATE artifact_rounds r SET steps=(SELECT jsonb_object_agg(s.key,CASE WHEN jsonb_typeof(s.value->'fieldMeta')='object'
  THEN jsonb_set(s.value,'{fieldMeta}',(SELECT coalesce(jsonb_object_agg(m.key,CASE WHEN jsonb_typeof(m.value)='object'
   THEN m.value-'withdrawnSuggestion' ELSE m.value END),'{}') FROM jsonb_each(s.value->'fieldMeta') m)) ELSE s.value END)
  FROM jsonb_each(r.steps) s)
 WHERE jsonb_typeof(r.steps)='object' AND EXISTS(SELECT 1 FROM jsonb_each(r.steps) s,
  jsonb_each(CASE WHEN jsonb_typeof(s.value->'fieldMeta')='object' THEN s.value->'fieldMeta' ELSE '{}' END) m
  WHERE jsonb_typeof(m.value)='object' AND m.value ? 'withdrawnSuggestion');
COMMIT;
