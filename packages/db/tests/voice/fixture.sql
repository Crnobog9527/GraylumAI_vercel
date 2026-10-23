/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Local-only fixtures for 0341: accounts and ready library documents.
CREATE SCHEMA IF NOT EXISTS voice_test;
CREATE OR REPLACE FUNCTION voice_test.actor() RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE a uuid:=gen_random_uuid();
BEGIN INSERT INTO profiles(id,credits) VALUES(a,100); RETURN a; END $$;
-- A ready document of n segments ("VOICE_CANARY <name> <i>"), each of the given byte size.
CREATE OR REPLACE FUNCTION voice_test.doc(a uuid,filename text,purpose text DEFAULT 'authored',n integer DEFAULT 2,
 bytes integer DEFAULT 40) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE id uuid;
BEGIN
 INSERT INTO library_documents(actor_id,request_id,kind,format,purpose,filename,status)
 VALUES(a,gen_random_uuid(),'document','md',purpose,filename,'ready') RETURNING library_documents.id INTO id;
 INSERT INTO library_document_segments(document_id,actor_id,ordinal,title,body,source)
 SELECT id,a,g,'',rpad('VOICE_CANARY '||filename||' '||g,bytes,'.'),'extracted' FROM generate_series(0,n-1) g;
 RETURN id;
END $$;
