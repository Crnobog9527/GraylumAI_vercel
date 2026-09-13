/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
BEGIN;
-- Freeze only identities of already saved replies, never a second copy of text.
-- Discussion stays within this work/round; cross-work handoff uses the fixed report.
ALTER TABLE public.agent_slice_executions ADD COLUMN IF NOT EXISTS discussion_refs jsonb NOT NULL DEFAULT '[]';
CREATE OR REPLACE FUNCTION public.agent_slice_freeze_discussion() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE previous record; refs jsonb:='[]'; used integer:=0;
BEGIN
 FOR previous IN
  SELECT e.request_id,c.id,c.body,q.payload->>'body' input_body
  FROM agent_slice_executions e
  JOIN artifact_requests q ON q.project_id=e.project_id AND q.request_id=e.request_id AND q.action='slice_input'
  JOIN artifact_requests result ON result.project_id=e.project_id AND result.action='candidate'
   AND result.payload->>'sliceExecution'=e.request_id::text AND result.payload->>'slicePhase'='reply'
  JOIN artifact_candidates c ON c.id=(result.response->>'candidateId')::uuid AND c.round_id=e.round_id
  WHERE e.conversation_id=NEW.conversation_id AND e.project_id=NEW.project_id AND e.round_id=NEW.round_id
   AND e.preference_refs=NEW.preference_refs AND e.evidence_ids <@ NEW.evidence_ids AND c.evidence_ids <@ NEW.evidence_ids
   AND artifact_evidence_allowed(NEW.project_id,c.evidence_ids)
  ORDER BY e.created_at DESC,e.request_id DESC LIMIT 8
 LOOP
  IF previous.body IS NULL OR previous.input_body IS NULL THEN RAISE EXCEPTION 'slice discussion unavailable'; END IF;
  IF used+char_length(previous.body)+char_length(previous.input_body)>64000 THEN EXIT; END IF;
  used:=used+char_length(previous.body)+char_length(previous.input_body);
  refs:=jsonb_build_array(jsonb_build_object('executionId',previous.request_id,'candidateId',previous.id))||refs;
 END LOOP;
 NEW.discussion_refs:=refs;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.agent_slice_freeze_discussion() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS agent_slice_freeze_discussion ON public.agent_slice_executions;
CREATE TRIGGER agent_slice_freeze_discussion BEFORE INSERT ON public.agent_slice_executions FOR EACH ROW EXECUTE FUNCTION public.agent_slice_freeze_discussion();
DO $$ BEGIN
 IF to_regprocedure('public.agent_slice_context_before_discussion(uuid,uuid)') IS NULL THEN
  ALTER FUNCTION public.agent_slice_context(uuid,uuid) RENAME TO agent_slice_context_before_discussion;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION public.agent_slice_context(p_actor_id uuid,p_execution_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE value jsonb;e agent_slice_executions%ROWTYPE;previous agent_slice_executions%ROWTYPE;ref jsonb;c artifact_candidates%ROWTYPE;input_body text;discussion jsonb:='[]';
BEGIN
 value:=agent_slice_context_before_discussion(p_actor_id,p_execution_id);
 SELECT * INTO e FROM agent_slice_executions WHERE request_id=p_execution_id;
 FOR ref IN SELECT * FROM jsonb_array_elements(e.discussion_refs) LOOP
  SELECT * INTO previous FROM agent_slice_executions WHERE request_id=(ref->>'executionId')::uuid
   AND conversation_id=e.conversation_id AND project_id=e.project_id AND round_id=e.round_id;
  SELECT * INTO c FROM artifact_candidates WHERE id=(ref->>'candidateId')::uuid AND round_id=e.round_id;
  IF previous.request_id IS NULL OR c.id IS NULL OR c.body IS NULL OR NOT(c.evidence_ids <@ e.evidence_ids)
   OR NOT artifact_evidence_allowed(e.project_id,c.evidence_ids) THEN RAISE EXCEPTION 'slice discussion unavailable'; END IF;
  SELECT payload->>'body' INTO input_body FROM artifact_requests WHERE project_id=e.project_id AND request_id=previous.request_id AND action='slice_input';
  IF input_body IS NULL THEN RAISE EXCEPTION 'slice discussion unavailable'; END IF;
  discussion:=discussion||jsonb_build_array(jsonb_build_object('user',input_body,'assistant',c.body));
 END LOOP;
 RETURN value||jsonb_build_object('discussion',discussion);
END $$;
REVOKE ALL ON FUNCTION public.agent_slice_context_before_discussion(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.agent_slice_context(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.agent_slice_context(uuid,uuid) TO service_role;
COMMIT;
