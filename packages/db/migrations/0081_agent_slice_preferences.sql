/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Explicit confirmed preferences only. No model-generated memory or remote seeds.
BEGIN;
CREATE TABLE IF NOT EXISTS public.agent_confirmed_preferences (
 actor_id uuid NOT NULL REFERENCES public.profiles(id),
 scope_key text NOT NULL CHECK(scope_key='user' OR scope_key ~ '^account:[a-z0-9][a-z0-9._:-]{0,159}$'),
 name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 80),
 value text CHECK(char_length(value) BETWEEN 1 AND 1000),
 version integer NOT NULL CHECK(version>0),
 active boolean NOT NULL,
 source text NOT NULL CHECK(source='explicit_user_confirmation'),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(actor_id,scope_key,name), CHECK(active=(value IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS public.agent_preference_requests (
 actor_id uuid NOT NULL REFERENCES public.profiles(id),request_id uuid NOT NULL,
 payload_hash text NOT NULL,version integer NOT NULL,
 PRIMARY KEY(actor_id,request_id)
);
ALTER TABLE public.agent_confirmed_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_preference_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.agent_confirmed_preferences,public.agent_preference_requests FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.agent_preference(p_actor_id uuid,p_action text,p_payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE scope text:=p_payload->>'scope'; key text:=p_payload->>'name'; pref agent_confirmed_preferences%ROWTYPE;
 request agent_preference_requests%ROWTYPE; digest text:=artifact_hash(jsonb_build_object('action',p_action,'payload',p_payload)); next_version integer;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false') THEN RAISE EXCEPTION 'PREFERENCE_DENIED'; END IF;
 IF scope IS NULL OR (scope<>'user' AND NOT EXISTS(SELECT 1 FROM artifact_accounts WHERE actor_id=p_actor_id AND 'account:'||account=scope)) THEN RAISE EXCEPTION 'PREFERENCE_DENIED'; END IF;
 IF p_action='read' THEN
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('scope',scope_key,'name',name,'value',value,'version',version,'active',active,'source',source) ORDER BY name)
  FROM agent_confirmed_preferences WHERE actor_id=p_actor_id AND scope_key=scope),'[]');
 END IF;
 IF p_action NOT IN ('confirm','delete') OR p_payload->>'confirmed' IS DISTINCT FROM 'true' OR key IS NULL OR char_length(key) NOT BETWEEN 1 AND 80 OR p_payload->>'requestId' IS NULL THEN RAISE EXCEPTION 'PREFERENCE_DENIED'; END IF;
 -- Replays contain hashes and metadata, never an old preference value.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text, 413));
 SELECT * INTO request FROM agent_preference_requests WHERE actor_id=p_actor_id AND request_id=(p_payload->>'requestId')::uuid;
 IF FOUND THEN
  IF request.payload_hash<>digest THEN RAISE EXCEPTION 'PREFERENCE_CONFLICT'; END IF;
  RETURN jsonb_build_object('version',request.version);
 END IF;
 SELECT * INTO pref FROM agent_confirmed_preferences WHERE actor_id=p_actor_id AND scope_key=scope AND name=key FOR UPDATE;
 IF coalesce(pref.version,0) IS DISTINCT FROM (p_payload->>'expectedVersion')::integer THEN RAISE EXCEPTION 'PREFERENCE_CONFLICT'; END IF;
 IF p_action='confirm' AND (p_payload->>'value' IS NULL OR char_length(btrim(p_payload->>'value')) NOT BETWEEN 1 AND 1000) THEN RAISE EXCEPTION 'PREFERENCE_DENIED'; END IF;
 IF p_action='confirm' AND NOT coalesce(pref.active,false) AND
  (SELECT count(*) FROM agent_confirmed_preferences WHERE actor_id=p_actor_id AND scope_key=scope AND active)>=20
 THEN RAISE EXCEPTION 'PREFERENCE_DENIED'; END IF;
 next_version:=coalesce(pref.version,0)+1;
 INSERT INTO agent_confirmed_preferences(actor_id,scope_key,name,value,version,active,source)
 VALUES(p_actor_id,scope,key,CASE WHEN p_action='confirm' THEN btrim(p_payload->>'value') ELSE NULL END,next_version,p_action='confirm','explicit_user_confirmation')
 ON CONFLICT(actor_id,scope_key,name) DO UPDATE SET value=excluded.value,version=excluded.version,active=excluded.active,updated_at=clock_timestamp();
 INSERT INTO agent_preference_requests VALUES(p_actor_id,(p_payload->>'requestId')::uuid,digest,next_version);
 RETURN jsonb_build_object('version',next_version);
END $$;
REVOKE ALL ON FUNCTION public.agent_preference(uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.agent_preference(uuid,text,jsonb) TO service_role;
COMMIT;
