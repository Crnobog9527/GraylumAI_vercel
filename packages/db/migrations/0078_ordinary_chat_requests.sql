-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Ordinary chat delivery identity. Reuses the existing atomic money path.
-- Independent of #402 / 0077. Additive; old RPC signatures remain unchanged.
BEGIN;
CREATE TABLE IF NOT EXISTS public.ordinary_chat_requests (
  request_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.profiles(id),
  input jsonb NOT NULL,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  writer_token uuid NOT NULL,
  state text NOT NULL DEFAULT 'preparing' CHECK (state IN ('preparing','running','unknown','responded','succeeded','failed')),
  pre_deduct_id uuid,
  reservation jsonb,
  response_params jsonb,
  partial_content text,
  billing_result jsonb,
  failure_reason text,
  stop_requested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ordinary_chat_requests_conversation ON public.ordinary_chat_requests(user_id,conversation_id,created_at);
ALTER TABLE public.ordinary_chat_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ordinary_chat_requests FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.ordinary_chat_requests TO service_role;

-- Preserve active/uncertain request context through the existing retention job.
-- Completed request bodies follow conversation retention; usage rows retain
-- the old identity so a purged request cannot be dispatched again.
CREATE OR REPLACE FUNCTION public.ordinary_chat_delete_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM ordinary_chat_requests WHERE conversation_id=OLD.id AND state NOT IN ('succeeded','failed')) THEN RETURN NULL; END IF;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS ordinary_chat_delete ON public.conversations;
CREATE TRIGGER ordinary_chat_delete BEFORE DELETE ON public.conversations FOR EACH ROW EXECUTE FUNCTION public.ordinary_chat_delete_guard();
REVOKE ALL ON FUNCTION public.ordinary_chat_delete_guard() FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.ordinary_chat_claim(p_user_id uuid,p_request_id uuid,p_input jsonb,p_writer_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r ordinary_chat_requests; c conversations; v_conversation uuid;
BEGIN
  IF p_request_id IS NULL OR p_writer_token IS NULL OR jsonb_typeof(p_input) <> 'object'
    OR COALESCE(length(p_input->>'message'),0)=0 THEN RAISE EXCEPTION 'CHAT_INPUT_INVALID'; END IF;
  -- Serializes first insertion as well as concurrent cross-user UUID reuse.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text,780));
  SELECT * INTO r FROM ordinary_chat_requests WHERE request_id=p_request_id;
  IF FOUND THEN
    IF r.user_id IS DISTINCT FROM p_user_id OR r.input IS DISTINCT FROM p_input THEN RAISE EXCEPTION 'CHAT_IDENTITY_CONFLICT'; END IF;
    RETURN jsonb_build_object('claimed',false,'request',to_jsonb(r));
  END IF;
  IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_user_id AND status='active' AND is_deleted='false') THEN RAISE EXCEPTION 'CHAT_ACCESS_DENIED'; END IF;
  IF EXISTS(SELECT 1 FROM ai_usage_logs WHERE request_id=p_request_id::text)
    OR EXISTS(SELECT 1 FROM billing_history WHERE metadata->>'requestId'=p_request_id::text) THEN RAISE EXCEPTION 'CHAT_IDENTITY_CONFLICT'; END IF;
  v_conversation := (p_input->>'conversationId')::uuid;
  IF v_conversation IS NOT NULL THEN
    SELECT * INTO c FROM conversations WHERE id=v_conversation AND user_id=p_user_id AND is_deleted='false' AND NOT skill_mode;
    IF NOT FOUND OR ((p_input->>'moduleId') IS NOT NULL AND c.module_id IS DISTINCT FROM (p_input->>'moduleId')::uuid) THEN RAISE EXCEPTION 'CHAT_ACCESS_DENIED'; END IF;
  ELSE
    INSERT INTO conversations(user_id,title,module_id) VALUES(p_user_id,left(p_input->>'message',50),(p_input->>'moduleId')::uuid) RETURNING id INTO v_conversation;
  END IF;
  INSERT INTO ordinary_chat_requests(request_id,user_id,input,conversation_id,writer_token)
  VALUES(p_request_id,p_user_id,p_input,v_conversation,p_writer_token) RETURNING * INTO r;
  RETURN jsonb_build_object('claimed',true,'request',to_jsonb(r));
END $$;

-- All state changes use a row lock and a server-held dispatch capability.
-- A browser disconnect never invokes failure finalization. Unknown operations
-- retain their reservation and cannot acquire another dispatch capability.
CREATE OR REPLACE FUNCTION public.ordinary_chat_transition(p_user_id uuid,p_request_id uuid,p_writer_token uuid,p_action text,p_params jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
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
END $$;
REVOKE ALL ON FUNCTION public.ordinary_chat_claim(uuid,uuid,jsonb,uuid),public.ordinary_chat_transition(uuid,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ordinary_chat_claim(uuid,uuid,jsonb,uuid),public.ordinary_chat_transition(uuid,uuid,uuid,text,jsonb) TO service_role;
COMMIT;
