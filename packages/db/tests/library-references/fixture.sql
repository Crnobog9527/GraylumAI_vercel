/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Local-only fixtures for 0262: library documents and executions that reference them.
CREATE SCHEMA IF NOT EXISTS lr_test;
-- A document with n segments ("LR_CANARY ..." bodies) in the given status and content version.
CREATE OR REPLACE FUNCTION lr_test.doc(a uuid,filename text,n integer DEFAULT 3,status text DEFAULT 'ready',
 version integer DEFAULT 1,kind text DEFAULT 'document') RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE id uuid;
BEGIN
 INSERT INTO library_documents(actor_id,request_id,kind,format,purpose,filename,status,content_version)
 VALUES(a,gen_random_uuid(),kind,CASE WHEN kind='image' THEN 'png' ELSE 'md' END,'reference',filename,status,version)
 RETURNING library_documents.id INTO id;
 INSERT INTO library_document_segments(document_id,actor_id,ordinal,title,body,source)
 SELECT id,a,g,'Chapter '||(g+1),'LR_CANARY '||filename||' segment '||(g+1),'extracted' FROM generate_series(0,n-1) g;
 RETURN id;
END $$;
-- An execution of a free conversation; refs (when given) is frozen as payload.libraryReferences.
CREATE OR REPLACE FUNCTION lr_test.exec(a uuid,sid uuid,refs jsonb DEFAULT NULL,state text DEFAULT 'running') RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE id uuid:=gen_random_uuid();
BEGIN
 INSERT INTO runtime_executions(id,actor_id,session_id,request_id,payload,history_revision,state)
 VALUES(id,a,sid,gen_random_uuid(),jsonb_build_object('role','ordinary','input','question','tools','["read_source"]'::jsonb,
  'maxToolCalls',8)||CASE WHEN refs IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('libraryReferences',refs) END,0,state);
 RETURN id;
END $$;
