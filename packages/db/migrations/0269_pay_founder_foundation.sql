-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PAY-FOUNDER PR-F1 (0269): founder-member status, the opt-in public wall, community bookkeeping, livestream
-- records and their account-erasure cleanup (docs/launch/tasks/PAY-FOUNDER.md sections 4, 4.5 and 5).
-- 1. pay_founder_status: none / active / grace / frozen / ended, derived only from founder orders and their
--    subscription; no "is founder" flag is stored. A refund, or a card renewal paid after the 7-day window,
--    ends the identity for good. The 7-day window reuses pay_waffo_founder_deadline (0211/0238).
-- 2. pay_founder_order_frozen: a dispute-freeze hook that is false until PAY-DISPUTE-GUARD PR-D1 replaces it.
-- 3. data_use_consents (0212) also records purpose 'founder_wall'. The team_improvement functions are unchanged;
--    the founder_wall functions below only read and write purpose='founder_wall' rows.
-- 4. founder_wall_entries (wall content) and founder_community_status (admin-kept community membership):
--    why new tables (AGENTS section 5): data_use_consents holds no content by design (it outlives erasure for a
--    year) and payment_orders is a 3-year financial record that must not hold public personal content.
-- 5. Livestream records reuse user_activity_logs (action 'founder_livestream'); no new table.
-- 6. Account erasure deletes both tables' rows through the merged prune loop (0192/0240 pattern); the consent
--    trigger of 0212 already revokes the founder_wall consent with reason 'account_erasure'.
-- Every function is service_role only; users act on their own rows through server routes that pass the
-- signed-in profile id, admin functions re-check the admin role. Repeatable. Rollback: forward-fix; the two
-- tables can be dropped after their rows are exported, consent rows stay under their 1-year retention.
BEGIN;
SET LOCAL lock_timeout='5s';

-- PAY-DISPUTE-GUARD PR-D1 replaces this body; never overwrite a newer body on re-application.
DO $$ BEGIN
 IF to_regprocedure('public.pay_founder_order_frozen(uuid)') IS NULL THEN
  EXECUTE $f$CREATE FUNCTION public.pay_founder_order_frozen(p_order uuid) RETURNS boolean
   LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS 'SELECT false AND $1 IS NOT NULL'$f$;
 END IF;
END $$;

CREATE OR REPLACE FUNCTION public.pay_founder_status(p_user uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o payment_orders; first_order payment_orders; prev payment_orders; s user_subscriptions;
 deadline timestamptz; ended_at timestamptz; ended_reason text; state text;
BEGIN
 IF p_user IS NULL THEN RAISE EXCEPTION 'PAY_FOUNDER_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 -- Sold founder orders of every channel (MP card, card_cn, wallet), oldest period first.
 FOR o IN SELECT * FROM payment_orders WHERE user_id=p_user AND item_type='membership_plan'
   AND offer_kind IN ('founder','founder_renewal') AND qualification_state='sold' AND fulfilled_at IS NOT NULL
   AND entitlement_start IS NOT NULL AND entitlement_end IS NOT NULL
   ORDER BY entitlement_start,id LOOP
  IF first_order.id IS NULL THEN first_order:=o; END IF;
  IF ended_at IS NULL AND (o.status='refunded' OR o.payment_status IN ('refunded','partially_refunded')) THEN
   ended_reason:='refunded';
   ended_at:=coalesce((o.metadata->'stripeExternalRefund'->>'refundedAt')::timestamptz,o.updated_at,o.entitlement_start);
  END IF;
  -- A card renewal charged after the 7-day window does not restore an identity that already ended.
  -- Wallet renewals are refused by admission after the deadline (0211), so they never form a gap here.
  IF ended_at IS NULL AND prev.id IS NOT NULL AND o.payment_method IN ('card','card_cn')
   AND coalesce(o.qualified_paid_at,o.entitlement_start)>prev.entitlement_end+interval '7 days' THEN
   ended_reason:='lapsed'; ended_at:=prev.entitlement_end+interval '7 days';
  END IF;
  prev:=o;
 END LOOP;
 IF first_order.id IS NULL THEN
  RETURN jsonb_build_object('state','none','orderId',NULL,'foundedAt',NULL,'periodEnd',NULL,'deadline',NULL,
   'endedAt',NULL,'endedReason',NULL);
 END IF;
 IF ended_at IS NULL THEN
  IF now()<prev.entitlement_end THEN state:='active';
  ELSE
   deadline:=pay_waffo_founder_deadline(prev.id);
   -- A renewing card subscription whose renewal outcome has not arrived yet keeps the same 7-day window.
   IF deadline IS NULL AND prev.payment_method IN ('card','card_cn') THEN
    SELECT * INTO s FROM user_subscriptions WHERE id=prev.subscription_id;
    IF s.status='active' AND s.founder_failed_at IS NULL AND s.method_cancel_requested_at IS NULL
     AND s.cancel_at_period_end IS DISTINCT FROM 'true' THEN deadline:=prev.entitlement_end+interval '7 days'; END IF;
   END IF;
   IF deadline IS NOT NULL AND now()<deadline THEN state:='grace';
   ELSE state:='ended'; ended_reason:='expired'; ended_at:=coalesce(deadline,prev.entitlement_end); END IF;
  END IF;
  IF state IN ('active','grace') AND EXISTS(SELECT 1 FROM payment_orders f WHERE f.user_id=p_user
    AND f.offer_kind IN ('founder','founder_renewal') AND f.qualification_state='sold' AND f.fulfilled_at IS NOT NULL
    AND f.entitlement_end>now()-interval '7 days' AND pay_founder_order_frozen(f.id)) THEN state:='frozen'; END IF;
 ELSE state:='ended';
 END IF;
 RETURN jsonb_build_object('state',state,'orderId',prev.id,
  'foundedAt',coalesce(first_order.qualified_paid_at,first_order.fulfilled_at),'periodEnd',prev.entitlement_end,
  'deadline',deadline,'endedAt',ended_at,'endedReason',ended_reason);
END $$;

-- Consent for the public wall lives beside the D5 consent, under its own purpose and version.
DO $$ DECLARE c text; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='public.data_use_consents'::regclass AND contype='c'
  AND pg_get_constraintdef(oid) ~ 'purpose' AND conname<>'data_use_consents_purpose_allowed' LOOP
  EXECUTE format('ALTER TABLE public.data_use_consents DROP CONSTRAINT %I',c);
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.data_use_consents'::regclass
  AND conname='data_use_consents_purpose_allowed') THEN
  ALTER TABLE public.data_use_consents ADD CONSTRAINT data_use_consents_purpose_allowed
   CHECK(purpose IN ('team_improvement','founder_wall'));
 END IF;
END $$;

CREATE OR REPLACE FUNCTION public.founder_wall_consent_current_version() RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$ SELECT 'fw-v1'::text $$;

-- Stored links are normalized https URLs (the server normalizes with URL()): plain host, optional port,
-- printable ASCII after it; no credentials, no whitespace, controls or backslashes.
CREATE OR REPLACE FUNCTION public.founder_wall_valid_url(u text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT u IS NOT NULL AND char_length(u)<=2048 AND position(E'\\' IN u)=0
  AND u ~ '^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?([/?#][!-~]*)?$'
$$;
CREATE OR REPLACE FUNCTION public.founder_wall_valid_text(t text,max_len integer) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT t IS NOT NULL AND char_length(btrim(t))>=1 AND char_length(t)<=max_len AND t=btrim(t) AND t !~ '[[:cntrl:]]'
$$;
CREATE OR REPLACE FUNCTION public.founder_wall_valid_accounts(j jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT j IS NOT NULL AND jsonb_typeof(j)='array' AND jsonb_array_length(j)<=3 AND NOT EXISTS(
  SELECT 1 FROM jsonb_array_elements(j) a WHERE jsonb_typeof(a)<>'object'
   OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(a) k) IS DISTINCT FROM ARRAY['handle','platform','url']
   OR jsonb_typeof(a->'platform')<>'string' OR a->>'platform' !~ '^[a-z_]{1,24}$'
   OR jsonb_typeof(a->'handle')<>'string' OR NOT founder_wall_valid_text(a->>'handle',60)
   OR jsonb_typeof(a->'url')<>'string' OR NOT founder_wall_valid_url(a->>'url'))
$$;

-- One row per founder who filled in a card; only the content that may become public.
CREATE TABLE IF NOT EXISTS public.founder_wall_entries(
 user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
 display_name text NOT NULL CHECK(founder_wall_valid_text(display_name,40)),
 social_accounts jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(founder_wall_valid_accounts(social_accounts)),
 product_name text CHECK(product_name IS NULL OR founder_wall_valid_text(product_name,60)),
 product_url text CHECK(product_url IS NULL OR founder_wall_valid_url(product_url)),
 intro text CHECK(intro IS NULL OR founder_wall_valid_text(intro,120)),
 review_state text NOT NULL DEFAULT 'pending' CHECK(review_state IN ('pending','approved','rejected')),
 reviewed_at timestamptz,
 reviewed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(product_url IS NULL OR product_name IS NOT NULL),
 CHECK((review_state='pending')=(reviewed_at IS NULL))
);
-- One row per founder the admin has handled; "pending removal" is computed, never stored.
CREATE TABLE IF NOT EXISTS public.founder_community_status(
 user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
 joined_at timestamptz NOT NULL,
 joined_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
 removed_at timestamptz,
 removed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
 CHECK(removed_at IS NULL OR removed_at>=joined_at)
);
ALTER TABLE public.founder_wall_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.founder_community_status ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.founder_wall_entries,public.founder_community_status FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.founder_account_open(a uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM profiles WHERE id=a AND status='active' AND is_deleted::text='false')
  AND NOT EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=a)
$$;
CREATE OR REPLACE FUNCTION public.founder_wall_consented(a uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM data_use_consents WHERE profile_id=a AND purpose='founder_wall' AND revoked_at IS NULL
  AND version=founder_wall_consent_current_version())
$$;
-- Shown on the wall only while every condition holds at read time: approved, consented, open account, and
-- an active or grace founder (frozen and ended are taken down without touching the row).
CREATE OR REPLACE FUNCTION public.founder_wall_listed(a uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM founder_wall_entries WHERE user_id=a AND review_state='approved')
  AND founder_wall_consented(a) AND founder_account_open(a)
  AND pay_founder_status(a)->>'state' IN ('active','grace')
$$;
CREATE OR REPLACE FUNCTION public.founder_wall_entry_json(e founder_wall_entries) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN e.user_id IS NULL THEN NULL ELSE jsonb_build_object('displayName',e.display_name,
  'socialAccounts',e.social_accounts,'productName',e.product_name,'productUrl',e.product_url,'intro',e.intro,
  'reviewState',e.review_state,'reviewedAt',e.reviewed_at,'updatedAt',e.updated_at) END
$$;

-- The signed-in member's own view (personal center).
CREATE OR REPLACE FUNCTION public.founder_member_state(a uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE st jsonb; latest data_use_consents; e founder_wall_entries; entry jsonb;
BEGIN
 st:=pay_founder_status(a);
 SELECT * INTO latest FROM data_use_consents WHERE profile_id=a AND purpose='founder_wall'
  ORDER BY granted_at DESC,id DESC LIMIT 1;
 SELECT * INTO e FROM founder_wall_entries WHERE user_id=a;
 SELECT value INTO entry FROM system_settings WHERE key='founder_community_entry';
 RETURN jsonb_build_object('founder',st,
  'consent',jsonb_build_object('purpose','founder_wall','currentVersion',founder_wall_consent_current_version(),
   'granted',founder_wall_consented(a),'version',latest.version,'grantedAt',latest.granted_at,'revokedAt',latest.revoked_at),
  'entry',founder_wall_entry_json(e),'listed',founder_wall_listed(a),
  'community',CASE WHEN st->>'state' IN ('active','grace') AND jsonb_typeof(entry)='object'
   THEN jsonb_build_object('url',entry->'url','note',entry->'note') END);
END $$;

-- Submitting the card is the opt-in: the consent (version the member was shown) and the content are written
-- together under the profile lock, which account_erasure_confirm takes first as well.
CREATE OR REPLACE FUNCTION public.founder_wall_submit(a uuid,p_entry jsonb,p_version text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p profiles; cur data_use_consents; e founder_wall_entries; acc jsonb;
BEGIN
 IF a IS NULL OR jsonb_typeof(p_entry) IS DISTINCT FROM 'object'
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_entry) k WHERE k NOT IN ('displayName','socialAccounts','productName','productUrl','intro'))
  OR jsonb_typeof(p_entry->'displayName') IS DISTINCT FROM 'string'
  OR coalesce(jsonb_typeof(p_entry->'productName'),'null') NOT IN ('string','null')
  OR coalesce(jsonb_typeof(p_entry->'productUrl'),'null') NOT IN ('string','null')
  OR coalesce(jsonb_typeof(p_entry->'intro'),'null') NOT IN ('string','null')
 THEN RAISE EXCEPTION 'FOUNDER_WALL_INPUT_INVALID' USING ERRCODE='23514'; END IF;
 acc:=coalesce(nullif(p_entry->'socialAccounts','null'::jsonb),'[]'::jsonb);
 SELECT * INTO p FROM profiles WHERE id=a FOR UPDATE;
 IF p.id IS NULL THEN RAISE EXCEPTION 'FOUNDER_PROFILE_MISSING' USING ERRCODE='P0002'; END IF;
 IF NOT founder_account_open(a) THEN RAISE EXCEPTION 'FOUNDER_ACCOUNT_CLOSED' USING ERRCODE='42501'; END IF;
 IF pay_founder_status(a)->>'state' NOT IN ('active','grace') THEN
  RAISE EXCEPTION 'FOUNDER_WALL_NOT_FOUNDER' USING ERRCODE='42501'; END IF;
 IF p_version IS DISTINCT FROM founder_wall_consent_current_version() THEN
  RAISE EXCEPTION 'FOUNDER_WALL_VERSION_STALE' USING ERRCODE='PT409'; END IF;
 IF NOT founder_wall_valid_text(p_entry->>'displayName',40) OR NOT founder_wall_valid_accounts(acc)
  OR p_entry->>'productName' IS NOT NULL AND NOT founder_wall_valid_text(p_entry->>'productName',60)
  OR p_entry->>'productUrl' IS NOT NULL AND (NOT founder_wall_valid_url(p_entry->>'productUrl') OR p_entry->>'productName' IS NULL)
  OR p_entry->>'intro' IS NOT NULL AND NOT founder_wall_valid_text(p_entry->>'intro',120)
 THEN RAISE EXCEPTION 'FOUNDER_WALL_INPUT_INVALID' USING ERRCODE='23514'; END IF;
 SELECT * INTO cur FROM data_use_consents WHERE profile_id=a AND purpose='founder_wall' AND revoked_at IS NULL;
 IF cur.id IS NULL OR cur.version<>p_version THEN
  UPDATE data_use_consents SET revoked_at=clock_timestamp(),revoke_reason='superseded' WHERE id=cur.id;
  INSERT INTO data_use_consents(profile_id,purpose,version) VALUES(a,'founder_wall',p_version);
 END IF;
 SELECT * INTO e FROM founder_wall_entries WHERE user_id=a FOR UPDATE;
 IF e.user_id IS NULL THEN
  INSERT INTO founder_wall_entries(user_id,display_name,social_accounts,product_name,product_url,intro)
  VALUES(a,p_entry->>'displayName',acc,p_entry->>'productName',p_entry->>'productUrl',p_entry->>'intro');
 -- Any change, including to an approved card, goes back to review; the wall shows nothing until approved.
 ELSIF (e.display_name,e.social_accounts,e.product_name,e.product_url,e.intro) IS DISTINCT FROM
  (p_entry->>'displayName',acc,p_entry->>'productName',p_entry->>'productUrl',p_entry->>'intro') THEN
  UPDATE founder_wall_entries SET display_name=p_entry->>'displayName',social_accounts=acc,
   product_name=p_entry->>'productName',product_url=p_entry->>'productUrl',intro=p_entry->>'intro',
   review_state='pending',reviewed_at=NULL,reviewed_by=NULL,updated_at=clock_timestamp() WHERE user_id=a;
 END IF;
 RETURN founder_member_state(a);
END $$;

-- Withdrawal always succeeds and is idempotent: the content row goes, the consent audit stays (0212, 1 year).
CREATE OR REPLACE FUNCTION public.founder_wall_withdraw(a uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF a IS NULL THEN RAISE EXCEPTION 'FOUNDER_WALL_INPUT_INVALID' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM profiles WHERE id=a FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'FOUNDER_PROFILE_MISSING' USING ERRCODE='P0002'; END IF;
 UPDATE data_use_consents SET revoked_at=clock_timestamp(),revoke_reason='user'
  WHERE profile_id=a AND purpose='founder_wall' AND revoked_at IS NULL;
 DELETE FROM founder_wall_entries WHERE user_id=a;
 RETURN founder_member_state(a);
END $$;

-- The public wall: display content only, no account identifiers.
CREATE OR REPLACE FUNCTION public.founder_wall_public() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('displayName',e.display_name,'socialAccounts',e.social_accounts,
  'productName',e.product_name,'productUrl',e.product_url,'intro',e.intro) ORDER BY e.reviewed_at,e.user_id),'[]'::jsonb)
 FROM founder_wall_entries e WHERE founder_wall_listed(e.user_id)
$$;

CREATE OR REPLACE FUNCTION public.founder_admin_check(p_actor uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF p_actor IS NULL OR NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor AND role='admin'
  AND status='active' AND is_deleted::text='false')
 THEN RAISE EXCEPTION 'FOUNDER_ADMIN_DENIED' USING ERRCODE='42501'; END IF;
END $$;

-- The admin sees exactly the content it approves: a card edited after the admin loaded it is a conflict.
CREATE OR REPLACE FUNCTION public.founder_wall_review(p_actor uuid,p_user uuid,p_decision text,p_seen_updated_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e founder_wall_entries;
BEGIN
 PERFORM founder_admin_check(p_actor);
 IF p_user IS NULL OR p_decision NOT IN ('approved','rejected') OR p_seen_updated_at IS NULL THEN
  RAISE EXCEPTION 'FOUNDER_WALL_INPUT_INVALID' USING ERRCODE='23514'; END IF;
 SELECT * INTO e FROM founder_wall_entries WHERE user_id=p_user FOR UPDATE;
 IF e.user_id IS NULL THEN RAISE EXCEPTION 'FOUNDER_WALL_ENTRY_MISSING' USING ERRCODE='P0002'; END IF;
 IF e.updated_at IS DISTINCT FROM p_seen_updated_at THEN
  RAISE EXCEPTION 'FOUNDER_WALL_ENTRY_CHANGED' USING ERRCODE='PT409'; END IF;
 IF e.review_state IS DISTINCT FROM p_decision THEN
  UPDATE founder_wall_entries SET review_state=p_decision,reviewed_at=clock_timestamp(),reviewed_by=p_actor
   WHERE user_id=p_user RETURNING * INTO e;
 END IF;
 RETURN founder_wall_entry_json(e)||jsonb_build_object('listed',founder_wall_listed(p_user));
END $$;

-- Admin list of everyone who ever held a founder identity (at most 50 per mode), with the computed
-- "pending removal" flag, the community bookkeeping and the wall card. Email is shown to admins only.
CREATE OR REPLACE FUNCTION public.founder_admin_overview(p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 PERFORM founder_admin_check(p_actor);
 SELECT coalesce(jsonb_agg(item ORDER BY item->>'foundedAt',item->>'userId'),'[]'::jsonb) INTO result FROM (
  SELECT jsonb_build_object('userId',u.user_id,'email',p.email,'founder',st,'foundedAt',st->>'foundedAt',
   'accountOpen',founder_account_open(u.user_id),
   'community',jsonb_build_object('joinedAt',c.joined_at,'removedAt',c.removed_at),
   'pendingRemoval',st->>'state'='ended' AND c.joined_at IS NOT NULL AND c.removed_at IS NULL,
   'wall',founder_wall_entry_json(e)||CASE WHEN e.user_id IS NULL THEN NULL ELSE jsonb_build_object(
    'consented',founder_wall_consented(u.user_id),'listed',founder_wall_listed(u.user_id)) END) item
  FROM (SELECT DISTINCT user_id FROM payment_orders WHERE offer_kind IN ('founder','founder_renewal')
    AND qualification_state='sold' AND fulfilled_at IS NOT NULL AND user_id IS NOT NULL) u
  CROSS JOIN LATERAL (SELECT pay_founder_status(u.user_id) st) s
  JOIN profiles p ON p.id=u.user_id
  LEFT JOIN founder_community_status c ON c.user_id=u.user_id
  LEFT JOIN founder_wall_entries e ON e.user_id=u.user_id
  WHERE st->>'state'<>'none') rows;
 RETURN result;
END $$;

-- "Joined" / "removed" as two idempotent actions; joining again after a removal starts a new membership.
CREATE OR REPLACE FUNCTION public.founder_community_mark(p_actor uuid,p_user uuid,p_action text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c founder_community_status;
BEGIN
 PERFORM founder_admin_check(p_actor);
 IF p_user IS NULL OR p_action NOT IN ('joined','removed') THEN
  RAISE EXCEPTION 'FOUNDER_COMMUNITY_INPUT_INVALID' USING ERRCODE='23514'; END IF;
 -- Shares the profile lock order of account_erasure_confirm; a closing account is left to erasure.
 PERFORM 1 FROM profiles WHERE id=p_user FOR SHARE;
 IF NOT founder_account_open(p_user) THEN RAISE EXCEPTION 'FOUNDER_ACCOUNT_CLOSED' USING ERRCODE='42501'; END IF;
 IF pay_founder_status(p_user)->>'state'='none' THEN RAISE EXCEPTION 'FOUNDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;
 SELECT * INTO c FROM founder_community_status WHERE user_id=p_user FOR UPDATE;
 IF p_action='joined' THEN
  IF c.user_id IS NULL THEN
   INSERT INTO founder_community_status(user_id,joined_at,joined_by) VALUES(p_user,clock_timestamp(),p_actor)
   ON CONFLICT(user_id) DO NOTHING RETURNING * INTO c;
   IF c.user_id IS NULL THEN SELECT * INTO c FROM founder_community_status WHERE user_id=p_user; END IF;
  ELSIF c.removed_at IS NOT NULL THEN
   UPDATE founder_community_status SET joined_at=clock_timestamp(),joined_by=p_actor,removed_at=NULL,removed_by=NULL
    WHERE user_id=p_user RETURNING * INTO c;
  END IF;
 ELSE
  IF c.user_id IS NULL THEN RAISE EXCEPTION 'FOUNDER_COMMUNITY_NOT_JOINED' USING ERRCODE='23514'; END IF;
  IF c.removed_at IS NULL THEN
   UPDATE founder_community_status SET removed_at=clock_timestamp(),removed_by=p_actor WHERE user_id=p_user RETURNING * INTO c;
  END IF;
 END IF;
 RETURN jsonb_build_object('userId',p_user,'joinedAt',c.joined_at,'removedAt',c.removed_at);
END $$;

-- The community entry shown to active/grace founders; set by an admin, never hard-coded (F1: WeChat group).
CREATE OR REPLACE FUNCTION public.founder_community_entry_set(p_actor uuid,p_url text,p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM founder_admin_check(p_actor);
 IF p_url IS NOT NULL AND NOT founder_wall_valid_url(p_url) OR p_note IS NOT NULL AND NOT founder_wall_valid_text(p_note,500)
 THEN RAISE EXCEPTION 'FOUNDER_COMMUNITY_INPUT_INVALID' USING ERRCODE='23514'; END IF;
 IF p_url IS NULL AND p_note IS NULL THEN DELETE FROM system_settings WHERE key='founder_community_entry';
 ELSE
  INSERT INTO system_settings(key,value) VALUES('founder_community_entry',jsonb_build_object('url',p_url,'note',p_note,
   'updatedBy',p_actor,'updatedAt',clock_timestamp()))
  ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value;
 END IF;
 RETURN (SELECT value FROM system_settings WHERE key='founder_community_entry');
END $$;

-- Half-monthly livestream records (Owner operations): admin audit rows in user_activity_logs, kept 3 years
-- like other admin audit rows; no member is linked (user_id NULL) and details hold no member data.
CREATE OR REPLACE FUNCTION public.founder_livestream_list(p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 PERFORM founder_admin_check(p_actor);
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',l.id,'heldOn',l.details->>'heldOn','topic',l.details->>'topic',
  'replayUrl',l.details->>'replayUrl','recordedBy',l.admin_id,'recordedAt',l.created_at)
  ORDER BY l.details->>'heldOn' DESC,l.created_at DESC),'[]'::jsonb) INTO result
 FROM (SELECT * FROM user_activity_logs WHERE action='founder_livestream' AND user_id IS NULL
  ORDER BY details->>'heldOn' DESC,created_at DESC LIMIT 200) l;
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION public.founder_livestream_record(p_actor uuid,p_request uuid,p_held_on date,p_topic text,p_replay_url text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM founder_admin_check(p_actor);
 IF p_request IS NULL OR p_held_on IS NULL OR p_held_on<date '2026-01-01' OR p_held_on>current_date+1
  OR NOT founder_wall_valid_text(p_topic,120) OR p_replay_url IS NOT NULL AND NOT founder_wall_valid_url(p_replay_url)
 THEN RAISE EXCEPTION 'FOUNDER_LIVESTREAM_INPUT_INVALID' USING ERRCODE='23514'; END IF;
 -- A retried submission (same request id) records one row.
 PERFORM pg_advisory_xact_lock(7064,hashtext(p_request::text));
 IF NOT EXISTS(SELECT 1 FROM user_activity_logs WHERE action='founder_livestream' AND user_id IS NULL
  AND details->>'requestId'=p_request::text) THEN
  INSERT INTO user_activity_logs(admin_id,action,action_type,details) VALUES(p_actor,'founder_livestream','founder',
   jsonb_build_object('requestId',p_request,'heldOn',p_held_on,'topic',p_topic,'replayUrl',p_replay_url));
 END IF;
 RETURN founder_livestream_list(p_actor);
END $$;

-- Account erasure: extend the merged prune loop in place (0192/0203/0240 pattern). Unique anchors fail
-- closed on source drift; the marker makes repeated application stable.
DO $$
DECLARE source text; needle text; replacement text; sig text;
BEGIN
 FOR sig,needle,replacement IN SELECT * FROM (VALUES
  ('erasure_business_owner(text,jsonb)', E' CASE\n',
   E' CASE\n WHEN t IN (''founder_wall_entries'',''founder_community_status'') THEN RETURN (j->>''user_id'')::uuid;\n'),
  ('account_erasure_prune_business(uuid,integer)', E' FOREACH t IN ARRAY ARRAY[\n',
   E' FOREACH t IN ARRAY ARRAY[\n  ''founder_wall_entries'',''founder_community_status'',\n'),
  ('account_erasure_business_remaining(uuid)', ' SELECT ',
   E' SELECT (SELECT count(*) FROM founder_wall_entries WHERE user_id=p_profile_id)\n'
   ||E' +(SELECT count(*) FROM founder_community_status WHERE user_id=p_profile_id)+')
 ) changes(signature,anchor,patch) LOOP
  source:=pg_get_functiondef(('public.'||sig)::regprocedure);
  IF position('-- PAY-FOUNDER erasure' IN source)=0 THEN
   IF length(source)-length(replace(source,needle,''))<>length(needle) THEN
    RAISE EXCEPTION 'PAY_FOUNDER_ERASURE_SOURCE_MISMATCH: %',sig; END IF;
   EXECUTE replace(source,needle,E' -- PAY-FOUNDER erasure\n'||replacement);
  END IF;
 END LOOP;
END $$;

DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('pay_founder_order_frozen','pay_founder_status',
   'founder_wall_consent_current_version','founder_wall_valid_url','founder_wall_valid_text','founder_wall_valid_accounts',
   'founder_account_open','founder_wall_consented','founder_wall_listed','founder_wall_entry_json','founder_member_state',
   'founder_wall_submit','founder_wall_withdraw','founder_wall_public','founder_admin_check','founder_wall_review',
   'founder_admin_overview','founder_community_mark','founder_community_entry_set','founder_livestream_list',
   'founder_livestream_record') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f);
  IF split_part(f::text,'(',1) IN ('pay_founder_status','founder_member_state','founder_wall_submit',
   'founder_wall_withdraw','founder_wall_public','founder_wall_review','founder_admin_overview','founder_community_mark',
   'founder_community_entry_set','founder_livestream_list','founder_livestream_record') THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f);END IF;
 END LOOP;
END $$;
COMMIT;
