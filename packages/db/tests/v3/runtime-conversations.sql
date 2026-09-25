/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Disposable bootstrap regression. All test records roll back.
BEGIN;
DO $$
DECLARE actor uuid:=gen_random_uuid();other_actor uuid:=gen_random_uuid();
 session jsonb;empty_session jsonb;other_session jsonb;organizer_session jsonb;result jsonb;
BEGIN
 INSERT INTO profiles(id) VALUES(actor),(other_actor);
 session:=runtime_start(actor,gen_random_uuid(),'{"scope":{"kind":"positioning_draft"}}');
 empty_session:=runtime_start(actor,gen_random_uuid(),'{"scope":{"kind":"positioning_draft"}}');
 other_session:=runtime_start(other_actor,gen_random_uuid(),'{"scope":{"kind":"positioning_draft"}}');
 organizer_session:=runtime_start(actor,gen_random_uuid(),'{"scope":{"kind":"positioning_draft"}}');
 INSERT INTO runtime_executions(actor_id,session_id,request_id,payload,history_revision,unavailable_reason)
 VALUES(actor,(session->>'sessionId')::uuid,gen_random_uuid(),'{"role":"ordinary","input":"must not expose unavailable content"}',0,'revoked'),
 (other_actor,(other_session->>'sessionId')::uuid,gen_random_uuid(),'{"role":"ordinary","input":"other actor"}',0,'revoked'),
 (actor,(organizer_session->>'sessionId')::uuid,gen_random_uuid(),'{"role":"organizer","input":"workflow only"}',0,'revoked');
 result:=opc_free_conversations(actor);
 IF jsonb_array_length(result)<>1 OR result->0->>'sessionId'<>session->>'sessionId' THEN
  RAISE EXCEPTION 'free conversations must isolate actors and omit empty/workflow-only sessions';
 END IF;
 IF result->0->>'title'<>'对话记录' THEN RAISE EXCEPTION 'unavailable input must be redacted';END IF;
 IF jsonb_array_length(opc_free_conversations(other_actor))<>1 THEN RAISE EXCEPTION 'other actor own conversation missing';END IF;
 UPDATE bill2_drafts SET revoked=true WHERE id=(session->'scope'->>'draftId')::uuid;
 IF opc_free_conversations(actor)<>'[]'::jsonb THEN RAISE EXCEPTION 'revoked conversation leaked';END IF;
 IF has_function_privilege('anon','public.opc_free_conversations(uuid)','EXECUTE')
  OR has_function_privilege('authenticated','public.opc_free_conversations(uuid)','EXECUTE')
  OR NOT has_function_privilege('service_role','public.opc_free_conversations(uuid)','EXECUTE') THEN
  RAISE EXCEPTION 'conversation RPC privileges are not service-only';
 END IF;
 IF has_table_privilege('service_role','public.runtime_sessions','SELECT') THEN
  RAISE EXCEPTION 'history must not add raw runtime table access';
 END IF;
 BEGIN
  PERFORM opc_free_conversations(NULL);
  RAISE EXCEPTION 'missing actor accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 RAISE NOTICE 'PASS: conversation history actor isolation, empty/workflow exclusion, revocation, redaction and RPC privileges';
END $$;
ROLLBACK;
