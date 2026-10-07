-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_scrubbed_at IS NOT NULL)
  OR EXISTS(SELECT 1 FROM runtime_test_windows WHERE cardinality(actor_ids)=0)
  OR EXISTS(SELECT 1 FROM token_stats WHERE erased_conversation_id IS NOT NULL) THEN
  RAISE EXCEPTION 'ERASURE_LEAVES_ROLLBACK_REQUIRES_FORWARD_FIX';
 END IF;
END $$;
DO $$
DECLARE signature text; original text;
 addition text:=$patch$  IF TG_OP='DELETE' AND public.erasure_business_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD)) THEN
    RETURN OLD;
  END IF;
$patch$;
BEGIN
 FOREACH signature IN ARRAY ARRAY['public.artifact_immutable()','public.artifact_chat_history_immutable()'] LOOP
  original:=pg_get_functiondef(signature::regprocedure);
  IF length(original)-length(replace(original,addition,''))<>length(addition) THEN RAISE EXCEPTION 'ERASURE_PRUNE_SOURCE_MISMATCH'; END IF;
  EXECUTE replace(original,addition,'');
 END LOOP;
 original:=pg_get_functiondef('public.account_erasure_local_cleanup(uuid,boolean)'::regprocedure);
 EXECUTE replace(original,E' PERFORM account_erasure_prune_business(p_profile_id);\n','');
 original:=pg_get_functiondef('public.account_erasure_local_remaining(uuid)'::regprocedure);
 EXECUTE replace(original,'account_erasure_business_remaining(p_profile_id)+','');
END $$;
ALTER TABLE public.runtime_test_windows DROP CONSTRAINT runtime_test_windows_actor_ids_check;
ALTER TABLE public.runtime_test_windows ADD CONSTRAINT runtime_test_windows_actor_ids_check CHECK(cardinality(actor_ids) BETWEEN 1 AND 8);
DROP TRIGGER account_erasure_log_guard ON public.application_logs;
DROP TRIGGER account_erasure_log_guard ON public.user_activity_logs;
DROP FUNCTION public.account_erasure_log_guard();
DROP TRIGGER aa_erasure_usage_unlink ON public.token_stats;
DROP FUNCTION public.erasure_usage_unlink_guard();
ALTER TABLE public.token_stats DROP CONSTRAINT token_stats_execution_scope;
ALTER TABLE public.token_stats DROP COLUMN erased_conversation_id,DROP COLUMN erased_message_id;
ALTER TABLE public.token_stats ADD CONSTRAINT token_stats_execution_scope CHECK(num_nonnulls(conversation_id,artifact_generation_id,bill2_run_id)=1);
DROP FUNCTION public.account_erasure_prune_business(uuid,integer),public.account_erasure_business_remaining(uuid),
 public.erasure_business_delete_allowed(text,jsonb),public.erasure_business_owner(text,jsonb);
COMMIT;
