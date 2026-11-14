-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- PUBLISH-MONITOR fix. Number 0548 assigned by the controller.
--   * publish_monitor_publish_key_job(a, p_key): the targets' connection ids and the state of this user's publish job under
--     this idempotency key, or null when there is none. Read only (STABLE, no lock, no insert).
--   * Why: the server read social_publish_jobs directly (publishOptions.ts publishKeyJob, since #1263 on 2026-10-23), but 0240
--     revoked every privilege on that table from service_role; every upload slot with a key and every submit failed with
--     PUBLISH_MONITOR_UNAVAILABLE before reaching the claim (staging: 0 jobs ever). Like every other publish function, the read
--     now goes through a SECURITY DEFINER entry point that only the server can execute; the table keeps no grants.
-- Compatibility: a new function only; the old code never reaches the table, so nothing depends on the old path.
-- Repeatable: CREATE OR REPLACE, REVOKE and GRANT. Recovery: DROP FUNCTION public.publish_monitor_publish_key_job(uuid,text).
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.publish_monitor_publish_key_job(a uuid, p_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE j social_publish_jobs;
BEGIN
 SELECT * INTO j FROM social_publish_jobs WHERE actor_id=a AND idempotency_key=p_key;
 IF j.id IS NULL THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('targets',COALESCE((SELECT jsonb_agg(t->>'connectionId') FROM jsonb_array_elements(j.targets) t
   WHERE t->>'connectionId' IS NOT NULL),'[]'::jsonb),'state',j.state);
END $function$;

REVOKE ALL ON FUNCTION public.publish_monitor_publish_key_job(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.publish_monitor_publish_key_job(uuid,text) TO service_role;

COMMIT;
