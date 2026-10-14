-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- LEGACY-CLOSE PR-B (0241): drop dead legacy SQL functions that have no settlement or refund role
-- (docs/launch/implementation/LEGACY_CLOSE_CLEANUP_PLAN.md section 5.1, #916).
-- Verified read-only on staging 2026-10-14: no application caller; no other function body calls
-- them except functions dropped here; no trigger, view, policy, constraint or pg_depend edge; no pg_cron.
-- Kept on purpose (still called by a kept settlement path, a live chain or a CI-required test):
--   agent_slice_preferences_valid, agent_slice_assert_legacy_generation, artifact_generation_inputs_current,
--   agent_slice_link, artifact_create_work(+_before_slice_revision), the trigger functions
--   agent_slice_freeze_discussion / agent_slice_stamp_dispatch / ordinary_chat_delete_guard, and every
--   settlement function (atomic_finalize_ai_*, atomic_abort_settle, bill2_legacy_*, ordinary_chat_transition,
--   agent_slice_call / _record_final / _result and copies, artifact_generation, artifact_reject_generation).
-- No table or data change. Rollback: packages/db/tests/legacy-close-0241-rollback.sql recreates every
-- function with its exact pre-0241 definition, owner and grants.
BEGIN;
SET LOCAL lock_timeout='5s';

-- Old agent slice entry, context and source readers (0081-0098).
DROP FUNCTION IF EXISTS public.agent_slice_admission_replay(uuid,uuid,uuid,jsonb);
DROP FUNCTION IF EXISTS public.agent_slice_admit(uuid,uuid,uuid,jsonb,uuid,integer);
DROP FUNCTION IF EXISTS public.agent_slice_begin(uuid,uuid,uuid,jsonb);
DROP FUNCTION IF EXISTS public.agent_slice_begin_before_entry(uuid,uuid,uuid,jsonb);
DROP FUNCTION IF EXISTS public.agent_slice_selected_source(uuid,uuid);
DROP FUNCTION IF EXISTS public.agent_slice_context(uuid,uuid);
DROP FUNCTION IF EXISTS public.agent_slice_context_before_discussion(uuid,uuid);
DROP FUNCTION IF EXISTS public.agent_slice_continue_work(uuid,uuid,uuid,uuid,text,text,text,uuid);
DROP FUNCTION IF EXISTS public.agent_slice_conversation(uuid,uuid,timestamp with time zone,uuid,integer);
DROP FUNCTION IF EXISTS public.agent_slice_link_read(uuid,uuid,uuid);
DROP FUNCTION IF EXISTS public.agent_slice_open(uuid,uuid);
DROP FUNCTION IF EXISTS public.agent_slice_sources(uuid);
DROP FUNCTION IF EXISTS public.agent_slice_targets(uuid);
DROP FUNCTION IF EXISTS public.agent_preference(uuid,text,jsonb);

-- Old workbench: provider observation (explicitly not a settlement authority, 0104) and reference choices.
DROP FUNCTION IF EXISTS public.artifact_observe_generation(uuid,uuid,uuid,uuid,uuid,jsonb);
DROP FUNCTION IF EXISTS public.artifact_reference_choices(uuid,uuid);

-- Old chat admission (execute already revoked by 0150) and the old conversation soft delete (0147).
DROP FUNCTION IF EXISTS public.ordinary_chat_claim(uuid,uuid,jsonb,uuid);
DROP FUNCTION IF EXISTS public.soft_delete_conversation(uuid,uuid);

COMMIT;
