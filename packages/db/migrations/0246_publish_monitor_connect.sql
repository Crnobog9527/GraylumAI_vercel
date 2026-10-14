-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PUBLISH-MONITOR PR-2b-1 (docs/launch/tasks/PUBLISH-MONITOR.md §4.1): the OAuth attempt lifecycle on top of 0240.
-- Number 0246 assigned by the controller. No provider calls here; the server passes provider-verified facts in.
BEGIN;
SET LOCAL lock_timeout='5s';

-- Per-user provider reference: the first half of every Post for Me external_id. Random (gen_random_uuid), never
-- derived from the user ID, so the provider cannot map it back to a Graylum account.
ALTER TABLE public.social_monitor_settings ADD COLUMN IF NOT EXISTS provider_ref text;
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.social_monitor_settings'::regclass
  AND conname='social_monitor_settings_provider_ref_check') THEN
  ALTER TABLE public.social_monitor_settings ADD CONSTRAINT social_monitor_settings_provider_ref_check
   CHECK(provider_ref ~ '^[0-9a-f]{32}$');
 END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS social_monitor_settings_provider_ref ON public.social_monitor_settings(provider_ref)
 WHERE provider_ref IS NOT NULL;

CREATE OR REPLACE FUNCTION public.publish_monitor_random_hex() RETURNS text
LANGUAGE sql VOLATILE SET search_path=public,pg_temp AS $$ SELECT replace(gen_random_uuid()::text,'-','') $$;

-- Start an attempt for one of the actor's own brand accounts. Any earlier attempt still awaiting its callback is
-- abandoned (only the newest may be consumed); abandoned rows stay for provider-side cleanup.
CREATE OR REPLACE FUNCTION public.publish_monitor_connect_start(a uuid,p_account_project_id uuid,p_permissions text[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE acct opc_accounts; ref text; req social_connect_requests; perms text[];
BEGIN
 IF p_account_project_id IS NULL OR p_permissions IS NULL THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 SELECT array_agg(DISTINCT x ORDER BY x) INTO perms FROM unnest(p_permissions) x;
 IF NOT (perms <@ ARRAY['feeds','posts'] AND 'feeds'=ANY(perms)) THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 PERFORM publish_monitor_actor(a);
 SELECT * INTO acct FROM opc_accounts WHERE project_id=p_account_project_id AND actor_id=a AND business_id IS NOT NULL;
 IF acct.project_id IS NULL THEN RAISE EXCEPTION 'PUBLISH_MONITOR_ACCOUNT_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 INSERT INTO social_monitor_settings(actor_id,provider_ref) VALUES(a,publish_monitor_random_hex())
 ON CONFLICT(actor_id) DO UPDATE SET provider_ref=COALESCE(social_monitor_settings.provider_ref,EXCLUDED.provider_ref)
 RETURNING provider_ref INTO ref;
 UPDATE social_connect_requests SET state='abandoned' WHERE actor_id=a AND state='awaiting_callback';
 INSERT INTO social_connect_requests(actor_id,business_id,target_account_project_id,platform,permissions,external_id,
  state,expires_at)
 VALUES(a,acct.business_id,acct.project_id,acct.platform,perms,ref||'.'||publish_monitor_random_hex(),
  'awaiting_callback',clock_timestamp()+interval '10 minutes')
 RETURNING * INTO req;
 RETURN jsonb_build_object('requestId',req.id,'externalId',req.external_id,'platform',req.platform,
  'permissions',to_jsonb(req.permissions));
END $$;

-- Record a callback. p_candidates holds provider facts the server fetched itself (never the callback query):
-- [{providerAccountId, platform, externalId}]. Only accounts whose current external_id equals this attempt's are
-- considered; another user's account is never bound here, and is quarantined only when its provider record proves
-- it was re-authorised away from its owner (its external_id now carries this attempt's value).
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
  ELSIF existing.actor_id=a THEN own:=own||pid;
  ELSE
   -- Proven takeover: the other user's connection stops reading and publishing until its owner re-authorises.
   IF existing.status NOT IN ('deleting','quarantined') THEN
    UPDATE social_connections SET status='quarantined',lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
    WHERE id=existing.id;
   END IF;
   quarantined:=quarantined||pid;
  END IF;
 END LOOP;
 UPDATE social_connect_requests SET state='pending_confirm',consumed_at=clock_timestamp(),
  confirm_expires_at=clock_timestamp()+interval '10 minutes',candidate_provider_ids=fresh||own
 WHERE id=req.id;
 RETURN jsonb_build_object('requestId',req.id,'platform',req.platform,'newAccounts',to_jsonb(fresh),
  'ownExisting',to_jsonb(own),'quarantined',to_jsonb(quarantined),'ignored',to_jsonb(ignored));
END $$;

-- The user picked one account on the confirmation page. The server re-reads that account from the provider just
-- before calling and passes its current facts: they must still be connected and carry this attempt's exact
-- external_id and platform, so an authorization taken over between callback and confirm is never applied.
-- Only the attempt's target brand account changes; consents of any other connection are untouched (plan §4.1).
CREATE OR REPLACE FUNCTION public.publish_monitor_connect_confirm(a uuid,p_request_id uuid,p_provider_account_id text,
 p_auto_track boolean,p_current jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE req social_connect_requests; existing social_connections; target social_connections; conn uuid;
 publish boolean;
BEGIN
 IF p_request_id IS NULL OR p_provider_account_id IS NULL OR p_auto_track IS NULL THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 PERFORM publish_monitor_actor(a);
 SELECT * INTO req FROM social_connect_requests WHERE id=p_request_id AND actor_id=a FOR UPDATE;
 IF req.id IS NULL OR req.state<>'pending_confirm' OR req.confirm_expires_at<=clock_timestamp()
  OR req.target_account_project_id IS NULL OR NOT (p_provider_account_id=ANY(req.candidate_provider_ids)) THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_REQUEST_INVALID' USING ERRCODE='PT409'; END IF;
 IF jsonb_typeof(p_current) IS DISTINCT FROM 'object' OR p_current->>'providerAccountId' IS DISTINCT FROM p_provider_account_id
  OR p_current->>'externalId' IS DISTINCT FROM req.external_id OR p_current->>'platform' IS DISTINCT FROM req.platform
  OR p_current->>'status' IS DISTINCT FROM 'connected' THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_AUTHORIZATION_CHANGED' USING ERRCODE='PT409'; END IF;
 publish:='posts'=ANY(req.permissions);
 SELECT * INTO existing FROM social_connections WHERE provider_account_id=p_provider_account_id FOR UPDATE;
 IF existing.id IS NOT NULL AND existing.actor_id<>a THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_ACCOUNT_OWNED_ELSEWHERE' USING ERRCODE='42501'; END IF;
 SELECT * INTO target FROM social_connections WHERE account_project_id=req.target_account_project_id
  AND status IN ('connected','reauth_required','quarantined') FOR UPDATE;
 IF existing.id IS NOT NULL THEN
  IF existing.status='deleting' OR existing.account_project_id IS DISTINCT FROM req.target_account_project_id THEN
   RAISE EXCEPTION 'PUBLISH_MONITOR_ACCOUNT_BOUND_ELSEWHERE' USING ERRCODE='PT409'; END IF;
  -- Quarantined after this attempt's callback: another user's later callback proved a takeover that the server's
  -- re-read may have raced past. Only a quarantine that predates this attempt can be lifted by confirming it.
  IF existing.status='quarantined' AND existing.updated_at>req.consumed_at THEN
   RAISE EXCEPTION 'PUBLISH_MONITOR_AUTHORIZATION_CHANGED' USING ERRCODE='PT409'; END IF;
  UPDATE social_connections SET status='connected',consent_read=true,consent_auto_track=p_auto_track,
   consent_publish=CASE WHEN publish THEN true ELSE consent_publish END,
   -- Capability follows this authorization (a read-only re-authorization drops it); consent stays the user's choice.
   provider_can_publish=publish,updated_at=clock_timestamp()
  WHERE id=existing.id RETURNING id INTO conn;
 ELSE
  IF target.id IS NOT NULL THEN RAISE EXCEPTION 'PUBLISH_MONITOR_TARGET_ALREADY_CONNECTED' USING ERRCODE='PT409'; END IF;
  INSERT INTO social_connections(actor_id,business_id,account_project_id,role,source,platform,provider_account_id,status,
   consent_read,consent_auto_track,consent_publish,provider_can_publish)
  VALUES(a,req.business_id,req.target_account_project_id,'own','postforme',req.platform,p_provider_account_id,'connected',
   true,p_auto_track,publish,publish)
  RETURNING id INTO conn;
 END IF;
 UPDATE social_connect_requests SET state='applied',confirm_expires_at=NULL WHERE id=req.id;
 RETURN jsonb_build_object('connectionId',conn,'unselected',to_jsonb(ARRAY(
  SELECT x FROM unnest(req.candidate_provider_ids) x
  WHERE x<>p_provider_account_id AND NOT EXISTS(SELECT 1 FROM social_connections c WHERE c.provider_account_id=x))));
END $$;

DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('publish_monitor_random_hex','publish_monitor_connect_start',
   'publish_monitor_connect_callback','publish_monitor_connect_confirm') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f);
  IF split_part(f::text,'(',1) IN ('publish_monitor_connect_start','publish_monitor_connect_callback',
   'publish_monitor_connect_confirm') THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f);END IF;
 END LOOP;
END $$;
COMMIT;
