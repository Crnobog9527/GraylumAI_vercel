-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- VOICE PR-1 (Owner 2026-10-23: "我的文风这个功能是核心功能，必须一起上线。"): the user's writing-voice profile
-- (Master Plan 5.3). One profile per account with versions; a version is generated from the user's own ("authored")
-- library documents, edited and confirmed by the user, and only a confirmed version is ever used for writing.
-- Deleting a source document really deletes every version made from it (5.3, LIBRARY-VOICE "删除传播"); account
-- erasure removes all rows. Generation is one sessionless BILL2 PAYG call made by the host (the Fusion pattern):
-- these tables only keep the frozen corpus, the result and the billing run id. Nothing reads a profile for writing yet
-- (VOICE PR-2), and nothing is shown before the library page (VOICE PR-3). No configuration data. No remote application.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.voice_profile_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 actor_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
 request_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0),
 status text NOT NULL CHECK(status IN ('generating','draft','confirmed','superseded','stale','failed')),
 -- The profile fields and 2-3 original passages; bounded so writing never carries more than ~3k tokens.
 profile jsonb CHECK(profile IS NULL OR (jsonb_typeof(profile)='object' AND octet_length(profile::text)<=16384)),
 -- sources: the documents (and versions) the model read; corpus: every authored ready document at generation start.
 -- A version whose corpus no longer matches the library is "needs update" (5.3 step 5).
 sources jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(sources)='array'),
 corpus jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(corpus)='array'),
 billing_run_id uuid, billing_settled boolean NOT NULL DEFAULT false,
 failure text CHECK(failure IS NULL OR failure ~ '^[A-Z0-9_]{1,64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 confirmed_at timestamptz,
 UNIQUE(actor_id,request_id), UNIQUE(actor_id,version), UNIQUE(id,actor_id),
 CHECK(status NOT IN ('draft','confirmed','superseded') OR profile IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS voice_profile_versions_one_generating ON public.voice_profile_versions(actor_id)
 WHERE status='generating';
CREATE TABLE IF NOT EXISTS public.voice_profiles (
 actor_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE RESTRICT,
 -- "使用我的文风" (5.3 step 4); on unless the user turns it off.
 enabled boolean NOT NULL DEFAULT true,
 confirmed_version_id uuid,
 -- "最像我": read first when the corpus is over the cap (5.3 step 2).
 preferred_document_ids uuid[] NOT NULL DEFAULT '{}' CHECK(cardinality(preferred_document_ids)<=20),
 revision integer NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(confirmed_version_id,actor_id) REFERENCES public.voice_profile_versions(id,actor_id)
  ON DELETE SET NULL (confirmed_version_id)
);
-- Billing runs whose frozen input held text of a document since deleted: the receipts are projected to their
-- financial fields once the run is closed (the 0262 rule), then the row goes.
CREATE TABLE IF NOT EXISTS public.voice_billing_scrubs (
 run_id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 -- Last recovery attempt: candidates are taken oldest-checked first, so rows that keep waiting never crowd out newer ones.
 checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 -- How the run ends if it is still open: a version with no saved profile is a confirmed failure (the user is refunded);
 -- one that had a profile settles at its known cost.
 outcome text NOT NULL DEFAULT 'cancelled' CHECK(outcome IN ('cancelled','confirmed_failure'))
);
ALTER TABLE public.voice_billing_scrubs ADD COLUMN IF NOT EXISTS checked_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE public.voice_billing_scrubs ADD COLUMN IF NOT EXISTS outcome text NOT NULL DEFAULT 'cancelled'
 CHECK(outcome IN ('cancelled','confirmed_failure'));
CREATE INDEX IF NOT EXISTS voice_billing_scrubs_actor ON public.voice_billing_scrubs(actor_id);
ALTER TABLE public.voice_profile_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voice_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voice_billing_scrubs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.voice_profile_versions,public.voice_profiles,public.voice_billing_scrubs
 FROM PUBLIC,anon,authenticated,service_role;

-- Administrator flag "使用用户文风" on writing Skills (read by VOICE PR-2). Same column rules as 0219.
ALTER TABLE public.modules ADD COLUMN IF NOT EXISTS uses_user_voice boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.modules.uses_user_voice IS
 'VOICE: writing Skill; when the user has a confirmed voice profile and "使用我的文风" on, its runs carry that version.';
REVOKE SELECT (uses_user_voice), INSERT (uses_user_voice), UPDATE (uses_user_voice),
 REFERENCES (uses_user_voice) ON public.modules FROM anon, authenticated;

-- Generation reads at most this much text (5.3 "总量有上限"); preferred documents first, then the newest.
CREATE OR REPLACE FUNCTION public.voice_corpus_limit() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 60000 $$;

-- Every authored, ready, live document as [{documentId,contentVersion}] in id order.
CREATE OR REPLACE FUNCTION public.voice_current_corpus(a uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('documentId',d.id,'contentVersion',d.content_version) ORDER BY d.id),'[]')
 FROM library_documents d WHERE d.actor_id=a AND d.kind='document' AND d.purpose='authored'
  AND d.status='ready' AND d.deleted_at IS NULL;
$$;

CREATE OR REPLACE FUNCTION public.voice_version_view(v voice_profile_versions) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN v.id IS NULL THEN NULL ELSE jsonb_build_object('id',v.id,'version',v.version,'status',v.status,
  'profile',v.profile,'failure',v.failure,'createdAt',v.created_at,'confirmedAt',v.confirmed_at,
  'sources',(SELECT coalesce(jsonb_agg(jsonb_build_object('documentId',d.id,'filename',d.filename) ORDER BY s.ord),'[]')
   FROM jsonb_array_elements(v.sources) WITH ORDINALITY s(item,ord)
   JOIN library_documents d ON d.id=(s.item->>'documentId')::uuid AND d.actor_id=v.actor_id AND d.deleted_at IS NULL))
 END;
$$;

-- The library page: the switch, the confirmed version, the newest unconfirmed one and the authored documents.
CREATE OR REPLACE FUNCTION public.voice_state(a uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p voice_profiles; c voice_profile_versions; l voice_profile_versions;
BEGIN
 PERFORM library_actor(a);
 SELECT * INTO p FROM voice_profiles WHERE actor_id=a;
 SELECT * INTO c FROM voice_profile_versions WHERE id=p.confirmed_version_id;
 SELECT * INTO l FROM voice_profile_versions WHERE actor_id=a AND status IN ('generating','draft','stale','failed')
  AND (c.id IS NULL OR version>c.version) ORDER BY version DESC LIMIT 1;
 -- A draft whose corpus changed since generation cannot be confirmed (voice_profile_confirm); show it as stale.
 IF l.status='draft' AND l.corpus IS DISTINCT FROM voice_current_corpus(a) THEN l.status:='stale'; END IF;
 RETURN jsonb_build_object('enabled',coalesce(p.enabled,true),'revision',coalesce(p.revision,1),
  'confirmed',voice_version_view(c),'latest',voice_version_view(l),
  'needsUpdate',c.id IS NOT NULL AND c.corpus IS DISTINCT FROM voice_current_corpus(a),
  'documents',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',d.id,'filename',d.filename,'textBytes',d.text_bytes,
    'contentVersion',d.content_version,'createdAt',d.created_at,
    'preferred',d.id=ANY(coalesce(p.preferred_document_ids,'{}'))) ORDER BY d.created_at DESC,d.id),'[]')
   FROM library_documents d WHERE d.actor_id=a AND d.kind='document' AND d.purpose='authored'
    AND d.status='ready' AND d.deleted_at IS NULL));
END $$;

-- Start one generation: freeze the corpus and the text the model will read, and record the user's "最像我" choice.
-- Idempotent per request; one generation at a time per account. Returns the text only to the host that starts it.
CREATE OR REPLACE FUNCTION public.voice_generation_begin(a uuid,r uuid,preferred uuid[] DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v voice_profile_versions; doc record; seg record; used integer:=0; src jsonb:='[]'; material jsonb:='[]';
 parts text[]; n integer;
BEGIN
 PERFORM library_actor(a);
 IF r IS NULL OR preferred IS NULL OR cardinality(preferred)>20 THEN RAISE EXCEPTION 'VOICE_INVALID'; END IF;
 SELECT * INTO v FROM voice_profile_versions WHERE actor_id=a AND request_id=r;
 IF v.id IS NOT NULL THEN RETURN jsonb_build_object('replayed',true,'version',voice_version_view(v)); END IF;
 IF EXISTS(SELECT 1 FROM voice_profile_versions WHERE actor_id=a AND status='generating') THEN
  RAISE EXCEPTION 'VOICE_GENERATION_BUSY'; END IF;
 INSERT INTO voice_profiles(actor_id,preferred_document_ids) VALUES(a,ARRAY(SELECT DISTINCT unnest(preferred)))
 ON CONFLICT(actor_id) DO UPDATE SET preferred_document_ids=EXCLUDED.preferred_document_ids,updated_at=clock_timestamp();
 FOR doc IN SELECT d.id,d.filename,d.content_version FROM library_documents d
  WHERE d.actor_id=a AND d.kind='document' AND d.purpose='authored' AND d.status='ready' AND d.deleted_at IS NULL
  ORDER BY (d.id=ANY(preferred)) DESC,d.created_at DESC,d.id FOR SHARE OF d LOOP
  -- The share lock keeps a document's version fixed while its text is read, so the frozen corpus below matches the
  -- material (a recognition save or deletion waits for this transaction).
  EXIT WHEN used>=voice_corpus_limit();
  parts:='{}';
  FOR seg IN SELECT body FROM library_document_segments WHERE document_id=doc.id ORDER BY ordinal LOOP
   n:=octet_length(seg.body);
   EXIT WHEN used+n>voice_corpus_limit();
   parts:=parts||seg.body;used:=used+n;
  END LOOP;
  CONTINUE WHEN cardinality(parts)=0;
  src:=src||jsonb_build_array(jsonb_build_object('documentId',doc.id,'contentVersion',doc.content_version));
  material:=material||jsonb_build_array(jsonb_build_object('documentId',doc.id,'filename',doc.filename,
   'text',array_to_string(parts,E'\n')));
 END LOOP;
 IF jsonb_array_length(src)=0 THEN RAISE EXCEPTION 'VOICE_NO_CORPUS'; END IF;
 INSERT INTO voice_profile_versions(actor_id,request_id,version,status,sources,corpus)
 VALUES(a,r,coalesce((SELECT max(version) FROM voice_profile_versions WHERE actor_id=a),0)+1,'generating',src,
  voice_current_corpus(a)) RETURNING * INTO v;
 RETURN jsonb_build_object('replayed',false,'version',voice_version_view(v),'material',material);
END $$;

CREATE OR REPLACE FUNCTION public.voice_generation_bind(a uuid,vid uuid,run uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM library_actor(a,true);
 UPDATE voice_profile_versions SET billing_run_id=run,updated_at=clock_timestamp()
  WHERE id=vid AND actor_id=a AND status='generating' AND (billing_run_id IS NULL OR billing_run_id=run);
 IF NOT FOUND THEN RAISE EXCEPTION 'VOICE_VERSION_GONE'; END IF;
END $$;

-- The host's result. A profile only becomes a draft when the authored corpus is unchanged since the start
-- (5.3 step 3: "生成期间语料有变化时，新画像不生效，标为需要更新"). A version deleted meanwhile (its source document
-- was deleted) stays deleted: the result is dropped. settled: the billing run is already finalized.
CREATE OR REPLACE FUNCTION public.voice_generation_finish(a uuid,vid uuid,result jsonb,failure_code text,settled boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v voice_profile_versions;
BEGIN
 PERFORM library_actor(a,true);
 SELECT * INTO v FROM voice_profile_versions WHERE id=vid AND actor_id=a FOR UPDATE;
 IF v.id IS NULL THEN RETURN jsonb_build_object('status','deleted'); END IF;
 IF v.status<>'generating' THEN
  -- A recovery attempt always moves the row to the back of the queue, settled or not.
  UPDATE voice_profile_versions SET billing_settled=billing_settled OR coalesce(settled,false),updated_at=clock_timestamp()
   WHERE id=vid RETURNING * INTO v;
  RETURN voice_version_view(v);
 END IF;
 IF (result IS NULL)=(failure_code IS NULL) THEN RAISE EXCEPTION 'VOICE_INVALID'; END IF;
 UPDATE voice_profile_versions SET profile=result,failure=failure_code,billing_settled=coalesce(settled,false),
  status=CASE WHEN failure_code IS NOT NULL THEN 'failed' WHEN corpus=voice_current_corpus(a) THEN 'draft' ELSE 'stale' END,
  updated_at=clock_timestamp() WHERE id=vid RETURNING * INTO v;
 RETURN voice_version_view(v);
END $$;

-- The user edits a draft or the confirmed profile and confirms it (5.3 step 3). Confirming a draft makes it current;
-- editing the confirmed one makes a new confirmed version. The previous confirmed version is kept as superseded
-- (writing replays keep reading the version they were frozen with) until the user deletes it.
CREATE OR REPLACE FUNCTION public.voice_profile_confirm(a uuid,vid uuid,expected_revision integer,result jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p voice_profiles; v voice_profile_versions; old uuid;
BEGIN
 PERFORM library_actor(a);
 IF result IS NULL OR jsonb_typeof(result)<>'object' THEN RAISE EXCEPTION 'VOICE_INVALID'; END IF;
 INSERT INTO voice_profiles(actor_id) VALUES(a) ON CONFLICT(actor_id) DO NOTHING;
 SELECT * INTO p FROM voice_profiles WHERE actor_id=a FOR UPDATE;
 IF p.revision IS DISTINCT FROM expected_revision THEN RAISE EXCEPTION 'VOICE_REVISION_CONFLICT'; END IF;
 SELECT * INTO v FROM voice_profile_versions WHERE id=vid AND actor_id=a FOR UPDATE;
 IF v.id IS NULL THEN RAISE EXCEPTION 'VOICE_VERSION_GONE'; END IF;
 -- Checked again when it takes effect (LIBRARY-VOICE "保存和生效前比对"): a draft whose corpus changed is stale.
 IF v.status='stale' OR (v.status='draft' AND v.corpus IS DISTINCT FROM voice_current_corpus(a)) THEN
  RAISE EXCEPTION 'VOICE_STALE'; END IF;
 old:=p.confirmed_version_id;
 IF v.status='draft' THEN
  UPDATE voice_profile_versions SET profile=result,status='confirmed',confirmed_at=clock_timestamp(),
   updated_at=clock_timestamp() WHERE id=vid RETURNING * INTO v;
 ELSIF v.status='confirmed' AND v.id=old THEN
  IF v.profile=result THEN RETURN voice_state(a); END IF;
  INSERT INTO voice_profile_versions(actor_id,request_id,version,status,profile,sources,corpus,billing_settled,confirmed_at)
  VALUES(a,gen_random_uuid(),(SELECT max(version) FROM voice_profile_versions WHERE actor_id=a)+1,'confirmed',result,
   v.sources,v.corpus,true,clock_timestamp()) RETURNING * INTO v;
 ELSE RAISE EXCEPTION 'VOICE_NOT_CONFIRMABLE'; END IF;
 UPDATE voice_profile_versions SET status='superseded',updated_at=clock_timestamp()
  WHERE id=old AND id<>v.id AND status='confirmed';
 UPDATE voice_profiles SET confirmed_version_id=v.id,revision=revision+1,updated_at=clock_timestamp() WHERE actor_id=a;
 RETURN voice_state(a);
END $$;

CREATE OR REPLACE FUNCTION public.voice_profile_set_enabled(a uuid,expected_revision integer,on_off boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p voice_profiles;
BEGIN
 PERFORM library_actor(a);
 IF on_off IS NULL THEN RAISE EXCEPTION 'VOICE_INVALID'; END IF;
 INSERT INTO voice_profiles(actor_id) VALUES(a) ON CONFLICT(actor_id) DO NOTHING;
 SELECT * INTO p FROM voice_profiles WHERE actor_id=a FOR UPDATE;
 IF p.revision IS DISTINCT FROM expected_revision THEN RAISE EXCEPTION 'VOICE_REVISION_CONFLICT'; END IF;
 UPDATE voice_profiles SET enabled=on_off,revision=revision+1,updated_at=clock_timestamp() WHERE actor_id=a;
 RETURN voice_state(a);
END $$;

-- Real deletion of one version (5.3 "支持真正删除"). A version still generating cannot be deleted by the user;
-- deleting its source document still removes it (voice_library_trigger).
CREATE OR REPLACE FUNCTION public.voice_profile_delete(a uuid,vid uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v voice_profile_versions;
BEGIN
 PERFORM library_actor(a);
 SELECT * INTO v FROM voice_profile_versions WHERE id=vid AND actor_id=a FOR UPDATE;
 IF v.status='generating' THEN RAISE EXCEPTION 'VOICE_GENERATION_BUSY'; END IF;
 IF v.id IS NOT NULL THEN PERFORM voice_delete_versions(a,ARRAY[v.id]); END IF;
 UPDATE voice_profiles SET revision=revision+1,updated_at=clock_timestamp() WHERE actor_id=a;
 RETURN voice_state(a);
END $$;

-- Deletes versions and queues their billing runs' receipts for content scrubbing.
CREATE OR REPLACE FUNCTION public.voice_delete_versions(a uuid,ids uuid[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE n integer;
BEGIN
 INSERT INTO voice_billing_scrubs(run_id,actor_id,outcome)
 SELECT billing_run_id,a,CASE WHEN profile IS NULL THEN 'confirmed_failure' ELSE 'cancelled' END
 FROM voice_profile_versions WHERE actor_id=a AND id=ANY(ids) AND billing_run_id IS NOT NULL
 ON CONFLICT(run_id) DO NOTHING;
 DELETE FROM voice_profile_versions WHERE actor_id=a AND id=ANY(ids);
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN n;
END $$;

-- Deleting an authored document (by the user, by upload cleanup or by account closure) deletes every version that
-- read it, including one still generating (its late result is then dropped). Superseded versions too: a replay
-- must never read deleted text again (LIBRARY-VOICE 必测项 2).
CREATE OR REPLACE FUNCTION public.voice_library_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM voice_delete_versions(NEW.actor_id,ARRAY(SELECT id FROM voice_profile_versions
  WHERE actor_id=NEW.actor_id AND sources @> jsonb_build_array(jsonb_build_object('documentId',NEW.id))));
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS voice_library_deleted ON public.library_documents;
CREATE TRIGGER voice_library_deleted AFTER UPDATE OF deleted_at ON public.library_documents
 FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
 EXECUTE FUNCTION public.voice_library_trigger();

-- What a writing run uses (VOICE PR-2), read without locking the account: the switch, and the confirmed version
-- (only when the switch is on). No profile row means the switch was never turned off and nothing is confirmed.
CREATE OR REPLACE FUNCTION public.voice_profile_current(a uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('enabled',coalesce(p.enabled,true),'versionId',CASE WHEN p.enabled THEN v.id END,
  'version',CASE WHEN p.enabled THEN v.version END)
 FROM (SELECT a AS actor_id) x LEFT JOIN voice_profiles p ON p.actor_id=x.actor_id
  LEFT JOIN voice_profile_versions v ON v.id=p.confirmed_version_id AND v.status='confirmed';
$$;
-- The text of a frozen version (replays keep their version); NULL once deleted.
CREATE OR REPLACE FUNCTION public.voice_profile_read(a uuid,vid uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('versionId',id,'version',version,'profile',profile) FROM voice_profile_versions
 WHERE id=vid AND actor_id=a AND status IN ('confirmed','superseded');
$$;

-- Daily backstop (billing-reconcile): generations left open by a closed page, and runs waiting for a scrub. A scrub
-- waits 30 minutes, so a generation still running when its source was deleted can finish its own settlement first.
-- The frozen staging binding of a run, as Fusion recovery reads it (0235): recovery never goes through live admission.
CREATE OR REPLACE FUNCTION public.voice_run_recovery(p_run_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN r.payload->>'mode'='production' AND r.test_window_id IS NULL THEN jsonb_build_object('mode','production',
  'id',r.payload->'rules'->>'quoteVersion','callPolicies',r.payload->'callPolicy','creditsPerUsd',r.payload->'rules'->>'creditsPerUsd',
  'multiplier',r.payload->'rules'->>'multiplier','expiresAt',r.deadline)
 WHEN r.payload->>'mode'='staging_test' AND r.test_window_id IS NOT NULL THEN jsonb_build_object(
  'id',r.test_window_id,'callPolicies',r.payload->'callPolicy','creditsPerUsd',r.payload->'rules'->>'creditsPerUsd',
  'multiplier',r.payload->'rules'->>'multiplier','expiresAt',r.deadline) END
 FROM bill2_runs r WHERE r.id=p_run_id;
$$;
CREATE OR REPLACE FUNCTION public.voice_recovery_candidates(p_limit integer DEFAULT 50) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object(
  -- hasProfile: a profile was really saved, so the run was delivered; otherwise the user must not be charged.
  'generations',(SELECT coalesce(jsonb_agg(jsonb_build_object('actorId',actor_id,'versionId',id,'runId',billing_run_id,
    'status',status,'hasProfile',profile IS NOT NULL,'recovery',voice_run_recovery(billing_run_id))),'[]')
    FROM (SELECT * FROM voice_profile_versions
    WHERE (status='generating' OR (billing_run_id IS NOT NULL AND NOT billing_settled))
     AND updated_at<clock_timestamp()-interval '30 minutes' ORDER BY updated_at LIMIT p_limit) g),
  'scrubs',(SELECT coalesce(jsonb_agg(jsonb_build_object('actorId',actor_id,'runId',run_id,'outcome',outcome,
    'recovery',voice_run_recovery(run_id))),'[]')
   FROM (SELECT * FROM voice_billing_scrubs WHERE checked_at<clock_timestamp()-interval '30 minutes'
    ORDER BY checked_at LIMIT p_limit) s));
$$;
-- A candidate that could not be processed (an error before any state change) also goes to the back of the queue.
CREATE OR REPLACE FUNCTION public.voice_recovery_touch(p_version_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 UPDATE voice_profile_versions SET updated_at=clock_timestamp() WHERE id=p_version_id;
$$;
CREATE OR REPLACE FUNCTION public.voice_scrub_touch(p_run_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 UPDATE voice_billing_scrubs SET checked_at=clock_timestamp() WHERE run_id=p_run_id;
$$;
-- Projects a closed run's receipts to their financial fields (0262's rule), then forgets it. Waits while open.
CREATE OR REPLACE FUNCTION public.voice_billing_scrub(p_run_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s voice_billing_scrubs; b bill2_runs; scrub jsonb;
BEGIN
 SELECT * INTO s FROM voice_billing_scrubs WHERE run_id=p_run_id FOR UPDATE SKIP LOCKED;
 IF s.run_id IS NULL THEN RETURN 'done'; END IF;
 UPDATE voice_billing_scrubs SET checked_at=clock_timestamp() WHERE run_id=p_run_id;
 SELECT * INTO b FROM bill2_runs WHERE id=p_run_id AND actor_id=s.actor_id FOR UPDATE NOWAIT;
 IF b.id IS NOT NULL THEN
  IF NOT b.closed THEN RETURN 'waiting'; END IF;
  UPDATE bill2_runs SET content_deleted_at=clock_timestamp() WHERE id=b.id AND content_deleted_at IS NULL;
  IF NOT coalesce(content_erasure_financial_allowed(s.actor_id,coalesce(b.pre_deduct_id,b.id)),false) THEN RETURN 'waiting'; END IF;
  scrub:=account_erasure_scrub_receipts(s.actor_id,b.id,100);
  IF (scrub->>'remaining')::bigint>(scrub->>'manualReview')::bigint THEN RETURN 'waiting'; END IF;
 END IF;
 DELETE FROM voice_billing_scrubs WHERE run_id=p_run_id;
 RETURN 'done';
EXCEPTION WHEN lock_not_available THEN RETURN 'waiting';
END $$;

-- Account erasure: all three tables are the account's own rows (no content survives in other tables).
DO $$
DECLARE source text; needle text; replacement text; sig text;
BEGIN
 FOR sig,needle,replacement IN SELECT * FROM (VALUES
  ('erasure_business_owner(text,jsonb)', E' CASE\n',
   E' CASE\n WHEN t IN (''voice_profiles'',''voice_profile_versions'',''voice_billing_scrubs'') THEN RETURN (j->>''actor_id'')::uuid;\n'),
  ('account_erasure_prune_business(uuid,integer)', E' FOREACH t IN ARRAY ARRAY[\n',
   E' FOREACH t IN ARRAY ARRAY[\n  ''voice_profiles'',''voice_profile_versions'',''voice_billing_scrubs'',\n'),
  ('account_erasure_business_remaining(uuid)', ' SELECT (',
   E' SELECT (SELECT count(*) FROM public.voice_profiles WHERE actor_id=p_profile_id)\n +(SELECT count(*) FROM public.voice_profile_versions WHERE actor_id=p_profile_id)\n +(SELECT count(*) FROM public.voice_billing_scrubs WHERE actor_id=p_profile_id)\n +(')
 ) changes(signature,anchor,patch) LOOP
  source:=pg_get_functiondef(('public.'||sig)::regprocedure);
  IF position('-- VOICE erasure' IN source)=0 THEN
   IF length(source)-length(replace(source,needle,''))<>length(needle) THEN
    RAISE EXCEPTION 'VOICE_ERASURE_SOURCE_MISMATCH: %',sig; END IF;
   EXECUTE replace(source,needle,E' -- VOICE erasure\n'||replacement);
  END IF;
 END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.voice_corpus_limit(),public.voice_current_corpus(uuid),
 public.voice_version_view(public.voice_profile_versions),public.voice_state(uuid),
 public.voice_generation_begin(uuid,uuid,uuid[]),public.voice_generation_bind(uuid,uuid,uuid),
 public.voice_generation_finish(uuid,uuid,jsonb,text,boolean),public.voice_profile_confirm(uuid,uuid,integer,jsonb),
 public.voice_profile_set_enabled(uuid,integer,boolean),public.voice_profile_delete(uuid,uuid),
 public.voice_delete_versions(uuid,uuid[]),public.voice_library_trigger(),public.voice_profile_current(uuid),
 public.voice_profile_read(uuid,uuid),public.voice_recovery_candidates(integer),public.voice_billing_scrub(uuid),
 public.voice_run_recovery(uuid),public.voice_recovery_touch(uuid),public.voice_scrub_touch(uuid),public.erasure_business_owner(text,jsonb),public.account_erasure_prune_business(uuid,integer),
 public.account_erasure_business_remaining(uuid)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.voice_state(uuid),public.voice_generation_begin(uuid,uuid,uuid[]),
 public.voice_generation_bind(uuid,uuid,uuid),public.voice_generation_finish(uuid,uuid,jsonb,text,boolean),
 public.voice_profile_confirm(uuid,uuid,integer,jsonb),public.voice_profile_set_enabled(uuid,integer,boolean),
 public.voice_profile_delete(uuid,uuid),public.voice_profile_current(uuid),public.voice_profile_read(uuid,uuid),
 public.voice_recovery_candidates(integer),public.voice_billing_scrub(uuid),public.voice_recovery_touch(uuid),public.voice_scrub_touch(uuid) TO service_role;
COMMIT;
