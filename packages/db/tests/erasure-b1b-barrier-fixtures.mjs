/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { randomUUID } from 'node:crypto';

export function actorFixture(q) {
  const actor = randomUUID();
  q(`INSERT INTO profiles(id,email,nickname,role,status,membership_level,credits,is_deleted)
    VALUES('${actor}','${actor}@example.test','barrier','user','active','free',10,'false')`);
  return actor;
}

// All FK and production triggers stay enabled. These are complete committed parent objects,
// not replicas or mocked admission functions. A test-only BEFORE INSERT trigger pauses precisely
// after the real entry's active check and before its first FK/content write.
export function artifactFixture(q, actor) {
  const ids = Object.fromEntries(['skill', 'module', 'revision', 'project', 'round', 'version']
    .map(key => [key, randomUUID()]));
  q(`INSERT INTO skills(id,skill_key,content_kind)
    VALUES('${ids.skill}','barrier-${ids.skill}','directory');
    INSERT INTO skill_revisions(id,skill_id,version,content,content_hash,published_by)
    VALUES('${ids.revision}','${ids.skill}',1,'fixture',repeat('a',64),'${actor}');
    INSERT INTO skill_packages(revision_id,skill_id,request_id,manifest,package_hash,entry_hash,expected_version,actor_id)
    VALUES('${ids.revision}','${ids.skill}',gen_random_uuid(),'{}',repeat('a',64),repeat('a',64),0,'${actor}');
    UPDATE skills SET status='published',published_version=1,published_content='fixture',
      published_content_hash=repeat('a',64),published_at=(SELECT published_at FROM skill_revisions WHERE id='${ids.revision}'),
      published_by='${actor}' WHERE id='${ids.skill}';
    INSERT INTO modules(id,title,skill_id,active) VALUES('${ids.module}','barrier','${ids.skill}',true);
    INSERT INTO artifact_projects(id,actor_id,module_id,skill_id)
    VALUES('${ids.project}','${actor}','${ids.module}','${ids.skill}');
    INSERT INTO artifact_rounds(id,project_id,revision_id,package_hash,workflow,workflow_hash,template_hash,state,steps)
    VALUES('${ids.round}','${ids.project}','${ids.revision}',repeat('a',64),
      '{"report":{"title":"private title"},"steps":[{"id":"step"}]}','workflow','template','published','{}');
    INSERT INTO artifact_versions(id,project_id,round_id,version,report,report_hash,evidence_ids)
    VALUES('${ids.version}','${ids.project}','${ids.round}',1,'{"private":"report"}','hash','[]');`);
  return ids;
}

export function pauseInsert(q, table) {
  q(`CREATE OR REPLACE FUNCTION public.barrier_test_pause() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF current_setting('barrier.test_pause',true)='on' THEN PERFORM pg_advisory_xact_lock(150150); END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER barrier_test_pause BEFORE INSERT ON public.${table}
      FOR EACH ROW EXECUTE FUNCTION public.barrier_test_pause();`);
  return () => q(`DROP TRIGGER barrier_test_pause ON public.${table}; DROP FUNCTION public.barrier_test_pause()`);
}
