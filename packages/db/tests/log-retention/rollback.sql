-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Recovery for 0226. First deploy application code that no longer calls log_retention_cleanup
-- (otherwise the daily cron counts a failure), then run this. It restores the pre-0226 behaviour:
-- erasure deletes user_activity_logs rows again (0191), the 0192 log guard, and the old remaining count.
-- Not restorable: log rows already deleted after 30 days, and audit text already scrubbed on erased
-- accounts (that is the point of erasure). content_erased_at stays so scrubbed rows remain identifiable.
BEGIN;
DO $$
DECLARE source text; old_text text; new_text text;
BEGIN
 source:=pg_get_functiondef('public.account_erasure_local_cleanup(uuid,boolean)'::regprocedure);
 new_text:=E' UPDATE user_activity_logs SET action=action_type,ip_address=NULL,details=erasure_audit_details(details),\n'
  ||E'  content_erased_at=clock_timestamp() WHERE ctid IN (SELECT ctid FROM user_activity_logs\n'
  ||E'  WHERE user_id=p_profile_id AND content_erased_at IS NULL LIMIT 100 FOR UPDATE SKIP LOCKED);\n'
  ||E' FOR entry IN SELECT unnest(ARRAY[''application_logs'',''user_checkins'']) tbl LOOP\n';
 old_text:=E' FOR entry IN SELECT unnest(ARRAY[''application_logs'',''user_activity_logs'',''user_checkins'']) tbl LOOP\n';
 IF position(new_text IN source)>0 THEN EXECUTE replace(source,new_text,old_text); END IF;
 source:=pg_get_functiondef('public.account_erasure_local_remaining(uuid)'::regprocedure);
 new_text:='+(SELECT count(*) FROM user_activity_logs WHERE user_id=p_profile_id AND content_erased_at IS NULL)';
 old_text:='+(SELECT count(*) FROM user_activity_logs WHERE user_id=p_profile_id)';
 IF position(new_text IN source)>0 THEN EXECUTE replace(source,new_text,old_text); END IF;
END $$;
CREATE OR REPLACE FUNCTION public.account_erasure_log_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=NEW.user_id)
  OR TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=OLD.user_id) THEN
  RETURN NULL;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.account_erasure_log_guard() FROM PUBLIC,anon,authenticated,service_role;
DROP FUNCTION IF EXISTS public.erasure_audit_details(jsonb);
DROP FUNCTION IF EXISTS public.log_retention_cleanup(integer);
COMMIT;
