-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Local synthetic fixture (CORE-PATH-V2 V2-7a): a Gold account's confirmed positioning round, ready for a report turn. The Skill,
-- module and package come from d7_test.artifacts (content-erasure/fixture.sql, loaded first); the round, its confirmation, the
-- draft binding its session and three qualified benchmarks are this round's own. Real constraints and triggers stay enabled.
CREATE SCHEMA IF NOT EXISTS turn_test;
CREATE OR REPLACE FUNCTION turn_test.report_source(a uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE f jsonb := d7_test.artifacts(a); p uuid := gen_random_uuid(); r uuid := gen_random_uuid(); conf uuid := gen_random_uuid();
  sid uuid := gen_random_uuid(); x uuid := gen_random_uuid(); d uuid; fetch_id uuid; account text;
BEGIN
  INSERT INTO artifact_projects(id, actor_id, module_id, skill_id, account)
    VALUES (p, a, (f->>'module')::uuid, (f->>'skill')::uuid, 'turn-report-' || p);
  INSERT INTO artifact_rounds(id, project_id, revision_id, package_hash, workflow, workflow_hash, template_hash, state, steps)
    VALUES (r, p, (f->>'revision')::uuid, repeat('b', 64), jsonb_build_object('id', 'turn-report', 'version', 1, 'kind', 'document',
      'steps', jsonb_build_array(jsonb_build_object('id', 's', 'title', 'Facts', 'dependsOn', '[]'::jsonb, 'resources', '[]'::jsonb,
        'minLength', 1, 'maxLength', 20000, 'requiresEvidence', false, 'requiredCapabilities', '[]'::jsonb, 'information', '[]'::jsonb)),
      'report', jsonb_build_object('id', 'report', 'version', 1, 'title', 'Positioning',
        'sections', jsonb_build_array(jsonb_build_object('title', 'Facts', 'stepId', 's'))),
      'planResources', jsonb_build_array('report.md'),
      'reportGeneration', jsonb_build_object('resources', jsonb_build_array('report.md'), 'sections', jsonb_build_array('One', 'Two'),
        'maxCharacters', 12000)),
      repeat('c', 64), repeat('d', 64), 'draft',
      jsonb_build_object('s', jsonb_build_object('body', 'CONFIRMED_FACTS', 'version', 1, 'reviewVersion', 0, 'valid', true,
        'confirmationId', conf, 'evidenceIds', '[]'::jsonb, 'provenanceIds', '[]'::jsonb, 'information', '{}'::jsonb)));
  INSERT INTO artifact_confirmations(id, round_id, step_id, version, review_version, body, evidence_ids)
    VALUES (conf, r, 's', 1, 0, 'CONFIRMED_FACTS', '[]');
  d := bill2_create_draft(a);
  INSERT INTO runtime_sessions(id, actor_id, scope, start_request_id, start_payload)
    VALUES (sid, a, jsonb_build_object('kind', 'positioning_draft', 'draftId', d), gen_random_uuid(), '{}');
  INSERT INTO opc_drafts(draft_id, actor_id, project_id, round_id, session_id, request_id, registration, mode)
    VALUES (d, a, p, r, sid, gen_random_uuid(), (SELECT id FROM artifact_workflows WHERE module_id = (f->>'module')::uuid LIMIT 1), 'mentor');
  -- RT-4b (0268): three qualified benchmark accounts of this session (the evidence-checked path is research-benchmarks' suite).
  -- (V2-12 F: the old execution row is gone; the research rows keep the id as a plain value.)
  FOREACH account IN ARRAY ARRAY['benchmark_a', 'benchmark_b', 'benchmark_c'] LOOP
    INSERT INTO research_account_fetches(actor_id, session_id, execution_id, platform, account, account_key, state)
      VALUES (a, sid, x, 'tiktok', account, encode(sha256(convert_to(sid::text || ':' || account, 'utf8')), 'hex'), 'succeeded')
      RETURNING id INTO fetch_id;
    INSERT INTO research_benchmarks(fetch_id, actor_id, session_id, execution_id, platform, account, followers, posts_analyzed,
        last_published_at, category, qualified, refs, operation_ids, missing, fetched_at)
      VALUES (fetch_id, a, sid, x, 'tiktok', account, 50000, 20, now(), 'imitable', true, '{}', '{}', '{}', now());
  END LOOP;
  UPDATE profiles SET membership_level = 'gold' WHERE id = a;
  RETURN jsonb_build_object('session', sid, 'project', p, 'round', r, 'module', f->>'module', 'skill', f->>'skill',
    'revision', f->>'revision', 'draft', d);
END $$;
-- The report switch (runtime_report_generation) is on for this local database only.
INSERT INTO system_settings(key, value) VALUES ('runtime_report_generation', '{"enabled":true}')
  ON CONFLICT (key) DO UPDATE SET value = excluded.value;
-- V2-10b: a published positioning with its bound topic workspace: its conversation, its frozen material, an account to adopt into.
CREATE OR REPLACE FUNCTION turn_test.topic_source(a uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE src jsonb := turn_test.report_source(a); v uuid := gen_random_uuid(); sid uuid := gen_random_uuid(); d uuid := (src->>'draft')::uuid;
  bus uuid := gen_random_uuid(); ac uuid := gen_random_uuid();
BEGIN
  UPDATE artifact_rounds SET state = 'published' WHERE id = (src->>'round')::uuid;
  UPDATE artifact_projects SET current_version = 1 WHERE id = (src->>'project')::uuid;
  INSERT INTO artifact_versions(id, project_id, round_id, version, report, report_hash, evidence_ids)
    VALUES (v, (src->>'project')::uuid, (src->>'round')::uuid, 1, '{"body":"CONFIRMED"}', repeat('e', 64), '[]');
  INSERT INTO runtime_sessions(id, actor_id, scope, start_request_id, start_payload)
    VALUES (sid, a, jsonb_build_object('kind', 'positioning_topic', 'draftId', d), gen_random_uuid(), '{}');
  INSERT INTO runtime_scope_material(session_id, revision, request_id, request, content, content_hash)
    VALUES (sid, 1, gen_random_uuid(), '{}', '{"brief":"topic","material":"CONFIRMED"}', repeat('f', 64));
  INSERT INTO opc_topic_workspaces(draft_id, actor_id, request_id, source_version_id, source_hash, module_id, skill_id, revision_id,
      package_hash, session_id, material_revision)
    VALUES (d, a, gen_random_uuid(), v, repeat('e', 64), (src->>'module')::uuid, (src->>'skill')::uuid, (src->>'revision')::uuid,
      repeat('b', 64), sid, 1);
  INSERT INTO opc_businesses(id, actor_id, name, current_source_version_id) VALUES (bus, a, 'topic business', v);
  INSERT INTO opc_draft_businesses VALUES (d, bus);
  INSERT INTO artifact_projects(id, actor_id, module_id, skill_id, account) VALUES (ac, a, (src->>'module')::uuid, (src->>'skill')::uuid, 'topic-' || ac);
  INSERT INTO opc_accounts(project_id, actor_id, platform, account_key, source_version_id, business_id)
    VALUES (ac, a, 'tiktok', 'topic-' || ac, v, bus);
  RETURN src || jsonb_build_object('topicSession', sid, 'version', v, 'business', bus, 'platform', 'tiktok', 'account', 'topic-' || ac);
END $$;
