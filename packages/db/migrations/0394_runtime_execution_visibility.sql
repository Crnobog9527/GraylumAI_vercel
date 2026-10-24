-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- DB-PERF PR-2A: the stream display fence in one round trip. Before anything of a running execution is shown, the
-- host checks content erasure (D7, content_erasure_visible) and, when the execution froze them, its voice version (0345)
-- and library references (0277, #1022). This function runs exactly those three checks, in the same order, by calling
-- the existing functions, so the rules stay theirs: a content erasure raises as before; otherwise the first gone source
-- is reported ('voice' before 'library', the order the host checked them), else 'visible'. Every call still reads the
-- current state; nothing is cached. Read only, like the functions it calls. Number provisional until control assigns it.
-- Repeatable: CREATE OR REPLACE.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.runtime_execution_visibility(p_actor_id uuid,p_execution_id uuid,
 p_voice boolean,p_library boolean)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM content_erasure_visible(p_actor_id,p_execution_id);
 IF p_voice AND EXISTS(SELECT 1 FROM runtime_voice_sources_gone(p_actor_id,ARRAY[p_execution_id])) THEN
  RETURN 'voice';
 END IF;
 IF p_library AND EXISTS(SELECT 1 FROM runtime_library_sources_gone(p_actor_id,ARRAY[p_execution_id])) THEN
  RETURN 'library';
 END IF;
 RETURN 'visible';
END $$;
REVOKE ALL ON FUNCTION public.runtime_execution_visibility(uuid,uuid,boolean,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.runtime_execution_visibility(uuid,uuid,boolean,boolean) TO service_role;
COMMIT;
