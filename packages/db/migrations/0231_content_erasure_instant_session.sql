-- DATA-ERASURE: deleting a whole conversation is one small synchronous step (Owner 2026-10-13).
-- The step sets the existing irreversible session marker under a lock on that one session only;
-- when a copy of the conversation lives elsewhere it also runs the full cleanup in the same request.
-- Every existing reader, writer and money path already refuses a marked session
-- (content_erasure_runtime_check, content_erasure_parent_guard, runtime_execution,
-- runtime_view, opc_free_conversations). Physical cleanup is the unchanged
-- content_erasure_confirm, run afterwards on its "already deleted" path (no preview hash):
-- by the client right after the step, and by the existing account-erasure cron as backstop.
-- No new queue, table or engine.

CREATE INDEX IF NOT EXISTS runtime_sessions_content_cleanup_pending_idx
 ON public.runtime_sessions(content_deleted_at) WHERE content_deleted_at IS NOT NULL AND erased_at IS NULL;

CREATE OR REPLACE FUNCTION public.content_erasure_mark_session(a uuid,target uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s runtime_sessions; deleted boolean; scope jsonb; ids uuid[]; refs uuid[]; local boolean;
BEGIN
 PERFORM bill2_actor(a);
 -- Same order as content_erasure_confirm (profile, then session). A short wait instead of
 -- NOWAIT lets a reply commit that holds this session for a moment finish first.
 PERFORM set_config('lock_timeout','2000',true);
 PERFORM id FROM profiles WHERE id=a FOR SHARE;
 PERFORM bill2_actor(a);
 SELECT * INTO s FROM runtime_sessions WHERE id=target AND actor_id=a FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND' USING ERRCODE='42501'; END IF;
 deleted:=s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL;
 IF deleted THEN
  RETURN jsonb_build_object('kind','session','id',target,'status','deleted','alreadyDeleted',true,
   'preservedSavedVersions',0,'financialReviewCount',0);
 END IF;
 -- Read-only scope (no account-wide locks). The marker alone is enough only when nothing outside
 -- this conversation holds a copy: a free conversation (no draft or topic binding), every scoped
 -- execution in it, no saved content, work, data event, result link, captured field, library
 -- request or other conversation's frozen material referencing it. Anything else, or any doubt,
 -- runs the full cleanup now so no derived copy stays readable after this call returns.
 scope:=content_erasure_scope(a,'session',target);
 SELECT coalesce(array_agg(v::uuid),'{}') INTO ids FROM jsonb_array_elements_text(scope->'executions') v;
 refs:=ids||target;
 local:=NOT EXISTS(SELECT 1 FROM opc_drafts d WHERE d.session_id=target)
  AND NOT EXISTS(SELECT 1 FROM opc_topic_workspaces t WHERE t.session_id=target)
  AND NOT EXISTS(SELECT 1 FROM runtime_executions e WHERE e.id=ANY(ids) AND e.session_id<>target)
  AND jsonb_array_length(scope->'projects')=0 AND jsonb_array_length(scope->'versions')=0
  AND jsonb_array_length(scope->'contents')=0 AND jsonb_array_length(scope->'affectedSources')=0
  AND NOT EXISTS(SELECT 1 FROM opc_content_versions c WHERE c.actor_id=a AND c.execution_id=ANY(ids))
  AND NOT EXISTS(SELECT 1 FROM opc_data_events d WHERE d.actor_id=a AND d.execution_id=ANY(ids))
  AND NOT EXISTS(SELECT 1 FROM opc_result_links l WHERE l.execution_id=ANY(ids))
  AND NOT EXISTS(SELECT 1 FROM artifact_rounds r JOIN artifact_projects p ON p.id=r.project_id
   WHERE p.actor_id=a AND r.erased_at IS NULL AND content_erasure_references(r.steps,refs))
  AND NOT EXISTS(SELECT 1 FROM opc_library_requests q WHERE q.actor_id=a AND q.erased_at IS NULL
   AND (content_erasure_references(q.payload,refs) OR content_erasure_references(q.result,refs)))
  AND NOT EXISTS(SELECT 1 FROM runtime_scope_material m JOIN runtime_sessions o ON o.id=m.session_id
   WHERE o.actor_id=a AND m.session_id<>target AND m.erased_at IS NULL
    AND (content_erasure_references(m.request,refs) OR content_erasure_references(m.content,refs)));
 UPDATE runtime_sessions SET content_deleted_at=clock_timestamp() WHERE id=target;
 IF NOT local THEN
  -- Same transaction: the marked-session cleanup locks only rows in scope. If it is busy the
  -- marker rolls back with it and the caller reports the conversation as not deleted.
  RETURN content_erasure_confirm(a,'session',target,NULL)||jsonb_build_object('alreadyDeleted',false);
 END IF;
 -- Content is unreadable from here on. Money facts stay on their original runs; the
 -- background cleanup reports any financial review.
 RETURN jsonb_build_object('kind','session','id',target,'status','deleted','alreadyDeleted',false,
  'preservedSavedVersions',0,'financialReviewCount',0);
EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
 RAISE EXCEPTION 'CONTENT_ERASURE_BUSY' USING ERRCODE='55P03';
END $$;
REVOKE ALL ON FUNCTION public.content_erasure_mark_session(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.content_erasure_mark_session(uuid,uuid) TO service_role;

-- Cleanup of a marked session no longer locks every session and project of the account.
-- Its own writers are already refused, so it locks the sessions its scope touches, then
-- recomputes the scope under those locks; a scope that reaches an unlocked session or any
-- project is busy (retried later), never partially cleaned. ids/sessions/rounds are only
-- scratch here; the original body reassigns them from the final scope.
-- Every other deletion keeps the account-wide locks.
DO $$ DECLARE definition text; needle text;
BEGIN
 definition:=pg_get_functiondef('public.content_erasure_confirm(uuid,text,uuid,text)'::regprocedure);
 IF position('-- 0231 marked session locks' IN definition)=0 THEN
  needle:=E' PERFORM id FROM runtime_sessions WHERE actor_id=a ORDER BY id FOR UPDATE NOWAIT;\n'
   ' PERFORM id FROM artifact_projects WHERE actor_id=a ORDER BY id FOR UPDATE NOWAIT;\n'
   ' scope:=content_erasure_scope(a,k,target);\n';
  IF (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 THEN
   RAISE EXCEPTION 'CONTENT_ERASURE_SOURCE_MISMATCH: content_erasure_confirm'; END IF;
  EXECUTE replace(definition,needle,
   E' -- 0231 marked session locks\n'
   ' IF k=''session'' AND EXISTS(SELECT 1 FROM runtime_sessions WHERE id=target AND actor_id=a AND content_deleted_at IS NOT NULL) THEN\n'
   '  scope:=content_erasure_scope(a,k,target);\n'
   '  SELECT coalesce(array_agg(v::uuid),''{}'') INTO ids FROM jsonb_array_elements_text(scope->''executions'') v;\n'
   '  SELECT coalesce(array_agg(v::uuid),''{}'') INTO sessions FROM jsonb_array_elements_text(scope->''sessions'') v;\n'
   '  rounds:=ARRAY(SELECT DISTINCT s0.id FROM runtime_sessions s0 WHERE s0.actor_id=a\n'
   '   AND (s0.id=ANY(sessions) OR s0.id IN (SELECT e0.session_id FROM runtime_executions e0 WHERE e0.id=ANY(ids))) ORDER BY s0.id);\n'
   '  PERFORM id FROM runtime_sessions WHERE id=ANY(rounds) ORDER BY id FOR UPDATE NOWAIT;\n'
   '  scope:=content_erasure_scope(a,k,target);\n'
   '  SELECT coalesce(array_agg(v::uuid),''{}'') INTO ids FROM jsonb_array_elements_text(scope->''executions'') v;\n'
   '  SELECT coalesce(array_agg(v::uuid),''{}'') INTO sessions FROM jsonb_array_elements_text(scope->''sessions'') v;\n'
   '  IF NOT sessions<@rounds OR jsonb_array_length(scope->''projects'')>0\n'
   '   OR EXISTS(SELECT 1 FROM runtime_executions e0 WHERE e0.id=ANY(ids) AND NOT e0.session_id=ANY(rounds)) THEN\n'
   '   RAISE EXCEPTION ''CONTENT_ERASURE_BUSY'' USING ERRCODE=''55P03'';\n'
   '  END IF;\n'
   ' ELSE\n'
   '  PERFORM id FROM runtime_sessions WHERE actor_id=a ORDER BY id FOR UPDATE NOWAIT;\n'
   '  PERFORM id FROM artifact_projects WHERE actor_id=a ORDER BY id FOR UPDATE NOWAIT;\n'
   '  scope:=content_erasure_scope(a,k,target);\n'
   ' END IF;\n');
 END IF;
END $$;
REVOKE ALL ON FUNCTION public.content_erasure_confirm(uuid,text,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.content_erasure_confirm(uuid,text,uuid,text) TO service_role;

-- Backstop for the cleanup the client starts: oldest marked sessions first, one page per call
-- after the caller's cursor, one subtransaction each. Only lock contention is "pending" (the
-- caller retries it in the same run); any other failure is counted as failed so the run reports it. Closed accounts
-- are cleaned by account erasure instead.
CREATE OR REPLACE FUNCTION public.content_erasure_sweep_sessions(lim integer,after_at timestamptz,after_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE row record; cleaned integer:=0; pending integer:=0; failed integer:=0; seen integer:=0;
 last_at timestamptz:=after_at; last_id uuid:=after_id;
BEGIN
 IF lim IS NULL OR lim<1 OR lim>200 THEN RAISE EXCEPTION 'CONTENT_ERASURE_SWEEP_LIMIT' USING ERRCODE='22023'; END IF;
 IF (after_at IS NULL)<>(after_id IS NULL) THEN RAISE EXCEPTION 'CONTENT_ERASURE_SWEEP_CURSOR' USING ERRCODE='22023'; END IF;
 FOR row IN SELECT s.id,s.actor_id,s.content_deleted_at FROM runtime_sessions s
  WHERE s.content_deleted_at IS NOT NULL AND s.erased_at IS NULL
   AND (after_at IS NULL OR (s.content_deleted_at,s.id)>(after_at,after_id))
   AND NOT EXISTS(SELECT 1 FROM account_erasure_requests r WHERE r.profile_id=s.actor_id)
  ORDER BY s.content_deleted_at,s.id LIMIT lim LOOP
  seen:=seen+1; last_at:=row.content_deleted_at; last_id:=row.id;
  BEGIN
   PERFORM content_erasure_confirm(row.actor_id,'session',row.id,NULL);
   cleaned:=cleaned+1;
  EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
   pending:=pending+1;
  WHEN OTHERS THEN
   failed:=failed+1;
  END;
 END LOOP;
 RETURN jsonb_build_object('cleaned',cleaned,'pending',pending,'failed',failed,'more',seen=lim,
  'afterAt',last_at,'afterId',last_id);
END $$;
REVOKE ALL ON FUNCTION public.content_erasure_sweep_sessions(integer,timestamptz,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.content_erasure_sweep_sessions(integer,timestamptz,uuid) TO service_role;
