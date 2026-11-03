-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-12 batch R6: report, research and topic functions stop looking at the old path's tables.
--   topic_turn_source: the "request already admitted on the old path" refusal (its own source comment: "V2-12 drops this").
--   report_final_snapshot: a report's link names its turn; the check for an old execution of the same id is gone (turn-path reports have none).
--   voice_recovery_candidates: no BILL2 'recovery' descriptor (the job ignores it; a run-bound version is left alone, see recovery.ts).
--   runtime_workspace_source: benchmark rows are read through their turn; the old execution's read-source journal check goes.
--   research_operation_settled: an operation whose BILL2 call settled counts as settled; operations of the turn path are settled by their turn.
-- For turn-path data every removed condition is false, so results are unchanged. Staging holds old-path test rows only (see 0458's header).
-- Repeatable: whole-function CREATE OR REPLACE. Recovery: re-apply the previous text of the functions from git history; nothing is removed.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.topic_turn_source(p_actor_id uuid, p_draft_id uuid, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE d opc_drafts;w opc_topic_workspaces;r artifact_rounds;m runtime_scope_material;
BEGIN
 SELECT * INTO d FROM opc_drafts WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
 IF d.draft_id IS NULL THEN RAISE EXCEPTION 'OPC_TOPIC_UNBOUND';END IF;
 -- An archived business is read-only (0324), a deleted conversation's draft too (0249), as opc_topic_material; without its row locks.
 IF EXISTS(SELECT 1 FROM opc_draft_businesses db JOIN opc_businesses b ON b.id=db.business_id AND b.actor_id=p_actor_id
   WHERE db.draft_id=d.draft_id AND b.archived_at IS NOT NULL) THEN RAISE EXCEPTION 'OPC_BUSINESS_ARCHIVED';END IF;
 IF opc_draft_readonly(p_actor_id,p_draft_id) THEN RAISE EXCEPTION 'CONTENT_ERASED' USING ERRCODE='42501';END IF;
 SELECT * INTO w FROM opc_topic_workspaces WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
 IF w.draft_id IS NULL THEN RAISE EXCEPTION 'OPC_TOPIC_UNBOUND';END IF;
 IF NOT opc_source_allowed(p_actor_id,w.source_version_id) THEN RAISE EXCEPTION 'OPC_TOPIC_SOURCE_REVOKED';END IF;
 -- A turn opens only on the latest formal positioning: a workspace behind it is read-only until the user starts again on the new version.
 IF (SELECT v.version FROM artifact_versions v WHERE v.id=w.source_version_id)
  IS DISTINCT FROM (SELECT ap.current_version FROM artifact_projects ap WHERE ap.id=d.project_id) THEN
  RAISE EXCEPTION 'OPC_TOPIC_SOURCE_CHANGED';END IF;
 SELECT * INTO m FROM runtime_scope_material WHERE session_id=w.session_id AND revision=w.material_revision;
 IF m.session_id IS NULL OR m.revoked THEN RAISE EXCEPTION 'OPC_TOPIC_MATERIAL_MISSING';END IF;
 SELECT * INTO r FROM artifact_rounds WHERE id=(SELECT round_id FROM artifact_versions WHERE id=w.source_version_id);
 IF r.id IS NULL THEN RAISE EXCEPTION 'OPC_TOPIC_UNBOUND';END IF;
 IF jsonb_typeof(r.workflow->'planResources') IS DISTINCT FROM 'array' OR jsonb_array_length(r.workflow->'planResources')=0 THEN
  RAISE EXCEPTION 'OPC_TOPIC_SKILL_MISSING';END IF;
 RETURN jsonb_build_object('sessionId',w.session_id,'moduleId',w.module_id,'skillId',w.skill_id,'revisionId',w.revision_id,
  'packageHash',r.package_hash,'resources',r.workflow->'planResources','sourceVersionId',w.source_version_id,
  'historyFloor',w.history_floor_seq,
  'material',jsonb_build_object('sessionId',m.session_id,'revision',m.revision,'hash',m.content_hash,'content',m.content));
END $function$;

CREATE OR REPLACE FUNCTION public.report_final_snapshot(a uuid, pid uuid, rid uuid, payload jsonb, snapshot jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE source jsonb;r artifact_rounds;ev uuid;eid uuid;tid bigint;l opc_result_links;
BEGIN
 SELECT * INTO r FROM artifact_rounds WHERE id=rid AND project_id=pid;
 IF NOT(r.workflow ? 'reportGeneration') THEN RETURN snapshot; END IF;
 -- R14 review revision
 IF payload ? 'reviewRevisionId' THEN RETURN report_revision_snapshot(a,pid,rid,payload,snapshot); END IF;
 IF payload->>'reportExecutionId' IS NULL THEN RAISE EXCEPTION 'REPORT_EXECUTION_REQUIRED'; END IF;
 source:=report_document_source(a,(payload->>'reportExecutionId')::uuid);
 IF source->>'projectId' IS DISTINCT FROM pid::text OR source->>'roundId' IS DISTINCT FROM rid::text THEN
  RAISE EXCEPTION 'REPORT_SOURCE_CONFLICT'; END IF;
 IF source->>'candidate' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'REPORT_NOT_COMPLETE'; END IF;
 IF source->'revision' IS DISTINCT FROM payload->'reportRevision'
  OR source->>'bodyHash' IS DISTINCT FROM payload->>'reportBodyHash' THEN RAISE EXCEPTION 'REPORT_VERSION_CONFLICT'; END IF;
 eid:=(source->>'executionId')::uuid;
 -- CORE-PATH-V2 V2-12: a report is generated on the turn path; its link names the turn.
 SELECT id INTO tid FROM turns WHERE actor_id=a AND request_id=eid AND kind='report' AND state='closed';
 IF tid IS NULL THEN l.execution_id:=eid; ELSE l.turn_actor_id:=a; l.turn_id:=tid; END IF;
 IF NOT opc_result_link_available(l) THEN RAISE EXCEPTION 'REPORT_SOURCE_CONFLICT'; END IF;
 SELECT evidence_id INTO ev FROM opc_result_links WHERE round_id=rid AND step_id='report-final'
  AND (execution_id=eid OR (turn_actor_id=a AND turn_id=tid));
 IF ev IS NULL THEN
  IF (SELECT count(*) FROM artifact_evidence WHERE project_id=pid)>=128 THEN
   RAISE EXCEPTION 'REPORT_EVIDENCE_CAPACITY'; END IF;
  ev:=gen_random_uuid();
  INSERT INTO artifact_evidence(id,project_id,kind,payload,content_hash)
   VALUES(ev,pid,'user',jsonb_strip_nulls(jsonb_build_object('executionId',eid,'turnId',tid)),source->>'bodyHash');
  INSERT INTO artifact_evidence_restrictions(evidence_id) VALUES(ev);
  INSERT INTO opc_result_links(evidence_id,execution_id,turn_actor_id,turn_id,round_id,step_id)
   VALUES(ev,l.execution_id,l.turn_actor_id,l.turn_id,rid,'report-final');
 END IF;
 RETURN snapshot||jsonb_build_object('sources',(snapshot->'sources')||jsonb_build_array(
  jsonb_build_object('id',ev,'kind','report','executionId',eid)),
  'generatedReport',jsonb_build_object('executionId',source->'executionId','evidenceId',ev,
  'revision',source->'revision','body',source->'body','bodyHash',source->'bodyHash','manuallyEdited',source->'manuallyEdited')||report_final_data(source),
  'limitations','Report text may be manually edited; downstream positioning uses the confirmed field snapshot.');
END $function$;

CREATE OR REPLACE FUNCTION public.voice_recovery_candidates(p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT jsonb_build_object(
  -- hasProfile: a profile was really saved, so the run was delivered; otherwise the user must not be charged.
  'generations',(SELECT coalesce(jsonb_agg(jsonb_build_object('actorId',actor_id,'versionId',id,'runId',billing_run_id,
    'status',status,'hasProfile',profile IS NOT NULL)),'[]')
    FROM (SELECT * FROM voice_profile_versions
    WHERE (status='generating' OR (billing_run_id IS NOT NULL AND NOT billing_settled))
     AND updated_at<clock_timestamp()-interval '30 minutes' ORDER BY updated_at LIMIT p_limit) g),
  'scrubs',(SELECT coalesce(jsonb_agg(jsonb_build_object('actorId',actor_id,'runId',run_id,'outcome',outcome)),'[]')
   FROM (SELECT * FROM voice_billing_scrubs WHERE checked_at<clock_timestamp()-interval '30 minutes'
    ORDER BY checked_at LIMIT p_limit) s));
$function$;

CREATE OR REPLACE FUNCTION public.runtime_workspace_source(p_actor_id uuid, p_session_id uuid, p_query text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE entries jsonb;entry jsonb;body text;version_id uuid;cap integer:=4000;produced jsonb;strategy jsonb;fit jsonb;profile jsonb;
BEGIN
 IF NOT runtime_workspace_session(p_actor_id,p_session_id) THEN RAISE EXCEPTION 'RUNTIME_WORKSPACE_DENIED';END IF;
 IF length(coalesce(p_query,''))>2000 THEN RAISE EXCEPTION 'RUNTIME_WORKSPACE_QUERY_DENIED';END IF;
 -- Metadata is requested by the model, not loaded into every conversation.
 SELECT coalesce(jsonb_agg(x.entry ORDER BY x.rank,x.id),'[]') INTO entries FROM (
  SELECT 0 rank,b.id::text id,jsonb_build_object('id',b.id,'kind','positioning','name',b.name,'confirmedAt',v.created_at,'sourceVersionId',b.current_source_version_id)
   -- 0301: a finalized report with strategy data is read by its own id; it takes none of the 40 places.
   ||CASE WHEN opc_strategy_data(b.current_source_version_id) IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('strategyReport',
    jsonb_build_object('id','strategy_report:'||b.id,'use','Finalized report strategy data with these confirmed fields: next steps, '
     ||'this week, 30-day plan and metrics, monetization, audience, benchmarks, assumptions.')) END entry
  FROM opc_businesses b JOIN artifact_versions v ON v.id=b.current_source_version_id WHERE b.actor_id=p_actor_id AND b.erased_at IS NULL AND b.current_source_version_id IS NOT NULL
   AND opc_source_allowed(p_actor_id,b.current_source_version_id)
  UNION ALL
  SELECT 1,s.session_id::text,jsonb_build_object('id',s.session_id,'kind','benchmarks','name',b.name,'sessionId',s.session_id,
   'accounts',s.accounts,'qualified',s.qualified,'fetchedAt',s.fetched_at,'sourceVersionId',b.current_source_version_id,
   'producedBy',s.produced_by,
   'use','Real public data of benchmark accounts fetched during positioning research; numbers come only from this table.')
  FROM opc_businesses b CROSS JOIN LATERAL (
   SELECT d.session_id,count(*)::int accounts,(count(*) FILTER (WHERE rb.qualified))::int qualified,max(rb.fetched_at) fetched_at,
    jsonb_agg(DISTINCT jsonb_strip_nulls(jsonb_build_object('executionId',rb.execution_id,'turnId',rb.turn_id))) produced_by
   FROM opc_draft_businesses db JOIN opc_drafts d ON d.draft_id=db.draft_id AND d.actor_id=p_actor_id
    AND d.project_id=(SELECT cv.project_id FROM artifact_versions cv WHERE cv.id=b.current_source_version_id)
   JOIN runtime_sessions rs ON rs.id=d.session_id AND rs.actor_id=p_actor_id AND rs.content_deleted_at IS NULL AND rs.erased_at IS NULL
   JOIN research_benchmarks rb ON rb.session_id=d.session_id AND rb.actor_id=p_actor_id
   WHERE db.business_id=b.id AND rb.turn_id IS NOT NULL GROUP BY d.session_id ORDER BY max(rb.fetched_at) DESC,d.session_id LIMIT 1) s
  WHERE b.actor_id=p_actor_id AND b.erased_at IS NULL AND b.current_source_version_id IS NOT NULL
   AND opc_source_allowed(p_actor_id,b.current_source_version_id)
  UNION ALL
  SELECT 2,ac.project_id::text,jsonb_build_object('id',ac.project_id,'kind','strategy','platform',ac.platform,'account',coalesce((SELECT display_name FROM opc_account_ui WHERE actor_id=p_actor_id AND account_project_id=ac.project_id),ac.account_key),'sourceVersionId',ac.source_version_id)
  FROM opc_accounts ac WHERE ac.actor_id=p_actor_id AND opc_source_allowed(p_actor_id,ac.source_version_id)
  UNION ALL
  SELECT 2,i.work_item_id::text,jsonb_build_object('id',i.work_item_id,'kind','topic','platform',ac.platform,'account',coalesce((SELECT display_name FROM opc_account_ui WHERE actor_id=p_actor_id AND account_project_id=ac.project_id),ac.account_key),'title',coalesce((SELECT title FROM opc_item_edits WHERE work_item_id=i.work_item_id),p.work_title),'sourceVersionId',i.source_version_id)
  FROM opc_items i JOIN opc_accounts ac ON ac.project_id=i.account_project_id JOIN artifact_projects p ON p.id=i.work_item_id AND p.actor_id=p_actor_id
  WHERE ac.actor_id=p_actor_id AND opc_source_allowed(p_actor_id,i.source_version_id)
  ORDER BY rank,id LIMIT 40
 ) x;
 -- B2 own posts: no changes to the existing directory entries or dependencies.
 DECLARE post_entries jsonb:='[]';days integer:=0;chosen jsonb;
 BEGIN
  IF (SELECT value='true'::jsonb FROM system_settings WHERE key='chat_my_posts_enabled')
   AND (SELECT value='true'::jsonb FROM system_settings WHERE key='publish_monitor_enabled') THEN
   days:=runtime_workspace_post_window(p_actor_id);
   SELECT jsonb_agg(jsonb_build_object('id','my_posts:'||d,'kind','my_posts','name','我的作品 · '||d||' 天',
    'windowDays',d,'use','Saved own post metrics, free to read. Default 14 days. At most two reads per answer.') ORDER BY d)
    INTO post_entries FROM unnest(ARRAY[14,30,90]) d WHERE d=14 OR d<=days;
  END IF;
  IF coalesce(p_query,'')='' THEN
   RETURN jsonb_build_object('kind','workspace_index','entries',entries||post_entries,'limit',40+jsonb_array_length(post_entries),
    'dependencies',(SELECT coalesce(jsonb_agg(DISTINCT x->>'sourceVersionId'),'[]') FROM jsonb_array_elements(entries) x));
  END IF;
  IF p_query IN ('my_posts','my_posts:14','my_posts:30','my_posts:90') THEN
   SELECT x INTO chosen FROM jsonb_array_elements(post_entries) x WHERE x->>'id'=CASE WHEN p_query='my_posts' THEN 'my_posts:14' ELSE p_query END;
   IF chosen IS NULL THEN RETURN jsonb_build_object('kind','unavailable','dependencies','[]'::jsonb);END IF;
   RETURN jsonb_build_object('kind','workspace_posts_request','windowDays',(chosen->>'windowDays')::int,'entitled',days>0,'review',coalesce((SELECT value='true'::jsonb
   FROM system_settings WHERE key='publish_monitor_review_enabled'),false)); -- PR6 review descriptor
  END IF;
 END;
 IF coalesce(p_query,'')='' THEN
  RETURN jsonb_build_object('kind','workspace_index','entries',entries,'limit',40,'dependencies',(SELECT coalesce(jsonb_agg(DISTINCT x->>'sourceVersionId'),'[]') FROM jsonb_array_elements(entries) x));
 END IF;
 -- 0301: one read gives the confirmed fields and both strategy groups; over 48000 bytes whole strategy fields are
 -- dropped in the fixed order (listed in strategyDropped), never the confirmed fields and never a cut JSON.
 IF p_query LIKE 'strategy\_report:%' THEN
  SELECT x INTO entry FROM jsonb_array_elements(entries) x WHERE x->>'kind'='positioning' AND x->'strategyReport'->>'id'=p_query;
  strategy:=CASE WHEN entry IS NULL THEN NULL ELSE opc_strategy_data((entry->>'sourceVersionId')::uuid) END;
  IF strategy IS NULL THEN RETURN jsonb_build_object('kind','unavailable','dependencies','[]'::jsonb);END IF;
  version_id:=(entry->>'sourceVersionId')::uuid;profile:=opc_profile(version_id);
  fit:=report_strategy_fit(strategy->'data',report_strategy_fields(),greatest(0,48000-octet_length(coalesce(profile,'null'::jsonb)::text)));
  RETURN jsonb_build_object('kind','workspace_source',
   'identity',(entry-'strategyReport')||jsonb_build_object('id',p_query,'kind','strategy_report','positioningId',entry->'id'),
   'body',jsonb_build_object('profile',profile,'strategy',fit->'strategy','strategyTextEdited',strategy->'textEdited',
    'strategyDropped',fit->'dropped','use',opc_strategy_use()),
   'truncated',jsonb_array_length(fit->'dropped')>0,'dependencies',jsonb_build_array(version_id));
 END IF;
 SELECT x INTO entry FROM jsonb_array_elements(entries) x WHERE x->>'id'=p_query;
 IF entry IS NULL THEN RETURN jsonb_build_object('kind','unavailable','dependencies','[]'::jsonb);END IF;
 version_id:=(entry->>'sourceVersionId')::uuid;
 IF entry->>'kind' IN ('strategy','positioning') THEN body:=opc_profile(version_id)::text;
 ELSIF entry->>'kind'='benchmarks' THEN
  -- 0299 unchanged: one statement, one snapshot. The rows (same projection as research_benchmark_table: live answers of
  -- this session, at most 30, same order) and the answers they came from are computed together, so producedBy always
  -- describes the body even if a content erasure commits meanwhile.
  SELECT coalesce(jsonb_agg(jsonb_build_object('platform',b.platform,'account',b.account,'followers',b.followers,
    'medianViews',b.median_views,'engagementRate',b.engagement_rate,'postsPerWeek',b.posts_per_week,
    'lastPublishedAt',b.last_published_at,'postsAnalyzed',b.posts_analyzed,'category',b.category,'qualified',b.qualified,
    'excluded',b.excluded,'missing',to_jsonb(b.missing),'fetchedAt',b.fetched_at)
    ORDER BY b.qualified DESC,b.followers DESC NULLS LAST,b.platform,b.account),'[]'::jsonb)::text,
   coalesce(jsonb_agg(DISTINCT jsonb_strip_nulls(jsonb_build_object('executionId',b.execution_id,'turnId',b.turn_id))),'[]'::jsonb) INTO body,produced
  FROM (SELECT rb.* FROM research_benchmarks rb
    WHERE rb.actor_id=p_actor_id AND rb.session_id=(entry->>'sessionId')::uuid AND rb.turn_id IS NOT NULL
    ORDER BY rb.qualified DESC,rb.followers DESC NULLS LAST,rb.platform,rb.account LIMIT 30) b;
  cap:=8000;
  RETURN jsonb_build_object('kind','workspace_source','identity',entry-'producedBy'-'accounts'-'qualified'-'fetchedAt','body',left(body,cap),'truncated',length(body)>cap,
   'producedBy',produced,'dependencies',jsonb_build_array(version_id));
 ELSE SELECT coalesce((SELECT ed.brief FROM opc_item_edits ed WHERE ed.work_item_id=i.work_item_id),i.brief) INTO body FROM opc_items i WHERE i.work_item_id=(entry->>'id')::uuid;END IF;
 RETURN jsonb_build_object('kind','workspace_source','identity',entry,'body',left(body,cap),'truncated',length(body)>cap,'dependencies',jsonb_build_array(version_id));
END $function$;

CREATE OR REPLACE FUNCTION public.research_operation_settled(o research_operations)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT o.state IN ('succeeded','failed','cancelled')
    -- A turn's operation is written at close: its unknown cost is the turn's receipt, kept on turn_calls for recovery.
    OR EXISTS(SELECT 1 FROM research_plans p WHERE p.id=o.plan_id AND p.turn_id IS NOT NULL)
$function$;

COMMIT;
