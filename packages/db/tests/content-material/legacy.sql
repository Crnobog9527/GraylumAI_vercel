-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Local-only pre-0229 rows: work-item sessions whose latest scope material is a saved body,
-- written the way the old content-save path did (request id = content id).
CREATE SCHEMA a1_test;
CREATE TABLE a1_test.legacy(label text PRIMARY KEY,v jsonb NOT NULL);
-- d7_test.artifacts leaves the work project unlinked; real handoffs link it to the account project.
CREATE FUNCTION a1_test.link(art jsonb) RETURNS jsonb LANGUAGE sql AS $$
 UPDATE artifact_projects w SET source_project_id=i.account_project_id FROM opc_items i
 WHERE i.work_item_id=(art->>'workItem')::uuid AND w.id=i.work_item_id RETURNING art;
$$;
CREATE FUNCTION a1_test.material(sid uuid,rev bigint,req uuid,content jsonb) RETURNS void LANGUAGE sql AS $$
 INSERT INTO runtime_scope_material(session_id,revision,request_id,request,content,content_hash)
 VALUES(sid,rev,req,jsonb_build_object('expectedRevision',rev-1,'payload',content),content,
  encode(sha256(convert_to(content::text,'UTF8')),'hex'));
$$;
DO $$
DECLARE f jsonb;art jsonb;pending jsonb;bound uuid:=gen_random_uuid();
BEGIN
 f:=b2a_test.fixture();
 art:=a1_test.link(d7_test.artifacts((f->>'actor')::uuid));
 PERFORM a1_test.material((art->>'session')::uuid,1,(art->>'content')::uuid,jsonb_build_object(
  'brief','已定稿口播稿：A1_LEGACY_SAVED_BODY','material','{}','roundId',NULL));
 INSERT INTO a1_test.legacy VALUES('plain',art);
 -- Same shape, plus an unfinished legacy video binding on an earlier revision.
 pending:=a1_test.link(d7_test.artifacts((f->>'actor')::uuid));
 PERFORM a1_test.material((pending->>'session')::uuid,1,gen_random_uuid(),jsonb_build_object(
  'brief','已定稿口播稿：A1_BOUND_SCRIPT','material','{}','roundId',NULL));
 INSERT INTO opc_video_material_bindings(actor_id,request_id,work_item_id,source_script_id,session_id,material_revision)
 VALUES((f->>'actor')::uuid,bound,(pending->>'workItem')::uuid,(pending->>'content')::uuid,(pending->>'session')::uuid,1);
 PERFORM a1_test.material((pending->>'session')::uuid,2,(pending->>'content')::uuid,jsonb_build_object(
  'brief','已定稿口播稿：A1_PENDING_SAVED_BODY','material','{}','roundId',NULL));
 INSERT INTO a1_test.legacy VALUES('pending',pending||jsonb_build_object('binding',bound,'fixture',f));
END $$;
