-- BENCHMARK-COVERAGE auto-continue after a page reload (#1308, staging 10-25 "temari"): a discovery round that ran out of
-- its reply's lookups continues on the user's behalf, but the page learned that only from the reply's live stream, and a
-- reload or a lost connection mid-reply drops it for good: nothing was ever sent and the user had to type "继续".
-- The host now stores in the discovery cursor which reply stopped the round (`continueFrom`) and which replies it took
-- (`executions`); this function lets the page read that back. It returns the session's latest discovery only while it
-- is still running and waiting for its next reply, and only when
--   * the reply that stopped it completed normally (not stopped by the user, not paused or cancelled),
--   * that reply is the session's latest (any later message of the user, or the continuation itself, ends the wait), and
--   * it started less than 30 minutes ago (opening an old draft never starts a paid reply on its own).
-- Read-only: no table, data or table grant changes. Repeatable (CREATE OR REPLACE).
-- Rollback: DROP FUNCTION IF EXISTS public.research_user_unfinished_round(uuid,uuid); the page then falls back to the live
-- signal alone (deploy the code before this change first). No stored data depends on the function.
CREATE OR REPLACE FUNCTION public.research_user_unfinished_round(a uuid, s uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d research_discoveries; x runtime_executions; marker text;
BEGIN
  PERFORM research_session_owned(a,s,NULL);
  SELECT * INTO d FROM research_discoveries WHERE actor_id=a AND session_id=s ORDER BY created_at DESC, id DESC LIMIT 1;
  IF d.id IS NULL OR d.state<>'running' THEN RETURN NULL; END IF;
  marker:=d.cursor->>'continueFrom';
  IF marker IS NULL OR marker !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN NULL; END IF;
  SELECT * INTO x FROM runtime_executions WHERE id=marker::uuid AND actor_id=a AND session_id=s;
  IF x.id IS NULL OR x.state<>'completed' OR x.content_deleted_at IS NOT NULL OR x.erased_at IS NOT NULL
   OR x.result->>'completeness' IS NOT DISTINCT FROM 'stopped' OR x.result->>'stopped' IS NOT DISTINCT FROM 'true'
   OR x.created_at < clock_timestamp() - interval '30 minutes' THEN RETURN NULL; END IF;
  IF EXISTS(SELECT 1 FROM runtime_executions y WHERE y.actor_id=a AND y.session_id=s AND y.id<>x.id
    AND (y.created_at,y.id)>(x.created_at,x.id)) THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('discoveryId',d.id,'executionId',x.id,
    'replies',greatest(1,CASE WHEN jsonb_typeof(d.cursor->'executions')='array' THEN jsonb_array_length(d.cursor->'executions') ELSE 1 END));
END $$;
REVOKE ALL ON FUNCTION public.research_user_unfinished_round(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.research_user_unfinished_round(uuid,uuid) TO service_role;
