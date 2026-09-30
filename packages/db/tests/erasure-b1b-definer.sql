-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- C9: actual post-migration DEFINER functions as non-superuser service_role (no replaced mocks).
BEGIN;
DO $$ BEGIN
  PERFORM set_config('b1b.open',(SELECT id::text FROM profiles WHERE nickname='b1b-open'),true);
  PERFORM set_config('b1b.conv',(SELECT id::text FROM conversations WHERE title='b1b-o_conv'),true);
  PERFORM set_config('b1b.request',gen_random_uuid()::text,true);
  PERFORM set_config('b1b.token',gen_random_uuid()::text,true);
  PERFORM set_config('b1b.closed',(SELECT id::text FROM profiles WHERE nickname='b1b-closed'),true);
  PERFORM set_config('b1b.busy_request',(SELECT request_id::text FROM ordinary_chat_requests
    WHERE user_id=current_setting('b1b.closed')::uuid AND state='unknown'),true);
  PERFORM set_config('b1b.busy_token',(SELECT writer_token::text FROM ordinary_chat_requests
    WHERE request_id=current_setting('b1b.busy_request')::uuid),true);
END $$;
-- Simulate a request admitted before 0150, without invoking the now-disabled admission RPC.
INSERT INTO ordinary_chat_requests(request_id,user_id,conversation_id,input,writer_token)
VALUES(current_setting('b1b.request')::uuid,current_setting('b1b.open')::uuid,
  current_setting('b1b.conv')::uuid,'{"message":"normal input"}',current_setting('b1b.token')::uuid);
SET LOCAL ROLE service_role;
DO $$
DECLARE a uuid:=current_setting('b1b.open')::uuid; s uuid; start_id uuid:=gen_random_uuid();
  material_id uuid:=gen_random_uuid(); r jsonb; ctx jsonb;
  request_id uuid:=current_setting('b1b.request')::uuid; token uuid:=current_setting('b1b.token')::uuid;
BEGIN
  IF has_function_privilege(current_user,'public.ordinary_chat_claim(uuid,uuid,jsonb,uuid)','EXECUTE')
    OR NOT has_function_privilege(current_user,'public.ordinary_chat_transition(uuid,uuid,uuid,text,jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'B1b C9 legacy admission/transition ACL mismatch'; END IF;
  BEGIN
    PERFORM ordinary_chat_claim(a,gen_random_uuid(),
      jsonb_build_object('conversationId',current_setting('b1b.conv'),'message','new admission'),gen_random_uuid());
    RAISE EXCEPTION 'B1b C9 legacy admission accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM<>'permission denied for function ordinary_chat_claim' THEN RAISE; END IF;
  END;
  r:=runtime_start(a,start_id,'{"scope":{"kind":"positioning_draft"}}');
  s:=(r->>'sessionId')::uuid;
  IF s IS NULL OR runtime_start(a,start_id,'{"scope":{"kind":"positioning_draft"}}') IS DISTINCT FROM r THEN
    RAISE EXCEPTION 'B1b C9 real runtime start/replay failed'; END IF;
  r:=runtime_material(a,s,'save',material_id,0,'{"brief":"normal brief","material":"normal material"}');
  IF (r->>'revision')::int<>1 OR r->>'hash' IS NULL THEN RAISE EXCEPTION 'B1b C9 material save failed'; END IF;
  ctx:=runtime_session_context(a,s);
  IF ctx#>>'{scopeMaterial,content,material}' IS DISTINCT FROM 'normal material' THEN
    RAISE EXCEPTION 'B1b C9 material read failed'; END IF;
  PERFORM runtime_material(a,s,'revoke',NULL,1,NULL);
  ctx:=runtime_session_context(a,s);
  IF ctx->'scopeMaterial' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'B1b C9 revoke failed'; END IF;
  PERFORM ordinary_chat_transition(a,request_id,token,'dispatch');
  r:=ordinary_chat_transition(a,request_id,token,'unknown','{"partialContent":"normal partial"}');
  IF r->>'state'<>'unknown' OR r->>'partial_content'<>'normal partial' THEN
    RAISE EXCEPTION 'B1b C9 real transition failed'; END IF;
  r:=ordinary_chat_transition(a,request_id,token,'stop');
  IF r->>'stop_requested_at' IS NULL OR r->>'writer_token' IS DISTINCT FROM token::text THEN
    RAISE EXCEPTION 'B1b C9 existing request lost stop transition or token'; END IF;
  r:=ordinary_chat_transition(current_setting('b1b.closed')::uuid,current_setting('b1b.busy_request')::uuid,
    current_setting('b1b.busy_token')::uuid,'stop');
  IF r->>'state' IS DISTINCT FROM 'unknown' OR r->>'stop_requested_at' IS NULL
    OR r->>'writer_token' IS DISTINCT FROM current_setting('b1b.busy_token') THEN
    RAISE EXCEPTION 'B1b C9 closed in-flight transition or token changed'; END IF;
END $$;
RESET ROLE;
SELECT 'PASS B1b C9 fresh service-role claim denied; actual runtime writers and existing ordinary transitions remain writable';
ROLLBACK;
