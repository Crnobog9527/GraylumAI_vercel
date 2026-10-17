-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Rollback for 0271_legacy_close_dead_tables.sql. NOT a migration: run by hand only, after approval.
-- Recreates the three tables (structure, constraints, index, erasure guard trigger, RLS, grants), the functions
-- ordinary_chat_transition / ordinary_chat_delete_guard with their grants and the conversations delete trigger,
-- then undoes 0271's text patches in the seven function bodies. Definitions were taken from a database built from
-- files at staging before 0271 (pg_dump --schema-only); local test: build -> fingerprint -> 0271 -> this script ->
-- the fingerprint equals the pre-0271 one.
-- The dropped rows are not restored (staging had none: read-only check 2026-10-16). Patch reversal works on the
-- current function bodies, so later migrations that changed other parts of the same functions are kept.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE TABLE public.agent_confirmed_preferences (
    actor_id uuid NOT NULL,
    scope_key text NOT NULL,
    name text NOT NULL,
    value text,
    version integer NOT NULL,
    active boolean NOT NULL,
    source text NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT agent_confirmed_preferences_check CHECK ((active = (value IS NOT NULL))),
    CONSTRAINT agent_confirmed_preferences_name_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 80))),
    CONSTRAINT agent_confirmed_preferences_scope_key_check CHECK (((scope_key = 'user'::text) OR (scope_key ~ '^account:[a-z0-9][a-z0-9._:-]{0,159}$'::text))),
    CONSTRAINT agent_confirmed_preferences_source_check CHECK ((source = 'explicit_user_confirmation'::text)),
    CONSTRAINT agent_confirmed_preferences_value_check CHECK (((char_length(value) >= 1) AND (char_length(value) <= 1000))),
    CONSTRAINT agent_confirmed_preferences_version_check CHECK ((version > 0))
);
CREATE TABLE public.agent_preference_requests (
    actor_id uuid NOT NULL,
    request_id uuid NOT NULL,
    payload_hash text NOT NULL,
    version integer NOT NULL
);
CREATE TABLE public.ordinary_chat_requests (
    request_id uuid NOT NULL,
    user_id uuid NOT NULL,
    input jsonb,
    conversation_id uuid NOT NULL,
    writer_token uuid,
    state text DEFAULT 'preparing'::text NOT NULL,
    pre_deduct_id uuid,
    reservation jsonb,
    response_params jsonb,
    partial_content text,
    billing_result jsonb,
    failure_reason text,
    stop_requested_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    erased_at timestamp with time zone,
    CONSTRAINT erasure_cleared_d0aada79f041e926 CHECK (((erased_at IS NULL) OR ((failure_reason IS NULL) AND (input IS NULL) AND (partial_content IS NULL) AND (response_params IS NULL) AND (writer_token IS NULL)))),
    CONSTRAINT erasure_present_0f0810d2785047b5 CHECK (((erased_at IS NOT NULL) OR (input IS NOT NULL))),
    CONSTRAINT erasure_present_a65cff4f821f9c5e CHECK (((erased_at IS NOT NULL) OR (writer_token IS NOT NULL))),
    CONSTRAINT ordinary_chat_requests_state_check CHECK ((state = ANY (ARRAY['preparing'::text, 'running'::text, 'unknown'::text, 'responded'::text, 'succeeded'::text, 'failed'::text])))
);
ALTER TABLE ONLY public.agent_confirmed_preferences
    ADD CONSTRAINT agent_confirmed_preferences_pkey PRIMARY KEY (actor_id, scope_key, name);
ALTER TABLE ONLY public.agent_preference_requests
    ADD CONSTRAINT agent_preference_requests_pkey PRIMARY KEY (actor_id, request_id);
ALTER TABLE ONLY public.ordinary_chat_requests
    ADD CONSTRAINT ordinary_chat_requests_pkey PRIMARY KEY (request_id);
CREATE INDEX ordinary_chat_requests_conversation ON public.ordinary_chat_requests USING btree (user_id, conversation_id, created_at);
CREATE TRIGGER a_erased_row_guard BEFORE UPDATE ON public.ordinary_chat_requests FOR EACH ROW EXECUTE FUNCTION public.erased_row_guard('writer_token', 'input', 'response_params', 'partial_content', 'failure_reason', 'reservation=keys:pre_deduct_id,balance_before,balance_after,is_idempotent', 'billing_result=keys:user_message_id,assistant_message_id,transaction_id,settle_id,refund_id,balance_after,refunded_credits,refund_amount');
ALTER TABLE ONLY public.agent_confirmed_preferences
    ADD CONSTRAINT agent_confirmed_preferences_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.profiles(id);
ALTER TABLE ONLY public.agent_preference_requests
    ADD CONSTRAINT agent_preference_requests_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.profiles(id);
ALTER TABLE ONLY public.ordinary_chat_requests
    ADD CONSTRAINT ordinary_chat_requests_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;
ALTER TABLE ONLY public.ordinary_chat_requests
    ADD CONSTRAINT ordinary_chat_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id);
ALTER TABLE public.agent_confirmed_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_preference_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ordinary_chat_requests ENABLE ROW LEVEL SECURITY;
-- Default privileges would otherwise grant the client roles access to the recreated tables.
REVOKE ALL ON public.ordinary_chat_requests,public.agent_confirmed_preferences,public.agent_preference_requests
 FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.ordinary_chat_requests TO service_role;

CREATE OR REPLACE FUNCTION public.ordinary_chat_delete_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF EXISTS(SELECT 1 FROM ordinary_chat_requests WHERE conversation_id=OLD.id AND state NOT IN ('succeeded','failed')) THEN RETURN NULL; END IF;
  RETURN OLD;
END $function$
;
CREATE OR REPLACE FUNCTION public.ordinary_chat_transition(p_user_id uuid, p_request_id uuid, p_writer_token uuid, p_action text, p_params jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r ordinary_chat_requests; v jsonb; p jsonb;
BEGIN
  SELECT * INTO r FROM ordinary_chat_requests WHERE request_id=p_request_id FOR UPDATE;
  IF NOT FOUND OR r.user_id IS DISTINCT FROM p_user_id OR r.writer_token IS DISTINCT FROM p_writer_token THEN RAISE EXCEPTION 'CHAT_ACCESS_DENIED'; END IF;
  IF p_action='reserve' THEN
    IF r.state<>'preparing' THEN RAISE EXCEPTION 'CHAT_STATE_CONFLICT'; END IF;
    IF r.reservation IS NOT NULL THEN RETURN jsonb_build_array(r.reservation || '{"is_idempotent":true}'::jsonb); END IF;
    -- Old billing/Skill identities cannot be adopted into a new chat request.
    IF EXISTS(SELECT 1 FROM billing_history WHERE user_id=p_user_id AND metadata->>'requestId'=p_request_id::text) THEN RAISE EXCEPTION 'CHAT_IDENTITY_CONFLICT'; END IF;
    SELECT to_jsonb(b) INTO v FROM atomic_pre_deduct(p_user_id,(p_params->>'p_amount')::integer,'AI 对话预扣',p_request_id) b;
    UPDATE ordinary_chat_requests SET pre_deduct_id=(v->>'pre_deduct_id')::uuid,reservation=v,updated_at=now() WHERE request_id=p_request_id;
    RETURN jsonb_build_array(v);
  ELSIF p_action='dispatch' THEN
    IF r.state<>'preparing' THEN RAISE EXCEPTION 'CHAT_ALREADY_DISPATCHED'; END IF;
    UPDATE ordinary_chat_requests SET state='running',updated_at=now() WHERE request_id=p_request_id;
  ELSIF p_action='respond' THEN
    IF r.state NOT IN ('running','unknown','responded') THEN RAISE EXCEPTION 'CHAT_STATE_CONFLICT'; END IF;
    IF r.response_params IS NOT NULL AND r.response_params<>p_params THEN RAISE EXCEPTION 'CHAT_RESPONSE_CONFLICT'; END IF;
    IF p_params->>'p_user_id' IS DISTINCT FROM p_user_id::text
      OR p_params->>'p_conversation_id' IS DISTINCT FROM r.conversation_id::text
      OR p_params->>'p_request_id' IS DISTINCT FROM p_request_id::text
      OR p_params->>'p_user_message' IS DISTINCT FROM r.input->>'message'
      OR (p_params->>'p_pre_deduct_id')::uuid IS DISTINCT FROM r.pre_deduct_id THEN RAISE EXCEPTION 'CHAT_IDENTITY_CONFLICT'; END IF;
    UPDATE ordinary_chat_requests SET state='responded',response_params=p_params,updated_at=now() WHERE request_id=p_request_id;
  ELSIF p_action='success' THEN
    IF r.state='succeeded' THEN RETURN jsonb_build_array(r.billing_result); END IF;
    IF r.state<>'responded' OR r.response_params IS NULL THEN RAISE EXCEPTION 'CHAT_STATE_CONFLICT'; END IF;
    p:=r.response_params;
    SELECT to_jsonb(b) INTO v FROM atomic_finalize_ai_success(
      p_user_id,r.conversation_id,r.input->>'message',p->>'p_assistant_message',p->>'p_model_used',
      (p->>'p_total_cost_usd')::numeric,(p->>'p_total_credits')::integer,r.pre_deduct_id,
      p->'p_usage',p->'p_token_metadata',p->'p_usage_metadata',p_request_id::text,
      (p->>'p_input_length')::integer,(p->>'p_latency_ms')::integer,(p->>'p_search_count')::integer,
      p->>'p_ip_address',p->>'p_user_agent') b;
    UPDATE ordinary_chat_requests SET state='succeeded',billing_result=v,updated_at=now() WHERE request_id=p_request_id;
    UPDATE messages SET is_deleted='true',deleted_at=c.deleted_at
      FROM conversations c WHERE c.id=r.conversation_id AND c.is_deleted='true'
      AND messages.id IN ((v->>'user_message_id')::uuid,(v->>'assistant_message_id')::uuid);
    RETURN jsonb_build_array(v);
  ELSIF p_action='failure' THEN
    IF r.state='failed' THEN RETURN jsonb_build_array(r.billing_result); END IF;
    -- Post-dispatch refund requires a strictly proven unmetered 429 refusal.
    IF r.state<>'preparing' AND (r.state IN ('running','unknown') AND p_params->>'p_reason'='provider_rate_limited') IS NOT TRUE THEN RAISE EXCEPTION 'CHAT_FAILURE_UNPROVEN'; END IF;
    SELECT to_jsonb(b) INTO v FROM atomic_finalize_ai_failure(p_user_id,
      COALESCE(p_params->>'p_model_used','unknown'),p_params->>'p_reason',r.pre_deduct_id,
      r.conversation_id,p_request_id::text,length(r.input->>'message'),NULL,NULL,NULL,
      COALESCE(p_params->'p_usage_metadata','{}'::jsonb)) b;
    UPDATE ordinary_chat_requests SET state='failed',failure_reason=p_params->>'p_reason',billing_result=v,updated_at=now() WHERE request_id=p_request_id;
    RETURN jsonb_build_array(v);
  ELSIF p_action='unknown' THEN
    UPDATE ordinary_chat_requests SET state='unknown',partial_content=COALESCE(p_params->>'partialContent',partial_content),updated_at=now() WHERE request_id=p_request_id AND state IN ('preparing','running','unknown');
  ELSIF p_action='stop' THEN
    UPDATE ordinary_chat_requests SET stop_requested_at=COALESCE(stop_requested_at,now()) WHERE request_id=p_request_id;
  ELSE RAISE EXCEPTION 'CHAT_ACTION_INVALID'; END IF;
  SELECT to_jsonb(t) INTO v FROM ordinary_chat_requests t WHERE request_id=p_request_id;
  RETURN v;
END $function$
;
ALTER FUNCTION public.ordinary_chat_delete_guard() OWNER TO postgres;
ALTER FUNCTION public.ordinary_chat_transition(uuid,uuid,uuid,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.ordinary_chat_delete_guard() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.ordinary_chat_transition(uuid,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ordinary_chat_transition(uuid,uuid,uuid,text,jsonb) TO service_role;
CREATE TRIGGER ordinary_chat_delete BEFORE DELETE ON public.conversations FOR EACH ROW EXECUTE FUNCTION public.ordinary_chat_delete_guard();

-- Restore the function bodies: undo each 0271 text patch (patch -> original text), last step first.
DO $$
DECLARE item record; source text;
BEGIN
 FOR item IN SELECT * FROM (VALUES
  (1,'account_erasure_scrub_runtime(uuid)',1,
$n$    ('ordinary_chat_requests',
      'writer_token = NULL, input = NULL, response_params = NULL, partial_content = NULL, failure_reason = NULL,
      reservation = (SELECT jsonb_object_agg(x.key,
      x.value) FROM jsonb_each(CASE WHEN jsonb_typeof(t.reservation) = ''object'' THEN t.reservation ELSE ''{}''::jsonb END) x WHERE x.key IN
      (''pre_deduct_id'', ''balance_before'', ''balance_after'', ''is_idempotent'')), billing_result = (SELECT jsonb_object_agg(x.key, x.value)
      FROM jsonb_each(CASE WHEN jsonb_typeof(t.billing_result) = ''object'' THEN t.billing_result ELSE ''{}''::jsonb END) x WHERE x.key IN
      (''user_message_id'', ''assistant_message_id'', ''transaction_id'', ''settle_id'', ''refund_id'', ''balance_after'', ''refunded_credits'',
      ''refund_amount'')), erased_at = $2',
      't.user_id = $1 AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = t.conversation_id AND c.user_id = $1)',
      't.conversation_id = ANY($4) AND t.state IN (''succeeded'',''failed'')'),
$n$,$n$    -- 0271 legacy chat tables
$n$),
  -- messages and conversation_context_snapshots carry the same readiness clause.
  (2,'account_erasure_scrub_runtime(uuid)',2,
$n$'t.conversation_id = ANY($4) AND NOT EXISTS (SELECT 1 FROM ordinary_chat_requests r WHERE r.conversation_id = t.conversation_id AND r.state
      NOT IN (''succeeded'',''failed'')) AND NOT EXISTS$n$,
$n$'t.conversation_id = ANY($4) AND NOT EXISTS$n$),
  (3,'account_erasure_scrub_runtime(uuid)',1,
$n$'t.id = ANY($4) AND NOT EXISTS (SELECT 1 FROM ordinary_chat_requests r WHERE r.conversation_id = t.id AND r.state NOT IN
      (''succeeded'',''failed'')) AND NOT EXISTS$n$,
$n$'t.id = ANY($4) AND NOT EXISTS$n$),
  (4,'account_erasure_scrub_content(uuid)',1,
$n$  DELETE FROM agent_confirmed_preferences WHERE actor_id = p_profile_id;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('agent_confirmed_preferences_deleted', n);
  DELETE FROM agent_preference_requests WHERE actor_id = p_profile_id;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('agent_preference_requests_deleted', n);
$n$,$n$  -- 0271 legacy chat tables
$n$),
  (5,'account_erasure_body_remaining(uuid)',1,
$n$  ('ordinary_chat_requests','t.user_id=$1'),
$n$,$n$  -- 0271 legacy chat tables
$n$),
  (6,'account_erasure_financial_proof(uuid)',1,
$n$ SELECT count(*) INTO n FROM ordinary_chat_requests WHERE user_id=p_profile_id
  AND (erased_at IS NULL OR state NOT IN ('succeeded','failed'));
 pending:=pending+n;
$n$,$n$ -- 0271 legacy chat tables
$n$),
  (7,'account_erasure_prune_business(uuid,integer)',1,
$n$  'runtime_sessions','conversation_context_snapshots','messages','ordinary_chat_requests',
$n$,$n$  -- 0271 legacy chat tables
  'runtime_sessions','conversation_context_snapshots','messages',
$n$),
  (8,'erasure_business_owner(text,jsonb)',1,
$n$ WHEN t IN ('conversations','ordinary_chat_requests') THEN RETURN (j->>'user_id')::uuid;
$n$,$n$ -- 0271 legacy chat tables
 WHEN t='conversations' THEN RETURN (j->>'user_id')::uuid;
$n$),
  (9,'agent_slice_preferences_valid(uuid,jsonb,text)',1,
$n$ AND jsonb_array_length(refs)=(SELECT count(DISTINCT (ref->>'scope',ref->>'name')) FROM jsonb_array_elements(refs) ref) AND
 NOT EXISTS(SELECT 1 FROM jsonb_array_elements(refs) ref LEFT JOIN agent_confirmed_preferences p
 ON p.actor_id=p_actor_id AND p.scope_key=ref->>'scope' AND p.name=ref->>'name'
 WHERE p.actor_id IS NULL OR NOT p.active OR p.version::text IS DISTINCT FROM ref->>'version'
 OR (p.scope_key<>'user' AND p.scope_key IS DISTINCT FROM 'account:'||p_account)
 OR (ref-'scope'-'name'-'version')<>'{}'::jsonb) END
$n$,$n$ -- 0271 legacy chat tables: no confirmed preference can exist any more, so only an empty list is valid.
 AND jsonb_array_length(refs)=0 END
$n$)
 ) v(step,signature,times,needle,patch) ORDER BY step DESC LOOP
  source:=pg_get_functiondef(('public.'||item.signature)::regprocedure);
  IF item.patch<>'' AND length(source)-length(replace(source,item.patch,''))<>item.times*length(item.patch) THEN
   RAISE EXCEPTION 'LEGACY_CLOSE_0271_ROLLBACK_SOURCE_MISMATCH: % step %',item.signature,item.step;
  END IF;
  EXECUTE replace(source,item.patch,item.needle);
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE prosrc LIKE '%-- 0271 legacy chat tables%') THEN
  RAISE EXCEPTION 'LEGACY_CLOSE_0271_ROLLBACK_MARKER_LEFT';
 END IF;
END $$;

COMMIT;
