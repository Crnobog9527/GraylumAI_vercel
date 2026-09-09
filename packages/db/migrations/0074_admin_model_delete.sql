-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Delete only unused model records, through the authenticated administrator API.
-- No row changes during migration and no client or direct server DELETE grant.
BEGIN;
CREATE OR REPLACE FUNCTION public.admin_delete_unused_model(p_actor_id uuid,p_model_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND role='admin' AND status='active' AND is_deleted='false') THEN
  RAISE EXCEPTION 'administrator required' USING ERRCODE='42501';
 END IF;
 -- Rare administrator operation: serialize reference writes for the short check/delete transaction.
 LOCK TABLE public.ai_models,public.system_settings,public.modules,public.prompts,public.conversations IN SHARE ROW EXCLUSIVE MODE;
 IF EXISTS(SELECT 1 FROM modules WHERE model_id=p_model_id)
 OR EXISTS(SELECT 1 FROM prompts WHERE model_id=p_model_id)
 OR EXISTS(SELECT 1 FROM conversations WHERE model_id=p_model_id)
 OR EXISTS(SELECT 1 FROM system_settings WHERE strpos(lower(value::text),p_model_id::text)>0) THEN
  RAISE EXCEPTION 'model is referenced' USING ERRCODE='23503';
 END IF;
 DELETE FROM ai_models WHERE id=p_model_id;
 RETURN jsonb_build_object('success',true);
END $$;
REVOKE ALL ON FUNCTION public.admin_delete_unused_model(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_unused_model(uuid,uuid) TO service_role;
COMMIT;
-- Recovery: revoke function EXECUTE from service_role; existing records are unaffected.
