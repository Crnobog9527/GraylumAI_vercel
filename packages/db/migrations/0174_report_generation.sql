-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- REPORT-GEN: 未完成、默认关闭。No settings or member grants are changed.
-- Reuses PAY-COMMON facts, Runtime result/session, artifact snapshots and PAYG accounting.
BEGIN;
CREATE OR REPLACE FUNCTION public.report_membership_check(p_actor_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE member profiles; facts jsonb; subscription jsonb; orders jsonb; managed jsonb; part jsonb;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO member FROM profiles WHERE id=p_actor_id FOR UPDATE;
 IF member.id IS NULL OR member.status<>'active' OR member.is_deleted<>'false' THEN
  RAISE EXCEPTION 'REPORT_ENTITLEMENTS_UNAVAILABLE';END IF;
 IF member.membership_level NOT IN ('pro','gold') THEN RAISE EXCEPTION 'REPORT_MEMBERSHIP_REQUIRED';END IF;
 -- The same rows and mapping projection as membershipEligibility / membershipEntitlements.
 -- Profile lock serializes paid fulfillment/revocation; facts themselves remain the authority.
 PERFORM id FROM user_subscriptions WHERE user_id=p_actor_id ORDER BY id FOR SHARE;
 facts:=pay_common_membership_facts(p_actor_id); orders:=facts->'latest_order';
 IF orders->>'status' IN ('refunded','partially_refunded','partial_refunded')
  OR orders->>'payment_status' IN ('refunded','partially_refunded','partial_refunded') THEN
  RAISE EXCEPTION 'REPORT_MEMBERSHIP_REQUIRED';END IF;
 FOR part IN SELECT value FROM jsonb_each(coalesce(orders->'metadata','{}'))
  WHERE key IN ('stripeRefundReconciliation','subscriptionCreditGrantReversal','refundReconciliation','refund') LOOP
  IF part->>'isFullRefund'='true' OR part->>'fullRefund'='true' OR part->>'reviewRequired'='true' OR part->>'refundType'='full'
   THEN RAISE EXCEPTION 'REPORT_MEMBERSHIP_REQUIRED';END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(facts->'subscriptions') s
   WHERE coalesce(s->>'mapping_state','') NOT IN ('none','mapped')) THEN
  RAISE EXCEPTION 'REPORT_ENTITLEMENTS_UNAVAILABLE';END IF;
 SELECT coalesce(jsonb_agg(s),'[]') INTO managed FROM jsonb_array_elements(facts->'subscriptions') s
  WHERE s->>'mapping_state'='mapped' AND s->>'payment_channel'='stripe'
   AND lower(s->>'status') IN ('active','trialing','past_due','incomplete','unpaid');
 IF jsonb_array_length(managed)>1 THEN RAISE EXCEPTION 'REPORT_ENTITLEMENTS_UNAVAILABLE';END IF;
 subscription:=coalesce(managed->0,facts->'subscriptions'->0);
 IF subscription IS NOT NULL THEN
  IF (subscription->>'mapping_state'='mapped' AND subscription->>'payment_channel' IS DISTINCT FROM 'stripe')
   OR (subscription->>'mapping_state'='none' AND subscription->>'payment_channel' IS NOT NULL) THEN
   RAISE EXCEPTION 'REPORT_ENTITLEMENTS_UNAVAILABLE';END IF;
  IF subscription->>'mapping_state'='mapped' THEN
   IF lower(subscription->>'status') NOT IN ('active','trialing') THEN RAISE EXCEPTION 'REPORT_MEMBERSHIP_REQUIRED';END IF;
   IF NOT EXISTS(SELECT 1 FROM membership_plans WHERE id::text=subscription->>'membership_plan_id'
    AND level=member.membership_level) THEN RAISE EXCEPTION 'REPORT_ENTITLEMENTS_UNAVAILABLE';END IF;
  END IF;
  -- A known expiry cannot be bypassed by delayed profile cleanup. One-time grants use
  -- the same profile authority and period fact; no channel-specific report permission.
  IF subscription->>'current_period_end' IS NOT NULL AND
    (subscription->>'current_period_end')::timestamptz<=clock_timestamp() THEN
   RAISE EXCEPTION 'REPORT_MEMBERSHIP_REQUIRED';END IF;
 END IF;
END $fn$;
REVOKE ALL ON FUNCTION public.report_membership_check(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.report_membership_check(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.report_source(p_actor_id uuid,p_session_id uuid,p_project_id uuid,p_round_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE s runtime_sessions;r artifact_rounds;source jsonb;binding jsonb;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO s FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id;
 IF s.id IS NULL OR NOT bill2_scope_allowed(p_actor_id,s.scope) THEN RAISE EXCEPTION 'REPORT_SOURCE_CONFLICT';END IF;
 IF NOT EXISTS(SELECT 1 FROM opc_drafts WHERE actor_id=p_actor_id AND session_id=s.id
   AND project_id=p_project_id AND round_id=p_round_id)
  AND NOT(s.scope->>'kind'='work_item' AND s.scope->>'workItemId'=p_project_id::text) THEN
  RAISE EXCEPTION 'REPORT_SOURCE_CONFLICT';END IF;
 SELECT * INTO r FROM artifact_rounds WHERE id=p_round_id AND project_id=p_project_id FOR SHARE;
 IF r.id IS NULL THEN RAISE EXCEPTION 'REPORT_SOURCE_CONFLICT';END IF;
 source:=artifact_query(p_actor_id,'read',p_project_id,p_round_id);
 binding:=artifact_query(p_actor_id,'resolve',p_project_id,p_round_id);
 RETURN jsonb_build_object('snapshot',source,'workflow',r.workflow,'moduleId',binding->'moduleId',
  'snapshotHash',artifact_hash(jsonb_build_object('steps',source->'steps','revision',r.revision_id,
    'package',r.package_hash,'workflow',r.workflow_hash,'template',r.template_hash)));
END $fn$;
REVOKE ALL ON FUNCTION public.report_source(uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.report_source(uuid,uuid,uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.report_admission_check(a uuid,sid uuid,context jsonb,billing jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $fn$
DECLARE source jsonb; spec jsonb; flag jsonb; item jsonb;
BEGIN
 IF NOT(context ? 'reportGeneration') THEN RETURN;END IF;
 SELECT value::jsonb INTO flag FROM system_settings WHERE key='runtime_report_generation';
 IF flag IS DISTINCT FROM '{"enabled":true}'::jsonb THEN RAISE EXCEPTION 'REPORT_DISABLED';END IF;
 IF billing->>'contractVersion' IS DISTINCT FROM 'bill2.v2' THEN RAISE EXCEPTION 'REPORT_PAYG_REQUIRED';END IF;
 IF context->>'role' IS DISTINCT FROM 'skill' OR context->>'maxTurns' IS DISTINCT FROM '1'
  OR context->>'historyItems' IS DISTINCT FROM '0' OR context->>'network' IS DISTINCT FROM 'deny'
  OR context->'tools' IS DISTINCT FROM '[]'::jsonb OR context->'sources' IS DISTINCT FROM '[]'::jsonb
  OR context#>>'{purposeBudget,purpose}' IS DISTINCT FROM 'report'
  OR context ?| ARRAY['promptCache','hostTurnContext','historySelection','scopeMaterial','attachedOrganizer','matching','workspaceContext']
  THEN RAISE EXCEPTION 'REPORT_SOURCE_CONFLICT';END IF;
 source:=report_source(a,sid,(context#>>'{reportGeneration,projectId}')::uuid,(context#>>'{reportGeneration,roundId}')::uuid);
 spec:=source#>'{workflow,reportGeneration}';
 IF spec IS NULL THEN RAISE EXCEPTION 'REPORT_MANIFEST_REQUIRED';END IF;
 IF source->>'snapshotHash' IS DISTINCT FROM context#>>'{reportGeneration,snapshotHash}'
  OR source#>>'{snapshot,revisionId}' IS DISTINCT FROM context->>'revisionId'
  OR source->>'moduleId' IS DISTINCT FROM context->>'moduleId'
  OR spec->'sections' IS DISTINCT FROM context#>'{reportGeneration,sections}'
  OR spec->'maxCharacters' IS DISTINCT FROM context#>'{reportGeneration,maxCharacters}'
  THEN RAISE EXCEPTION 'REPORT_SOURCE_CONFLICT';END IF;
 FOR item IN SELECT value FROM jsonb_each(source#>'{snapshot,steps}') LOOP
  IF item->>'valid' IS DISTINCT FROM 'true' OR item->>'confirmationId' IS NULL OR item->>'body' IS NULL
   OR item->>'available'='false' THEN RAISE EXCEPTION 'REPORT_CONFIRMATION_REQUIRED';END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM runtime_executions e WHERE e.session_id=sid AND e.primary_result IS NOT NULL
   AND e.payload ? 'attachedOrganizer' AND e.result IS NULL
   AND e.state IN ('waiting_credits','waiting_resume','running','interrupted','cost_pending')) THEN
  RAISE EXCEPTION 'OPC_CAPTURE_PENDING';END IF;
END $fn$;
REVOKE ALL ON FUNCTION public.report_admission_check(uuid,uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- Narrow patches of existing transaction bodies. Old execution/recovery/read paths stay intact.
DO $patch$
DECLARE definition text; original text; replacement text;
BEGIN
 definition:=pg_get_functiondef('runtime_admit(uuid,uuid,uuid,jsonb,jsonb)'::regprocedure);
 IF position('PERFORM report_admission_check(' in definition)=0 THEN
  IF md5(definition)<>'28999a90cd0396f6fd8779cde7e0c595' THEN RAISE EXCEPTION 'REPORT_ADMIT_SOURCE_MISMATCH';END IF;
  original:=' IF EXISTS(SELECT 1 FROM runtime_executions pending JOIN bill2_runs pr';
  replacement:=' PERFORM report_admission_check(p_actor_id,p_session_id,p_payload,p_billing);'||chr(10)||original;
  IF position(original in definition)=0 THEN RAISE EXCEPTION 'REPORT_ADMIT_PATCH_MISSING';END IF;
  EXECUTE replace(definition,original,replacement);
 ELSIF md5(definition)<>'11ff43aed8b67e76fab03f2ba7107696' THEN RAISE EXCEPTION 'REPORT_ADMIT_TARGET_MISMATCH';
 END IF;
 definition:=pg_get_functiondef('bill2_payg_claim(uuid,uuid,integer,jsonb)'::regprocedure);
 IF position('PERFORM report_membership_check(a)' in definition)=0 THEN
  IF md5(definition)<>'4708e5d1d85c24581b0aa5ea990c0080' THEN RAISE EXCEPTION 'REPORT_CLAIM_SOURCE_MISMATCH';END IF;
  original:=' IF r.session_ref IS NOT NULL AND (coalesce(p->>''runtimeEpoch'','''')';
  replacement:=$sql$ IF r.payload#>'{input,reportGeneration}' IS NOT NULL THEN
  PERFORM report_membership_check(a);
  IF p->>'phase' IS DISTINCT FROM 'report' THEN RAISE EXCEPTION 'REPORT_SOURCE_CONFLICT';END IF;
  IF (report_source(a,r.session_ref,(r.payload#>>'{input,reportGeneration,projectId}')::uuid,
    (r.payload#>>'{input,reportGeneration,roundId}')::uuid)->>'snapshotHash')
    IS DISTINCT FROM r.payload#>>'{input,reportGeneration,snapshotHash}' THEN RAISE EXCEPTION 'REPORT_SOURCE_CONFLICT';END IF;
 END IF;
$sql$||original;
  IF position(original in definition)=0 THEN RAISE EXCEPTION 'REPORT_CLAIM_PATCH_MISSING';END IF;
  EXECUTE replace(definition,original,replacement);
 ELSIF md5(definition)<>'f12b6962b2883df773d984f3b187b1b4' THEN RAISE EXCEPTION 'REPORT_CLAIM_TARGET_MISMATCH';
 END IF;
 -- Permission rechecks apply on reads too, but never recheck membership or source freshness.
 definition:=pg_get_functiondef('runtime_context_allowed(uuid,jsonb)'::regprocedure);
 IF position('report_source(p_actor_id' in definition)=0 THEN
  IF md5(definition)<>'9027a0927a1a1e7247dad733e12035f6' THEN RAISE EXCEPTION 'REPORT_CONTEXT_SOURCE_MISMATCH';END IF;
  original:=' PERFORM runtime_context_allowed_before_workspace(p_actor_id,p_context);';
  replacement:=original||$sql$
 IF p_context ? 'reportGeneration' THEN
  IF NOT artifact_evidence_allowed((p_context#>>'{reportGeneration,projectId}')::uuid,
    coalesce(p_context#>'{reportGeneration,evidenceIds}','[]'::jsonb)) THEN
   RAISE EXCEPTION 'RUNTIME_SOURCE_DENIED';END IF;
  PERFORM report_source(p_actor_id,(p_context#>>'{request,sessionId}')::uuid,
   (p_context#>>'{reportGeneration,projectId}')::uuid,(p_context#>>'{reportGeneration,roundId}')::uuid);
 END IF;
$sql$;
  EXECUTE replace(definition,original,replacement);
 ELSIF md5(definition)<>'c0128dea573b43ef813e49eaed9d5dc0' THEN RAISE EXCEPTION 'REPORT_CONTEXT_TARGET_MISMATCH';
 END IF;
 -- Reports bind to the confirmed artifact, not an OPC question token/material copy.
 -- Retain the common actor, scope, Skill/model and source checks before this branch.
 definition:=pg_get_functiondef('runtime_direct_billing_allowed_before_topic(uuid,jsonb,uuid)'::regprocedure);
 original:=' PERFORM runtime_direct_billing_allowed_before_opc(a,p,p_run_id);';
 replacement:=$sql$
 IF p#>'{input,reportGeneration}' IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM runtime_sessions WHERE id=(p#>>'{input,request,sessionId}')::uuid
    AND actor_id=a AND scope=p->'scope') THEN RAISE EXCEPTION 'REPORT_SOURCE_CONFLICT';END IF;
  RETURN;
 END IF;
$sql$;
 IF position(replacement in definition)>0 THEN
  IF md5(replace(definition,replacement,''))<>'9546388594cea6731a021f68536492ad' THEN
   RAISE EXCEPTION 'REPORT_BINDING_TARGET_MISMATCH';END IF;
 ELSE
  IF md5(definition)<>'9546388594cea6731a021f68536492ad' THEN RAISE EXCEPTION 'REPORT_BINDING_SOURCE_MISMATCH';END IF;
  EXECUTE replace(definition,original,original||replacement);
 END IF;
END $patch$;
COMMIT;
