-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PUBLISH-MONITOR PR-2c-1 (docs/launch/tasks/PUBLISH-MONITOR.md §4.1, §7, §9 items 14/16/22/24): settle every Post for
-- Me account an attempt touched, retry provider deletions and takeover disconnects, and let a user disconnect.
-- Number 0265 assigned by the controller. Progress lives on the existing rows (plan §8: no new queue tables).
BEGIN;
SET LOCAL lock_timeout='5s';

-- Cleanup progress of an attempt once it can no longer be used (applied, abandoned, or expired). No identity.
ALTER TABLE public.social_connect_requests ADD COLUMN IF NOT EXISTS cleaned_at timestamptz;
ALTER TABLE public.social_connect_requests ADD COLUMN IF NOT EXISTS cleanup_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE public.social_connect_requests ADD COLUMN IF NOT EXISTS cleanup_lease_until timestamptz;
ALTER TABLE public.social_connect_requests ADD COLUMN IF NOT EXISTS cleanup_error text;
-- A proven takeover still has to be cleared at the provider (plan §4.1 step 2) until this is false.
ALTER TABLE public.social_connections ADD COLUMN IF NOT EXISTS provider_disconnect_pending boolean NOT NULL DEFAULT false;
-- A deletion record keeps the owner's non-reversible provider reference (the first half of its external_id), so the
-- worker deletes the provider account only while it still carries that owner's authorization (plan §9 item 14). It
-- is captured when the row enters 'deleting', before account erasure removes the settings row.
ALTER TABLE public.social_connections ADD COLUMN IF NOT EXISTS owner_ref text;
-- Tokens already cleared for a deletion that has to wait for unresolved publishes (plan §4.1: disconnect first).
ALTER TABLE public.social_connections ADD COLUMN IF NOT EXISTS provider_tokens_cleared boolean NOT NULL DEFAULT false;
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.social_connect_requests'::regclass
  AND conname='social_connect_requests_cleanup_check') THEN
  ALTER TABLE public.social_connect_requests ADD CONSTRAINT social_connect_requests_cleanup_check
   CHECK(cleanup_attempts BETWEEN 0 AND 1000 AND (cleanup_error IS NULL OR cleanup_error ~ '^[A-Z0-9_]{1,64}$')
    AND (cleaned_at IS NULL OR state IN ('applied','abandoned')));
 END IF;
END $$;
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.social_connections'::regclass
  AND conname='social_connections_owner_ref_check') THEN
  ALTER TABLE public.social_connections ADD CONSTRAINT social_connections_owner_ref_check
   CHECK(owner_ref IS NULL OR owner_ref ~ '^[0-9a-f]{32}$');
 END IF;
END $$;
CREATE OR REPLACE FUNCTION public.publish_monitor_capture_owner_ref() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.status='deleting' AND OLD.status IS DISTINCT FROM 'deleting' AND NEW.owner_ref IS NULL THEN
  NEW.owner_ref:=(SELECT provider_ref FROM social_monitor_settings WHERE actor_id=NEW.actor_id);
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS social_connections_capture_owner_ref ON public.social_connections;
CREATE TRIGGER social_connections_capture_owner_ref BEFORE UPDATE OF status ON public.social_connections
 FOR EACH ROW EXECUTE FUNCTION public.publish_monitor_capture_owner_ref();
CREATE INDEX IF NOT EXISTS social_connect_requests_cleanup ON public.social_connect_requests(created_at)
 WHERE cleaned_at IS NULL;
CREATE INDEX IF NOT EXISTS social_connections_provider_work ON public.social_connections(updated_at)
 WHERE status='deleting' OR provider_disconnect_pending;

-- Callback (replaces 0246): a late callback of an older attempt arrives with the newer attempt's cookie. If it brought
-- accounts but none carries this attempt's external_id and platform, it is refused without consuming the attempt
-- (plan §9 item 24); the older attempt's accounts are settled by its own cleanup. Takeovers are queued for disconnect.
CREATE OR REPLACE FUNCTION public.publish_monitor_connect_callback(a uuid,p_request_id uuid,p_candidates jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE req social_connect_requests; item jsonb; pid text; existing social_connections;
 fresh text[]:='{}'; own text[]:='{}'; quarantined text[]:='{}'; ignored text[]:='{}';
BEGIN
 IF p_request_id IS NULL OR jsonb_typeof(p_candidates) IS DISTINCT FROM 'array' OR jsonb_array_length(p_candidates)>200 THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 PERFORM publish_monitor_actor(a);
 SELECT * INTO req FROM social_connect_requests WHERE id=p_request_id AND actor_id=a FOR UPDATE;
 IF req.id IS NULL OR req.state<>'awaiting_callback' OR req.expires_at<=clock_timestamp() THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_REQUEST_INVALID' USING ERRCODE='PT409'; END IF;
 FOR item IN SELECT * FROM jsonb_array_elements(p_candidates) LOOP
  pid:=item->>'providerAccountId';
  IF pid IS NULL OR pid !~ '^[A-Za-z0-9_-]{1,128}$' THEN RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  IF item->>'externalId' IS DISTINCT FROM req.external_id OR item->>'platform' IS DISTINCT FROM req.platform THEN
   ignored:=ignored||pid; CONTINUE; END IF;
  SELECT * INTO existing FROM social_connections WHERE provider_account_id=pid FOR UPDATE;
  IF existing.id IS NULL THEN fresh:=fresh||pid;
  ELSIF existing.actor_id=a THEN
   own:=own||pid;
   -- This authorization covers every account it imported: the provider capability follows it, consent does not change.
   UPDATE social_connections SET provider_can_publish='posts'=ANY(req.permissions),updated_at=clock_timestamp()
   WHERE id=existing.id AND provider_can_publish IS DISTINCT FROM ('posts'=ANY(req.permissions));
  ELSE
   -- Proven takeover: the other user's connection stops reading and publishing until its owner re-authorises.
   -- Every takeover bumps updated_at, even on an already quarantined row, so confirm can reject stale facts.
   IF existing.status<>'deleting' THEN
    UPDATE social_connections SET status='quarantined',provider_disconnect_pending=true,deletion_attempts=0,lease_owner=NULL,
     lease_expires_at=NULL,updated_at=clock_timestamp()
    WHERE id=existing.id;
   ELSE
    -- Already deleting: keep the record and queue the disconnect, so the overwriting grant is cleared before it ends.
    UPDATE social_connections SET provider_disconnect_pending=true,deletion_attempts=0,lease_owner=NULL,
     lease_expires_at=NULL,updated_at=clock_timestamp()
    WHERE id=existing.id AND NOT provider_disconnect_pending;
   END IF;
   quarantined:=quarantined||pid;
  END IF;
 END LOOP;
 IF jsonb_array_length(p_candidates)>0 AND cardinality(fresh||own||quarantined)=0 THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_CALLBACK_STALE' USING ERRCODE='PT409'; END IF;
 UPDATE social_connect_requests SET state='pending_confirm',consumed_at=clock_timestamp(),
  confirm_expires_at=clock_timestamp()+interval '10 minutes',candidate_provider_ids=fresh||own
 WHERE id=req.id;
 RETURN jsonb_build_object('requestId',req.id,'platform',req.platform,'newAccounts',to_jsonb(fresh),
  'ownExisting',to_jsonb(own),'quarantined',to_jsonb(quarantined),'ignored',to_jsonb(ignored));
END $$;

-- Daily job: claim attempts whose provider side still has to be settled. Expired open attempts are abandoned first.
-- Each claim holds a lease, so overlapping runs never process the same attempt.
CREATE OR REPLACE FUNCTION public.publish_monitor_cleanup_claim(p_limit integer,p_lease_seconds integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE now_at timestamptz:=clock_timestamp(); out jsonb;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 900 THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 -- Settled attempts are kept 30 days (plan §7), then only the daily orphan sweep remains as a backstop. This runs on
 -- every daily claim, whether or not there is new work.
 DELETE FROM social_connect_requests WHERE cleaned_at IS NOT NULL AND created_at<now_at-interval '30 days';
 UPDATE social_connect_requests SET state='abandoned',confirm_expires_at=NULL
 WHERE (state='awaiting_callback' AND expires_at<=now_at) OR (state='pending_confirm' AND confirm_expires_at<=now_at);
 WITH picked AS (
  SELECT id FROM social_connect_requests
  -- An abandoned attempt's consent link never expires at the provider, so it is checked again daily for 30 days:
  -- an authorization completed later (webhook missed) is still found and settled.
  WHERE state IN ('applied','abandoned') AND cleanup_attempts<50
   AND (cleaned_at IS NULL OR (state='abandoned' AND created_at>now_at-interval '30 days'
    AND cleaned_at<now_at-interval '20 hours'))
   AND (cleanup_lease_until IS NULL OR cleanup_lease_until<=now_at)
  -- Never-settled attempts first, then re-checks by how long ago they were last checked.
  ORDER BY cleaned_at IS NOT NULL,cleaned_at NULLS FIRST,created_at LIMIT p_limit FOR UPDATE SKIP LOCKED
 ), claimed AS (
  -- Attempts are counted when a result is reported (cleanup_finish), so claimed-but-unreached rows lose nothing.
  UPDATE social_connect_requests r SET cleanup_lease_until=now_at+make_interval(secs=>p_lease_seconds)
  FROM picked WHERE r.id=picked.id
  RETURNING r.id,r.external_id,r.platform,r.candidate_provider_ids
 )
 SELECT COALESCE(jsonb_agg(jsonb_build_object('requestId',id,'externalId',external_id,'platform',platform,
  'candidateIds',to_jsonb(candidate_provider_ids)) ORDER BY id),'[]'::jsonb) INTO out FROM claimed;
 RETURN out;
END $$;

-- Decide what to do with provider accounts that currently carry a settled attempt's external_id (facts read by the
-- server). Accounts carrying anything else are not this attempt's to touch. A proven takeover found here is
-- quarantined exactly like in a callback (plan §4.1: rejected callbacks are settled by the same ownership rules).
CREATE OR REPLACE FUNCTION public.publish_monitor_cleanup_classify(p_request_id uuid,p_accounts jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE req social_connect_requests; item jsonb; pid text; existing social_connections; verdicts jsonb:='[]'; verdict text;
BEGIN
 IF p_request_id IS NULL OR jsonb_typeof(p_accounts) IS DISTINCT FROM 'array' OR jsonb_array_length(p_accounts)>5000 THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 SELECT * INTO req FROM social_connect_requests WHERE id=p_request_id FOR UPDATE;
 IF req.id IS NULL OR req.state NOT IN ('applied','abandoned') THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_REQUEST_INVALID' USING ERRCODE='PT409'; END IF;
 FOR item IN SELECT * FROM jsonb_array_elements(p_accounts) LOOP
  pid:=item->>'providerAccountId';
  IF pid IS NULL OR pid !~ '^[A-Za-z0-9_-]{1,128}$' THEN RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO existing FROM social_connections WHERE provider_account_id=pid FOR UPDATE;
  IF item->>'externalId' IS DISTINCT FROM req.external_id THEN verdict:='skip';
  ELSIF existing.id IS NULL THEN verdict:='delete';
  ELSIF existing.status='deleting' THEN
   -- Overwritten after its owner's record began deleting: queue the disconnect on that record; the provider work
   -- clears the overwriting grant before ending it (or holds it while publishes are unresolved).
   UPDATE social_connections SET provider_disconnect_pending=true,deletion_attempts=0,lease_owner=NULL,
    lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=existing.id AND NOT provider_disconnect_pending;
   verdict:='takeover';
  ELSIF existing.actor_id=req.actor_id THEN verdict:='keep';
  ELSE
   UPDATE social_connections SET status='quarantined',provider_disconnect_pending=true,deletion_attempts=0,lease_owner=NULL,
    lease_expires_at=NULL,updated_at=clock_timestamp()
   WHERE id=existing.id;
   verdict:='takeover';
  END IF;
  verdicts:=verdicts||jsonb_build_object('providerAccountId',pid,'action',verdict);
 END LOOP;
 RETURN verdicts;
END $$;

-- Account erasure (replaces the 0240 versions for attempts): an attempt is kept, detached from the brand, until its
-- provider cleanup has succeeded and 30 days have passed since it was made (plan §7), even after it stops being open;
-- otherwise a prune pass could delete the external_id the daily re-check still needs. Other tables keep 0240's rules.
CREATE OR REPLACE FUNCTION public.publish_monitor_erasure_retained(t text,j jsonb) RETURNS boolean
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT CASE t
  WHEN 'social_connections' THEN j->>'provider_account_id' IS NOT NULL
  -- Open jobs hold frozen credits and publish slots: kept until publishing releases or settles them (plan §9 item 17).
  WHEN 'social_publish_jobs' THEN j->>'state' IN ('claimed','dispatching','unknown')
  WHEN 'social_connect_requests' THEN j->>'state' IN ('awaiting_callback','pending_confirm') OR j->>'cleaned_at' IS NULL
   OR (j->>'created_at')::timestamptz>clock_timestamp()-interval '30 days'
  ELSE false END
$$;

CREATE OR REPLACE FUNCTION public.publish_monitor_erasure_scrub(a uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE n integer; total integer:=0;
BEGIN
 PERFORM account_erasure_assert_closed(a);
 -- Posts and snapshots go first through the prune loop; detach retained rows from the brand now.
 UPDATE social_connections SET status='deleting',business_id=NULL,account_project_id=NULL,display_hint=NULL,
  profile_ref=NULL,consent_read=false,consent_auto_track=false,consent_publish=false,refresh_id=NULL,
  refresh_cursor=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
 WHERE actor_id=a AND provider_account_id IS NOT NULL AND status<>'deleting';
 GET DIAGNOSTICS n=ROW_COUNT;total:=total+n;
 UPDATE social_publish_jobs SET business_id=NULL,work_item_id=NULL,updated_at=clock_timestamp()
 WHERE actor_id=a AND state IN ('claimed','dispatching','unknown') AND (business_id IS NOT NULL OR work_item_id IS NOT NULL);
 GET DIAGNOSTICS n=ROW_COUNT;total:=total+n;
 UPDATE social_connect_requests SET business_id=NULL,target_account_project_id=NULL
 WHERE actor_id=a AND (state IN ('awaiting_callback','pending_confirm') OR cleaned_at IS NULL
   OR created_at>clock_timestamp()-interval '30 days')
  AND (business_id IS NOT NULL OR target_account_project_id IS NOT NULL);
 GET DIAGNOSTICS n=ROW_COUNT;total:=total+n;
 RETURN total;
END $$;

CREATE OR REPLACE FUNCTION public.publish_monitor_erasure_remaining(a uuid) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT (SELECT count(*) FROM social_monitor_settings WHERE actor_id=a)
 +(SELECT count(*) FROM social_review_runs WHERE actor_id=a)
 +(SELECT count(*) FROM social_metric_snapshots WHERE actor_id=a)
 +(SELECT count(*) FROM social_posts WHERE actor_id=a)
 +(SELECT count(*) FROM social_connections WHERE actor_id=a AND provider_account_id IS NULL)
 +(SELECT count(*) FROM social_connections WHERE actor_id=a AND provider_account_id IS NOT NULL
   AND (status<>'deleting' OR business_id IS NOT NULL))
 +(SELECT count(*) FROM social_publish_jobs WHERE actor_id=a
   AND (state NOT IN ('claimed','dispatching','unknown') OR business_id IS NOT NULL))
 +(SELECT count(*) FROM social_connect_requests WHERE actor_id=a
   AND (business_id IS NOT NULL OR target_account_project_id IS NOT NULL
    OR NOT (state IN ('awaiting_callback','pending_confirm') OR cleaned_at IS NULL
     OR created_at>clock_timestamp()-interval '30 days')))
$$;

CREATE OR REPLACE FUNCTION public.publish_monitor_cleanup_finish(p_request_id uuid,p_done boolean,p_error text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF p_request_id IS NULL OR p_done IS NULL OR (p_error IS NOT NULL AND p_error !~ '^[A-Z0-9_]{1,64}$') THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 UPDATE social_connect_requests SET cleanup_lease_until=NULL,cleanup_error=CASE WHEN p_done THEN NULL ELSE p_error END,
  cleanup_attempts=CASE WHEN p_done THEN 0 ELSE LEAST(cleanup_attempts+1,1000) END,
  cleaned_at=CASE WHEN p_done THEN clock_timestamp() ELSE cleaned_at END
 WHERE id=p_request_id AND state IN ('applied','abandoned');
END $$;

-- Daily orphan sweep: of the provider accounts listed (all pages first, plan §9 item 22), which are ours to delete?
-- Only accounts with Graylum's own external_id format, not bound to any connection, and not carrying the external_id
-- of an attempt that is still open or not yet settled. Unknown formats are reported, never deleted (environment
-- safety: another environment or a manually connected test account may share the provider project).
CREATE OR REPLACE FUNCTION public.publish_monitor_orphan_classify(p_accounts jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE item jsonb; pid text; ext text; existing social_connections; owner text;
 deletable text[]:='{}'; unknown text[]:='{}'; taken text[]:='{}';
BEGIN
 IF jsonb_typeof(p_accounts) IS DISTINCT FROM 'array' OR jsonb_array_length(p_accounts)>5000 THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 FOR item IN SELECT * FROM jsonb_array_elements(p_accounts) LOOP
  pid:=item->>'providerAccountId'; ext:=item->>'externalId';
  IF pid IS NULL OR pid !~ '^[A-Za-z0-9_-]{1,128}$' THEN RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO existing FROM social_connections WHERE provider_account_id=pid FOR UPDATE;
  IF existing.id IS NOT NULL THEN
   -- A bound account now carrying another user's reference was taken over and the callback or webhook was missed:
   -- quarantine it and queue the disconnect, exactly like a callback that proves a takeover.
   -- An already quarantined row starts a new takeover episode when its account is live again under someone else
   -- (no disconnect pending); a disconnected account needs nothing.
   IF existing.status<>'deleting' AND NOT (existing.status='quarantined' AND existing.provider_disconnect_pending)
    AND item->>'status' IS DISTINCT FROM 'disconnected' AND ext ~ '^[0-9a-f]{32}\.[0-9a-f]{32}$' THEN
    SELECT provider_ref INTO owner FROM social_monitor_settings WHERE actor_id=existing.actor_id;
    IF owner IS NOT NULL AND split_part(ext,'.',1)<>owner THEN
     UPDATE social_connections SET status='quarantined',provider_disconnect_pending=true,deletion_attempts=0,
      lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=existing.id;
     taken:=taken||pid;
    END IF;
   END IF;
   CONTINUE;
  END IF;
  -- Exactly what publish_monitor_random_hex() generates for both halves; anything else is only reported.
  IF ext IS NULL OR ext !~ '^[0-9a-f]{32}\.[0-9a-f]{32}$' THEN unknown:=unknown||pid; CONTINUE; END IF;
  CONTINUE WHEN EXISTS(SELECT 1 FROM social_connect_requests WHERE external_id=ext AND cleaned_at IS NULL);
  deletable:=deletable||pid;
 END LOOP;
 RETURN jsonb_build_object('delete',to_jsonb(deletable),'unknownFormat',to_jsonb(unknown),'takenOver',to_jsonb(taken));
END $$;

-- Daily job: claim provider work on connections. A deletion record is deleted at the provider, unless a publish of
-- its owner still waits for a final result: then its tokens are only cleared (once) and the account is kept for
-- reconciliation (plan §4.1). A proven takeover is disconnected. ownerRef is the reference the provider account must
-- still carry for the action to apply; the server re-reads the account and compares before acting.
CREATE OR REPLACE FUNCTION public.publish_monitor_provider_work_claim(p_limit integer,p_lease_seconds integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE now_at timestamptz:=clock_timestamp(); lease uuid:=gen_random_uuid(); out jsonb;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 900 THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 WITH candidates AS (
  SELECT c.id,c.updated_at,c.status,c.provider_tokens_cleared,
   EXISTS(SELECT 1 FROM social_publish_jobs j WHERE j.actor_id=c.actor_id AND j.state IN ('claimed','dispatching','unknown')
    AND j.targets @> jsonb_build_array(jsonb_build_object('connectionId',c.id::text))) AS publishes_open
  FROM social_connections c
  WHERE c.source='postforme' AND (c.status='deleting' OR c.provider_disconnect_pending) AND c.deletion_attempts<50
   AND (c.lease_expires_at IS NULL OR c.lease_expires_at<=now_at)
 ), picked AS (
  SELECT c.id FROM social_connections c JOIN candidates k ON k.id=c.id
  WHERE NOT (k.status='deleting' AND k.publishes_open AND k.provider_tokens_cleared)
  ORDER BY k.updated_at LIMIT p_limit FOR UPDATE OF c SKIP LOCKED
 ), claimed AS (
  -- Attempts are counted when a result is reported (provider_work_finish), not when claimed.
  UPDATE social_connections c SET lease_owner=lease,lease_expires_at=now_at+make_interval(secs=>p_lease_seconds)
  FROM picked WHERE c.id=picked.id
  RETURNING c.id,c.actor_id,c.provider_account_id,c.status,c.owner_ref,c.provider_disconnect_pending
 )
 SELECT COALESCE(jsonb_agg(jsonb_build_object('connectionId',claimed.id,'providerAccountId',claimed.provider_account_id,
  'deleting',claimed.status='deleting','takeoverPending',claimed.provider_disconnect_pending,
  'action',CASE WHEN claimed.status<>'deleting' OR k.publishes_open THEN 'disconnect' ELSE 'delete' END,
  'ownerRef',CASE WHEN claimed.status='deleting' THEN claimed.owner_ref
   ELSE (SELECT provider_ref FROM social_monitor_settings s WHERE s.actor_id=claimed.actor_id) END) ORDER BY claimed.id),
  '[]'::jsonb) INTO out FROM claimed JOIN candidates k ON k.id=claimed.id;
 RETURN out;
END $$;

-- Outcome of one claimed connection. For a deletion record: 'deleted' or 'gone' (the provider has no such account)
-- ends it; 'owner_changed' (someone else now authorizes that account) ends our record without touching theirs;
-- 'disconnected' marks its tokens cleared while publishes are unresolved. For a takeover: 'disconnected', 'gone' or
-- 'owner_back' settles it. 'retry' records the error for the next run.
CREATE OR REPLACE FUNCTION public.publish_monitor_provider_work_finish(p_connection_id uuid,p_outcome text,p_error text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c social_connections;
BEGIN
 IF p_connection_id IS NULL OR p_outcome NOT IN ('deleted','gone','owner_changed','disconnected','owner_back','retry')
  OR (p_error IS NOT NULL AND p_error !~ '^[A-Z0-9_]{1,64}$') THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 SELECT * INTO c FROM social_connections WHERE id=p_connection_id FOR UPDATE;
 IF c.id IS NULL THEN RETURN; END IF;
 -- A takeover queued after this job was claimed (the queueing clears the lease): the worker's outcome is stale; keep
 -- the record so the next run clears the overwriting grant first.
 IF c.status='deleting' AND c.provider_disconnect_pending AND c.lease_owner IS NULL AND p_outcome<>'gone' THEN
  RETURN;
 END IF;
 -- Unresolved publishes still need this record to reconcile: hold it instead of ending it.
 IF c.status='deleting' AND p_outcome IN ('deleted','gone','owner_changed') AND EXISTS(SELECT 1 FROM social_publish_jobs j
   WHERE j.actor_id=c.actor_id AND j.state IN ('claimed','dispatching','unknown')
    AND j.targets @> jsonb_build_array(jsonb_build_object('connectionId',c.id::text))) THEN
  UPDATE social_connections SET provider_tokens_cleared=true,provider_disconnect_pending=false,deletion_error=NULL,
   deletion_attempts=0,lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=c.id;
  RETURN;
 END IF;
 IF p_outcome IN ('deleted','gone','owner_changed') AND c.status='deleting' THEN
  -- Nothing references a deleting row: its posts and snapshots were removed when it entered 'deleting'.
  DELETE FROM social_connections WHERE id=c.id;
 ELSIF p_outcome='disconnected' AND c.status='deleting' THEN
  -- Held for unresolved publishes: tokens (including any overwriting takeover grant) are cleared, the record stays.
  UPDATE social_connections SET provider_tokens_cleared=true,provider_disconnect_pending=false,deletion_error=NULL,
   deletion_attempts=0,lease_owner=NULL,
   lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=c.id;
 ELSIF p_outcome IN ('deleted','gone','disconnected','owner_back') AND c.provider_disconnect_pending THEN
  -- A settled takeover starts the next episode with a fresh retry allowance.
  UPDATE social_connections SET provider_disconnect_pending=false,deletion_error=NULL,deletion_attempts=0,lease_owner=NULL,
   lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=c.id;
 ELSE
  UPDATE social_connections SET deletion_error=COALESCE(p_error,'PROVIDER_RETRY'),
   deletion_attempts=LEAST(deletion_attempts+1,1000),lease_owner=NULL,lease_expires_at=NULL,
   updated_at=clock_timestamp() WHERE id=c.id;
 END IF;
END $$;

-- The user disconnects one of their own connections ("断开并删除", plan §4.1): their posts and snapshots go now; the
-- row becomes an identity-free deletion record until the provider confirms the account is deleted.
CREATE OR REPLACE FUNCTION public.publish_monitor_disconnect(a uuid,p_connection_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c social_connections;
BEGIN
 IF p_connection_id IS NULL THEN RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 PERFORM publish_monitor_actor(a);
 SELECT * INTO c FROM social_connections WHERE id=p_connection_id AND actor_id=a FOR UPDATE;
 IF c.id IS NULL OR c.status='deleting' THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_CONNECTION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 DELETE FROM social_metric_snapshots WHERE connection_id=c.id;
 DELETE FROM social_posts WHERE connection_id=c.id;
 IF c.source<>'postforme' THEN
  DELETE FROM social_connections WHERE id=c.id;
  RETURN jsonb_build_object('connectionId',c.id,'providerCleanup',false);
 END IF;
 UPDATE social_connections SET status='deleting',business_id=NULL,account_project_id=NULL,display_hint=NULL,
  profile_ref=NULL,consent_read=false,consent_auto_track=false,consent_publish=false,provider_can_publish=false,
  refresh_id=NULL,refresh_cursor=NULL,lease_owner=NULL,lease_expires_at=NULL,deletion_attempts=0,deletion_error=NULL,
  updated_at=clock_timestamp()
 WHERE id=c.id;
 RETURN jsonb_build_object('connectionId',c.id,'providerCleanup',true);
END $$;

-- Provider webhook social.account.updated: a connection whose provider account is now disconnected needs the owner to
-- re-authorise; nothing else changes. Unknown accounts are ignored (the sweep settles them).
CREATE OR REPLACE FUNCTION public.publish_monitor_provider_account_disconnected(p_provider_account_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE n integer;
BEGIN
 IF p_provider_account_id IS NULL OR p_provider_account_id !~ '^[A-Za-z0-9_-]{1,128}$' THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 UPDATE social_connections SET status='reauth_required',lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
 WHERE provider_account_id=p_provider_account_id AND status='connected';
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN n>0;
END $$;

DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('publish_monitor_capture_owner_ref','publish_monitor_connect_callback',
   'publish_monitor_erasure_retained','publish_monitor_erasure_scrub','publish_monitor_erasure_remaining',
   'publish_monitor_cleanup_claim',
   'publish_monitor_cleanup_classify','publish_monitor_cleanup_finish','publish_monitor_orphan_classify',
   'publish_monitor_provider_work_claim','publish_monitor_provider_work_finish','publish_monitor_disconnect',
   'publish_monitor_provider_account_disconnected') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f);
  -- The erasure helpers stay internal, exactly as in 0240.
  IF split_part(f::text,'(',1) NOT IN ('publish_monitor_capture_owner_ref','publish_monitor_erasure_retained',
   'publish_monitor_erasure_scrub','publish_monitor_erasure_remaining') THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f); END IF;
 END LOOP;
END $$;
COMMIT;
