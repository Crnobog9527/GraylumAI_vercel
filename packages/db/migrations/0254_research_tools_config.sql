-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- RESEARCH-TOOLS RT-2b: admin-only, revision-checked writer for research_tools_config.
-- Allocation: controller 2026-10-14 (0254). Template: 0216 model_identity_guard.
-- The full shape is validated in the API (zod) before this call; the database enforces the
-- invariants that must hold whoever calls it:
--   * only an active, non-deleted admin may write; stale revisions fail with PT409;
--   * hard-cap attestations are written by the server only (who and when come from p_actor and
--     now(), never from the client), and a supplier cannot be enabled without one;
--   * no other path (e.g. the generic settings upsert) may write this key.
-- Audit rows in user_activity_logs carry only a summary and a hash of the stored value. The
-- config holds no secrets (supplier keys live in env vars), and the audit never copies it.
-- Recovery: forward only. postgres may delete the key, which turns all research calls off.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.research_tools_config_set(
 p_config jsonb,p_attest_vendors text[],p_expected_revision bigint,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE prior jsonb;revision bigint;vendors jsonb:='{}'::jsonb;vendor text;enabled jsonb;attested jsonb;
 stamp text:=to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');v jsonb;
BEGIN
 IF p_config IS NULL OR p_actor IS NULL OR p_expected_revision IS NULL OR p_attest_vendors IS NULL
  OR p_expected_revision<0 OR p_expected_revision>=9999999999
  OR jsonb_typeof(p_config) IS DISTINCT FROM 'object'
  OR p_config ?| ARRAY['revision','updatedBy','updatedAt']
  OR jsonb_typeof(p_config->'vendors') IS DISTINCT FROM 'object'
  OR ((p_config->'vendors') - ARRAY['tikhub','parallel','firecrawl'])<>'{}'::jsonb
  OR cardinality(p_attest_vendors)>3
  OR EXISTS(SELECT 1 FROM unnest(p_attest_vendors) a WHERE a IS NULL OR a NOT IN ('tikhub','parallel','firecrawl'))
 THEN RAISE EXCEPTION 'RESEARCH_TOOLS_INPUT_INVALID' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor AND role='admin'
  AND status='active' AND is_deleted::text='false')
 THEN RAISE EXCEPTION 'RESEARCH_TOOLS_ACTOR_DENIED' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(254,1);
 SELECT value INTO prior FROM system_settings WHERE key='research_tools_config';
 revision:=CASE WHEN prior ? 'revision' AND prior->>'revision' ~ '^(0|[1-9][0-9]{0,9})$'
  THEN (prior->>'revision')::bigint ELSE 0 END;
 IF p_expected_revision<>revision THEN
  RAISE EXCEPTION 'RESEARCH_TOOLS_VERSION_CONFLICT' USING ERRCODE='PT409';
 END IF;
 FOREACH vendor IN ARRAY ARRAY['tikhub','parallel','firecrawl'] LOOP
  enabled:=p_config->'vendors'->vendor->'enabled';
  IF jsonb_typeof(enabled) IS DISTINCT FROM 'boolean' THEN
   RAISE EXCEPTION 'RESEARCH_TOOLS_INPUT_INVALID' USING ERRCODE='23514';END IF;
  -- Attestation is server-stamped; a client-supplied hardCapAttested is ignored.
  attested:=CASE WHEN vendor=ANY(p_attest_vendors) THEN jsonb_build_object('by',p_actor,'at',stamp)
   ELSE prior->'vendors'->vendor->'hardCapAttested' END;
  -- Keep a prior attestation only if it has the exact server-written shape; a malformed one is
  -- dropped so an admin can repair an invalid row through this writer (direct writes are blocked).
  IF NOT (jsonb_typeof(attested)='object' AND (attested - ARRAY['by','at'])='{}'::jsonb
   AND attested->>'by' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND attested->>'at' ~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,6})?Z$')
  THEN attested:=NULL;END IF;
  IF enabled='true'::jsonb AND attested IS NULL THEN
   RAISE EXCEPTION 'RESEARCH_TOOLS_HARD_CAP_REQUIRED' USING ERRCODE='23514';END IF;
  vendors:=vendors||jsonb_build_object(vendor,jsonb_build_object('enabled',enabled,
   'hardCapAttested',coalesce(attested,'null'::jsonb)));
 END LOOP;
 v:=p_config||jsonb_build_object('vendors',vendors,'revision',revision+1,'updatedBy',p_actor,'updatedAt',stamp);
 INSERT INTO system_settings(key,value) VALUES('research_tools_config',v)
 ON CONFLICT(key) DO UPDATE SET value=excluded.value;
 INSERT INTO user_activity_logs(admin_id,action,action_type,details)
 VALUES(p_actor,'research_tools_config_set','settings',jsonb_build_object(
  'revision',revision+1,'previousRevision',revision,
  'enabled',p_config->'enabled','previousEnabled',prior->'enabled',
  'vendorsEnabled',jsonb_build_object('tikhub',vendors->'tikhub'->'enabled',
   'parallel',vendors->'parallel'->'enabled','firecrawl',vendors->'firecrawl'->'enabled'),
  'hardCapAttested',to_jsonb(p_attest_vendors),
  'valueSha256',encode(sha256(convert_to(v::text,'UTF8')),'hex')));
 RETURN v;
END $$;

-- Only the postgres-owned writer above may change this key.
CREATE OR REPLACE FUNCTION public.research_tools_settings_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF ((TG_OP<>'INSERT' AND OLD.key='research_tools_config')
  OR (TG_OP<>'DELETE' AND NEW.key='research_tools_config')) AND current_user<>'postgres' THEN
  RAISE EXCEPTION 'RESEARCH_TOOLS_DEDICATED_WRITE_REQUIRED' USING ERRCODE='42501';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS research_tools_settings_guard ON public.system_settings;
CREATE TRIGGER research_tools_settings_guard BEFORE INSERT OR UPDATE OR DELETE ON public.system_settings
 FOR EACH ROW EXECUTE FUNCTION public.research_tools_settings_guard();

ALTER FUNCTION public.research_tools_config_set(jsonb,text[],bigint,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.research_tools_config_set(jsonb,text[],bigint,uuid),
 public.research_tools_settings_guard() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.research_tools_config_set(jsonb,text[],bigint,uuid) TO service_role;
COMMIT;
