-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- A DB transaction barrier cannot observe an outstanding Storage HTTP upload.
-- This subject/operation-only intent is the smallest durable admission/drain fact;
-- it contains no filename/body and is neither a job queue nor a retry authority.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS public.ticket_upload_intents (
  upload_id uuid PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  admitted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS ticket_upload_intents_profile ON public.ticket_upload_intents(profile_id);
ALTER TABLE public.ticket_upload_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ticket_upload_intents FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.ticket_upload_begin(p_profile_id uuid,p_upload_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p public.profiles;
BEGIN
  IF p_profile_id IS NULL OR p_upload_id IS NULL THEN
    RAISE EXCEPTION 'UPLOAD_INVALID' USING ERRCODE='22023';
  END IF;
  SELECT * INTO p FROM public.profiles WHERE id=p_profile_id FOR UPDATE;
  IF p.id IS NULL OR p.status IS DISTINCT FROM 'active' OR p.is_deleted::text IS DISTINCT FROM 'false'
    OR EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=p_profile_id) THEN
    RAISE EXCEPTION 'UPLOAD_ACCOUNT_CLOSED' USING ERRCODE='42501';
  END IF;
  -- Never return a second dispatch grant for an existing identity, including an unknown outcome.
  INSERT INTO public.ticket_upload_intents(upload_id,profile_id) VALUES(p_upload_id,p_profile_id);
  RETURN jsonb_build_object('admitted',true);
END $$;

CREATE OR REPLACE FUNCTION public.ticket_upload_finish(
  p_profile_id uuid,p_upload_id uuid,p_absent boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p public.profiles; closed boolean;
BEGIN
  IF p_profile_id IS NULL OR p_upload_id IS NULL OR p_absent IS NULL THEN
    RAISE EXCEPTION 'UPLOAD_INVALID' USING ERRCODE='22023';
  END IF;
  -- Same order as admission/confirmation. Upload I/O is always outside this transaction.
  SELECT * INTO p FROM public.profiles WHERE id=p_profile_id FOR UPDATE;
  IF p.id IS NULL THEN RAISE EXCEPTION 'UPLOAD_INVALID' USING ERRCODE='22023'; END IF;
  closed:=p.status IS DISTINCT FROM 'active' OR p.is_deleted::text IS DISTINCT FROM 'false'
    OR EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=p_profile_id);
  IF EXISTS(SELECT 1 FROM ticket_upload_intents WHERE upload_id=p_upload_id AND profile_id<>p_profile_id) THEN
    RAISE EXCEPTION 'UPLOAD_IDENTITY_MISMATCH' USING ERRCODE='42501';
  END IF;
  IF NOT closed OR p_absent THEN
    DELETE FROM ticket_upload_intents WHERE upload_id=p_upload_id AND profile_id=p_profile_id;
    RETURN jsonb_build_object('released',true,'closed',closed);
  END IF;
  RETURN jsonb_build_object('released',false,'closed',true);
END $$;
REVOKE ALL ON FUNCTION public.ticket_upload_begin(uuid,uuid),public.ticket_upload_finish(uuid,uuid,boolean)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ticket_upload_begin(uuid,uuid),public.ticket_upload_finish(uuid,uuid,boolean)
  TO service_role;
COMMIT;
