-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- DB-PERF PR-5a: a conversation refresh (runtime.view) in one round trip instead of two. It calls the existing
-- runtime_view and runtime_work_items, so their rules stay theirs: runtime_view raises exactly as before (another
-- actor's, missing or out-of-scope session, erased content), and the work rows stay decorative -- any error of
-- runtime_work_items returns no rows and never fails the view, as the host's separate call did. Read only; nothing is
-- cached. Number 0359 assigned by control. Repeatable: CREATE OR REPLACE.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.runtime_view_with_work_items(p_actor_id uuid,p_session_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v jsonb; w jsonb;
BEGIN
 v:=runtime_view(p_actor_id,p_session_id);
 BEGIN
  w:=runtime_work_items(p_actor_id,p_session_id);
 EXCEPTION WHEN OTHERS THEN
  w:='{}'::jsonb;
 END;
 RETURN jsonb_build_object('view',v,'workItems',coalesce(w,'{}'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.runtime_view_with_work_items(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.runtime_view_with_work_items(uuid,uuid) TO service_role;
COMMIT;
