/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Local-only fixtures for 0228: mentor executions of one positioning conversation.
CREATE SCHEMA IF NOT EXISTS mh_test;
-- seconds orders the conversation; reader marks the turn frozen with read_history.
CREATE OR REPLACE FUNCTION mh_test.exec(a uuid,sid uuid,input text,seconds integer,state text DEFAULT 'completed',
 reader boolean DEFAULT false,extra jsonb DEFAULT '{}') RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE id uuid:=gen_random_uuid();
BEGIN
 INSERT INTO runtime_executions(id,actor_id,session_id,request_id,payload,history_revision,state,created_at)
 VALUES(id,a,sid,gen_random_uuid(),jsonb_build_object('role','skill','opcTurnToken',gen_random_uuid(),'input',input,
  'tools',CASE WHEN reader THEN '["ask_question","read_skill_file","read_history"]'::jsonb ELSE '["ask_question"]'::jsonb END)
  ||CASE WHEN reader THEN jsonb_build_object('historyRead',jsonb_build_object('version','mentor-history-v1','reserve',26624)) ELSE '{}' END
  ||extra,0,state,timestamptz '2026-10-01 00:00:00+00'+make_interval(secs=>seconds));
 RETURN id;
END $$;
