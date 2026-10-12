/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Owner 2026-10-12: after a revision, the earlier version's report stays viewable and exportable.
-- Number allocated by the controller.
--
-- Cause: 0174 (#667) made runtime_context_allowed re-run report_source on every read of a report
-- execution. report_source requires the round to be the draft's current round, which is right for
-- generating and billing a report but not for reading one. Since 0206 (#783) a finalized version's
-- evidence links to its report execution, so once a new round opens (manual revision or R14 sync)
-- that execution reads as unavailable and the earlier version reads as unreadable.
--
-- Reads of a report whose round is already published accept any round of the same draft; every other
-- check stays: actor, session and scope, the draft owning the session, the round's formal version not
-- erased. Admission (report_admission_check) and billing claims call report_source directly and keep
-- requiring the current round. Deletion, account erasure and source withdrawal still make it unreadable
-- through the existing execution, evidence and version checks, which this does not touch.
BEGIN;
CREATE OR REPLACE FUNCTION public.report_source_for_read(p_actor_id uuid,p_session_id uuid,p_project_id uuid,p_round_id uuid)
RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE s runtime_sessions;
BEGIN
 IF EXISTS(SELECT 1 FROM artifact_rounds r JOIN artifact_versions v ON v.round_id=r.id
   WHERE r.id=p_round_id AND r.project_id=p_project_id AND r.state='published' AND r.erased_at IS NULL AND v.erased_at IS NULL) THEN
  PERFORM bill2_actor(p_actor_id);
  SELECT * INTO s FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id;
  IF s.id IS NULL OR NOT bill2_scope_allowed(p_actor_id,s.scope)
   OR NOT EXISTS(SELECT 1 FROM opc_drafts WHERE actor_id=p_actor_id AND session_id=s.id AND project_id=p_project_id) THEN
   RAISE EXCEPTION 'REPORT_SOURCE_CONFLICT'; END IF;
  RETURN;
 END IF;
 PERFORM report_source(p_actor_id,p_session_id,p_project_id,p_round_id);
END $$;
REVOKE ALL ON FUNCTION public.report_source_for_read(uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

DO $$ DECLARE definition text;needle text;
BEGIN
 definition:=pg_get_functiondef('public.runtime_context_allowed(uuid,jsonb)'::regprocedure);
 IF position('report_source_for_read(' IN definition)=0 THEN
  needle:='PERFORM report_source(p_actor_id,(p_context#>>''{request,sessionId}'')::uuid,';
  IF position(needle IN definition)=0 THEN RAISE EXCEPTION 'REPORT_READ_TARGET_MISMATCH'; END IF;
  EXECUTE replace(definition,needle,'PERFORM report_source_for_read(p_actor_id,(p_context#>>''{request,sessionId}'')::uuid,');
 END IF;
END $$;
COMMIT;
