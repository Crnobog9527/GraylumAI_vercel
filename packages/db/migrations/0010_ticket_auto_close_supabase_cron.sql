-- Migration: 0010_ticket_auto_close_supabase_cron
-- Description: Move ticket auto-close scheduling to Supabase Cron (pg_cron)
-- Date: 2026-03-09

-- ============================================
-- Part 1: Enable pg_cron
-- ============================================

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ============================================
-- Part 2: Database-native ticket auto-close function
-- ============================================

CREATE OR REPLACE FUNCTION public.auto_close_stale_tickets(
  p_timeout_hours integer DEFAULT 48
)
RETURNS TABLE(
  checked integer,
  eligible integer,
  closed integer
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_ticket record;
  v_first_admin_reply timestamptz;
  v_last_user_reply_after_admin timestamptz;
  v_timeout_start timestamptz;
  v_checked integer := 0;
  v_eligible integer := 0;
  v_closed integer := 0;
  v_system_message text := format(
    '此工单因超过 %s 小时无用户回复，已被系统自动关闭。如需继续咨询，请创建新工单。',
    p_timeout_hours
  );
BEGIN
  FOR v_ticket IN
    SELECT id, title
    FROM tickets
    WHERE is_deleted = 'false'
      AND status IN ('open', 'in_progress')
  LOOP
    v_checked := v_checked + 1;

    SELECT MIN(created_at)
    INTO v_first_admin_reply
    FROM ticket_replies
    WHERE ticket_id = v_ticket.id
      AND is_deleted = 'false'
      AND is_admin = 'true';

    IF v_first_admin_reply IS NULL THEN
      CONTINUE;
    END IF;

    SELECT MAX(created_at)
    INTO v_last_user_reply_after_admin
    FROM ticket_replies
    WHERE ticket_id = v_ticket.id
      AND is_deleted = 'false'
      AND is_admin <> 'true'
      AND created_at > v_first_admin_reply;

    v_timeout_start := COALESCE(v_last_user_reply_after_admin, v_first_admin_reply);

    IF now() - v_timeout_start < make_interval(hours => p_timeout_hours) THEN
      CONTINUE;
    END IF;

    v_eligible := v_eligible + 1;

    UPDATE tickets
    SET
      status = 'closed',
      updated_at = now()
    WHERE id = v_ticket.id
      AND status <> 'closed';

    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    INSERT INTO ticket_replies (
      ticket_id,
      user_id,
      content,
      is_admin,
      attachments
    ) VALUES (
      v_ticket.id,
      NULL,
      v_system_message,
      'true',
      '[]'::jsonb
    );

    v_closed := v_closed + 1;
  END LOOP;

  RETURN QUERY
  SELECT v_checked, v_eligible, v_closed;
END;
$$;

COMMENT ON FUNCTION public.auto_close_stale_tickets(integer)
IS 'Closes tickets when the user has not replied within the timeout window after the first admin reply.';

-- ============================================
-- Part 3: Schedule with Supabase Cron
-- ============================================

DO $schedule$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM cron.job
    WHERE jobname = 'ticket-auto-close-hourly'
  ) THEN
    PERFORM cron.unschedule('ticket-auto-close-hourly');
  END IF;

  PERFORM cron.schedule(
    'ticket-auto-close-hourly',
    '0 * * * *',
    $cron$SELECT public.auto_close_stale_tickets(48);$cron$
  );
END
$schedule$;

-- ============================================
-- Part 4: Notes
-- ============================================

-- This migration intentionally keeps the Vercel cron route in place as a fallback.
-- After this migration is applied to the target Supabase project and verified,
-- the Vercel daily fallback can be removed in a follow-up change.
