-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- LEGACY-CLOSE PR-C (0271): drop three legacy chat tables nobody reads or writes
-- (docs/launch/implementation/LEGACY_CLOSE_CLEANUP_PLAN.md sections 5.2 and 6.3):
--   ordinary_chat_requests, agent_confirmed_preferences, agent_preference_requests.
-- Kept: agent_slice_calls (financial evidence, plan 5.2) and, for now, conversation_context_snapshots (empty on
-- staging): the CI empty-database check re-runs 0148 on the finished catalog and 0148 renames its foreign keys by
-- table name, so dropping it needs that check reworked first (separate PR, CI change for Owner approval).
-- Account erasure keeps scrubbing and pruning conversation_context_snapshots unchanged.
-- With ordinary_chat_requests go its settlement function ordinary_chat_transition and the conversations delete
-- guard ordinary_chat_delete_guard (plan 5.1). Every function body that still names one of the tables is patched
-- in place (text patches, marker '0271 legacy chat tables'), so changes made by other migrations stay intact:
--   account_erasure_scrub_runtime, account_erasure_scrub_content, account_erasure_body_remaining,
--   account_erasure_financial_proof, account_erasure_prune_business, erasure_business_owner,
--   agent_slice_preferences_valid.
-- Settlement gate (plan 5.1): refuses to run while an ordinary chat request is not terminal or a pre-deduct of one
-- has no settle/refund/abort_settle record. Staging read-only check 2026-10-16: all four legacy tables empty, gate met.
-- Amount evidence lives in billing_history (kept). Rollback: packages/db/tests/legacy-close-0271-rollback.sql
-- (only valid while no row has been written that depends on the absence of these tables; the dropped rows are not
-- restored, there were none on staging).
BEGIN;
SET LOCAL lock_timeout='5s';

DO $$
BEGIN
 IF to_regclass('public.ordinary_chat_requests') IS NOT NULL THEN
  IF EXISTS(SELECT 1 FROM public.ordinary_chat_requests WHERE state NOT IN ('succeeded','failed')) THEN
   RAISE EXCEPTION 'LEGACY_CLOSE_0271_ORDINARY_CHAT_PENDING';
  END IF;
  IF EXISTS(SELECT 1 FROM public.ordinary_chat_requests r WHERE r.pre_deduct_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM public.billing_history b WHERE b.user_id=r.user_id AND b.operation_type IN ('settle','refund','abort_settle')
     AND b.metadata->>'preDeductId'=r.pre_deduct_id::text)) THEN
   RAISE EXCEPTION 'LEGACY_CLOSE_0271_ORDINARY_CHAT_UNSETTLED';
  END IF;
 END IF;
END $$;

-- Remove every reference before the tables go. Each needle must occur exactly `times` times in the current definition.
DO $$
DECLARE
 marker constant text:='-- 0271 legacy chat tables';
 item record; source text; needle text;
BEGIN
 FOR item IN SELECT * FROM (VALUES
  (1,'account_erasure_scrub_runtime(uuid)',1,
$n$    ('ordinary_chat_requests',
      'writer_token = NULL, input = NULL, response_params = NULL, partial_content = NULL, failure_reason = NULL,
      reservation = (SELECT jsonb_object_agg(x.key,
      x.value) FROM jsonb_each(CASE WHEN jsonb_typeof(t.reservation) = ''object'' THEN t.reservation ELSE ''{}''::jsonb END) x WHERE x.key IN
      (''pre_deduct_id'', ''balance_before'', ''balance_after'', ''is_idempotent'')), billing_result = (SELECT jsonb_object_agg(x.key, x.value)
      FROM jsonb_each(CASE WHEN jsonb_typeof(t.billing_result) = ''object'' THEN t.billing_result ELSE ''{}''::jsonb END) x WHERE x.key IN
      (''user_message_id'', ''assistant_message_id'', ''transaction_id'', ''settle_id'', ''refund_id'', ''balance_after'', ''refunded_credits'',
      ''refund_amount'')), erased_at = $2',
      't.user_id = $1 AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = t.conversation_id AND c.user_id = $1)',
      't.conversation_id = ANY($4) AND t.state IN (''succeeded'',''failed'')'),
$n$,$n$    -- 0271 legacy chat tables
$n$),
  -- messages and conversation_context_snapshots carry the same readiness clause.
  (2,'account_erasure_scrub_runtime(uuid)',2,
$n$'t.conversation_id = ANY($4) AND NOT EXISTS (SELECT 1 FROM ordinary_chat_requests r WHERE r.conversation_id = t.conversation_id AND r.state
      NOT IN (''succeeded'',''failed'')) AND NOT EXISTS$n$,
$n$'t.conversation_id = ANY($4) AND NOT EXISTS$n$),
  (3,'account_erasure_scrub_runtime(uuid)',1,
$n$'t.id = ANY($4) AND NOT EXISTS (SELECT 1 FROM ordinary_chat_requests r WHERE r.conversation_id = t.id AND r.state NOT IN
      (''succeeded'',''failed'')) AND NOT EXISTS$n$,
$n$'t.id = ANY($4) AND NOT EXISTS$n$),
  (4,'account_erasure_scrub_content(uuid)',1,
$n$  DELETE FROM agent_confirmed_preferences WHERE actor_id = p_profile_id;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('agent_confirmed_preferences_deleted', n);
  DELETE FROM agent_preference_requests WHERE actor_id = p_profile_id;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('agent_preference_requests_deleted', n);
$n$,$n$  -- 0271 legacy chat tables
$n$),
  (5,'account_erasure_body_remaining(uuid)',1,
$n$  ('ordinary_chat_requests','t.user_id=$1'),
$n$,$n$  -- 0271 legacy chat tables
$n$),
  (6,'account_erasure_financial_proof(uuid)',1,
$n$ SELECT count(*) INTO n FROM ordinary_chat_requests WHERE user_id=p_profile_id
  AND (erased_at IS NULL OR state NOT IN ('succeeded','failed'));
 pending:=pending+n;
$n$,$n$ -- 0271 legacy chat tables
$n$),
  (7,'account_erasure_prune_business(uuid,integer)',1,
$n$  'runtime_sessions','conversation_context_snapshots','messages','ordinary_chat_requests',
$n$,$n$  -- 0271 legacy chat tables
  'runtime_sessions','conversation_context_snapshots','messages',
$n$),
  (8,'erasure_business_owner(text,jsonb)',1,
$n$ WHEN t IN ('conversations','ordinary_chat_requests') THEN RETURN (j->>'user_id')::uuid;
$n$,$n$ -- 0271 legacy chat tables
 WHEN t='conversations' THEN RETURN (j->>'user_id')::uuid;
$n$),
  (9,'agent_slice_preferences_valid(uuid,jsonb,text)',1,
$n$ AND jsonb_array_length(refs)=(SELECT count(DISTINCT (ref->>'scope',ref->>'name')) FROM jsonb_array_elements(refs) ref) AND
 NOT EXISTS(SELECT 1 FROM jsonb_array_elements(refs) ref LEFT JOIN agent_confirmed_preferences p
 ON p.actor_id=p_actor_id AND p.scope_key=ref->>'scope' AND p.name=ref->>'name'
 WHERE p.actor_id IS NULL OR NOT p.active OR p.version::text IS DISTINCT FROM ref->>'version'
 OR (p.scope_key<>'user' AND p.scope_key IS DISTINCT FROM 'account:'||p_account)
 OR (ref-'scope'-'name'-'version')<>'{}'::jsonb) END
$n$,$n$ -- 0271 legacy chat tables: no confirmed preference can exist any more, so only an empty list is valid.
 AND jsonb_array_length(refs)=0 END
$n$)
 ) v(step,signature,times,needle,patch) ORDER BY step LOOP
  source:=pg_get_functiondef(('public.'||item.signature)::regprocedure);
  needle:=item.needle;
  -- Already applied by an earlier run of this migration: the marker is there and the old text is gone.
  IF position(marker IN source)>0 AND position(needle IN source)=0 THEN CONTINUE; END IF;
  IF length(source)-length(replace(source,needle,''))<>item.times*length(needle) THEN
   RAISE EXCEPTION 'LEGACY_CLOSE_0271_SOURCE_MISMATCH: % step %',item.signature,item.step;
  END IF;
  EXECUTE replace(source,needle,item.patch);
 END LOOP;
 -- Nothing may still name a dropped table.
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace s ON s.oid=p.pronamespace WHERE s.nspname='public'
   AND p.proname NOT IN ('ordinary_chat_transition','ordinary_chat_delete_guard')
   AND p.prosrc ~ '(ordinary_chat_requests|agent_confirmed_preferences|agent_preference_requests)') THEN
  RAISE EXCEPTION 'LEGACY_CLOSE_0271_REFERENCE_LEFT';
 END IF;
END $$;

DROP TRIGGER IF EXISTS ordinary_chat_delete ON public.conversations;
DROP FUNCTION IF EXISTS public.ordinary_chat_delete_guard();
DROP FUNCTION IF EXISTS public.ordinary_chat_transition(uuid,uuid,uuid,text,jsonb);

-- No other table has a foreign key into these three (checked on a file-built database); RESTRICT keeps it that way.
DROP TABLE IF EXISTS public.ordinary_chat_requests RESTRICT;
DROP TABLE IF EXISTS public.agent_preference_requests RESTRICT;
DROP TABLE IF EXISTS public.agent_confirmed_preferences RESTRICT;

COMMIT;
