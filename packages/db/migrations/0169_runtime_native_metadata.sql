-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Project the nativeMetadata whitelist directly from each authorized result.
-- 0168 is the source; preserve its permissions, availability and billing logic.
BEGIN;
DO $migration$
DECLARE definition text; source_md5 text;
BEGIN
 definition:=pg_get_functiondef('public.runtime_view(uuid,uuid)'::regprocedure);
 source_md5:=md5(definition);
 IF source_md5='1518394dfc8a5478186e3db382697e79' THEN RETURN;END IF;
 IF source_md5<>'e7ee4aa5d28b6984a57f4fff78e98782' THEN
  RAISE EXCEPTION 'NATIVE_METADATA_VIEW_SOURCE_MISMATCH';
 END IF;
 -- Match nativeOutput.ts: omit absent/invalid fields; never expose hidden results.
 definition:=replace(definition,
  $old$'contentAvailable',availability.available,'billing',bill2_public(b)) ORDER BY e.created_at,e.id)$old$,
  $new$'contentAvailable',availability.available,'billing',bill2_public(b))
  || CASE WHEN availability.available THEN jsonb_strip_nulls(jsonb_build_object(
   'completeness',CASE WHEN e.result->>'completeness' IN ('complete','length_limit') THEN e.result->'completeness' END,
   'organized',CASE WHEN jsonb_typeof(e.result->'organized')='boolean' THEN e.result->'organized' END,
   'summaryOmitted',CASE WHEN jsonb_typeof(e.result->'summaryOmitted')='boolean' THEN e.result->'summaryOmitted' END,
   'messageFirst',CASE WHEN jsonb_typeof(e.result->'messageFirst')='boolean' THEN e.result->'messageFirst' END,
   'envelopeCompact',CASE WHEN jsonb_typeof(e.result->'envelopeCompact')='boolean' THEN e.result->'envelopeCompact' END
  )) ELSE '{}'::jsonb END ORDER BY e.created_at,e.id)$new$);
 IF md5(definition)<>'1518394dfc8a5478186e3db382697e79' THEN
  RAISE EXCEPTION 'NATIVE_METADATA_VIEW_TARGET_MISMATCH';
 END IF;
 EXECUTE definition;
END $migration$;
COMMIT;
