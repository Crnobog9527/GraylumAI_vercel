-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- VOICE-2 (Owner 2026-11-14 "加按钮，按用量扣"): the 「从我的账号导入」 panel gets a "读取最新帖子" button for an own TikHub
-- account. It is a manual run of 数据复盘's daily TikHub read of that connection: the same claim shape (publish_monitor_tikhub_item),
-- the same billed-read ledger (social_billed_reads: frozen at the start, charged by what came back, nothing for a failure, a
-- re-run of the same refresh re-uses a stored answer) and the same settle functions. Only the claim is new. Number 0549 from
-- the controller.
--   * publish_monitor_tikhub_request(a, cid, lease_seconds): the user's own connected TikHub connection with read consent, once an
--     hour (manual_refresh_at, as the Post for Me refresh button), never while a read is running. Unlike the daily job it does not
--     need 「每天自动更新」: the user asked for this one read.
--   * publish_monitor_tikhub_request_undo(a, cid, lease, refresh_id): when the read could not start or the balance ran out, the
--     hour is given back, so a user who tops up can try again at once. Only for the current claim of the user's own connection.
-- Compatibility: two new functions only; the daily claim and every existing function are unchanged.
BEGIN;

CREATE OR REPLACE FUNCTION public.publish_monitor_tikhub_request(a uuid, p_connection_id uuid, p_lease_seconds integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE c social_connections; now_at timestamptz:=clock_timestamp();
BEGIN
 IF p_connection_id IS NULL OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 900 THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 PERFORM publish_monitor_actor(a);
 SELECT * INTO c FROM social_connections WHERE id=p_connection_id AND actor_id=a AND role='own'
  AND status NOT IN ('deleting','pending_selection') FOR UPDATE;
 IF c.id IS NULL THEN RAISE EXCEPTION 'PUBLISH_MONITOR_CONNECTION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 IF c.source<>'tikhub' OR c.status<>'connected' OR NOT c.consent_read THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_REFRESH_UNAVAILABLE' USING ERRCODE='42501'; END IF;
 IF c.manual_refresh_at>now_at-interval '1 hour' THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_REFRESH_TOO_SOON' USING ERRCODE='PT429'; END IF;
 -- A read already running (the daily job or another tab) is not doubled.
 IF c.lease_expires_at>now_at THEN RAISE EXCEPTION 'PUBLISH_MONITOR_REFRESH_RUNNING' USING ERRCODE='PT409'; END IF;
 UPDATE social_connections SET lease_owner=gen_random_uuid(),lease_expires_at=now_at+make_interval(secs=>p_lease_seconds),
  refresh_id=COALESCE(refresh_id,gen_random_uuid()),manual_refresh_at=now_at,last_attempt_at=now_at
 WHERE id=c.id RETURNING * INTO c;
 RETURN publish_monitor_tikhub_item(c);
END $function$;

CREATE OR REPLACE FUNCTION public.publish_monitor_tikhub_request_undo(a uuid, p_connection_id uuid, p_lease uuid, p_refresh_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE c social_connections;
BEGIN
 c:=publish_monitor_refresh_current(p_connection_id,p_lease,p_refresh_id);
 IF c.id IS NULL OR c.actor_id IS DISTINCT FROM a OR c.role<>'own' OR c.source<>'tikhub' THEN RETURN false; END IF;
 UPDATE social_connections SET manual_refresh_at=NULL,updated_at=clock_timestamp() WHERE id=c.id;
 RETURN true;
END $function$;

REVOKE ALL ON FUNCTION public.publish_monitor_tikhub_request(uuid,uuid,integer),
 public.publish_monitor_tikhub_request_undo(uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.publish_monitor_tikhub_request(uuid,uuid,integer),
 public.publish_monitor_tikhub_request_undo(uuid,uuid,uuid,uuid) TO service_role;
COMMIT;
