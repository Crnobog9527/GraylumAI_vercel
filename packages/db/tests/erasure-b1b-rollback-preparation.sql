-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- INCOMPLETE LOCAL PREPARATION ONLY. Not a migration; do not apply remotely.
-- Waiting for the controller-provided staging definitions of the two existing functions.
-- B1b rollback: refuse before any change if a B1b row has already lost content.
-- Scope is only the eleven B1b tables; all B1a structures remain untouched.
-- Controller-approved staging originals must be appended before this script can be released.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$
DECLARE t text; n bigint;
BEGIN
  FOREACH t IN ARRAY ARRAY['runtime_sessions','runtime_executions','runtime_history_dependencies',
    'runtime_session_batches','runtime_session_history','runtime_tool_calls','runtime_scope_material',
    'conversations','messages','conversation_context_snapshots','ordinary_chat_requests'] LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE erased_at IS NOT NULL',t) INTO n;
    IF n>0 THEN RAISE EXCEPTION 'ERASURE_ROLLBACK_REFUSED: % has erased rows',t; END IF;
  END LOOP;
END $$;
DROP FUNCTION public.account_erasure_scrub_runtime(uuid);
DROP TRIGGER erasure_closed_account_guard ON public.conversations;
DROP FUNCTION public.erasure_closed_conversation_guard();
DO $$
DECLARE t text; c record;
BEGIN
  FOREACH t IN ARRAY ARRAY['runtime_sessions','runtime_executions','runtime_history_dependencies',
    'runtime_session_batches','runtime_session_history','runtime_tool_calls','runtime_scope_material',
    'conversations','messages','conversation_context_snapshots','ordinary_chat_requests'] LOOP
    EXECUTE format('DROP TRIGGER a_erased_row_guard ON public.%I',t);
    FOR c IN SELECT con.conname,pg_get_constraintdef(con.oid) AS def FROM pg_constraint con
      WHERE con.conrelid=format('public.%I',t)::regclass AND con.contype='c'
      AND (con.conname LIKE 'erasure\_present\_%' OR con.conname LIKE 'erasure\_cleared\_%'
        OR pg_get_constraintdef(con.oid) LIKE 'CHECK (((erased_at IS NOT NULL) OR %') LOOP
      IF c.conname LIKE 'erasure\_present\_%' THEN
        EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I SET NOT NULL',t,
          substring(c.def FROM 'OR \(([a-z_]+) IS NOT NULL\)'));
        EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I',t,c.conname);
      ELSIF c.conname LIKE 'erasure\_cleared\_%' THEN
        EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I',t,c.conname);
      ELSE
        EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I',t,c.conname);
        EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK %s',t,c.conname,
          substring(c.def FROM '^CHECK \(\(\(erased_at IS NOT NULL\) OR (.*)\)\)$'));
      END IF;
    END LOOP;
    EXECUTE format('ALTER TABLE public.%I DROP COLUMN erased_at',t);
  END LOOP;
END $$;
-- SOURCE-BOUND ORIGINAL FUNCTIONS MUST BE INSERTED HERE AFTER CONTROLLER EVIDENCE.
COMMIT;
