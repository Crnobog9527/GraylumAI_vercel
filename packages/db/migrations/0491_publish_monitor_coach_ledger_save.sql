-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PUBLISH-MONITOR RC-3b (0491): a delivered brand review writes its
-- checked coach output into the experiment ledger and the post facts, in one transaction, under the review's lease.
--   * publish_monitor_review_save_coach(run, token, payload): the verdicts come from the pack saved before the model ran
--     (pack.review.ledger.to_review[].result, computed by code), never from the payload; the payload only adds the model's short note
--     per verdict, the new experiments (at most 3, status running) and the pillar tags of untagged posts (only a pillar the brand has,
--     only a post of this brand that has none yet). A verdict that concluded sets status / verdict / verdict_in; an inconclusive one
--     with a second chance extends the period by its own length once. Pillar-mix and strategy proposals and the stage suggestion are
--     not written here (they need the user's confirmation flow).
-- Compatibility: a new function nothing old calls; no table or column changes. Repeatable: CREATE OR REPLACE only; calling it twice
--   for one run changes nothing the second time (verdicts are keyed by verdict_in, experiments by proposed_in, tags by "no pillar yet").
-- Recovery: DROP FUNCTION public.publish_monitor_review_save_coach(uuid,uuid,jsonb); ledger rows it wrote are ordinary rows of the
--   tables from 0457 and can stay (the next review reads them as any other experiment).
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.publish_monitor_review_save_coach(p_id uuid,p_token uuid,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
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
 -- Pillar tags: a post of this brand without a pillar, a pillar the brand's profile has.
 FOR x IN SELECT value FROM jsonb_array_elements(coalesce(p_payload->'tags','[]')) LOOP
  CONTINUE WHEN coalesce(x->>'post_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  UPDATE social_post_facts f SET pillar_key=x->>'pillar_key', pillar_source='model', updated_at=clock_timestamp()
   WHERE f.post_id=(x->>'post_id')::uuid AND f.actor_id=r.actor_id AND f.business_id=r.business_id AND f.pillar_key IS NULL
    AND EXISTS(SELECT 1 FROM social_coach_profiles p WHERE p.actor_id=r.actor_id AND p.business_id=r.business_id
     AND p.pillars @> jsonb_build_array(jsonb_build_object('key',x->>'pillar_key')));
  GET DIAGNOSTICS n=ROW_COUNT; tagged:=tagged+n;
 END LOOP;
 RETURN jsonb_build_object('saved',true,'concluded',concluded,'proposed',proposed,'tagged',tagged);
END $$;

DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='publish_monitor_review_save_coach' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f);
 END LOOP;
END $$;
COMMIT;
