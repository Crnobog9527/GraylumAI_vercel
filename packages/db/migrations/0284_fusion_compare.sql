/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- FUSION-COMPARE PR-1 (docs/launch/tasks/FUSION-COMPARE.md §3, §6 PR-1). Number allocated by the controller.
-- Multi-model compare in the free-conversation composer, on the merged Fusion foundation (0234 billing
-- groups, 0235 sessionless runs and outputs). This migration adds:
--  * the compare record (product state: source conversation, frozen history revision, question, models,
--    positioning-gate verdict, workspace dependencies, adoption) — bill2_runs holds money only and
--    fusion_call_outputs holds per-call bodies, so neither can carry it (same reason as fusion_reviews);
--  * a compare branch in fusion_group_admit (compare switch, membership, allowlist, [minModels, D3], budget);
--  * begin / gate / claim / read / stop / adopt functions;
--  * conversation, workspace-source and account erasure coverage for the record.
-- WIP: draft PR; functions land in follow-up commits on this branch.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.fusion_compares (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT fusion_compares_pk PRIMARY KEY,
  actor_id uuid NOT NULL CONSTRAINT fusion_compares_actor_ref REFERENCES public.profiles(id),
  request_id uuid NOT NULL,
  session_id uuid NOT NULL CONSTRAINT fusion_compares_session_ref REFERENCES public.runtime_sessions(id),
  group_id uuid CONSTRAINT fusion_compares_group_ref REFERENCES public.fusion_billing_groups(id),
  history_revision bigint NOT NULL CHECK (history_revision >= 0),
  question text CHECK (question IS NULL OR octet_length(question) BETWEEN 1 AND 90000),
  question_hash text NOT NULL CHECK (question_hash ~ '^[a-f0-9]{64}$'),
  -- Frozen choices: {models: [modelId...], skill: {moduleId, revisionId, instructionsHash} | null, settings}.
  config jsonb NOT NULL,
  -- clear | allow | block | unavailable; written once by the positioning gate before any group exists.
  gate_verdict text CHECK (gate_verdict IS NULL OR gate_verdict IN ('clear','allow','block','unavailable')),
  workspace_dependencies jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(workspace_dependencies) = 'array'),
  state text NOT NULL CHECK (state IN ('admitting','refused','running','finished','stopped')),
  -- Written once, only by a successful direct write-back: {column, runId, executionId, fromRevision, toRevision}.
  adoption jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fusion_compares_request_unique UNIQUE (actor_id, request_id),
  CHECK (octet_length(config::text) <= 65536 AND octet_length(workspace_dependencies::text) <= 65536)
);
CREATE INDEX IF NOT EXISTS fusion_compares_session_idx ON public.fusion_compares(session_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS fusion_compares_group_idx ON public.fusion_compares(group_id) WHERE group_id IS NOT NULL;
ALTER TABLE public.fusion_compares ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fusion_compares FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
