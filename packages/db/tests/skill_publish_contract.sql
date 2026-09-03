/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

-- Transactional SKILL-1A contract test. Run only on a disposable database
-- after 0062_skill_1a_db_publish_contract.sql has been applied.

BEGIN;

SELECT set_config('skill_1a.actor_id', gen_random_uuid()::TEXT, true);
SELECT set_config('skill_1a.skill_id', gen_random_uuid()::TEXT, true);

INSERT INTO public.profiles (id, email)
VALUES (
  current_setting('skill_1a.actor_id')::UUID,
  'skill-1a-publisher@example.test'
);

SET LOCAL ROLE service_role;

INSERT INTO public.skills (
  id,
  skill_key,
  draft_content,
  created_by,
  updated_by
) VALUES (
  current_setting('skill_1a.skill_id')::UUID,
  'contract-test-skill',
  'version one',
  current_setting('skill_1a.actor_id')::UUID,
  current_setting('skill_1a.actor_id')::UUID
);

RESET ROLE;
SET LOCAL ROLE anon;

DO $$
DECLARE
  v_visible_count INTEGER;
BEGIN
  SELECT count(*) INTO v_visible_count
  FROM public.skills
  WHERE id = current_setting('skill_1a.skill_id')::UUID;

  IF v_visible_count <> 0 THEN
    RAISE EXCEPTION 'anon can read an unpublished skill';
  END IF;

  BEGIN
    PERFORM draft_content
    FROM public.skills
    WHERE id = current_setting('skill_1a.skill_id')::UUID;
    RAISE EXCEPTION 'anon can select draft_content';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    INSERT INTO public.skills (skill_key, draft_content)
    VALUES ('anon-write', 'forbidden');
    RAISE EXCEPTION 'anon can insert a skill';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM public.atomic_publish_skill(
      current_setting('skill_1a.skill_id')::UUID,
      current_setting('skill_1a.actor_id')::UUID,
      '{}'::jsonb
    );
    RAISE EXCEPTION 'anon can invoke atomic_publish_skill';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;

RESET ROLE;
SET LOCAL ROLE authenticated;

DO $$
BEGIN
  BEGIN
    PERFORM draft_content
    FROM public.skills
    WHERE id = current_setting('skill_1a.skill_id')::UUID;
    RAISE EXCEPTION 'authenticated can select draft_content';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    UPDATE public.skills
    SET status = 'archived'
    WHERE id = current_setting('skill_1a.skill_id')::UUID;
    RAISE EXCEPTION 'authenticated can update a skill';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM public.atomic_publish_skill(
      current_setting('skill_1a.skill_id')::UUID,
      current_setting('skill_1a.actor_id')::UUID,
      '{}'::jsonb
    );
    RAISE EXCEPTION 'authenticated can invoke atomic_publish_skill';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;

RESET ROLE;
SET LOCAL ROLE service_role;

DO $$
DECLARE
  v_result RECORD;
  v_expected_hash TEXT;
BEGIN
  SELECT * INTO v_result
  FROM public.atomic_publish_skill(
    current_setting('skill_1a.skill_id')::UUID,
    current_setting('skill_1a.actor_id')::UUID,
    '{"reason":"initial publish"}'::jsonb
  );

  v_expected_hash := encode(sha256(convert_to('version one', 'UTF8')), 'hex');

  IF v_result.published_version <> 1
    OR v_result.published_content_hash <> v_expected_hash THEN
    RAISE EXCEPTION 'first publish result is invalid: %', row_to_json(v_result);
  END IF;

  UPDATE public.skills
  SET draft_content = 'version two',
      updated_by = current_setting('skill_1a.actor_id')::UUID
  WHERE id = current_setting('skill_1a.skill_id')::UUID;

  SELECT * INTO v_result
  FROM public.atomic_publish_skill(
    current_setting('skill_1a.skill_id')::UUID,
    current_setting('skill_1a.actor_id')::UUID,
    '{"reason":"second publish"}'::jsonb
  );

  IF v_result.published_version <> 2 THEN
    RAISE EXCEPTION 'published version did not increase monotonically';
  END IF;

  UPDATE public.skills
  SET draft_content = '   ',
      updated_by = current_setting('skill_1a.actor_id')::UUID
  WHERE id = current_setting('skill_1a.skill_id')::UUID;

  BEGIN
    PERFORM public.atomic_publish_skill(
      current_setting('skill_1a.skill_id')::UUID,
      current_setting('skill_1a.actor_id')::UUID,
      '{}'::jsonb
    );
    RAISE EXCEPTION 'blank draft was published';
  EXCEPTION
    WHEN invalid_parameter_value THEN NULL;
  END;

  UPDATE public.skills
  SET status = 'archived',
      archived_by = current_setting('skill_1a.actor_id')::UUID,
      archived_at = clock_timestamp(),
      updated_by = current_setting('skill_1a.actor_id')::UUID
  WHERE id = current_setting('skill_1a.skill_id')::UUID;
END;
$$;

RESET ROLE;
SET LOCAL ROLE anon;

DO $$
DECLARE
  v_visible_count INTEGER;
BEGIN
  SELECT count(*) INTO v_visible_count
  FROM public.skills
  WHERE id = current_setting('skill_1a.skill_id')::UUID;

  IF v_visible_count <> 0 THEN
    RAISE EXCEPTION 'anon can read an archived skill';
  END IF;
END;
$$;

RESET ROLE;
SET LOCAL ROLE service_role;

UPDATE public.skills AS skill
SET draft_content = revision.content,
    status = 'draft',
    updated_by = current_setting('skill_1a.actor_id')::UUID
FROM public.skill_revisions AS revision
WHERE skill.id = current_setting('skill_1a.skill_id')::UUID
  AND revision.skill_id = skill.id
  AND revision.version = 1;

DO $$
DECLARE
  v_result RECORD;
  v_revision_count INTEGER;
BEGIN
  SELECT * INTO v_result
  FROM public.atomic_publish_skill(
    current_setting('skill_1a.skill_id')::UUID,
    current_setting('skill_1a.actor_id')::UUID,
    '{"reason":"restore revision 1 as a new publish"}'::jsonb
  );

  SELECT count(*) INTO v_revision_count
  FROM public.skill_revisions
  WHERE skill_id = current_setting('skill_1a.skill_id')::UUID;

  IF v_result.published_version <> 3 OR v_revision_count <> 3 THEN
    RAISE EXCEPTION 'revision restoration did not create version 3';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.skills
    WHERE id = current_setting('skill_1a.skill_id')::UUID
      AND published_content = 'version one'
  ) THEN
    RAISE EXCEPTION 'restored content was not republished';
  END IF;

  BEGIN
    UPDATE public.skills
    SET published_content = 'direct service-role tamper'
    WHERE id = current_setting('skill_1a.skill_id')::UUID;
    RAISE EXCEPTION 'service_role can directly update published content';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    INSERT INTO public.skill_revisions (
      skill_id,
      version,
      content,
      content_hash,
      published_by
    ) VALUES (
      current_setting('skill_1a.skill_id')::UUID,
      99,
      'direct service-role revision',
      repeat('a', 64),
      current_setting('skill_1a.actor_id')::UUID
    );
    RAISE EXCEPTION 'service_role can directly insert a published revision';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;

RESET ROLE;
SET LOCAL ROLE anon;

DO $$
DECLARE
  v_row RECORD;
BEGIN
  SELECT skill_key, published_content, published_version, published_content_hash
  INTO v_row
  FROM public.skills
  WHERE id = current_setting('skill_1a.skill_id')::UUID;

  IF NOT FOUND
    OR v_row.published_content <> 'version one'
    OR v_row.published_version <> 3
    OR v_row.published_content_hash <> encode(sha256(convert_to('version one', 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'anon published read contract is invalid: %', row_to_json(v_row);
  END IF;
END;
$$;

RESET ROLE;

DO $$
BEGIN
  BEGIN
    UPDATE public.skill_revisions
    SET content = 'tampered'
    WHERE skill_id = current_setting('skill_1a.skill_id')::UUID
      AND version = 1;
    RAISE EXCEPTION 'published revision update unexpectedly succeeded';
  EXCEPTION
    WHEN object_not_in_prerequisite_state THEN NULL;
  END;

  BEGIN
    DELETE FROM public.skill_revisions
    WHERE skill_id = current_setting('skill_1a.skill_id')::UUID
      AND version = 1;
    RAISE EXCEPTION 'published revision delete unexpectedly succeeded';
  EXCEPTION
    WHEN object_not_in_prerequisite_state THEN NULL;
  END;

  BEGIN
    UPDATE public.skills
    SET skill_key = 'renamed-skill'
    WHERE id = current_setting('skill_1a.skill_id')::UUID;
    RAISE EXCEPTION 'skill_key update unexpectedly succeeded';
  EXCEPTION
    WHEN object_not_in_prerequisite_state THEN NULL;
  END;

  BEGIN
    UPDATE public.skills
    SET published_version = published_version - 1
    WHERE id = current_setting('skill_1a.skill_id')::UUID;
    RAISE EXCEPTION 'published version rollback unexpectedly succeeded';
  EXCEPTION
    WHEN object_not_in_prerequisite_state THEN NULL;
  END;
END;
$$;

INSERT INTO public.modules (title)
VALUES ('SKILL-1A default inactive module');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.modules
    WHERE title = 'SKILL-1A default inactive module'
      AND active IS FALSE
      AND skill_id IS NULL
  ) THEN
    RAISE EXCEPTION 'new module default or nullable Skill binding is invalid';
  END IF;
END;
$$;

ROLLBACK;
