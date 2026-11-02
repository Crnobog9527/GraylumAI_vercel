-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-10b (number 0452 = staging's highest + 1): a claimed video package that never opened its turn no longer holds the session.
-- opc_work_check refused every other request (OPC_CONTENT_BINDING) while a claim had no execution or turn: the old path's rule, because
-- an execution froze the material and the claimed one had to be first. A turn only reads it (policy.workMaterial) and nothing is used up,
-- so the rule protected nothing here and a claim whose turn failed to open (staging, 2026-11-01: the session's guide and chat) wedged
-- the conversation for good, also from another browser. The request that made the claim still reads its own revision.
-- Compatible: only the refusal goes; a request after a claim reads the newest material, as one without a claim does. Repeatable:
-- CREATE OR REPLACE. Recovery: re-apply 0450's opc_work_check. No data is written.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.opc_work_check(p_actor_id uuid, p_session_id uuid, p_video_required boolean, p_request_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s runtime_sessions;item uuid;work jsonb;m runtime_scope_material;binding opc_video_material_bindings;
BEGIN
 SELECT * INTO s FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id;
 IF s.id IS NULL OR s.scope->>'kind' IS DISTINCT FROM 'work_item' THEN RETURN jsonb_build_object('work',NULL); END IF; -- turn_open refuses another account's conversation
 -- By read only: opc_assert_business_writable takes a row lock, which the read client refuses.
 IF EXISTS(SELECT 1 FROM opc_businesses b WHERE b.id=opc_target_business(p_actor_id,jsonb_build_object('sessionId',p_session_id))
   AND b.actor_id=p_actor_id AND b.archived_at IS NOT NULL) THEN
  RAISE EXCEPTION 'OPC_BUSINESS_ARCHIVED' USING ERRCODE='42501';
 END IF;
 item:=(s.scope->>'workItemId')::uuid;
 IF p_video_required AND opc_item_content_type(item)<>'video' THEN RAISE EXCEPTION 'OPC_VIDEO_TYPE_REQUIRED'; END IF;
 -- The work method is the Skill revision of the round the item came from (opc_query's methodRevisionId), never the module's latest.
 SELECT jsonb_build_object('moduleId',p.module_id,'skillId',p.skill_id,'revisionId',r.revision_id) INTO work
  FROM artifact_projects p JOIN opc_items i ON i.work_item_id=p.id JOIN artifact_versions v ON v.id=i.source_version_id
  JOIN artifact_rounds r ON r.id=v.round_id WHERE p.id=item AND p.actor_id=p_actor_id;
 -- A request that claimed video material (opc_video_material_prepare) reads exactly that revision.
 IF p_request_id IS NOT NULL THEN
  SELECT * INTO binding FROM opc_video_material_bindings WHERE actor_id=p_actor_id AND request_id=p_request_id;
 END IF;
 IF binding.request_id IS NOT NULL THEN
  SELECT * INTO m FROM runtime_scope_material WHERE session_id=binding.session_id AND revision=binding.material_revision;
  IF binding.session_id<>s.id OR binding.work_item_id<>item OR m.session_id IS NULL OR m.revoked OR m.erased_at IS NOT NULL THEN
   RAISE EXCEPTION 'OPC_CONTENT_BINDING' USING ERRCODE='42501';
  END IF;
 ELSE
  -- The brief and material the old path froze for the next turn: the newest of this conversation not revoked. A claimed revision that
  -- has not opened its turn does not hold other requests back: a turn reads the material and does not use it up.
  SELECT * INTO m FROM runtime_scope_material
   WHERE session_id=s.id AND NOT revoked AND erased_at IS NULL ORDER BY revision DESC LIMIT 1;
 END IF;
 RETURN jsonb_build_object('work',work||jsonb_build_object('brief',m.content->'brief','material',m.content->'material',
  'videoPackage',binding.request_id IS NOT NULL,'materialRevision',m.revision,'materialHash',m.content_hash));
END $function$;

REVOKE ALL ON FUNCTION public.opc_work_check(uuid,uuid,boolean,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.opc_work_check(uuid,uuid,boolean,uuid) TO service_role;
COMMIT;
