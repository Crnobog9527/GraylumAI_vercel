-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- C9: actual post-migration DEFINER functions as non-superuser service_role (no replaced mocks).
BEGIN;
DO $$ BEGIN
  PERFORM set_config('b1b.open',(SELECT id::text FROM profiles WHERE nickname='b1b-open'),true);
  PERFORM set_config('b1b.conv',(SELECT id::text FROM conversations WHERE title='b1b-o_conv'),true);
END $$;
SET LOCAL ROLE service_role;
DO $$
DECLARE a uuid:=current_setting('b1b.open')::uuid; s uuid; start_id uuid:=gen_random_uuid();
  material_id uuid:=gen_random_uuid(); r jsonb; ctx jsonb; request_id uuid:=gen_random_uuid(); token uuid:=gen_random_uuid();
BEGIN
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
  r:=ordinary_chat_claim(a,request_id,jsonb_build_object('conversationId',current_setting('b1b.conv'),'message','normal input'),token);
  IF (r->>'claimed')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'B1b C9 claim failed'; END IF;
  PERFORM ordinary_chat_transition(a,request_id,token,'dispatch');
  r:=ordinary_chat_transition(a,request_id,token,'unknown','{"partialContent":"normal partial"}');
  IF r->>'state'<>'unknown' OR r->>'partial_content'<>'normal partial' THEN
    RAISE EXCEPTION 'B1b C9 real transition failed'; END IF;
  PERFORM ordinary_chat_transition(a,request_id,token,'stop');
END $$;
RESET ROLE;
SELECT 'PASS B1b C9 actual definer runtime start/material/revoke and ordinary claim/transitions remain writable';
ROLLBACK;
