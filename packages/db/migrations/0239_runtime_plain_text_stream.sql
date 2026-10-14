-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- CHAT-NATIVE-OUTPUT: free chat (v6) and Skill (v2) turns admitted with the frozen marker
-- textStream='plain-text-v1' stream their primary reply. Two functions learn the marker:
--  * runtime_execution 'stop' keeps the shown prefix (stopAt/source) for a marked turn, as it does for
--    agent turns and message-first steps. The stopped body is plain text, never parsed as an envelope
--    (stop_envelope stays v4/v5 only), and is appended to history verbatim. Unmarked turns of every
--    format keep the plain runtime_cancel they had: their behaviour and bytes are unchanged.
--  * runtime_stale_charged_rounds reports a marked turn as streamed (review evidence only).
-- Settlement is untouched: a stop still settles only the calls that were dispatched, once.
-- Repeatable: each function is patched only from its known source and returns early once patched.
-- No remote database use.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $migration$
DECLARE definition text; source_md5 text; patched text;
BEGIN
 definition:=pg_get_functiondef('public.runtime_execution(uuid,uuid,text,jsonb)'::regprocedure);source_md5:=md5(definition);
 IF source_md5='6f66e0feeaba637dae8f96acdf2c4e00' THEN RETURN;END IF;
 IF source_md5<>'7525ae8d4e450dd8f03db7fa77e89453' THEN RAISE EXCEPTION 'PLAIN_TEXT_STREAM_SOURCE_MISMATCH: runtime_execution(uuid,uuid,text,jsonb)';END IF;
 IF (length(definition)-length(replace(definition,$a1$   OR (e.payload->>'providerRequestFormat' IS DISTINCT FROM 'agent-turn-v5-stream'
    AND e.payload->>'envelopeOrder' IS DISTINCT FROM 'message-first-v1') THEN RETURN runtime_cancel(p_actor_id,e.id);END IF;$a1$,'')))
  <>length($a1$   OR (e.payload->>'providerRequestFormat' IS DISTINCT FROM 'agent-turn-v5-stream'
    AND e.payload->>'envelopeOrder' IS DISTINCT FROM 'message-first-v1') THEN RETURN runtime_cancel(p_actor_id,e.id);END IF;$a1$)
  THEN RAISE EXCEPTION 'PLAIN_TEXT_STREAM_ANCHOR_1';END IF;
 definition:=replace(definition,$a1$   OR (e.payload->>'providerRequestFormat' IS DISTINCT FROM 'agent-turn-v5-stream'
    AND e.payload->>'envelopeOrder' IS DISTINCT FROM 'message-first-v1') THEN RETURN runtime_cancel(p_actor_id,e.id);END IF;$a1$,
  $b1$   OR (e.payload->>'providerRequestFormat' IS DISTINCT FROM 'agent-turn-v5-stream'
    AND e.payload->>'envelopeOrder' IS DISTINCT FROM 'message-first-v1'
    AND e.payload->>'textStream' IS DISTINCT FROM 'plain-text-v1') THEN RETURN runtime_cancel(p_actor_id,e.id);END IF;$b1$);
 EXECUTE definition;
 patched:=md5(pg_get_functiondef('public.runtime_execution(uuid,uuid,text,jsonb)'::regprocedure));
 IF patched<>'6f66e0feeaba637dae8f96acdf2c4e00' THEN RAISE EXCEPTION 'PLAIN_TEXT_STREAM_TARGET_MISMATCH: %',patched;END IF;
END $migration$;
DO $migration$
DECLARE definition text;
BEGIN
 definition:=pg_get_functiondef('public.runtime_stale_charged_rounds(timestamptz,integer)'::regprocedure);
 IF position($n$'textStream'$n$ IN definition)>0 THEN RETURN;END IF;
 IF (length(definition)-length(replace(definition,$a2$   coalesce(e.payload->>'providerRequestFormat','') IN ('serial-tools-v3-stream','serial-tools-v4-stream','agent-turn-v5-stream') streamed,$a2$,'')))
  <>length($a2$   coalesce(e.payload->>'providerRequestFormat','') IN ('serial-tools-v3-stream','serial-tools-v4-stream','agent-turn-v5-stream') streamed,$a2$)
  THEN RAISE EXCEPTION 'PLAIN_TEXT_STREAM_ANCHOR_2';END IF;
 EXECUTE replace(definition,
  $a2$   coalesce(e.payload->>'providerRequestFormat','') IN ('serial-tools-v3-stream','serial-tools-v4-stream','agent-turn-v5-stream') streamed,$a2$,
  $b2$   (coalesce(e.payload->>'providerRequestFormat','') IN ('serial-tools-v3-stream','serial-tools-v4-stream','agent-turn-v5-stream')
    OR coalesce(e.payload->>'textStream','')='plain-text-v1') streamed,$b2$);
END $migration$;
COMMIT;
