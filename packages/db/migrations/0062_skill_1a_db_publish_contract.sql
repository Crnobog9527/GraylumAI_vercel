/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

-- SKILL-1A: minimal Skill CMS and atomic publish contract.
-- Expand-only: existing module rows are not updated and skill_id is nullable.
-- Source only: applying this migration to a remote database requires a separate
-- immediately-before-effect Owner authorization.

CREATE TABLE IF NOT EXISTS public.skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_key TEXT NOT NULL,
  draft_content TEXT NOT NULL DEFAULT '',
  published_content TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  published_version INTEGER NOT NULL DEFAULT 0,
  published_content_hash TEXT,
  created_by UUID REFERENCES public.profiles(id),
  updated_by UUID REFERENCES public.profiles(id),
  published_by UUID REFERENCES public.profiles(id),
  archived_by UUID REFERENCES public.profiles(id),
  audit_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  CONSTRAINT skills_skill_key_key UNIQUE (skill_key),
  CONSTRAINT skills_skill_key_nonempty_check
    CHECK (length(btrim(skill_key)) > 0 AND skill_key = btrim(skill_key)),
  CONSTRAINT skills_status_check
    CHECK (status IN ('draft', 'published', 'archived')),
  CONSTRAINT skills_published_version_check
    CHECK (published_version >= 0),
  CONSTRAINT skills_audit_metadata_object_check
    CHECK (jsonb_typeof(audit_metadata) = 'object'),
  CONSTRAINT skills_published_state_check CHECK (
    (
      published_version = 0
      AND published_content IS NULL
      AND published_content_hash IS NULL
      AND published_at IS NULL
      AND published_by IS NULL
      AND status <> 'published'
    )
    OR
    (
      published_version > 0
      AND published_content IS NOT NULL
      AND published_content_hash ~ '^[0-9a-f]{64}$'
      AND published_at IS NOT NULL
      AND published_by IS NOT NULL
    )
  ),
  CONSTRAINT skills_archived_audit_check CHECK (
    status <> 'archived'
    OR (archived_at IS NOT NULL AND archived_by IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS public.skill_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id UUID NOT NULL REFERENCES public.skills(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  published_by UUID NOT NULL REFERENCES public.profiles(id),
  publish_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT skill_revisions_skill_id_version_key UNIQUE (skill_id, version),
  CONSTRAINT skill_revisions_version_check CHECK (version > 0),
  CONSTRAINT skill_revisions_content_nonempty_check CHECK (length(btrim(content)) > 0),
  CONSTRAINT skill_revisions_content_hash_check CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT skill_revisions_publish_metadata_object_check
    CHECK (jsonb_typeof(publish_metadata) = 'object')
);

ALTER TABLE public.modules
  ADD COLUMN IF NOT EXISTS skill_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.modules'::regclass
      AND conname = 'modules_skill_id_fkey'
  ) THEN
    ALTER TABLE public.modules
      ADD CONSTRAINT modules_skill_id_fkey
      FOREIGN KEY (skill_id)
      REFERENCES public.skills(id)
      ON DELETE SET NULL;
  END IF;
END
$$;

-- Changing a default is metadata-only and leaves all existing module rows intact.
ALTER TABLE public.modules
  ALTER COLUMN active SET DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_modules_skill_id
  ON public.modules(skill_id)
  WHERE skill_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_skills_status
  ON public.skills(status);

CREATE INDEX IF NOT EXISTS idx_skill_revisions_skill_published_at
  ON public.skill_revisions(skill_id, published_at DESC);

CREATE OR REPLACE FUNCTION public.enforce_skill_row_invariants()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_matching_revision BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft'
      OR NEW.published_version <> 0
      OR NEW.published_content IS NOT NULL
      OR NEW.published_content_hash IS NOT NULL
      OR NEW.published_at IS NOT NULL
      OR NEW.published_by IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'new skills must start as unpublished drafts';
    END IF;

    NEW.updated_at := clock_timestamp();
    RETURN NEW;
  END IF;

  IF NEW.skill_key IS DISTINCT FROM OLD.skill_key THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'skill_key is immutable';
  END IF;

  IF NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'skill creation audit fields are immutable';
  END IF;

  IF NEW.published_version < OLD.published_version THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'published_version cannot decrease';
  END IF;

  IF NEW.published_version = OLD.published_version THEN
    IF NEW.published_content IS DISTINCT FROM OLD.published_content
      OR NEW.published_content_hash IS DISTINCT FROM OLD.published_content_hash
      OR NEW.published_at IS DISTINCT FROM OLD.published_at
      OR NEW.published_by IS DISTINCT FROM OLD.published_by THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'published fields can change only with a new revision';
    END IF;

    IF NEW.status = 'published' AND OLD.status <> 'published' THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'published status requires a new revision';
    END IF;
  ELSE
    IF NEW.published_version <> OLD.published_version + 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'published_version must increase by exactly one';
    END IF;

    SELECT EXISTS (
      SELECT 1
      FROM public.skill_revisions AS revision
      WHERE revision.skill_id = NEW.id
        AND revision.version = NEW.published_version
        AND revision.content = NEW.published_content
        AND revision.content_hash = NEW.published_content_hash
        AND revision.published_by = NEW.published_by
        AND revision.published_at = NEW.published_at
    ) INTO v_matching_revision;

    IF NOT v_matching_revision OR NEW.status <> 'published' THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'published state requires its matching immutable revision';
    END IF;
  END IF;

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.prevent_skill_revision_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'published skill revisions are immutable';
END;
$$;

DROP TRIGGER IF EXISTS enforce_skill_row_invariants ON public.skills;
CREATE TRIGGER enforce_skill_row_invariants
BEFORE INSERT OR UPDATE ON public.skills
FOR EACH ROW
EXECUTE FUNCTION public.enforce_skill_row_invariants();

DROP TRIGGER IF EXISTS prevent_skill_revision_mutation ON public.skill_revisions;
CREATE TRIGGER prevent_skill_revision_mutation
BEFORE UPDATE OR DELETE ON public.skill_revisions
FOR EACH ROW
EXECUTE FUNCTION public.prevent_skill_revision_mutation();

ALTER TABLE public.skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skill_revisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS skills_published_select ON public.skills;
CREATE POLICY skills_published_select
  ON public.skills
  FOR SELECT
  TO anon, authenticated
  USING (
    status = 'published'
    AND published_version > 0
    AND published_content IS NOT NULL
    AND published_content_hash IS NOT NULL
  );

-- Client roles receive only published columns; draft and private audit columns
-- remain inaccessible even on rows allowed by the published-read RLS policy.
REVOKE ALL ON TABLE public.skills FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.skill_revisions FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT (
  id,
  skill_key,
  status,
  published_content,
  published_version,
  published_content_hash,
  published_at
) ON TABLE public.skills TO anon, authenticated;

GRANT SELECT, INSERT ON TABLE public.skills TO service_role;
GRANT UPDATE (
  draft_content,
  status,
  updated_by,
  archived_by,
  archived_at,
  audit_metadata
) ON TABLE public.skills TO service_role;
GRANT SELECT ON TABLE public.skill_revisions TO service_role;

CREATE OR REPLACE FUNCTION public.atomic_publish_skill(
  p_skill_id UUID,
  p_published_by UUID,
  p_publish_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  skill_id UUID,
  skill_key TEXT,
  published_version INTEGER,
  published_content_hash TEXT,
  published_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_skill public.skills%ROWTYPE;
  v_next_version INTEGER;
  v_content_hash TEXT;
  v_published_at TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF p_skill_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22004',
      MESSAGE = 'skill id is required';
  END IF;

  IF p_published_by IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22004',
      MESSAGE = 'publisher id is required';
  END IF;

  IF p_publish_metadata IS NULL OR jsonb_typeof(p_publish_metadata) <> 'object' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'publish metadata must be a JSON object';
  END IF;

  SELECT skill.*
  INTO v_skill
  FROM public.skills AS skill
  WHERE skill.id = p_skill_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'skill not found';
  END IF;

  IF length(btrim(v_skill.draft_content)) = 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'skill draft content must not be empty';
  END IF;

  IF v_skill.published_version = 2147483647 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22003',
      MESSAGE = 'skill published version exhausted';
  END IF;

  v_next_version := v_skill.published_version + 1;
  v_content_hash := encode(sha256(convert_to(v_skill.draft_content, 'UTF8')), 'hex');

  INSERT INTO public.skill_revisions (
    skill_id,
    version,
    content,
    content_hash,
    published_by,
    publish_metadata,
    published_at
  ) VALUES (
    v_skill.id,
    v_next_version,
    v_skill.draft_content,
    v_content_hash,
    p_published_by,
    p_publish_metadata,
    v_published_at
  );

  UPDATE public.skills
  SET published_content = v_skill.draft_content,
      published_version = v_next_version,
      published_content_hash = v_content_hash,
      status = 'published',
      published_by = p_published_by,
      published_at = v_published_at,
      updated_by = p_published_by,
      audit_metadata = v_skill.audit_metadata || jsonb_build_object(
        'lastPublishedVersion', v_next_version,
        'lastPublish', p_publish_metadata
      )
  WHERE id = v_skill.id;

  RETURN QUERY
  SELECT skill.id,
         skill.skill_key,
         skill.published_version,
         skill.published_content_hash,
         skill.published_at
  FROM public.skills AS skill
  WHERE skill.id = v_skill.id;
END;
$$;

-- CREATE OR REPLACE does not preserve the intended least-privilege posture on
-- a fresh function, so every application reasserts the complete ACL.
REVOKE ALL ON FUNCTION public.atomic_publish_skill(UUID, UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_publish_skill(UUID, UUID, JSONB)
  TO service_role;

REVOKE ALL ON FUNCTION public.enforce_skill_row_invariants()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.prevent_skill_revision_mutation()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.skills
  IS 'SKILL-1A draft and current published state; skill_key is immutable.';
COMMENT ON TABLE public.skill_revisions
  IS 'Immutable SKILL-1A publish history; restoration creates a new draft and version.';
COMMENT ON COLUMN public.modules.skill_id
  IS 'Nullable SKILL-1A binding; existing modules remain unbound and unchanged.';
COMMENT ON FUNCTION public.atomic_publish_skill(UUID, UUID, JSONB)
  IS 'Service-role-only atomic Skill publish: lock, validate, append revision, and advance version.';
