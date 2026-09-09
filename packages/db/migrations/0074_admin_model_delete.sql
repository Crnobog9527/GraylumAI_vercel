-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Delete only unused model records, through the authenticated administrator API.
-- No row changes during migration and no client or direct server DELETE grant.
BEGIN;
-- Only supported model-setting fields are references; unrelated UUID text is not.
CREATE OR REPLACE FUNCTION public.model_setting_references(p_key text,p_value jsonb)
RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT COALESCE(array_agg(lower(btrim(v))) FILTER (WHERE v IS NOT NULL AND btrim(v)<>''),ARRAY[]::text[])
 FROM unnest(CASE
  WHEN p_key IN ('primary_model_id','assistant_model_id','v3_summary_model_id') THEN ARRAY[p_value #>> '{}']
  WHEN p_key='ai_models' AND jsonb_typeof(p_value)='object' THEN ARRAY[p_value->>'primaryModelId',p_value->>'assistantModelId',p_value->>'defaultModelId',p_value->>'sonnetModelId',p_value->>'haikuModelId']
  ELSE ARRAY[]::text[] END) AS item(v);
$$;
CREATE OR REPLACE FUNCTION public.guard_model_setting_references()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='3s' AS $$
DECLARE model_ref text;
BEGIN
 FOREACH model_ref IN ARRAY public.model_setting_references(NEW.key,NEW.value) LOOP
  -- A key-share lock holds the referenced model until the settings write commits.
  PERFORM 1 FROM public.ai_models WHERE id::text=model_ref FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'selected model no longer exists' USING ERRCODE='23503'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS system_settings_model_references ON public.system_settings;
CREATE TRIGGER system_settings_model_references BEFORE INSERT OR UPDATE OF key,value
 ON public.system_settings FOR EACH ROW EXECUTE FUNCTION public.guard_model_setting_references();
REVOKE ALL ON FUNCTION public.model_setting_references(text,jsonb),public.guard_model_setting_references() FROM PUBLIC,anon,authenticated;
CREATE OR REPLACE FUNCTION public.admin_delete_unused_model(p_actor_id uuid,p_model_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='3s' AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND role='admin' AND status='active' AND is_deleted='false') THEN
  RAISE EXCEPTION 'administrator required' USING ERRCODE='42501';
 END IF;
 -- Rare administrator operation: serialize reference writes for the short check/delete transaction.
 LOCK TABLE public.ai_models,public.system_settings,public.modules,public.prompts,public.conversations IN SHARE ROW EXCLUSIVE MODE;
 IF EXISTS(SELECT 1 FROM modules WHERE model_id=p_model_id)
 OR EXISTS(SELECT 1 FROM prompts WHERE model_id=p_model_id)
 OR EXISTS(SELECT 1 FROM conversations WHERE model_id=p_model_id)
 OR EXISTS(SELECT 1 FROM system_settings WHERE p_model_id::text=ANY(public.model_setting_references(key,value))) THEN
  RAISE EXCEPTION 'model is referenced' USING ERRCODE='23503';
 END IF;
 DELETE FROM ai_models WHERE id=p_model_id;
 RETURN jsonb_build_object('success',true);
END $$;
REVOKE ALL ON FUNCTION public.admin_delete_unused_model(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_unused_model(uuid,uuid) TO service_role;
COMMIT;
-- Recovery: revoke function EXECUTE from service_role; existing records are unaffected.
