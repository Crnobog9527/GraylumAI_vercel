/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
// DB-PERF PR-7a: runtime_library_propagate checks own-post history only for executions whose history can hold own posts.
export async function propagateScopeCases({c,report}){
 const one=async(sql,args=[])=>(await c.query(sql,args)).rows[0]?.v;
 const scope=`WITH RECURSIVE reach(id) AS (
   SELECT t.execution_id FROM runtime_tool_calls t WHERE t.result->>'kind'='my_posts'
   UNION SELECT ex.id FROM runtime_executions ex WHERE ex.payload->>'ownPosts'='true'
   UNION SELECT dep.execution_id FROM runtime_history_dependencies dep JOIN reach r ON dep.dependency_id=r.id
  ) SELECT id FROM reach`;
 // The scope is a necessary condition: on everything the suites above created (own posts, descendants through
 // runtime_history_dependencies, plain executions), no execution outside it passes the history check.
 const outside=await one(`SELECT count(*)::int v FROM runtime_executions ex
  WHERE runtime_workspace_posts_history_erased(ex.id) AND ex.id NOT IN (${scope})`);
 assert.equal(outside,0);
 const total=await one('SELECT count(*)::int v FROM runtime_executions'),inside=await one(`SELECT count(*)::int v FROM (${scope}) s`);
 assert.ok(inside>0&&total>inside,`fixture must hold executions on both sides (${inside}/${total})`);
 assert.ok(await one(`SELECT count(*)::int v FROM runtime_history_dependencies dep WHERE dep.execution_id IN (${scope})
  AND dep.dependency_id IN (${scope}) AND dep.execution_id NOT IN (SELECT execution_id FROM runtime_tool_calls
  WHERE result->>'kind'='my_posts') AND dep.execution_id NOT IN (SELECT id FROM runtime_executions WHERE payload->>'ownPosts'='true')`)>0,
  'a descendant reached only through a dependency is in the scope');
 report.checks.push(`own-post scope is a necessary condition of the history check (${inside} of ${total} executions, descendants included)`);
 // Same data, same effects: the definition without the scope (this migration's two filters removed) and the scoped
 // one return the same counts and clear exactly the same rows. Stamps differ per run, so rows are compared by state.
 const scoped=await one("SELECT pg_get_functiondef('public.runtime_library_propagate(uuid,integer)'::regprocedure) v");
 assert.equal(scoped.split('ex.id=ANY(posts_scope) AND ').length,3);
 const effects=`SELECT jsonb_build_object(
   'calls',(SELECT jsonb_agg(jsonb_build_array(execution_id,call_id,erased_at IS NOT NULL,result IS NULL) ORDER BY execution_id,call_id) FROM runtime_tool_calls),
   'history',(SELECT jsonb_agg(jsonb_build_array(session_id,revision,erased_at IS NOT NULL) ORDER BY session_id,revision) FROM runtime_session_history),
   'batches',(SELECT jsonb_agg(jsonb_build_array(execution_id,batch,erased_at IS NOT NULL) ORDER BY execution_id,batch) FROM runtime_session_batches),
   'runs',(SELECT jsonb_agg(jsonb_build_array(id,content_deleted_at IS NOT NULL) ORDER BY id) FROM bill2_runs),
   'executions',(SELECT jsonb_agg(jsonb_build_array(id,unavailable_reason) ORDER BY id) FROM runtime_executions),
   'receipts',(SELECT jsonb_agg(jsonb_build_array(id,financial_projection_version) ORDER BY id) FROM bill2_receipts)) v`;
 const sweep=async definition=>{
  await c.query('BEGIN');
  try{
   if(definition)await c.query(definition);
   // Give both sweeps real work: own-post executions whose history check passes go back to running without a reason,
   // which the first loop must mark source_deleted.
   await c.query(`UPDATE runtime_executions SET state='running',unavailable_reason=NULL
    WHERE id IN (${scope}) AND runtime_workspace_posts_history_erased(id)`);
   const returned=await one('SELECT runtime_library_propagate(NULL,100) v');
   return {returned,after:await one(effects)};
  }finally{await c.query('ROLLBACK');}
 };
 const unscoped=await sweep(scoped.split('ex.id=ANY(posts_scope) AND ').join('')),current=await sweep();
 assert.deepEqual(current,unscoped);
 assert.ok(current.returned.processed>0,'the compared sweeps had work to do');
 report.checks.push(`RED/GREEN on the same data: scoped and unscoped sweeps return ${JSON.stringify(current.returned)} and clear the same rows`);
 // With no own-post history at all the sweep never calls it.
 await c.query('BEGIN');
 try{
  await c.query("UPDATE runtime_tool_calls SET result=jsonb_set(result,'{kind}','\"other\"') WHERE result->>'kind'='my_posts'");
  await c.query(`UPDATE runtime_executions SET payload=payload-'ownPosts' WHERE payload->>'ownPosts'='true'`);
  await c.query("SET LOCAL track_functions='all'");
  // The setup updates above may run the check through triggers: count only what the sweep itself adds.
  const counted=`SELECT coalesce(pg_stat_get_xact_function_calls('public.runtime_workspace_posts_history_erased(uuid)'::regprocedure),0)::int v`;
  const before=await one(counted);
  await c.query('SELECT runtime_library_propagate(NULL,100)');
  assert.equal(await one(counted)-before,0);
 }finally{await c.query('ROLLBACK');}
 report.checks.push('without own-post history a library sweep does no own-post history checks');
}
