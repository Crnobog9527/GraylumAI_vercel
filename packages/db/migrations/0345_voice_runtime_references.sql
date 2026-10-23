-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- VOICE: a writing run that carries a voice profile is bound to the exact version it used. Owner 2026-10-23:
-- "删了就必须立刻生效，连正在写的那一次也不能用。" Deleting a profile version, or the authored document it was learned
-- from (0341 voice_library_trigger), stops every run bound to it: the run is marked source_deleted, no provider call is
-- newly granted, no answer is saved or shown, and billing follows the existing deletion-abort rule (runtime_cancel).
-- Same shape as 0262 (library references) and 0306 (own posts). Repeatable: IF NOT EXISTS, marked patches.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.runtime_voice_references (
 execution_id uuid PRIMARY KEY REFERENCES public.runtime_executions(id),
 actor_id uuid NOT NULL REFERENCES public.profiles(id),
 -- No foreign key: the version row is removed by its deletion; this row then reveals that to the run.
 version_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS runtime_voice_references_version ON public.runtime_voice_references(version_id);
ALTER TABLE public.runtime_voice_references ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.runtime_voice_references FROM PUBLIC,anon,authenticated,service_role;

-- Frozen with the admission (commits or rolls back with it). Fires only for a run that carries a version.
-- The version row is share-locked and its deletion takes it exclusively, so admission and deletion are strictly ordered.
CREATE OR REPLACE FUNCTION public.runtime_voice_references_freeze() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE vid uuid;
BEGIN
 IF (NEW.payload->'voiceProfile'->>'versionId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
  RAISE EXCEPTION 'VOICE_REFERENCE_INVALID'; END IF;
 vid:=(NEW.payload->'voiceProfile'->>'versionId')::uuid;
 PERFORM bill2_actor(NEW.actor_id);
 PERFORM id FROM voice_profile_versions WHERE id=vid AND actor_id=NEW.actor_id AND status IN ('confirmed','superseded') FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'VOICE_REFERENCE_STALE'; END IF;
 INSERT INTO runtime_voice_references(execution_id,actor_id,version_id) VALUES(NEW.id,NEW.actor_id,vid);
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS runtime_voice_references_freeze ON public.runtime_executions;
CREATE TRIGGER runtime_voice_references_freeze AFTER INSERT ON public.runtime_executions
 FOR EACH ROW WHEN (NEW.payload->'voiceProfile' ? 'versionId') EXECUTE FUNCTION public.runtime_voice_references_freeze();

-- True while a run's bound version still exists (and is the actor's own).
CREATE OR REPLACE FUNCTION public.runtime_voice_source_gone(p_execution_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM runtime_voice_references r WHERE r.execution_id=p_execution_id
  AND NOT EXISTS(SELECT 1 FROM voice_profile_versions v WHERE v.id=r.version_id AND v.actor_id=r.actor_id));
$$;

-- Entry check of every runtime_execution action: a running execution whose voice version is gone is source-deleted at
-- once (begin/read report it unavailable; every other action takes the 0262 cancellation path). Inserted in front of
-- the 0262 library check, as 0306 does for own posts.
DO $entry$ DECLARE d text;anchor text;patch text;
BEGIN
 d:=pg_get_functiondef('public.runtime_execution(uuid,uuid,text,jsonb)'::regprocedure);
 IF position('-- VOICE source deleted' IN d)=0 THEN
  anchor:=$a$ -- 0262 library source deleted$a$;
  patch:=$p$ -- VOICE source deleted
 IF e.state NOT IN ('completed','cancelled') AND runtime_voice_source_gone(e.id) THEN
  UPDATE runtime_executions SET unavailable_reason=coalesce(unavailable_reason,'source_deleted')
   WHERE id=e.id RETURNING * INTO e;
 END IF;
$p$;
  IF array_length(string_to_array(d,anchor),1)<>2 THEN RAISE EXCEPTION 'VOICE_EXECUTION_SOURCE_MISMATCH';END IF;
  EXECUTE replace(d,anchor,patch||anchor);
 END IF;
END $entry$;

-- Final provider permission fence (as 0306): a deleted voice version means no NEW provider request is granted.
-- Receipt recording and financial recovery are unchanged.
DO $dispatch$ DECLARE d text;anchor text;fence text;
BEGIN
 d:=pg_get_functiondef('public.bill2_dispatch(uuid,uuid,uuid,uuid,boolean,jsonb)'::regprocedure);
 IF position('-- VOICE dispatch fence' IN d)=0 THEN
  anchor:=$a$ IF r.id IS NOT NULL THEN PERFORM runtime_billing_allowed(p_actor_id,r.payload,r.id);END IF;$a$;
  fence:=$dispatchFence$ -- VOICE dispatch fence
 IF EXISTS(SELECT 1 FROM runtime_executions ex WHERE ex.billing_run_id=r.id AND runtime_voice_source_gone(ex.id))
  THEN RAISE EXCEPTION 'RUNTIME_CONTEXT_REVOKED';END IF;
$dispatchFence$;
  IF array_length(string_to_array(d,anchor),1)<>2 THEN RAISE EXCEPTION 'VOICE_DISPATCH_SOURCE_MISMATCH';END IF;
  EXECUTE replace(d,anchor,anchor||E'\n'||fence);
 END IF;
END $dispatch$;

-- Account erasure: the reference rows hold no content; prune them before their executions (as 0262).
DO $$
DECLARE source text; needle text; replacement text; sig text;
BEGIN
 FOR sig,needle,replacement IN SELECT * FROM (VALUES
  ('erasure_business_owner(text,jsonb)', E' CASE\n', E' CASE\n WHEN t=''runtime_voice_references'' THEN RETURN (j->>''actor_id'')::uuid;\n'),
  ('account_erasure_prune_business(uuid,integer)', E' FOREACH t IN ARRAY ARRAY[\n', E' FOREACH t IN ARRAY ARRAY[\n  ''runtime_voice_references'',\n')
 ) changes(signature,anchor,patch) LOOP
  source:=pg_get_functiondef(('public.'||sig)::regprocedure);
  IF position('-- VOICE references' IN source)=0 THEN
   IF length(source)-length(replace(source,needle,''))<>length(needle) THEN
    RAISE EXCEPTION 'VOICE_REFERENCE_ERASURE_SOURCE_MISMATCH: %',sig; END IF;
   EXECUTE replace(source,needle,E' -- VOICE references\n'||replacement);
  END IF;
 END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.runtime_voice_references_freeze(),public.runtime_voice_source_gone(uuid),
 public.erasure_business_owner(text,jsonb),public.account_erasure_prune_business(uuid,integer)
 FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
