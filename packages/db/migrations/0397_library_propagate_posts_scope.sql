/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- DB-PERF PR-7a (placeholder number; the controller assigns the final one). runtime_library_propagate runs on every
-- library list (library.list sweep), upload, deletion and erasure. 0306 added two own-post cleanup loops that call
-- runtime_workspace_posts_history_erased(ex.id), a recursive history check, for every execution of the actor (every
-- execution when called without an actor): staging measured about 136 000 buffer pages and 1.4 s for a full call while
-- no own-post execution existed at all.
-- That check can only be true for an execution whose history (itself plus its runtime_history_dependencies, followed
-- transitively) holds an execution with a my_posts tool result or an ownPosts payload: both of its branches require one.
-- So both loops now first restrict to exactly those executions (posts_scope): the own-post executions, found through two
-- partial indexes, and every execution depending on them, found through a new reverse dependency index. Dependencies are
-- followed for every actor, so nothing an actor filter could miss is dropped. Every condition, lock and update inside the
-- loops is unchanged, and the check itself still decides each execution.
-- Repeatable: the indexes use IF NOT EXISTS and the patch is skipped when its marker is present.
-- Rollback: drop the three indexes, reset the check's COST to 100 and recreate the function from its definition
-- before this migration (0306's patch); no data changes.
BEGIN;
CREATE INDEX IF NOT EXISTS runtime_tool_calls_my_posts ON public.runtime_tool_calls(execution_id)
 WHERE result->>'kind'='my_posts';
CREATE INDEX IF NOT EXISTS runtime_executions_own_posts ON public.runtime_executions(id)
 WHERE payload->>'ownPosts'='true';
CREATE INDEX IF NOT EXISTS runtime_history_dependencies_dependency
 ON public.runtime_history_dependencies(dependency_id,execution_id);
-- The check is far more expensive than any other condition next to it: tell the planner, so it evaluates the cheap
-- conditions first (with the default cost of 100 a scoped plan could call it before them). Planning only; same results.
ALTER FUNCTION public.runtime_workspace_posts_history_erased(uuid) COST 10000;

DO $patch$ DECLARE d text;declare_anchor text;scope_anchor text;first_loop text;second_loop text;
BEGIN
 d:=pg_get_functiondef('public.runtime_library_propagate(uuid,integer)'::regprocedure);
 IF position('-- DB-PERF PR-7a own-post scope' IN d)=0 THEN
  declare_anchor:=$a$ done integer:=0; waiting integer:=0;$a$;
  scope_anchor:=$a$ -- B2 pending own-post receipts:$a$;
  first_loop:=$a$  WHERE (p_actor_id IS NULL OR ex.actor_id=p_actor_id) AND runtime_workspace_posts_history_erased(ex.id)$a$;
  second_loop:=$a$  WHERE br.content_deleted_at IS NOT NULL AND br.closed AND runtime_workspace_posts_history_erased(ex.id)$a$;
  IF array_length(string_to_array(d,declare_anchor),1)<>2 OR array_length(string_to_array(d,scope_anchor),1)<>2
   OR array_length(string_to_array(d,first_loop),1)<>2 OR array_length(string_to_array(d,second_loop),1)<>2
  THEN RAISE EXCEPTION 'DB_PERF_LIBRARY_PROPAGATE_MISMATCH'; END IF;
  d:=replace(d,declare_anchor,declare_anchor||' posts_scope uuid[];');
  d:=replace(d,scope_anchor,$s$ -- DB-PERF PR-7a own-post scope: the only executions runtime_workspace_posts_history_erased can be
 -- true for. Own-post executions (two partial indexes), then every execution depending on them (reverse index).
 posts_scope:=ARRAY(WITH RECURSIVE reach(id) AS (
   SELECT t.execution_id FROM runtime_tool_calls t WHERE t.result->>'kind'='my_posts'
   UNION SELECT ex.id FROM runtime_executions ex WHERE ex.payload->>'ownPosts'='true'
   UNION SELECT dep.execution_id FROM runtime_history_dependencies dep JOIN reach r ON dep.dependency_id=r.id
  ) SELECT id FROM reach);
$s$||scope_anchor);
  d:=replace(d,first_loop,$r$  WHERE ex.id=ANY(posts_scope) AND (p_actor_id IS NULL OR ex.actor_id=p_actor_id)
   AND runtime_workspace_posts_history_erased(ex.id)$r$);
  d:=replace(d,second_loop,$r$  WHERE ex.id=ANY(posts_scope) AND br.content_deleted_at IS NOT NULL AND br.closed
   AND runtime_workspace_posts_history_erased(ex.id)$r$);
  EXECUTE d;
 END IF;
END $patch$;
COMMIT;
