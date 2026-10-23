-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- CHAT-AUTO-CONTEXT C (Owner 2026-10-17, questions 1-3 all A; docs/launch/tasks/CHAT-AUTO-CONTEXT.md §2.3, §4): a free
-- chat reply may call the general research tools. Two read-only functions; no table, no column, no data written.
--   * research_chat_benchmark_accounts(a,s,e): the accounts of the benchmark tables the caller's free chat can read (the
--     entries runtime_workspace_source lists, same rows as their body), so social_account can refuse an account the model made up. Scoped by research_session_owned to the
--     caller's live free-chat session and answer.
--   * runtime_work_items: patched (not replaced; earlier projections are kept) to also return each free-chat answer's
--     research subcalls as work rows, so the rows survive a page refresh. Only the facts the research_call stream event
--     already shows leave the database: tool, query, platform, data kind, state and the user's settled credits for that
--     subcall (same frozen multiplier and run conversion as research_runtime_call_charge, before the run's single ceil).
--     Never a result body, a supplier, a route or a US dollar amount. Erased plans or operations, deleted or erased
--     answers and conversations, and answers runtime_view hides return nothing, as for the other rows.
-- Compatibility: additive; older code ignores the new rows' extra `research` field. Repeatable: CREATE OR REPLACE and a
-- marker-skipped patch. Rollback: DROP FUNCTION public.research_chat_benchmark_accounts(uuid,uuid,uuid); re-run the
-- latest runtime_work_items definition without the '-- free chat research rows' block.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.research_chat_benchmark_accounts(a uuid,s uuid,e uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE sessions uuid[];
BEGIN
 PERFORM research_session_owned(a,s,e);
 -- Exactly the tables a free chat can read: the benchmark entries runtime_workspace_source lists for this caller (the
 -- confirmed positioning's own session, positioning version still allowed), never an older or unconfirmed table.
 SELECT coalesce(array_agg((x->>'sessionId')::uuid),ARRAY[]::uuid[]) INTO sessions
 FROM jsonb_array_elements(runtime_workspace_source(a,s,'')->'entries') x WHERE x->>'kind'='benchmarks';
 -- Same rows and order as the entry's body (live answers of that session, at most 30).
 RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('platform',b.platform,'account',b.account)),'[]'::jsonb)
  FROM (SELECT DISTINCT ON (t.platform,t.account) t.platform,t.account FROM (
    SELECT rb.platform,rb.account,row_number() OVER (PARTITION BY rb.session_id
      ORDER BY rb.qualified DESC,rb.followers DESC NULLS LAST,rb.platform,rb.account) n
    FROM research_benchmarks rb
    JOIN runtime_executions x ON x.id=rb.execution_id AND x.actor_id=a AND x.session_id=rb.session_id
     AND x.content_deleted_at IS NULL AND x.erased_at IS NULL
    WHERE rb.actor_id=a AND rb.session_id=ANY(sessions)) t WHERE t.n<=30
   ORDER BY t.platform,t.account) b);
END $$;
REVOKE ALL ON FUNCTION public.research_chat_benchmark_accounts(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.research_chat_benchmark_accounts(uuid,uuid,uuid) TO service_role;

DO $work$ DECLARE d text;anchor text;replacement text;
BEGIN
 d:=pg_get_functiondef('public.runtime_work_items(uuid,uuid)'::regprocedure);
 IF position('-- free chat research rows' IN d)=0 THEN
  anchor:=E'\n RETURN result;\n';
  replacement:=$p$
 -- free chat research rows
 WITH answers AS MATERIALIZED (
  SELECT e.id FROM runtime_executions e
  WHERE e.session_id=s.id AND e.actor_id=p_actor_id AND e.erased_at IS NULL AND e.content_deleted_at IS NULL
   AND e.unavailable_reason IS NULL AND e.payload->'research'->>'freeChat'='free-chat-v1'
 ), visible AS MATERIALIZED (
  SELECT a.execution_id id FROM runtime_history_availability(ARRAY(SELECT id FROM answers)) a WHERE a.available
 )
 SELECT coalesce(result,'{}'::jsonb)||coalesce(jsonb_object_agg(k.execution_id::text,
   coalesce(result->(k.execution_id::text),'[]'::jsonb)||k.items),'{}'::jsonb) INTO result FROM (
  SELECT r.execution_id,jsonb_agg(r.item ORDER BY r.created_at,r.id) items FROM (
   SELECT p.execution_id,o.id,o.created_at,row_number() OVER (PARTITION BY p.execution_id ORDER BY o.created_at,o.id) n,
    jsonb_build_object('id',o.id,'kind','research',
     'state',CASE WHEN o.state IN ('prepared','dispatched') THEN 'running' WHEN o.state='unknown' THEN 'pending'
      WHEN o.state='succeeded' AND o.result->>'outcome' IN ('ok','partial') THEN 'done' ELSE 'missing' END,
     'label',left('搜索 '||coalesce(o.result->'call'->>'query',''),200),
     'research',jsonb_build_object('callId',o.id,'toolName',o.result->>'toolName','args','{}'::jsonb,
      'query',left(coalesce(o.result->'call'->>'query',''),200),'platform',o.result->'call'->>'platform',
      'dataKind',o.result->'call'->>'dataKind',
      'state',CASE WHEN o.state IN ('prepared','dispatched') THEN 'running' WHEN o.state='unknown' THEN 'unknown'
       WHEN o.state='succeeded' AND o.result->>'outcome' IN ('ok','partial') THEN 'succeeded' ELSE 'failed' END,
      'credits',CASE WHEN c.settled_at IS NOT NULL AND c.nominal_source LIKE 'tool_%'
       THEN (c.nominal_cost_usd*bill2_unit_multiplier(c.payload->'billingUnit'->'multiplier')*b.credits_per_usd)::text END)) item
   FROM visible v
   JOIN research_plans p ON p.execution_id=v.id AND p.actor_id=p_actor_id AND p.session_id=s.id AND p.erased_at IS NULL
   JOIN research_operations o ON o.plan_id=p.id AND o.erased_at IS NULL
   LEFT JOIN bill2_calls c ON c.id=o.bill2_call_id AND c.call_kind='tool'
   LEFT JOIN bill2_runs b ON b.id=c.run_id AND b.actor_id=p_actor_id
  ) r WHERE r.n<=12 GROUP BY r.execution_id
 ) k;
 RETURN result;
$p$;
  IF array_length(string_to_array(d,anchor),1)<>2 THEN RAISE EXCEPTION 'CHAT_RESEARCH_WORK_ROWS_MISMATCH'; END IF;
  EXECUTE replace(d,anchor,replacement);
 END IF;
END $work$;
COMMIT;
