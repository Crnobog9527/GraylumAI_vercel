-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- DATA-ERASURE PR-B1a (0149) rollback. Refuses once any row was erased: the content is gone and
-- the original NOT NULL rules could not hold. Function bodies below are the pre-0149 definitions
-- (pg_get_functiondef of the replayed files, which match staging). Separately authorize remote use.
BEGIN;
DO $$
DECLARE t text; n bigint;
BEGIN
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE c.relnamespace = 'public'::regnamespace AND a.attname = 'erased_at' AND NOT a.attisdropped
      AND c.relname NOT IN ('conversations', 'messages') LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE erased_at IS NOT NULL', t) INTO n;
    IF n > 0 THEN RAISE EXCEPTION 'ERASURE_ROLLBACK_REFUSED: % has erased rows', t; END IF;
  END LOOP;
END $$;
DROP FUNCTION IF EXISTS public.account_erasure_scrub_content(uuid);
DO $$
DECLARE g record; c record;
BEGIN
  -- Guard triggers back to their argument-free form.
  FOR g IN SELECT t.tgrelid::regclass AS rel, t.tgname, p.proname FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE t.tgnargs > 0 AND p.proname IN ('artifact_immutable', 'artifact_chat_history_immutable',
      'artifact_round_identity', 'erased_row_guard') LOOP
    EXECUTE format('DROP TRIGGER %I ON %s', g.tgname, g.rel);
    IF g.proname = 'artifact_round_identity' THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION public.artifact_round_identity()', g.tgname, g.rel);
    ELSIF g.proname <> 'erased_row_guard' THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION public.%I()', g.tgname, g.rel, g.proname);
    END IF;
  END LOOP;
  -- Constraints: drop the erasure checks, unwrap rewritten checks, restore NOT NULL.
  FOR c IN SELECT con.conrelid::regclass AS rel, con.conname, pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con WHERE con.contype = 'c' AND con.connamespace = 'public'::regnamespace
      AND (con.conname LIKE 'erasure\_present\_%' OR con.conname LIKE 'erasure\_cleared\_%'
        OR pg_get_constraintdef(con.oid) LIKE 'CHECK (((erased_at IS NOT NULL) OR %') LOOP
    IF c.conname LIKE 'erasure\_present\_%' THEN
      EXECUTE format('ALTER TABLE %s ALTER COLUMN %I SET NOT NULL', c.rel,
        substring(c.def FROM 'OR \(([a-z_]+) IS NOT NULL\)'));
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.rel, c.conname);
    ELSIF c.conname LIKE 'erasure\_cleared\_%' THEN
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.rel, c.conname);
    ELSE
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.rel, c.conname);
      EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I CHECK %s', c.rel, c.conname,
        substring(c.def FROM '^CHECK \(\(\(erased_at IS NOT NULL\) OR (.*)\)\)$'));
    END IF;
  END LOOP;
END $$;
DROP FUNCTION IF EXISTS public.erased_row_guard();

CREATE OR REPLACE FUNCTION public.artifact_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN RAISE EXCEPTION 'artifact history immutable'; END $function$;

CREATE OR REPLACE FUNCTION public.artifact_chat_history_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF TG_OP='DELETE' THEN
  IF TG_TABLE_NAME='artifact_chat_turns' THEN
   IF NOT EXISTS(SELECT 1 FROM conversations WHERE id=OLD.conversation_id) THEN RETURN OLD; END IF;
  ELSIF TG_TABLE_NAME='artifact_chat_summaries' THEN
   IF NOT EXISTS(SELECT 1 FROM artifact_chat_turns WHERE request_id=OLD.turn_id) THEN RETURN OLD; END IF;
  END IF;
 END IF;
 RAISE EXCEPTION 'artifact history immutable';
END $function$;

CREATE OR REPLACE FUNCTION public.artifact_round_identity()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
 IF OLD.id IS DISTINCT FROM NEW.id OR OLD.project_id IS DISTINCT FROM NEW.project_id OR OLD.revision_id IS DISTINCT FROM NEW.revision_id
 OR OLD.package_hash IS DISTINCT FROM NEW.package_hash OR OLD.workflow IS DISTINCT FROM NEW.workflow OR OLD.workflow_hash IS DISTINCT FROM NEW.workflow_hash
 OR OLD.template_hash IS DISTINCT FROM NEW.template_hash OR OLD.created_at IS DISTINCT FROM NEW.created_at
 OR (OLD.state<>'draft' AND NEW IS DISTINCT FROM OLD) THEN RAISE EXCEPTION 'fixed round is immutable'; END IF;
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.artifact_chat_generation_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE c public.artifact_chats%ROWTYPE; t public.artifact_chat_turns%ROWTYPE;
BEGIN
 IF NEW.input->>'conversationId' IS NULL THEN
  IF NEW.input->>'purpose' IS NOT NULL THEN RAISE EXCEPTION 'role denied' USING ERRCODE='42501'; END IF;
  RETURN NEW; END IF;
 SELECT * INTO c FROM artifact_chats WHERE conversation_id=(NEW.input->>'conversationId')::uuid AND project_id=NEW.project_id AND round_id=NEW.round_id;
 SELECT * INTO t FROM artifact_chat_turns WHERE conversation_id=c.conversation_id AND request_id=(NEW.input->>'turnId')::uuid AND step_id=NEW.step_id;
 IF c.conversation_id IS NULL OR t.request_id IS NULL OR NEW.input->>'instruction' IS DISTINCT FROM t.body OR NEW.input->>'turnId' IS DISTINCT FROM t.request_id::text THEN RAISE EXCEPTION 'chat generation denied' USING ERRCODE='42501'; END IF;
 IF t.generation_mode='legacy' THEN
  IF NEW.request_id<>t.request_id OR NEW.input->>'purpose' IS NOT NULL THEN RAISE EXCEPTION 'legacy role denied' USING ERRCODE='42501'; END IF;
 ELSIF NEW.input->>'purpose'='reply' THEN
  IF NEW.request_id<>t.request_id THEN RAISE EXCEPTION 'reply identity denied' USING ERRCODE='42501'; END IF;
 ELSIF NEW.input->>'purpose'='summary' THEN
  IF NOT EXISTS(SELECT 1 FROM artifact_chat_summaries s JOIN artifact_generations parent ON parent.project_id=NEW.project_id AND parent.round_id=NEW.round_id AND parent.request_id=s.turn_id
    WHERE s.turn_id=t.request_id AND s.request_id=NEW.request_id AND parent.state='succeeded' AND parent.input->>'purpose'='reply'
     AND parent.evidence_ids <@ NEW.evidence_ids) THEN RAISE EXCEPTION 'summary parent denied' USING ERRCODE='42501'; END IF;
 ELSE RAISE EXCEPTION 'role denied' USING ERRCODE='42501'; END IF;
 IF TG_OP='INSERT' OR (NEW.state='dispatched' AND OLD.state='prepared') THEN
  IF NEW.input->>'purpose'='summary' AND NOT EXISTS(SELECT 1 FROM artifact_generations parent WHERE parent.project_id=NEW.project_id AND parent.round_id=NEW.round_id AND parent.request_id=t.request_id AND parent.quote->>'modelId' <> NEW.quote->>'modelId' AND lower(trim(parent.quote->>'providerModel')) <> lower(trim(NEW.quote->>'providerModel')) AND artifact_evidence_allowed(NEW.project_id,parent.evidence_ids)) THEN RAISE EXCEPTION 'summary source denied' USING ERRCODE='42501'; END IF;
  IF NOT (t.evidence_ids <@ NEW.evidence_ids) OR NOT artifact_evidence_allowed(NEW.project_id,t.evidence_ids) THEN RAISE EXCEPTION 'chat evidence denied' USING ERRCODE='42501'; END IF;
  SELECT coalesce(jsonb_agg(DISTINCT e),'[]') INTO NEW.evidence_ids FROM jsonb_array_elements(NEW.evidence_ids||t.evidence_ids) e;
 END IF;
 RETURN NEW;
END $function$;


CREATE OR REPLACE FUNCTION public.artifact_reference_receipt_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE ref artifact_work_references%ROWTYPE;
BEGIN
 SELECT * INTO ref FROM artifact_work_references WHERE round_id=NEW.round_id;
 IF FOUND AND NEW.result IS NOT NULL AND NOT artifact_evidence_allowed(NEW.project_id,NEW.evidence_ids||jsonb_build_array(ref.evidence_id)) THEN
  NEW.result:=jsonb_set(NEW.result,'{body}','"[来源已不可用]"');
 END IF;
 RETURN NEW;
END $function$;

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE c.relnamespace = 'public'::regnamespace AND a.attname = 'erased_at' AND NOT a.attisdropped
      AND c.relname NOT IN ('conversations', 'messages') LOOP
    EXECUTE format('ALTER TABLE public.%I DROP COLUMN erased_at', t);
  END LOOP;
END $$;
DROP FUNCTION IF EXISTS public.erasure_update_allowed(jsonb, jsonb, text[]);
COMMIT;
