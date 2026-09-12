/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
BEGIN;
CREATE OR REPLACE FUNCTION public.agent_slice_selected_source(p_actor_id uuid,p_execution_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE context jsonb;selection jsonb;report jsonb;sections jsonb;
BEGIN
 context:=agent_slice_context(p_actor_id,p_execution_id);
 IF EXISTS(SELECT 1 FROM agent_slice_links WHERE round_id=(context->>'roundId')::uuid) THEN
  selection:=agent_slice_link_read(p_actor_id,(context->>'projectId')::uuid,(context->>'roundId')::uuid);
  SELECT v.report INTO report FROM artifact_versions v WHERE id=(selection->>'versionId')::uuid AND report_hash=selection->>'hash';
  SELECT jsonb_agg(jsonb_build_object('title',s->>'title','body',s->>'body') ORDER BY n) INTO sections
   FROM jsonb_array_elements(report->'sections') WITH ORDINALITY t(s,n) WHERE selection->'sections' ? (s->>'stepId');
 ELSE
  selection:=artifact_work_source(p_actor_id,(context->>'projectId')::uuid,(context->>'roundId')::uuid);
  SELECT jsonb_agg(jsonb_build_object('title',s->>'title','body',s->>'body') ORDER BY n) INTO sections FROM jsonb_array_elements(selection->'sections') WITH ORDINALITY t(s,n);
 END IF;
 IF sections IS NULL OR jsonb_array_length(sections)=0 OR (SELECT sum(char_length(s->>'body')) FROM jsonb_array_elements(sections) s)>coalesce((selection->>'maxChars')::integer,20000) THEN RAISE EXCEPTION 'slice source unavailable'; END IF;
 RETURN jsonb_build_object('kind','formal_report','version',(selection->>'version')::integer,'sections',sections);
END $$;
REVOKE ALL ON FUNCTION public.agent_slice_selected_source(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.agent_slice_selected_source(uuid,uuid) TO service_role;
COMMIT;
