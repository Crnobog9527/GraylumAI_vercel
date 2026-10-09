-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- REPORT-MODEL: null preserves the dialogue binding. No configuration data is seeded.
BEGIN;
ALTER TABLE public.modules ADD COLUMN IF NOT EXISTS report_model_id uuid
 REFERENCES public.ai_models(id) ON DELETE RESTRICT;
COMMENT ON COLUMN public.modules.report_model_id IS
 'Optional final-report model; null uses model_id for NEW report admissions. Frozen executions retain their model.';
-- Client roles have an explicit public-column allowlist; never grant this column to them.
REVOKE SELECT (report_model_id), INSERT (report_model_id), UPDATE (report_model_id),
 REFERENCES (report_model_id) ON public.modules FROM anon, authenticated;

-- Admin configuration validation needs the bound window quotes, not permission to dispatch
-- as the administrator. Keep the window table private and the normal actor whitelist intact.
CREATE OR REPLACE FUNCTION public.report_model_window(p_actor_id uuid,p_window_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE w runtime_test_windows;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND role='admin' AND status='active')
 THEN RAISE EXCEPTION 'REPORT_MODEL_ADMIN_REQUIRED' USING ERRCODE='42501';END IF;
 SELECT * INTO w FROM runtime_test_windows WHERE id=p_window_id;
 IF w.id IS NULL OR NOT w.enabled OR clock_timestamp()>=w.expires_at
 THEN RAISE EXCEPTION 'REPORT_MODEL_ADMISSION_REQUIRED';END IF;
 RETURN jsonb_build_object('id',w.id,'callPolicies',w.call_policies,'creditsPerUsd',w.credits_per_usd::text,
 'multiplier',w.multiplier::text,'expiresAt',w.expires_at);
END $$;
REVOKE ALL ON FUNCTION public.report_model_window(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.report_model_window(uuid,uuid) TO service_role;

DO $patch$
DECLARE definition text; original text; replacement text;
BEGIN
 -- Check current settings only for NEW admissions, under the existing module share lock.
 definition:=pg_get_functiondef('public.runtime_admit(uuid,uuid,uuid,jsonb,jsonb)'::regprocedure);
 original:='AND skill_id=(p_billing->>''skillId'')::uuid AND active AND model_id=(p_billing->>''modelId'')::uuid FOR SHARE;';
 replacement:=$sql$AND skill_id=(p_billing->>'skillId')::uuid AND active
   AND (CASE WHEN p_payload ? 'reportGeneration' THEN coalesce(report_model_id,model_id)
     ELSE model_id END)=(p_billing->>'modelId')::uuid FOR SHARE;$sql$;
 IF position(replacement in definition)>0 THEN
  IF md5(replace(definition,replacement,original))<>'11ff43aed8b67e76fab03f2ba7107696'
   THEN RAISE EXCEPTION 'REPORT_MODEL_ADMIT_TARGET_MISMATCH';END IF;
 ELSE
  IF md5(definition)<>'11ff43aed8b67e76fab03f2ba7107696' OR position(original in definition)=0
   THEN RAISE EXCEPTION 'REPORT_MODEL_ADMIT_SOURCE_MISMATCH';END IF;
  EXECUTE replace(definition,original,replacement);
 END IF;
 -- Every retained access still checks actor, module/Skill activity, source and model availability.
 -- Only the mutable model binding is replaced by the exact persisted report contract identity.
 -- This includes reports frozen before this migration, with no new payload marker required.
 definition:=pg_get_functiondef('public.runtime_direct_billing_allowed_before_opc(uuid,jsonb,uuid)'::regprocedure);
 original:='PERFORM id FROM modules WHERE id=m AND skill_id=k AND active AND model_id=(p->>''modelId'')::uuid FOR SHARE;';
 replacement:=$sql$PERFORM id FROM modules WHERE id=m AND skill_id=k AND active AND (
    (NOT (p->'input' ? 'reportGeneration') AND model_id=(p->>'modelId')::uuid)
    OR (p->'input' ? 'reportGeneration' AND EXISTS(
     SELECT 1 FROM runtime_executions e JOIN bill2_runs r ON r.id=e.billing_run_id
     WHERE r.id=p_run_id AND r.actor_id=a AND e.actor_id=a AND r.payload=p
      AND e.payload=p->'input' AND e.payload ? 'reportGeneration'))
   ) FOR SHARE;$sql$;
 IF position(replacement in definition)>0 THEN
  IF md5(replace(definition,replacement,original))<>'f7587da7257cee711f64c7a0e82d8311'
   THEN RAISE EXCEPTION 'REPORT_MODEL_FROZEN_TARGET_MISMATCH';END IF;
 ELSE
  IF md5(definition)<>'f7587da7257cee711f64c7a0e82d8311' OR position(original in definition)=0
   THEN RAISE EXCEPTION 'REPORT_MODEL_FROZEN_SOURCE_MISMATCH';END IF;
  EXECUTE replace(definition,original,replacement);
 END IF;
 -- A completed report is not a dialogue turn. Standalone organization must keep
 -- the last actual dialogue model, even when the report uses the summary model.
 definition:=pg_get_functiondef('public.runtime_session_context(uuid,uuid)'::regprocedure);
 original:='WHERE session_id=s.id AND payload->>''role'' IN (''ordinary'',''skill'')';
 replacement:=original||' AND NOT (payload ? ''reportGeneration'')';
 IF position(replacement in definition)>0 THEN
  IF md5(replace(definition,replacement,original))<>'67b8e8ca0a4f07c95e5758676a1a803c'
   THEN RAISE EXCEPTION 'REPORT_MODEL_SESSION_TARGET_MISMATCH';END IF;
 ELSE
  IF md5(definition)<>'67b8e8ca0a4f07c95e5758676a1a803c' OR position(original in definition)=0
   THEN RAISE EXCEPTION 'REPORT_MODEL_SESSION_SOURCE_MISMATCH';END IF;
  EXECUTE replace(definition,original,replacement);
 END IF;
END $patch$;
COMMIT;
