-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CODE-HEALTH: the profile "使用统计" card and the "本月消耗" numbers.
--   The card counted rows of `conversations` and `messages`, which only the retired chat path wrote: on a database built from files
--   (production) every account would show 0 conversations, 0 messages and 0 days for ever. The per-turn core writes `turns` and
--   `session_messages`, which no API role can read (0420 revokes them from every role), so the numbers need a definer function.
--   The credit totals were summed in Node over an unpaged `credit_transactions` read: PostgREST returns at most 1000 rows, so an
--   account with more ledger rows in the period (a turn writes several) got a total that was silently too small.
--   usage_stats_for_user(user): three counts for one account, each read by the owner key.
--     conversations: sessions in which the account opened a chat, mentor or compare turn (a report, a jury review or a voice
--       profile runs inside or beside a conversation and is not one; a scheduled review is not started by the user).
--       A conversation the user deleted still counts (its turns remain); an erased account has no profile to ask for.
--     messages: visible, undeleted messages (both sides) in the account's sessions, scheduled reviews left out.
--     usageDays: UTC days on which the account opened any turn other than a scheduled review.
--   usage_credit_summary_for_user(user, from): the totals the profile cards show, from `from` on (NULL: all time). The same rules as
--     services/creditLedger.ts on rows the 0044 trigger has normalised: earned = positive grants, spent = counts_as_spend rows
--     (ledger_type 'spend'; reservations and their release are adjustments and are not spend).
-- Both are STABLE, read-only, take no lock, and are granted to service_role only: the router passes the signed-in account's own
-- id (and the admin user page passes the account it shows).
-- Compatible: two new functions; deployed code does not call them. Repeatable: CREATE OR REPLACE and idempotent grants.
-- Recovery: DROP FUNCTION public.usage_stats_for_user(uuid), public.usage_credit_summary_for_user(uuid, timestamptz); no data is written.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.usage_stats_for_user(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT jsonb_build_object(
  'conversations', (SELECT count(DISTINCT t.session_id) FROM turns t
    WHERE t.actor_id = p_user_id AND t.kind IN ('chat', 'mentor', 'compare') AND t.session_id IS NOT NULL),
  'messages', (SELECT count(*) FROM runtime_sessions s
    JOIN session_messages m ON m.session_id = s.id
    JOIN turns t ON t.actor_id = s.actor_id AND t.id = m.turn_id
    WHERE s.actor_id = p_user_id AND m.visible AND m.deleted_at IS NULL AND t.kind <> 'review'),
  'usageDays', (SELECT count(DISTINCT (t.opened_at AT TIME ZONE 'UTC')::date) FROM turns t
    WHERE t.actor_id = p_user_id AND t.kind <> 'review'))
$function$;

CREATE OR REPLACE FUNCTION public.usage_credit_summary_for_user(p_user_id uuid, p_from timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 WITH rows AS (
  SELECT c.amount, c.type, c.ledger_type, c.counts_as_spend FROM credit_transactions c
  WHERE c.user_id = p_user_id AND (p_from IS NULL OR c.created_at >= p_from)
 )
 SELECT jsonb_build_object(
  'totalEarned', coalesce((SELECT sum(r.amount) FROM rows r WHERE r.ledger_type = 'grant' AND r.amount > 0), 0),
  'totalSpent', coalesce((SELECT sum(abs(r.amount)) FROM rows r WHERE r.counts_as_spend), 0),
  'transactionCount', (SELECT count(*) FROM rows),
  'byType', coalesce((SELECT jsonb_object_agg(g.type, jsonb_build_object('count', g.n, 'amount', g.total))
    FROM (SELECT r.type, count(*) n, sum(r.amount) total FROM rows r GROUP BY r.type) g), '{}'::jsonb),
  'byLedgerType', coalesce((SELECT jsonb_object_agg(g.ledger_type, jsonb_build_object('count', g.n, 'amount', g.total))
    FROM (SELECT coalesce(r.ledger_type, 'adjustment') ledger_type, count(*) n, sum(r.amount) total FROM rows r GROUP BY 1) g), '{}'::jsonb))
$function$;

REVOKE ALL ON FUNCTION public.usage_stats_for_user(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.usage_stats_for_user(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.usage_credit_summary_for_user(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.usage_credit_summary_for_user(uuid, timestamptz) TO service_role;
COMMIT;
