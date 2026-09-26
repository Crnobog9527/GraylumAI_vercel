/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Expose only the information version already frozen in each owned execution.
-- This read metadata lets the UI distinguish an unconsumed reply from history
-- followed by a user edit. No new ledger, mutation, dispatch or private content.
BEGIN;
DO $$ BEGIN
 IF to_regprocedure('opc_query_before_mentor_basis(uuid,uuid)') IS NULL THEN
  ALTER FUNCTION opc_query(uuid,uuid) RENAME TO opc_query_before_mentor_basis;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION opc_query(p_actor_id uuid,p_draft_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE projection jsonb;turns jsonb;
BEGIN
 projection:=opc_query_before_mentor_basis(p_actor_id,p_draft_id);
 IF p_draft_id IS NULL THEN RETURN projection;END IF;
 SELECT coalesce(jsonb_agg(t.value||jsonb_build_object('informationVersion',
   e.payload->'scopeMaterial'->'content'->'work'->'steps'->(t.value->>'stepId')->'version') ORDER BY t.ord),'[]')
 INTO turns FROM jsonb_array_elements(projection->'turns') WITH ORDINALITY t(value,ord)
 LEFT JOIN runtime_executions e ON e.id=(t.value->>'executionId')::uuid
   AND e.actor_id=p_actor_id AND e.session_id=(projection->>'sessionId')::uuid;
 RETURN jsonb_set(projection,'{turns}',turns);
END $$;
REVOKE ALL ON FUNCTION opc_query_before_mentor_basis(uuid,uuid),opc_query(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION opc_query(uuid,uuid) TO service_role;
COMMIT;
