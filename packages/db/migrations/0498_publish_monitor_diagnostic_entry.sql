-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PUBLISH-MONITOR RC (single-post diagnosis layer, entry by hand; placeholder number, the controller assigns the real one): the first
-- way into social_post_diagnostics (0457 created the table and nothing wrote to it). The user types the back-office rates of one of
-- their own posts (2-second bounce, 3/5-second retention, completion, like/comment/save/share rates ...), the post's opening lines and
-- its length, sees them again and confirms; confirming is the save. Reading a screenshot with a model is a separate step and goes
-- through the same save.
--   * publish_monitor_diagnostic_candidates(actor): the user's own posts of the last 45 days (newest first, at most 30), with whether a
--     diagnosis exists. Only posts of a connected own account that belongs to a brand.
--   * publish_monitor_diagnostics(actor): the user's saved diagnoses (newest first, at most 30).
--   * publish_monitor_diagnostic_save(actor, post, rates, opening, video seconds, drop second, captured on): one diagnosis per post and
--     day (a second save the same day replaces the first). Keys must be the normalized rate keys; a rate is a fraction 0..1
--     (avg_watch_seconds in seconds); a blank rate is absent, never zero. source 'manual' (typed) or 'screenshot' (read from a
--     picture by a model, with rates_raw / screenshot_asset / read_run_id); confirmed_at is now: calling this is the user's confirmation.
--   * publish_monitor_diagnostic_delete(actor, id): the user removes one of their own diagnoses.
-- Compatibility: four new functions nothing old calls; no table or column changes. Repeatable: CREATE OR REPLACE only.
-- Recovery: DROP the four functions; rows they wrote are ordinary rows of social_post_diagnostics and can stay.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.publish_monitor_diagnostic_candidates(a uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM publish_monitor_actor(a);
 RETURN coalesce((SELECT jsonb_agg(v ORDER BY v->>'postedAt' DESC NULLS LAST) FROM (
  SELECT jsonb_build_object('postId',p.id,'platform',c.platform,'title',p.title_excerpt,'postedAt',p.posted_at,
   'businessId',c.business_id,'businessName',b.name,
   'diagnosedOn',(SELECT max(d.captured_on) FROM social_post_diagnostics d WHERE d.post_id=p.id AND d.actor_id=a)) v
  FROM social_posts p JOIN social_connections c ON c.id=p.connection_id AND c.actor_id=a
   JOIN opc_businesses b ON b.id=c.business_id AND b.actor_id=a AND b.erased_at IS NULL AND b.archived_at IS NULL
  WHERE p.actor_id=a AND c.role='own' AND c.status IN ('connected','reauth_required','quarantined')
   AND p.posted_at >= clock_timestamp()-interval '45 days'
  ORDER BY p.posted_at DESC NULLS LAST LIMIT 30) q),'[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.publish_monitor_diagnostics(a uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM publish_monitor_actor(a);
 RETURN coalesce((SELECT jsonb_agg(v ORDER BY v->>'capturedOn' DESC, v->>'confirmedAt' DESC) FROM (
  SELECT jsonb_build_object('id',d.id,'postId',d.post_id,'platform',d.platform,'title',p.title_excerpt,'businessId',d.business_id,
   'rates',d.rates,'openingText',d.opening_text,'videoSeconds',d.video_seconds,'dropSecond',d.drop_second,
   'capturedOn',d.captured_on,'confirmedAt',d.confirmed_at,'source',d.source) v
  FROM social_post_diagnostics d JOIN social_posts p ON p.id=d.post_id AND p.actor_id=a
  WHERE d.actor_id=a ORDER BY d.captured_on DESC, d.confirmed_at DESC LIMIT 30) q),'[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.publish_monitor_diagnostic_save(a uuid,p_post uuid,p_rates jsonb,p_opening text,p_video integer,
 p_drop integer,p_captured date,p_source text DEFAULT 'manual',p_rates_raw jsonb DEFAULT NULL,p_screenshot_asset text DEFAULT NULL,
 p_read_run uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c social_connections; p social_posts; k text; val jsonb; n numeric; today date:=(clock_timestamp() AT TIME ZONE 'UTC')::date;
 on_day date; text_in text; saved uuid;
 keys text[]:=ARRAY['impressions_ctr','bounce_2s','retain_3s','retain_5s','retain_30s','avg_watch_seconds','avg_watch_pct','complete_rate',
  'like_rate','comment_rate','save_rate','share_rate','follow_rate','profile_visit_rate'];
BEGIN
 PERFORM publish_monitor_actor(a);
 IF p_post IS NULL OR jsonb_typeof(p_rates) IS DISTINCT FROM 'object' OR NOT EXISTS(SELECT 1 FROM jsonb_object_keys(p_rates))
  OR (SELECT count(*) FROM jsonb_object_keys(p_rates))>array_length(keys,1)
  OR (p_video IS NOT NULL AND p_video NOT BETWEEN 1 AND 86400) OR (p_drop IS NOT NULL AND p_drop NOT BETWEEN 0 AND 86400)
  OR (p_video IS NOT NULL AND p_drop IS NOT NULL AND p_drop>p_video) OR p_source IS NULL OR p_source NOT IN ('manual','screenshot')
  -- What a screenshot read adds: the labels as read (an object of at most 50 entries), the storage key of the picture (until it is
  -- deleted) and the read's request id. A manual entry carries none of them.
  OR (p_source='manual' AND (p_rates_raw IS NOT NULL OR p_screenshot_asset IS NOT NULL OR p_read_run IS NOT NULL))
  OR (p_rates_raw IS NOT NULL AND (jsonb_typeof(p_rates_raw)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(p_rates_raw))>50
   OR pg_column_size(p_rates_raw)>8192))
  OR (p_screenshot_asset IS NOT NULL AND char_length(p_screenshot_asset) NOT BETWEEN 1 AND 512) THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 -- Only the normalized keys, only numbers; fractions are 0..1, the one count of seconds is 0..86400. A blank is absent, never zero.
 FOR k,val IN SELECT * FROM jsonb_each(p_rates) LOOP
  IF NOT k=ANY(keys) OR jsonb_typeof(val)<>'number' THEN RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  n:=(val#>>'{}')::numeric;
  IF n<0 OR (k='avg_watch_seconds' AND n>86400) OR (k<>'avg_watch_seconds' AND n>1) THEN
   RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 END LOOP;
 SELECT * INTO p FROM social_posts WHERE id=p_post AND actor_id=a;
 SELECT * INTO c FROM social_connections WHERE id=p.connection_id AND actor_id=a AND role='own'
  AND status IN ('connected','reauth_required','quarantined') AND business_id IS NOT NULL;
 IF p.id IS NULL OR c.id IS NULL THEN RAISE EXCEPTION 'PUBLISH_MONITOR_POST_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 -- The day the numbers were read: today by default, never in the future, never before the post, not older than 60 days.
 on_day:=coalesce(p_captured,today);
 IF on_day>today OR on_day<today-60 OR (p.posted_at IS NOT NULL AND on_day<(p.posted_at AT TIME ZONE 'UTC')::date) THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 text_in:=nullif(btrim(regexp_replace(coalesce(p_opening,''),'[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]','','g')),'');
 IF text_in IS NOT NULL AND char_length(text_in)>2000 THEN RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 INSERT INTO social_post_diagnostics AS d(actor_id,business_id,post_id,platform,source,rates,opening_text,video_seconds,drop_second,
  captured_on,confirmed_at,rates_raw,screenshot_asset,read_run_id)
 VALUES(a,c.business_id,p.id,c.platform,p_source,p_rates,text_in,p_video,p_drop,on_day,clock_timestamp(),p_rates_raw,p_screenshot_asset,p_read_run)
 ON CONFLICT(post_id,captured_on) DO UPDATE SET rates=EXCLUDED.rates,opening_text=EXCLUDED.opening_text,
  video_seconds=EXCLUDED.video_seconds,drop_second=EXCLUDED.drop_second,source=EXCLUDED.source,confirmed_at=clock_timestamp(),
  rates_raw=EXCLUDED.rates_raw,screenshot_asset=EXCLUDED.screenshot_asset,read_run_id=EXCLUDED.read_run_id
 RETURNING d.id INTO saved;
 RETURN jsonb_build_object('id',saved,'capturedOn',on_day);
END $$;

CREATE OR REPLACE FUNCTION public.publish_monitor_diagnostic_delete(a uuid,p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE n integer;
BEGIN
 PERFORM publish_monitor_actor(a);
 DELETE FROM social_post_diagnostics WHERE id=p_id AND actor_id=a;
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN n=1;
END $$;

DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('publish_monitor_diagnostic_candidates','publish_monitor_diagnostics',
   'publish_monitor_diagnostic_save','publish_monitor_diagnostic_delete') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f);
 END LOOP;
END $$;
COMMIT;
