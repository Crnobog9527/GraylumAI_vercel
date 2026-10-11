-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- MODEL-IDENTITY-GUARD switch. Allocation: controller 2026-10-12 (0216; 0217 follows).
-- One admin switch, default on when absent. It controls the brand identity layers and
-- page display only; network responses never carry provider model ids either way.
-- Every change records who and when, inside the value and in user_activity_logs.
-- Recovery: forward only. The key may be deleted by postgres to fall back to the
-- default (on); never re-open direct service-role writes to this key.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.model_identity_guard_config() RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
DECLARE v jsonb;
BEGIN
 SELECT value INTO v FROM system_settings WHERE key='model_identity_guard';
 IF v IS NULL THEN RETURN jsonb_build_object('version',1,'enabled',true,'revision',0,
  'updatedBy',NULL,'updatedAt',NULL);END IF;
 IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR v->'version' IS DISTINCT FROM '1'::jsonb
  OR jsonb_typeof(v->'enabled') IS DISTINCT FROM 'boolean'
  OR jsonb_typeof(v->'revision') IS DISTINCT FROM 'number'
  OR v->>'revision' !~ '^(0|[1-9][0-9]{0,9})$'
  OR (v - ARRAY['version','enabled','revision','updatedBy','updatedAt'])<>'{}'::jsonb
 THEN RAISE EXCEPTION 'MODEL_IDENTITY_GUARD_CONFIG_INVALID';END IF;
 RETURN v;
END $$;

CREATE OR REPLACE FUNCTION public.model_identity_guard_set(
 p_enabled boolean,p_expected_revision bigint,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE prior jsonb;revision bigint;v jsonb;
BEGIN
 IF p_enabled IS NULL OR p_actor IS NULL OR p_expected_revision IS NULL
  OR p_expected_revision<0 OR p_expected_revision>=9999999999
 THEN RAISE EXCEPTION 'MODEL_IDENTITY_GUARD_INPUT_INVALID' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor AND role='admin'
  AND status='active' AND is_deleted::text='false')
 THEN RAISE EXCEPTION 'MODEL_IDENTITY_GUARD_ACTOR_DENIED' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(216,1);
 prior:=model_identity_guard_config();
 revision:=(prior->>'revision')::bigint;
 IF p_expected_revision<>revision THEN
  RAISE EXCEPTION 'MODEL_IDENTITY_GUARD_VERSION_CONFLICT' USING ERRCODE='PT409';
 END IF;
 v:=jsonb_build_object('version',1,'enabled',p_enabled,'revision',revision+1,
  'updatedBy',p_actor,'updatedAt',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
 INSERT INTO system_settings(key,value) VALUES('model_identity_guard',v)
 ON CONFLICT(key) DO UPDATE SET value=excluded.value;
 INSERT INTO user_activity_logs(admin_id,action,action_type,details)
 VALUES(p_actor,'model_identity_guard_set','settings',jsonb_build_object(
  'enabled',p_enabled,'previousEnabled',prior->'enabled','revision',revision+1));
 RETURN model_identity_guard_config();
END $$;

-- Only the postgres-owned writer above may change this key; old or generic
-- service-role upserts (settings.updateSystemSettings) are rejected.
CREATE OR REPLACE FUNCTION public.model_identity_guard_settings_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF ((TG_OP<>'INSERT' AND OLD.key='model_identity_guard')
  OR (TG_OP<>'DELETE' AND NEW.key='model_identity_guard')) AND current_user<>'postgres' THEN
  RAISE EXCEPTION 'MODEL_IDENTITY_GUARD_DEDICATED_WRITE_REQUIRED' USING ERRCODE='42501';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS model_identity_guard_settings_guard ON public.system_settings;
CREATE TRIGGER model_identity_guard_settings_guard BEFORE INSERT OR UPDATE OR DELETE ON public.system_settings
 FOR EACH ROW EXECUTE FUNCTION public.model_identity_guard_settings_guard();

ALTER FUNCTION public.model_identity_guard_set(boolean,bigint,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.model_identity_guard_config(),
 public.model_identity_guard_set(boolean,bigint,uuid),
 public.model_identity_guard_settings_guard() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.model_identity_guard_config(),
 public.model_identity_guard_set(boolean,bigint,uuid) TO service_role;
COMMIT;
