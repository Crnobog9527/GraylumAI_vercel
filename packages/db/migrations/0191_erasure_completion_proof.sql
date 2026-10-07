-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Bounded PR-C inventory and completion proof. No scheduler or provider dispatch.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.account_erasure_requests
 ADD COLUMN IF NOT EXISTS profile_scrubbed_at timestamptz,
 ADD COLUMN IF NOT EXISTS local_cleaned_at timestamptz,
 ADD COLUMN IF NOT EXISTS storage_verified_at timestamptz,
 ADD COLUMN IF NOT EXISTS auth_delete_started_at timestamptz,
 ADD COLUMN IF NOT EXISTS auth_deleted_at timestamptz,
 ADD COLUMN IF NOT EXISTS review_codes text[] NOT NULL DEFAULT '{}',
 ADD COLUMN IF NOT EXISTS next_review_at timestamptz,
 ADD COLUMN IF NOT EXISTS progress_token_hash text,
 ADD COLUMN IF NOT EXISTS progress_expires_at timestamptz;

CREATE OR REPLACE FUNCTION public.account_erasure_assert_closed(p_profile_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF p_profile_id IS NULL OR NOT EXISTS(SELECT 1 FROM account_erasure_requests e JOIN profiles p ON p.id=e.profile_id
  WHERE e.profile_id=p_profile_id AND p.status='deleted' AND p.is_deleted::text='true') THEN
  RAISE EXCEPTION 'ACCOUNT_ERASURE_NOT_CLOSED' USING ERRCODE='42501';
 END IF;
END $$;

-- The fixed inventory follows actual ownership, never names supplied by a caller.
-- Parent identities are retained while required by financial references.
CREATE OR REPLACE FUNCTION public.account_erasure_body_remaining(p_profile_id uuid)
RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE entry record; n bigint; total bigint:=0;
BEGIN
 FOR entry IN SELECT * FROM (VALUES
  ('runtime_sessions','t.actor_id=$1'),
  ('runtime_executions','t.actor_id=$1'),
  ('artifact_projects','t.actor_id=$1'),
  ('opc_accounts','t.actor_id=$1'),
  ('opc_businesses','t.actor_id=$1'),
  ('opc_handoffs','t.actor_id=$1'),
  ('opc_content_versions','t.actor_id=$1'),
  ('opc_library_requests','t.actor_id=$1'),
  ('opc_topic_workspaces','t.actor_id=$1'),
  ('opc_topic_draft_versions','t.actor_id=$1'),
  ('research_plans','t.actor_id=$1'),
  ('conversations','t.user_id=$1'),
  ('ordinary_chat_requests','t.user_id=$1'),
  ('messages','EXISTS(SELECT 1 FROM conversations p WHERE p.id=t.conversation_id AND p.user_id=$1)'),
  ('conversation_context_snapshots','EXISTS(SELECT 1 FROM conversations p WHERE p.id=t.conversation_id AND p.user_id=$1)'),
  ('runtime_scope_material','EXISTS(SELECT 1 FROM runtime_sessions p WHERE p.id=t.session_id AND p.actor_id=$1)'),
  ('runtime_session_history','EXISTS(SELECT 1 FROM runtime_sessions p WHERE p.id=t.session_id AND p.actor_id=$1)'),
  ('runtime_session_batches','EXISTS(SELECT 1 FROM runtime_sessions p WHERE p.id=t.session_id AND p.actor_id=$1)'),
  ('runtime_tool_calls','EXISTS(SELECT 1 FROM runtime_executions p WHERE p.id=t.execution_id AND p.actor_id=$1)'),
  ('runtime_history_dependencies','EXISTS(SELECT 1 FROM runtime_executions p WHERE p.id=t.execution_id AND p.actor_id=$1)'),
  ('artifact_rounds','EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=t.project_id AND p.actor_id=$1)'),
  ('artifact_evidence','EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=t.project_id AND p.actor_id=$1)'),
  ('artifact_versions','EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=t.project_id AND p.actor_id=$1)'),
  ('artifact_requests','EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=t.project_id AND p.actor_id=$1)'),
  ('artifact_generations','EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=t.project_id AND p.actor_id=$1)'),
  ('artifact_work_references','EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=t.project_id AND p.actor_id=$1)'),
  ('agent_slice_executions','EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=t.project_id AND p.actor_id=$1)'),
  ('artifact_confirmations','EXISTS(SELECT 1 FROM artifact_rounds r JOIN artifact_projects p ON p.id=r.project_id WHERE r.id=t.round_id AND p.actor_id=$1)'),
  ('artifact_candidates','EXISTS(SELECT 1 FROM artifact_rounds r JOIN artifact_projects p ON p.id=r.project_id WHERE r.id=t.round_id AND p.actor_id=$1)'),
  ('agent_slice_links','EXISTS(SELECT 1 FROM artifact_rounds r JOIN artifact_projects p ON p.id=r.project_id WHERE r.id=t.round_id AND p.actor_id=$1)'),
  ('artifact_chat_turns','EXISTS(SELECT 1 FROM conversations p WHERE p.id=t.conversation_id AND p.user_id=$1)'),
  ('research_operations','EXISTS(SELECT 1 FROM research_plans p WHERE p.id=t.plan_id AND p.actor_id=$1)'),
  ('opc_plans','EXISTS(SELECT 1 FROM opc_drafts p WHERE p.draft_id=t.draft_id AND p.actor_id=$1)'),
  ('opc_turns','EXISTS(SELECT 1 FROM opc_drafts p WHERE p.draft_id=t.draft_id AND p.actor_id=$1)'),
  ('opc_topic_openings','EXISTS(SELECT 1 FROM opc_drafts p WHERE p.draft_id=t.draft_id AND p.actor_id=$1)'),
  ('opc_items','EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=t.work_item_id AND p.actor_id=$1)'),
  ('opc_item_edits','EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=t.work_item_id AND p.actor_id=$1)')
 ) AS v(tbl,predicate) LOOP
  EXECUTE format('SELECT count(*) FROM public.%I t WHERE (%s) AND t.erased_at IS NULL',entry.tbl,entry.predicate)
   INTO n USING p_profile_id;
  total:=total+n;
 END LOOP;
 RETURN total;
END $$;

-- Terminal checkout requests retain fixed pricing/identity fields, not redirect URLs,
-- product labels or arbitrary metadata. Pending requests keep their exact retry payload.
ALTER TABLE public.payment_orders ADD COLUMN IF NOT EXISTS request_erased_at timestamptz;
CREATE OR REPLACE FUNCTION public.erasure_payment_envelope(v jsonb,k text)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE ids jsonb:='{"orderId":"id","userId":"id","itemId":"id","itemType":"id","billingCycle":"id","priceId":"id","upgradeAttemptId":"id"}';
 shape jsonb; amount jsonb;
BEGIN
 IF v IS NULL OR v='null'::jsonb THEN RETURN v; END IF;
 IF k='checkout' THEN
  shape:='{"mode":{"$enum":["subscription","payment"]},"payment_method_types":[{"$enum":["card","alipay"]}],
   "customer_creation":{"$enum":["always","if_required"]},"client_reference_id":"id","expires_at":"number",
   "line_items":[{"price":"id","quantity":"number","price_data":{"currency":"id","unit_amount":"number"}}]}'::jsonb
   ||jsonb_build_object('metadata',ids,'subscription_data',jsonb_build_object('metadata',ids),
    'payment_intent_data',jsonb_build_object('metadata',ids));
 ELSIF k='change' THEN
  shape:='{"originalPrice":"id","itemId":"id","createdAt":"number","quote":{"amountDue":"number", "currency":"id",
   "quotedAt":"number","fingerprint":"id","freshnessProof":"id"}}'::jsonb||jsonb_build_object('stripeMetadata',ids);
 ELSE RAISE EXCEPTION 'ERASURE_ENVELOPE_KIND'; END IF;
 FOR amount IN SELECT value FROM jsonb_path_query(v,
  CASE WHEN k='checkout' THEN '$.line_items[*].quantity'::jsonpath ELSE '$.quote.amountDue'::jsonpath END) q(value)
  UNION ALL SELECT value FROM jsonb_path_query(v,
  CASE WHEN k='checkout' THEN '$.line_items[*].price_data.unit_amount'::jsonpath ELSE '$.quote.quotedAt'::jsonpath END) q(value)
 LOOP
  IF jsonb_typeof(amount)<>'number' OR amount#>>'{}' !~ '^[0-9]+$' THEN
   RAISE EXCEPTION 'ERASURE_PAYMENT_REQUEST_REVIEW';
  END IF;
 END LOOP;
 RETURN erasure_ledger_value(v,shape);
END $$;
CREATE OR REPLACE FUNCTION public.erasure_payment_terminal(j jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT coalesce((j->>'status' IN ('completed','refunded','partially_refunded')
  AND j->>'payment_status' IN ('paid','refunded','partially_refunded') AND j->>'fulfilled_at' IS NOT NULL
  AND j->>'amount_total' IS NOT NULL)
 OR (j->>'status' IN ('failed','expired') AND j->>'purchase_closed_at' IS NOT NULL
  AND j->>'purchase_close_reason' IN ('stripe_checkout_expired','stripe_checkout_never_created',
   'stripe_checkout_not_prepared','stripe_upgrade_rejected','stripe_upgrade_not_applied')),false);
$$;
CREATE OR REPLACE FUNCTION public.erasure_envelope_transition(o jsonb,n jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 RETURN o->>'request_erased_at' IS NULL AND n->>'request_erased_at' IS NOT NULL
  AND erasure_payment_terminal(o)
  AND EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=(o->>'user_id')::uuid)
  AND (o-ARRAY['checkout_request','purchase_change_request','request_erased_at'])=
      (n-ARRAY['checkout_request','purchase_change_request','request_erased_at'])
  AND n->'checkout_request' IS NOT DISTINCT FROM erasure_payment_envelope(o->'checkout_request','checkout')
  AND n->'purchase_change_request' IS NOT DISTINCT FROM erasure_payment_envelope(o->'purchase_change_request','change');
END $$;
-- Exact, single insertion into the known frozen guard, preserving every original normal path.
DO $$
DECLARE original text:=pg_get_functiondef('public.pay_common_frozen_guard()'::regprocedure);
 needle text:=E'  FOREACH key IN ARRAY TG_ARGV LOOP';
 addition text:=$patch$  IF TG_TABLE_NAME='payment_orders' AND public.erasure_envelope_transition(prior,incoming) THEN
    RETURN NEW;
  END IF;
$patch$;
BEGIN
 IF position('public.erasure_envelope_transition(prior,incoming)' IN original)=0 THEN
  IF length(original)-length(replace(original,needle,''))<>length(needle) THEN
   RAISE EXCEPTION 'ERASURE_SOURCE_MISMATCH: pay_common_frozen_guard';
  END IF;
  EXECUTE replace(original,needle,addition||needle);
 END IF;
END $$;
CREATE OR REPLACE FUNCTION public.erasure_envelope_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' AND NEW.request_erased_at IS NOT NULL THEN RAISE EXCEPTION 'ERASURE_ENVELOPE_DENIED'; END IF;
 IF TG_OP='UPDATE' AND OLD.request_erased_at IS NOT NULL THEN
  IF NEW.request_erased_at IS DISTINCT FROM OLD.request_erased_at
   OR NEW.checkout_request IS DISTINCT FROM OLD.checkout_request
   OR NEW.purchase_change_request IS DISTINCT FROM OLD.purchase_change_request
   OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN RAISE EXCEPTION 'ERASURE_ENVELOPE_REFILL'; END IF;
 ELSIF TG_OP='UPDATE' AND NEW.request_erased_at IS NOT NULL
  AND NOT erasure_envelope_transition(to_jsonb(OLD),to_jsonb(NEW)) THEN RAISE EXCEPTION 'ERASURE_ENVELOPE_DENIED';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS aa_erasure_envelope_guard ON public.payment_orders;
CREATE TRIGGER aa_erasure_envelope_guard BEFORE INSERT OR UPDATE ON public.payment_orders
 FOR EACH ROW EXECUTE FUNCTION public.erasure_envelope_guard();

-- Original financial sources are authoritative. Unknown legacy evidence remains restricted,
-- explicitly pending, with a review date; it is never converted into zero spend or a refund.
CREATE OR REPLACE FUNCTION public.account_erasure_financial_proof(p_profile_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE pending bigint:=0; manual bigint:=0; n bigint; entry record;
BEGIN
 SELECT count(*) INTO pending FROM bill2_runs WHERE actor_id=p_profile_id
  AND (NOT closed OR state NOT IN ('settled','refunded') OR conflict);
 SELECT count(*) INTO n FROM payment_orders WHERE user_id=p_profile_id
  AND (NOT erasure_payment_terminal(to_jsonb(payment_orders))
    OR (refund_approval IS NOT NULL AND coalesce(refund_approval->>'status','') NOT IN ('rejected','succeeded','failed')));
 pending:=pending+n+CASE WHEN account_erasure_renewing(p_profile_id) THEN 1 ELSE 0 END;
 SELECT count(*) INTO n FROM payment_orders WHERE user_id=p_profile_id AND (
  (status IN ('completed','refunded','partially_refunded') AND (amount_total IS NULL OR currency IS NULL))
  OR jsonb_path_exists(metadata,'$.**.reviewRequired ? (@ == true)')
  OR metadata->'paymentConflicts' IS NOT NULL AND metadata->'paymentConflicts'<>'[]'::jsonb
  OR jsonb_path_exists(payment_amount_facts,'$[*] ? (@.amount == null)'));
 manual:=manual+n;
 SELECT count(*) INTO n FROM subscription_credit_grants WHERE user_id=p_profile_id
  AND accounting_state IS DISTINCT FROM 'trusted';
 manual:=manual+n;
 SELECT count(*) INTO n FROM bill2_runs b WHERE b.actor_id=p_profile_id AND
  (b.content_erased_at IS NULL OR EXISTS(SELECT 1 FROM bill2_calls c WHERE c.run_id=b.id AND
    (c.content_erased_at IS NULL OR EXISTS(SELECT 1 FROM bill2_receipts r WHERE r.call_id=c.id
      AND r.financial_projected_at IS NULL))));
 manual:=manual+n;
 FOR entry IN SELECT * FROM (VALUES
  ('credit_transactions','user_id'),('billing_history','user_id'),('token_stats','user_id'),('ai_usage_logs','user_id')
 ) v(tbl,owner_col) LOOP
  EXECUTE format('SELECT count(*) FROM public.%I WHERE %I=$1 AND content_erased_at IS NULL',entry.tbl,entry.owner_col)
   INTO n USING p_profile_id;
  manual:=manual+n;
 END LOOP;
 FOR entry IN SELECT unnest(ARRAY['payment_orders','user_subscriptions','subscription_credit_grants']) tbl LOOP
  EXECUTE format('SELECT count(*) FROM public.%I WHERE user_id=$1 AND
   (metadata_scrubbed_at IS NULL OR (erasure_payment_metadata(metadata,%L)->>''manualReview'')::int>0)',entry.tbl,entry.tbl)
   INTO n USING p_profile_id;
  manual:=manual+n;
 END LOOP;
 SELECT count(*) INTO n FROM payment_orders WHERE user_id=p_profile_id AND
  ((request_erased_at IS NULL AND (checkout_request IS NOT NULL OR purchase_change_request IS NOT NULL)) OR refund_approval IS NOT NULL);
 manual:=manual+n;
 -- Older generations/slices have original provider evidence not covered by BILL2 projections.
 -- Do not infer that a terminal state proves those arbitrary objects contain no private body.
 SELECT count(*) INTO n FROM artifact_generations g JOIN artifact_projects p ON p.id=g.project_id WHERE p.actor_id=p_profile_id;
 manual:=manual+n;
 SELECT count(*) INTO n FROM agent_slice_calls c JOIN agent_slice_executions x ON x.request_id=c.execution_id
  JOIN artifact_projects p ON p.id=x.project_id WHERE p.actor_id=p_profile_id;
 manual:=manual+n;
 SELECT count(*) INTO n FROM research_operations o JOIN research_plans p ON p.id=o.plan_id
  WHERE p.actor_id=p_profile_id AND (o.erased_at IS NULL OR o.state NOT IN ('succeeded','failed','cancelled'));
 pending:=pending+n;
 SELECT count(*) INTO n FROM ordinary_chat_requests WHERE user_id=p_profile_id
  AND (erased_at IS NULL OR state NOT IN ('succeeded','failed'));
 pending:=pending+n;
 RETURN jsonb_build_object('financialPending',pending,'manualReview',manual);
END $$;

CREATE OR REPLACE FUNCTION public.account_erasure_work_batch(
 p_profile_id uuid,p_limit integer DEFAULT 20,p_after_run_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE request public.account_erasure_requests; ids uuid[]; proof jsonb; last_id uuid;
BEGIN
 PERFORM account_erasure_assert_closed(p_profile_id);
 IF p_limit IS NULL OR p_limit<1 OR p_limit>20 THEN RAISE EXCEPTION 'ERASURE_BATCH_LIMIT_INVALID'; END IF;
 SELECT * INTO request FROM account_erasure_requests WHERE profile_id=p_profile_id;
 SELECT array_agg(id ORDER BY id) INTO ids FROM (
  SELECT id FROM bill2_runs WHERE actor_id=p_profile_id AND (p_after_run_id IS NULL OR id>p_after_run_id)
   AND (content_erased_at IS NULL OR session_ref IS NOT NULL OR NOT closed OR state NOT IN ('settled','refunded')
    OR EXISTS(SELECT 1 FROM bill2_calls c WHERE c.run_id=bill2_runs.id AND (c.content_erased_at IS NULL
     OR EXISTS(SELECT 1 FROM bill2_receipts r WHERE r.call_id=c.id AND r.financial_projected_at IS NULL))))
   ORDER BY id LIMIT p_limit+1
 ) rows;
 IF cardinality(ids)>p_limit THEN ids:=ids[1:p_limit];last_id:=ids[p_limit]; END IF;
 proof:=account_erasure_financial_proof(p_profile_id);
 RETURN proof||jsonb_build_object('requestId',request.request_id,'stage',request.stage,
  'runs',coalesce(to_jsonb(ids),'[]'::jsonb),'nextRunId',last_id);
END $$;

-- Identity can never be refilled after the local scrub; the original financial balance stays.
CREATE OR REPLACE FUNCTION public.account_erasure_identity_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=NEW.id AND profile_scrubbed_at IS NOT NULL)
  AND (NEW.email IS NOT NULL OR NEW.nickname IS NOT NULL OR NEW.avatar_url IS NOT NULL
   OR NEW.last_ip IS NOT NULL OR NEW.last_login_at IS NOT NULL) THEN
  RAISE EXCEPTION 'ACCOUNT_ERASURE_IDENTITY_REFILL' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS account_erasure_identity_guard ON public.profiles;
CREATE TRIGGER account_erasure_identity_guard BEFORE UPDATE ON public.profiles
 FOR EACH ROW EXECUTE FUNCTION public.account_erasure_identity_guard();

-- Freeze attachment references as well as upload admission. Admin replies must respect the
-- subject's closure too. The profile SHARE lock serializes with confirmation's UPDATE lock.
CREATE OR REPLACE FUNCTION public.account_erasure_ticket_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE subject uuid; p public.profiles; path text;
BEGIN
 IF TG_TABLE_NAME='tickets' THEN subject:=NEW.user_id;
 ELSE SELECT user_id INTO subject FROM tickets WHERE id=NEW.ticket_id; END IF;
 -- Deny new references to objects owned by a closed subject or already attached to its
 -- tickets, including administrator-owned paths. Existing shared references are not deleted.
 IF NEW.attachments IS NOT NULL AND jsonb_typeof(NEW.attachments)='array' THEN
  FOR path IN SELECT value FROM jsonb_array_elements_text(NEW.attachments) LOOP
   IF EXISTS(SELECT 1 FROM account_erasure_requests e WHERE split_part(path,'/',1)=e.profile_id::text)
    OR EXISTS(SELECT 1 FROM tickets t JOIN account_erasure_requests e ON e.profile_id=t.user_id
      WHERE coalesce(t.attachments,'[]'::jsonb) ? path)
    OR EXISTS(SELECT 1 FROM ticket_replies r JOIN tickets t ON t.id=r.ticket_id
      JOIN account_erasure_requests e ON e.profile_id=t.user_id WHERE coalesce(r.attachments,'[]'::jsonb) ? path) THEN
    RAISE EXCEPTION 'ACCOUNT_ERASURE_ATTACHMENT_CLOSED' USING ERRCODE='42501';
   END IF;
  END LOOP;
 END IF;
 IF subject IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO p FROM profiles WHERE id=subject FOR SHARE;
 IF p.id IS NULL OR p.status='deleted' OR p.is_deleted::text='true'
  OR EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=subject) THEN
  RAISE EXCEPTION 'ACCOUNT_ERASURE_TICKET_CLOSED' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS account_erasure_ticket_guard ON public.tickets;
CREATE TRIGGER account_erasure_ticket_guard BEFORE INSERT OR UPDATE ON public.tickets
 FOR EACH ROW EXECUTE FUNCTION public.account_erasure_ticket_guard();
DROP TRIGGER IF EXISTS account_erasure_ticket_guard ON public.ticket_replies;
CREATE TRIGGER account_erasure_ticket_guard BEFORE INSERT OR UPDATE ON public.ticket_replies
 FOR EACH ROW EXECUTE FUNCTION public.account_erasure_ticket_guard();

CREATE OR REPLACE FUNCTION public.account_erasure_storage_ready(p_profile_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM account_erasure_assert_closed(p_profile_id);
 RETURN jsonb_build_object('ready',account_erasure_barrier()
  AND NOT EXISTS(SELECT 1 FROM ticket_upload_intents WHERE profile_id=p_profile_id)
  AND NOT EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=p_profile_id
    AND confirmed_at>=transaction_timestamp()));
END $$;

CREATE OR REPLACE FUNCTION public.account_erasure_local_remaining(p_profile_id uuid)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT account_erasure_body_remaining(p_profile_id)
 +(SELECT count(*) FROM opc_video_material_bindings WHERE actor_id=p_profile_id)
 +(SELECT count(*) FROM opc_account_strategy_request_bases WHERE actor_id=p_profile_id)
 +(SELECT count(*) FROM runtime_test_windows WHERE p_profile_id=ANY(actor_ids))
 +(SELECT count(*) FROM tickets WHERE user_id=p_profile_id)
 +(SELECT count(*) FROM ticket_replies WHERE user_id=p_profile_id)
 +(SELECT count(*) FROM application_logs WHERE user_id=p_profile_id)
 +(SELECT count(*) FROM user_activity_logs WHERE user_id=p_profile_id)
 +(SELECT count(*) FROM user_checkins WHERE user_id=p_profile_id)
 +(SELECT count(*) FROM ticket_upload_intents WHERE profile_id=p_profile_id)
 +(SELECT count(*) FROM profiles WHERE id=p_profile_id AND
   (email IS NOT NULL OR nickname IS NOT NULL OR avatar_url IS NOT NULL OR last_ip IS NOT NULL OR last_login_at IS NOT NULL));
$$;

CREATE OR REPLACE FUNCTION public.account_erasure_local_cleanup(p_profile_id uuid,p_storage_verified boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE remaining bigint; manual bigint; proof jsonb; entry record; errors text[]:='{}';
BEGIN
 PERFORM account_erasure_assert_closed(p_profile_id);
 IF p_storage_verified IS NULL THEN RAISE EXCEPTION 'ERASURE_INVALID_STORAGE_PROOF'; END IF;
 IF NOT account_erasure_barrier() OR EXISTS(SELECT 1 FROM account_erasure_requests
  WHERE profile_id=p_profile_id AND confirmed_at>=transaction_timestamp()) THEN
  RETURN jsonb_build_object('remaining',1,'manualReview',0,'errors',jsonb_build_array('ERASURE_TRANSACTIONS_PENDING'));
 END IF;
 -- Independent content cleanup continues while financial questions remain unresolved.
 -- Each leaf batch has a hard row cap and never waits on another writer's row lock.
 FOR entry IN SELECT unnest(ARRAY['application_logs','user_activity_logs','user_checkins']) tbl LOOP
  EXECUTE format('DELETE FROM public.%I WHERE ctid IN
   (SELECT ctid FROM public.%I WHERE user_id=$1 LIMIT 100 FOR UPDATE SKIP LOCKED)',entry.tbl,entry.tbl) USING p_profile_id;
 END LOOP;
 IF p_storage_verified AND NOT EXISTS(SELECT 1 FROM ticket_upload_intents WHERE profile_id=p_profile_id) THEN
  DELETE FROM ticket_replies WHERE ctid IN (SELECT t.ctid FROM ticket_replies t
   WHERE t.user_id=p_profile_id OR EXISTS(SELECT 1 FROM tickets p WHERE p.id=t.ticket_id AND p.user_id=p_profile_id)
   LIMIT 100 FOR UPDATE OF t SKIP LOCKED);
  DELETE FROM tickets WHERE ctid IN (SELECT t.ctid FROM tickets t WHERE t.user_id=p_profile_id
   AND NOT EXISTS(SELECT 1 FROM ticket_replies r WHERE r.ticket_id=t.id) LIMIT 100 FOR UPDATE OF t SKIP LOCKED);
  UPDATE account_erasure_requests SET storage_verified_at=clock_timestamp() WHERE profile_id=p_profile_id;
 ELSE
  errors:=array_append(errors,'ERASURE_STORAGE_PENDING');
  UPDATE account_erasure_requests SET storage_verified_at=NULL WHERE profile_id=p_profile_id;
 END IF;
 -- No amount, balance, membership, status or original primary key is changed.
 UPDATE profiles SET email=NULL,nickname=NULL,avatar_url=NULL,last_ip=NULL,last_login_at=NULL
  WHERE id=p_profile_id;
 UPDATE account_erasure_requests SET profile_scrubbed_at=coalesce(profile_scrubbed_at,clock_timestamp())
  WHERE profile_id=p_profile_id;
 -- One locked order at a time; malformed finance stays unchanged and reviewable.
 FOR entry IN SELECT * FROM payment_orders WHERE user_id=p_profile_id AND request_erased_at IS NULL
  AND erasure_payment_terminal(to_jsonb(payment_orders))
  AND (checkout_request IS NOT NULL OR purchase_change_request IS NOT NULL)
  ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED LOOP
  BEGIN
   UPDATE payment_orders SET checkout_request=erasure_payment_envelope(checkout_request,'checkout'),
    purchase_change_request=erasure_payment_envelope(purchase_change_request,'change'),request_erased_at=clock_timestamp()
    WHERE id=entry.id;
  EXCEPTION WHEN raise_exception THEN errors:=array_append(errors,'ERASURE_PAYMENT_REQUEST_REVIEW');
  END;
 END LOOP;
 remaining:=account_erasure_local_remaining(p_profile_id);
 proof:=account_erasure_financial_proof(p_profile_id);
 manual:=(proof->>'manualReview')::bigint;
 -- IP/abuse retention and legacy financial JSON have no invented retention decision here.
 IF EXISTS(SELECT 1 FROM invitation_records WHERE (inviter_id=p_profile_id OR invitee_id=p_profile_id)
  AND (inviter_email IS NOT NULL OR invitee_email IS NOT NULL OR ip_address IS NOT NULL OR user_agent IS NOT NULL)) THEN
  manual:=manual+1; errors:=array_append(errors,'ERASURE_INVITATION_REVIEW');
 END IF;
 errors:=ARRAY(SELECT DISTINCT code FROM unnest(errors) AS code);
 UPDATE account_erasure_requests SET
  local_cleaned_at=CASE WHEN remaining=0 AND cardinality(errors)=0 THEN clock_timestamp() ELSE NULL END,
  stage=CASE WHEN stage='completed' THEN stage WHEN manual>0 OR (proof->>'financialPending')::bigint>0
    THEN 'billing_pending' ELSE 'erasing' END,
  review_codes=(CASE WHEN manual>0 THEN ARRAY['ERASURE_FINANCIAL_EVIDENCE_REVIEW']||errors ELSE errors END)
   ||CASE WHEN auth_delete_started_at IS NOT NULL AND auth_deleted_at IS NULL THEN ARRAY['ERASURE_AUTH_PENDING'] ELSE '{}'::text[] END,
  next_review_at=CASE WHEN manual>0 OR auth_delete_started_at IS NOT NULL AND auth_deleted_at IS NULL
   THEN coalesce(next_review_at,clock_timestamp()+interval '30 days') ELSE NULL END,
  stage_updated_at=clock_timestamp()
 WHERE profile_id=p_profile_id;
 RETURN jsonb_build_object('remaining',remaining,'manualReview',manual,'errors',to_jsonb(errors));
END $$;

CREATE OR REPLACE FUNCTION public.account_erasure_auth_begin(p_profile_id uuid,p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE request public.account_erasure_requests; proof jsonb; ready boolean; claimed boolean:=false;
BEGIN
 PERFORM account_erasure_assert_closed(p_profile_id);
 SELECT * INTO request FROM account_erasure_requests WHERE profile_id=p_profile_id FOR UPDATE;
 IF p_request_id IS DISTINCT FROM request.request_id THEN RAISE EXCEPTION 'ERASURE_IDENTITY_MISMATCH'; END IF;
 proof:=account_erasure_financial_proof(p_profile_id);
 ready:=request.local_cleaned_at IS NOT NULL AND request.storage_verified_at IS NOT NULL
  AND request.profile_scrubbed_at IS NOT NULL AND request.review_codes<@ARRAY['ERASURE_AUTH_PENDING']
  AND (proof->>'financialPending')::bigint=0 AND (proof->>'manualReview')::bigint=0
  AND account_erasure_local_remaining(p_profile_id)=0 AND account_erasure_barrier();
 IF ready AND request.auth_delete_started_at IS NULL THEN
  UPDATE account_erasure_requests SET auth_delete_started_at=clock_timestamp(),stage_updated_at=clock_timestamp(),
   review_codes=ARRAY['ERASURE_AUTH_PENDING'],next_review_at=coalesce(next_review_at,clock_timestamp()+interval '30 days')
   WHERE profile_id=p_profile_id RETURNING * INTO request;
  claimed:=true;
 END IF;
 RETURN jsonb_build_object('ready',ready,'alreadyDeleted',request.auth_deleted_at IS NOT NULL,
  'started',request.auth_delete_started_at IS NOT NULL,'claimed',claimed,'requestId',request.request_id);
END $$;

CREATE OR REPLACE FUNCTION public.account_erasure_auth_result(p_profile_id uuid,p_request_id uuid,p_absent boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE request public.account_erasure_requests; proof jsonb;
BEGIN
 PERFORM account_erasure_assert_closed(p_profile_id);
 SELECT * INTO request FROM account_erasure_requests WHERE profile_id=p_profile_id FOR UPDATE;
 IF p_request_id IS DISTINCT FROM request.request_id OR request.auth_delete_started_at IS NULL THEN
  RAISE EXCEPTION 'ERASURE_IDENTITY_MISMATCH';
 END IF;
 IF p_absent IS DISTINCT FROM true THEN RETURN jsonb_build_object('stage',request.stage); END IF;
 proof:=account_erasure_financial_proof(p_profile_id);
 IF request.local_cleaned_at IS NULL OR request.storage_verified_at IS NULL OR NOT request.review_codes<@ARRAY['ERASURE_AUTH_PENDING']
  OR (proof->>'financialPending')::bigint>0 OR (proof->>'manualReview')::bigint>0
  OR account_erasure_local_remaining(p_profile_id)>0 THEN
  RETURN jsonb_build_object('stage',request.stage);
 END IF;
 UPDATE account_erasure_requests SET auth_deleted_at=coalesce(auth_deleted_at,clock_timestamp()),
  stage='completed',stage_updated_at=clock_timestamp(),review_codes='{}',next_review_at=NULL,
  progress_expires_at=coalesce(progress_expires_at,clock_timestamp()+interval '30 days') WHERE profile_id=p_profile_id;
 RETURN jsonb_build_object('stage','completed');
END $$;

-- Capability hashes are separate from request IDs. Raw bearer tokens never enter the DB.
CREATE OR REPLACE FUNCTION public.account_erasure_progress_issue(
 p_profile_id uuid,p_request_id uuid,p_token_hash text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE n integer;
BEGIN
 PERFORM account_erasure_assert_closed(p_profile_id);
 IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'ERASURE_PROGRESS_INVALID'; END IF;
 UPDATE account_erasure_requests SET progress_token_hash=p_token_hash,progress_expires_at=CASE WHEN stage='completed' THEN clock_timestamp()+interval '30 days' END
  WHERE profile_id=p_profile_id AND request_id=p_request_id AND progress_token_hash IS NULL;
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN jsonb_build_object('issued',n=1);
END $$;
CREATE OR REPLACE FUNCTION public.account_erasure_progress_read(p_request_id uuid,p_token_hash text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('stage',stage,'confirmedAt',confirmed_at,'updatedAt',stage_updated_at,
  'needsReview',cardinality(review_codes)>0)
 FROM account_erasure_requests WHERE request_id=p_request_id AND progress_token_hash=p_token_hash
  AND (progress_expires_at IS NULL OR progress_expires_at>statement_timestamp()) AND p_token_hash ~ '^[0-9a-f]{64}$';
$$;

DO $$
DECLARE f text;
BEGIN
 FOREACH f IN ARRAY ARRAY[
  'account_erasure_assert_closed(uuid)','account_erasure_body_remaining(uuid)',
  'erasure_payment_terminal(jsonb)','erasure_payment_envelope(jsonb,text)','erasure_envelope_transition(jsonb,jsonb)','erasure_envelope_guard()',
  'account_erasure_financial_proof(uuid)','account_erasure_local_remaining(uuid)',
  'account_erasure_identity_guard()','account_erasure_ticket_guard()'
 ] LOOP EXECUTE 'REVOKE ALL ON FUNCTION public.'||f||' FROM PUBLIC,anon,authenticated,service_role'; END LOOP;
 FOREACH f IN ARRAY ARRAY[
  'account_erasure_work_batch(uuid,integer,uuid)','account_erasure_local_cleanup(uuid,boolean)',
  'account_erasure_storage_ready(uuid)',
  'account_erasure_progress_issue(uuid,uuid,text)','account_erasure_progress_read(uuid,text)',
  'account_erasure_auth_begin(uuid,uuid)','account_erasure_auth_result(uuid,uuid,boolean)'
 ] LOOP
  EXECUTE 'REVOKE ALL ON FUNCTION public.'||f||' FROM PUBLIC,anon,authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.'||f||' TO service_role';
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION public.erasure_envelope_transition(jsonb,jsonb) TO service_role;
COMMIT;
