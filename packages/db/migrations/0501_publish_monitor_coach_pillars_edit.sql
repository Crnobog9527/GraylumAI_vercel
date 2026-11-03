-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PUBLISH-MONITOR block D (0501): the user edits a brand's content pillars
-- as a simple setting (Owner 2026-11-03: keep "edit content pillars", no confirmation screen for coach suggestions). Add, rename,
-- delete, reorder; at most 6 (the table's CHECK). Keys never change: a rename keeps the key, so posts keep their tag; a new pillar
-- gets a fresh key that was never used, so an old experiment or mix target can never point at it. Deleting a pillar sends its
-- posts back to "未分类" (tag cleared, so title tagging may tag them again) and drops it from the mix target.
--   * publish_monitor_coach_extracted_pillars(brand): the candidates the review claim takes from the confirmed positioning
--     report on first sight of a brand (same rule; the claim itself is unchanged).
--   * publish_monitor_coach_pillars(actor): the actor's reviewable brands (own connections, as the claim) and their pillars;
--     a brand without a profile row yet shows the extracted candidates, not saved.
--   * publish_monitor_coach_pillars_save(actor, brand, pillars, base): the whole list in order, [{key|null, name}], and the list the
--     page read ([{key, name}]); a save from a page whose list is out of date (edited in another window meanwhile) is refused.
-- Compatibility: new functions, and the coach save (whole function) takes a shared lock on the brand's pillars before tagging;
-- its input, output and writes are unchanged. The claim and pack rows are unchanged.
-- Repeatable: CREATE OR REPLACE plus REVOKE/GRANT. Recovery: DROP the three new functions and re-apply the coach save as 0491
-- defines it (only the lock line differs); saved pillars stay valid rows the old code already reads ('user' is allowed since 0457).
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.publish_monitor_coach_extracted_pillars(p_business_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT coalesce((SELECT jsonb_agg(jsonb_build_object('key','p'||n,'name',left(btrim(p),40),'definition',left(btrim(p),200)) ORDER BY n)
  FROM opc_businesses b JOIN artifact_versions v ON v.id=b.current_source_version_id,
   jsonb_array_elements_text(CASE WHEN jsonb_typeof(v.report#>'{generatedReport,data,data,content,pillars}')='array'
    THEN v.report#>'{generatedReport,data,data,content,pillars}' ELSE '[]' END) WITH ORDINALITY q(p,n)
  WHERE b.id=p_business_id AND n<=6 AND btrim(p)<>''),'[]'::jsonb)
$function$;

CREATE OR REPLACE FUNCTION public.publish_monitor_coach_pillars(a uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF NOT publish_monitor_actor_open(a) THEN RAISE EXCEPTION 'PUBLISH_MONITOR_ACCOUNT_CLOSED' USING ERRCODE='42501'; END IF;
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('businessId',b.id,'businessName',b.name,
   'pillars',coalesce(p.pillars,publish_monitor_coach_extracted_pillars(b.id)),
   'source',CASE WHEN p.business_id IS NOT NULL THEN p.pillars_source
    WHEN jsonb_array_length(publish_monitor_coach_extracted_pillars(b.id))>0 THEN 'extracted' END) ORDER BY b.created_at,b.id)
  FROM opc_businesses b LEFT JOIN social_coach_profiles p ON p.actor_id=a AND p.business_id=b.id
  WHERE b.actor_id=a AND b.erased_at IS NULL AND b.archived_at IS NULL
   AND EXISTS(SELECT 1 FROM social_connections c WHERE c.actor_id=a AND c.business_id=b.id AND c.role='own'
    AND c.status IN ('connected','reauth_required','quarantined'))),'[]'::jsonb);
END $function$;

-- An earlier draft of this migration had no base list: never leave that overload behind (it would skip the out-of-date check).
DROP FUNCTION IF EXISTS public.publish_monitor_coach_pillars_save(uuid,uuid,jsonb);
CREATE OR REPLACE FUNCTION public.publish_monitor_coach_pillars_save(a uuid, p_business_id uuid, p_pillars jsonb, p_base jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE prof social_coach_profiles; current jsonb; next jsonb:='[]'; x jsonb; k text; nm text; old jsonb; kept text[]:='{}';
 removed text[]; stages jsonb;
BEGIN
 -- Locks only this user's row for this brand (the insert below and FOR UPDATE), waited for at most 2 s (transaction-local) while
 -- a coach save tags (milliseconds); past it the save fails and the page says try again.
 PERFORM set_config('lock_timeout','2000',true);
 IF NOT publish_monitor_actor_open(a) THEN RAISE EXCEPTION 'PUBLISH_MONITOR_ACCOUNT_CLOSED' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM opc_businesses WHERE id=p_business_id AND actor_id=a AND erased_at IS NULL AND archived_at IS NULL) THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_BUSINESS_NOT_FOUND' USING ERRCODE='42501'; END IF;
 -- The brands the setting lists (and the claim reviews): one with an own connection.
 IF NOT EXISTS(SELECT 1 FROM social_connections c WHERE c.actor_id=a AND c.business_id=p_business_id AND c.role='own'
  AND c.status IN ('connected','reauth_required','quarantined')) THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_BUSINESS_NOT_FOUND' USING ERRCODE='42501'; END IF;
 IF p_pillars IS NULL OR jsonb_typeof(p_pillars)<>'array' OR jsonb_array_length(p_pillars)>6 THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 -- The same first-sight row the review claim would make (confirmed positioning version, extracted candidates), so saving first
 -- never leaves the brand without its positioning version; then the row is locked against a concurrent save or claim.
 -- The account stages too, as the claim records them: a stage change is then noticed from the first review on.
 SELECT coalesce(jsonb_object_agg(project_id::text,stage),'{}') INTO stages FROM opc_accounts
  WHERE actor_id=a AND business_id=p_business_id AND erased_at IS NULL;
 INSERT INTO social_coach_profiles(actor_id,business_id,strategy_version_id,pillars,pillars_source,strategy_check_stages)
 SELECT a,b.id,b.current_source_version_id,publish_monitor_coach_extracted_pillars(b.id),
  CASE WHEN jsonb_array_length(publish_monitor_coach_extracted_pillars(b.id))>0 THEN 'extracted' END,stages
 FROM opc_businesses b WHERE b.id=p_business_id
 ON CONFLICT(actor_id,business_id) DO NOTHING;
 SELECT * INTO prof FROM social_coach_profiles WHERE actor_id=a AND business_id=p_business_id FOR UPDATE;
 current:=prof.pillars;
 -- The whole list replaces the saved one, so it must be built on the saved one: otherwise another window's new pillar would be read
 -- as deleted here (its posts untagged). The page reads the list again and the user edits that.
 IF coalesce((SELECT jsonb_agg(jsonb_build_object('key',e->>'key','name',e->>'name') ORDER BY n) FROM jsonb_array_elements(current)
   WITH ORDINALITY q(e,n)),'[]') IS DISTINCT FROM coalesce((SELECT jsonb_agg(jsonb_build_object('key',e->>'key','name',e->>'name')
   ORDER BY n) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_base)='array' THEN p_base ELSE '[]' END) WITH ORDINALITY q(e,n)),'[]') THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_PILLARS_CHANGED' USING ERRCODE='40001'; END IF;
 FOR x IN SELECT value FROM jsonb_array_elements(p_pillars) LOOP
  IF jsonb_typeof(x)<>'object' THEN RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  nm:=btrim(coalesce(x->>'name',''));
  IF char_length(nm) NOT BETWEEN 1 AND 40 OR nm ~ '[[:cntrl:]]' THEN
   RAISE EXCEPTION 'PUBLISH_MONITOR_PILLAR_NAME_INVALID' USING ERRCODE='22023'; END IF;
  -- Same comparison as title tagging (NFKC, no spaces, lower case): two names it cannot tell apart would make it give up on both.
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(next) e
   WHERE lower(regexp_replace(normalize(e->>'name',NFKC),'\s+','','g'))=lower(regexp_replace(normalize(nm,NFKC),'\s+','','g'))) THEN
   RAISE EXCEPTION 'PUBLISH_MONITOR_PILLAR_NAME_DUPLICATE' USING ERRCODE='22023'; END IF;
  k:=x->>'key';
  IF k IS NULL THEN
   -- A key never used by this brand: an old experiment or mix target that named a deleted pillar can never match the new one.
   LOOP
    k:='u'||substr(md5(gen_random_uuid()::text),1,8);
    EXIT WHEN NOT EXISTS(SELECT 1 FROM jsonb_array_elements(current||next) e WHERE e->>'key'=k)
     AND NOT EXISTS(SELECT 1 FROM social_post_facts WHERE actor_id=a AND business_id=p_business_id AND pillar_key=k)
     AND NOT EXISTS(SELECT 1 FROM social_review_experiments WHERE actor_id=a AND business_id=p_business_id AND match->>'pillar_key'=k);
   END LOOP;
   next:=next||jsonb_build_array(jsonb_build_object('key',k,'name',nm,'definition',nm));
  ELSE
   -- Only a pillar the brand has now keeps its key; a deleted key cannot be brought back from an old page.
   SELECT e INTO old FROM jsonb_array_elements(current) e WHERE e->>'key'=k;
   IF old IS NULL OR k=ANY(kept) THEN RAISE EXCEPTION 'PUBLISH_MONITOR_PILLAR_KEY_INVALID' USING ERRCODE='22023'; END IF;
   kept:=kept||k;
   next:=next||jsonb_build_array(jsonb_build_object('key',k,'name',nm,
    'definition',CASE WHEN old->>'name'=nm THEN coalesce(old->>'definition',nm) ELSE nm END));
  END IF;
 END LOOP;
 SELECT coalesce(array_agg(e->>'key'),'{}') INTO removed FROM jsonb_array_elements(current) e WHERE NOT (e->>'key'=ANY(kept));
 IF cardinality(removed)>0 THEN
  UPDATE social_post_facts SET pillar_key=NULL,pillar_source=NULL,updated_at=clock_timestamp()
   WHERE actor_id=a AND business_id=p_business_id AND pillar_key=ANY(removed);
 END IF;
 UPDATE social_coach_profiles SET pillars=next,pillars_source='user',
  pillar_mix_target=CASE WHEN pillar_mix_target IS NULL THEN NULL
   -- The other shares are kept as they are (no 100% rule); nothing left is no target.
   ELSE (SELECT jsonb_object_agg(t.key,t.value) FROM jsonb_each(pillar_mix_target) t WHERE NOT (t.key=ANY(removed))) END,
  updated_at=clock_timestamp()
  WHERE actor_id=a AND business_id=p_business_id;
 RETURN jsonb_build_object('businessId',p_business_id,'pillars',next,'source','user','removed',to_jsonb(removed));
END $function$;

-- The coach save, unchanged except that it locks the pillars before tagging (see the comment there).
CREATE OR REPLACE FUNCTION public.publish_monitor_review_save_coach(p_id uuid, p_token uuid, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r social_review_runs; v jsonb; x jsonb; note text; concluded integer:=0; proposed integer:=0; tagged integer:=0; n integer;
BEGIN
 IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR pg_column_size(p_payload)>65536
  OR jsonb_typeof(coalesce(p_payload->'experiments','[]'))<>'array' OR jsonb_array_length(coalesce(p_payload->'experiments','[]'))>3
  OR jsonb_typeof(coalesce(p_payload->'verdict_notes','[]'))<>'array' OR jsonb_array_length(coalesce(p_payload->'verdict_notes','[]'))>20
  OR jsonb_typeof(coalesce(p_payload->'tags','[]'))<>'array' OR jsonb_array_length(coalesce(p_payload->'tags','[]'))>40 THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 SELECT * INTO r FROM social_review_runs WHERE id=p_id AND lease_token=p_token AND status='claimed'
  AND business_id IS NOT NULL AND pack IS NOT NULL FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('saved',false); END IF;
 -- Verdicts: only the experiments the pack showed for review, with the result the code computed then.
 FOR v IN SELECT value FROM jsonb_array_elements(coalesce(r.pack->'review'->'ledger'->'to_review','[]')) LOOP
  CONTINUE WHEN coalesce(v->>'id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  SELECT nt.val->>'note' INTO note FROM jsonb_array_elements(coalesce(p_payload->'verdict_notes','[]')) AS nt(val)
   WHERE nt.val->>'experiment_id'=v->>'id' LIMIT 1;
  IF v->'result'->>'next_status'='concluded' THEN
   UPDATE social_review_experiments SET status='concluded', verdict=v->'result'->>'verdict',
    verdict_detail=(v->'result')||CASE WHEN note IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('note',left(note,300)) END,
    verdict_in=r.id, updated_at=clock_timestamp()
    WHERE id=(v->>'id')::uuid AND actor_id=r.actor_id AND business_id=r.business_id
     AND status IN ('proposed','running','extended') AND verdict_in IS DISTINCT FROM r.id;
  ELSIF v->'result'->>'next_status'='extended' THEN
   UPDATE social_review_experiments SET status='extended', extended_once=true,
    period_end=period_end+(period_end-period_start+1),
    verdict_detail=(v->'result')||CASE WHEN note IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('note',left(note,300)) END,
    verdict_in=r.id, updated_at=clock_timestamp()
    WHERE id=(v->>'id')::uuid AND actor_id=r.actor_id AND business_id=r.business_id
     AND status IN ('proposed','running','extended') AND verdict_in IS DISTINCT FROM r.id AND NOT extended_once;
  ELSE CONTINUE; END IF;
  GET DIAGNOSTICS n=ROW_COUNT; concluded:=concluded+n;
 END LOOP;
 -- New experiments: once per review.
 IF NOT EXISTS(SELECT 1 FROM social_review_experiments WHERE proposed_in=r.id) THEN
  FOR x IN SELECT value FROM jsonb_array_elements(coalesce(p_payload->'experiments','[]')) LOOP
   INSERT INTO social_review_experiments(actor_id,business_id,proposed_in,kind,status,hypothesis,action,metric,layer,target_mult,
    target_line,match,baseline,evidence,period_start,period_end)
   VALUES(r.actor_id,r.business_id,r.id,x->>'kind','running',x->>'hypothesis',x->>'action',x->>'metric',x->>'layer',
    (x->>'target_mult')::numeric,nullif(x->'target_line','null'::jsonb),x->'match',nullif(x->'baseline','null'::jsonb),coalesce(x->'evidence','{}'::jsonb),
    (x->>'period_start')::date,(x->>'period_end')::date);
   proposed:=proposed+1;
  END LOOP;
 END IF;
 -- Pillar tags: a post of this brand without a pillar, a pillar the brand's profile has. The pillars are locked (shared) first, so
 -- a user's pillar save that deletes a key (FOR UPDATE, block D) and these tags run one after the other: a tag never lands on a
 -- key deleted meanwhile, and a delete that comes second untags what was tagged here.
 -- Only this user's row for this brand; a pillar save holds it for milliseconds. The wait is capped (transaction-local): past it
 -- the save fails as any coach save failure does (the host logs it, the review itself is already delivered), never a stuck turn.
 PERFORM set_config('lock_timeout','2000',true);
 PERFORM 1 FROM social_coach_profiles WHERE actor_id=r.actor_id AND business_id=r.business_id FOR SHARE;
 FOR x IN SELECT value FROM jsonb_array_elements(coalesce(p_payload->'tags','[]')) LOOP
  CONTINUE WHEN coalesce(x->>'post_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  UPDATE social_post_facts f SET pillar_key=x->>'pillar_key', pillar_source='model', updated_at=clock_timestamp()
   WHERE f.post_id=(x->>'post_id')::uuid AND f.actor_id=r.actor_id AND f.business_id=r.business_id AND f.pillar_key IS NULL
    AND EXISTS(SELECT 1 FROM social_coach_profiles p WHERE p.actor_id=r.actor_id AND p.business_id=r.business_id
     AND p.pillars @> jsonb_build_array(jsonb_build_object('key',x->>'pillar_key')));
  GET DIAGNOSTICS n=ROW_COUNT; tagged:=tagged+n;
 END LOOP;
 RETURN jsonb_build_object('saved',true,'concluded',concluded,'proposed',proposed,'tagged',tagged);
END $function$;

REVOKE ALL ON FUNCTION public.publish_monitor_coach_extracted_pillars(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.publish_monitor_coach_pillars(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.publish_monitor_coach_pillars_save(uuid,uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.publish_monitor_coach_pillars(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.publish_monitor_coach_pillars_save(uuid,uuid,jsonb,jsonb) TO service_role;
COMMIT;
