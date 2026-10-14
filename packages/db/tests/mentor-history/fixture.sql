/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Local-only fixtures for 0228/0245: mentor executions of one positioning conversation.
CREATE SCHEMA IF NOT EXISTS mh_test;
-- seconds orders the conversation; reader marks the turn frozen with read_history.
-- purpose records the execution as that kind of turn of the session's draft in opc_turns
-- (as opc_turn_material does), or as no turn at all when null or without a draft.
CREATE OR REPLACE FUNCTION mh_test.exec(a uuid,sid uuid,input text,seconds integer,state text DEFAULT 'completed',
 reader boolean DEFAULT false,extra jsonb DEFAULT '{}',purpose text DEFAULT 'mentor') RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE id uuid:=gen_random_uuid();request uuid:=gen_random_uuid();token uuid:=gen_random_uuid();d opc_drafts;revision bigint;
BEGIN
 SELECT * INTO d FROM opc_drafts WHERE session_id=sid AND actor_id=a;
 IF purpose IS NOT NULL AND d.draft_id IS NOT NULL THEN
  SELECT coalesce(max(m.revision),0)+1 INTO revision FROM runtime_scope_material m WHERE m.session_id=sid;
  INSERT INTO runtime_scope_material(session_id,revision,request_id,request,content,content_hash)
  VALUES(sid,revision,request,'{}','{}',repeat('f',64));
  INSERT INTO opc_turns(token,draft_id,session_id,request_id,round_id,step_id,purpose,material_revision,input_hash)
  VALUES(token,d.draft_id,sid,request,d.round_id,'first',purpose,revision,repeat('e',64));
 END IF;
 INSERT INTO runtime_executions(id,actor_id,session_id,request_id,payload,history_revision,state,created_at)
 VALUES(id,a,sid,request,jsonb_build_object('role','skill','opcTurnToken',token,'input',input,
  'tools',CASE WHEN reader THEN '["ask_question","read_skill_file","read_history"]'::jsonb ELSE '["ask_question"]'::jsonb END)
  ||CASE WHEN reader THEN jsonb_build_object('historyRead',jsonb_build_object('version','mentor-history-v1','reserve',26624)) ELSE '{}' END
  ||extra,0,state,timestamptz '2026-10-01 00:00:00+00'+make_interval(secs=>seconds));
 RETURN id;
END $$;
