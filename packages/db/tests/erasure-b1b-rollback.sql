-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- B1b rollback: refuse before any change if a B1b row has already lost content.
-- Scope is only the eleven B1b tables; all B1a structures remain untouched.
-- Restores the controller-provided staging originals verbatim (PR #537).
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
-- Exact staging originals, including bodies, settings and retained ACLs.
CREATE OR REPLACE FUNCTION public.erasure_update_allowed(o jsonb, n jsonb, specs text[])
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  spec text; col text; rule text; cols text[] := '{}'; oldv jsonb; newv jsonb; kept jsonb;
BEGIN
  IF specs IS NULL OR cardinality(specs) = 0
    OR nullif(o -> 'erased_at', 'null'::jsonb) IS NOT NULL
    OR nullif(n -> 'erased_at', 'null'::jsonb) IS NULL THEN
    RETURN false;
  END IF;
  FOREACH spec IN ARRAY specs LOOP
    col := split_part(spec, '=', 1);
    rule := nullif(substr(spec, length(col) + 2), '');
    cols := cols || col;
    oldv := nullif(o -> col, 'null'::jsonb);
    newv := nullif(n -> col, 'null'::jsonb);
    IF rule IS NULL THEN
      IF newv IS NOT NULL THEN RETURN false; END IF;
    ELSIF rule LIKE 'erased:%' THEN
      IF NOT ((oldv IS NULL AND newv IS NULL)
        OR newv = to_jsonb('erased:' || (n ->> substr(rule, 8)))) THEN RETURN false; END IF;
    ELSIF rule LIKE 'keys:%' THEN
      SELECT jsonb_object_agg(e.key, e.value) INTO kept
      FROM jsonb_each(CASE WHEN jsonb_typeof(oldv) = 'object' THEN oldv ELSE '{}'::jsonb END) e
      WHERE e.key = ANY (string_to_array(substr(rule, 6), ','));
      IF newv IS DISTINCT FROM kept THEN RETURN false; END IF;
    ELSE
      RETURN false;
    END IF;
  END LOOP;
  RETURN (o - cols - 'erased_at') = (n - cols - 'erased_at');
END $function$;

CREATE OR REPLACE FUNCTION public.artifact_chat_message_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF EXISTS(SELECT 1 FROM conversations WHERE id=NEW.conversation_id AND skill_mode) THEN RAISE EXCEPTION 'guided messages require artifact turn' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $function$;
-- Restore the pre-0150 service-role admission grant; the function body never changed.
GRANT EXECUTE ON FUNCTION public.ordinary_chat_claim(uuid,uuid,jsonb,uuid) TO service_role;
COMMIT;
