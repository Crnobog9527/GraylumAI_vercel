-- Migration: 0004_recursive_summary_and_soft_delete
-- Description: Add recursive summary support and soft delete mechanism
-- Date: 2026-01-22

-- ============================================
-- Part 1: Recursive Summary Support
-- ============================================

-- Add summary_metadata column to conversations table for storing recursive summary layers
ALTER TABLE conversations
ADD COLUMN IF NOT EXISTS summary_metadata jsonb DEFAULT NULL;

-- Add comment for documentation
COMMENT ON COLUMN conversations.summary_metadata IS 'Metadata for recursive summary layers including level, tokenCount, algorithm version';

-- ============================================
-- Part 2: Soft Delete Mechanism
-- ============================================

-- Add is_deleted column to key user data tables

-- Profiles table
ALTER TABLE profiles
ADD COLUMN IF NOT EXISTS is_deleted boolean DEFAULT false NOT NULL;

ALTER TABLE profiles
ADD COLUMN IF NOT EXISTS deleted_at timestamptz DEFAULT NULL;

-- Conversations table
ALTER TABLE conversations
ADD COLUMN IF NOT EXISTS is_deleted boolean DEFAULT false NOT NULL;

ALTER TABLE conversations
ADD COLUMN IF NOT EXISTS deleted_at timestamptz DEFAULT NULL;

-- Messages table
ALTER TABLE messages
ADD COLUMN IF NOT EXISTS is_deleted boolean DEFAULT false NOT NULL;

ALTER TABLE messages
ADD COLUMN IF NOT EXISTS deleted_at timestamptz DEFAULT NULL;

-- Tickets table
ALTER TABLE tickets
ADD COLUMN IF NOT EXISTS is_deleted boolean DEFAULT false NOT NULL;

ALTER TABLE tickets
ADD COLUMN IF NOT EXISTS deleted_at timestamptz DEFAULT NULL;

-- Ticket Replies table
ALTER TABLE ticket_replies
ADD COLUMN IF NOT EXISTS is_deleted boolean DEFAULT false NOT NULL;

ALTER TABLE ticket_replies
ADD COLUMN IF NOT EXISTS deleted_at timestamptz DEFAULT NULL;

-- Prompts table
ALTER TABLE prompts
ADD COLUMN IF NOT EXISTS is_deleted boolean DEFAULT false NOT NULL;

ALTER TABLE prompts
ADD COLUMN IF NOT EXISTS deleted_at timestamptz DEFAULT NULL;

-- Announcements table
ALTER TABLE announcements
ADD COLUMN IF NOT EXISTS is_deleted boolean DEFAULT false NOT NULL;

ALTER TABLE announcements
ADD COLUMN IF NOT EXISTS deleted_at timestamptz DEFAULT NULL;

-- Create indexes for soft delete queries
CREATE INDEX IF NOT EXISTS idx_profiles_is_deleted ON profiles(is_deleted) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_conversations_is_deleted ON conversations(is_deleted) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_messages_is_deleted ON messages(is_deleted) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_tickets_is_deleted ON tickets(is_deleted) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_ticket_replies_is_deleted ON ticket_replies(is_deleted) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_prompts_is_deleted ON prompts(is_deleted) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_announcements_is_deleted ON announcements(is_deleted) WHERE is_deleted = false;

-- ============================================
-- Part 3: Update RLS Policies for Soft Delete
-- ============================================

-- Drop existing policies and recreate with soft delete check

-- Conversations: Update RLS to exclude soft-deleted records
DROP POLICY IF EXISTS "Users can view own conversations" ON conversations;
CREATE POLICY "Users can view own conversations" ON conversations
  FOR SELECT
  USING (auth.uid() = user_id AND is_deleted = false);

DROP POLICY IF EXISTS "Users can insert own conversations" ON conversations;
CREATE POLICY "Users can insert own conversations" ON conversations
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own conversations" ON conversations;
CREATE POLICY "Users can update own conversations" ON conversations
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Messages: Update RLS to exclude soft-deleted records
DROP POLICY IF EXISTS "Users can view messages in own conversations" ON messages;
CREATE POLICY "Users can view messages in own conversations" ON messages
  FOR SELECT
  USING (
    is_deleted = false AND
    conversation_id IN (
      SELECT id FROM conversations WHERE user_id = auth.uid() AND is_deleted = false
    )
  );

DROP POLICY IF EXISTS "Users can insert messages in own conversations" ON messages;
CREATE POLICY "Users can insert messages in own conversations" ON messages
  FOR INSERT
  WITH CHECK (
    conversation_id IN (
      SELECT id FROM conversations WHERE user_id = auth.uid()
    )
  );

-- Tickets: Update RLS to exclude soft-deleted records
DROP POLICY IF EXISTS "Users can view own tickets" ON tickets;
CREATE POLICY "Users can view own tickets" ON tickets
  FOR SELECT
  USING (auth.uid() = user_id AND is_deleted = false);

DROP POLICY IF EXISTS "Users can insert own tickets" ON tickets;
CREATE POLICY "Users can insert own tickets" ON tickets
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own tickets" ON tickets;
CREATE POLICY "Users can update own tickets" ON tickets
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Ticket Replies: Update RLS
DROP POLICY IF EXISTS "Users can view replies on own tickets" ON ticket_replies;
CREATE POLICY "Users can view replies on own tickets" ON ticket_replies
  FOR SELECT
  USING (
    is_deleted = false AND
    ticket_id IN (
      SELECT id FROM tickets WHERE user_id = auth.uid()
    )
  );

-- Prompts: Update RLS (visible to all but only active)
DROP POLICY IF EXISTS "Anyone can view active prompts" ON prompts;
CREATE POLICY "Anyone can view active prompts" ON prompts
  FOR SELECT
  USING (active = 'true' AND is_deleted = false);

-- Announcements: Update RLS
DROP POLICY IF EXISTS "Anyone can view active announcements" ON announcements;
CREATE POLICY "Anyone can view active announcements" ON announcements
  FOR SELECT
  USING (active = 'true' AND is_deleted = false);

-- ============================================
-- Part 4: Soft Delete Helper Functions
-- ============================================

-- Function to soft delete a conversation and its messages
CREATE OR REPLACE FUNCTION soft_delete_conversation(
  p_conversation_id uuid,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_deleted boolean := false;
BEGIN
  -- Verify ownership
  IF NOT EXISTS (
    SELECT 1 FROM conversations
    WHERE id = p_conversation_id
    AND user_id = p_user_id
    AND is_deleted = false
  ) THEN
    RETURN false;
  END IF;

  -- Soft delete the conversation
  UPDATE conversations
  SET is_deleted = true, deleted_at = NOW()
  WHERE id = p_conversation_id AND user_id = p_user_id;

  -- Soft delete all messages in the conversation
  UPDATE messages
  SET is_deleted = true, deleted_at = NOW()
  WHERE conversation_id = p_conversation_id;

  RETURN true;
END;
$$;

-- Function to soft delete a ticket
CREATE OR REPLACE FUNCTION soft_delete_ticket(
  p_ticket_id uuid,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Verify ownership
  IF NOT EXISTS (
    SELECT 1 FROM tickets
    WHERE id = p_ticket_id
    AND user_id = p_user_id
    AND is_deleted = false
  ) THEN
    RETURN false;
  END IF;

  -- Soft delete the ticket
  UPDATE tickets
  SET is_deleted = true, deleted_at = NOW()
  WHERE id = p_ticket_id AND user_id = p_user_id;

  -- Soft delete all replies
  UPDATE ticket_replies
  SET is_deleted = true, deleted_at = NOW()
  WHERE ticket_id = p_ticket_id;

  RETURN true;
END;
$$;

-- Function to permanently delete soft-deleted records older than N days (for admin use)
CREATE OR REPLACE FUNCTION purge_deleted_records(
  p_days_old integer DEFAULT 30
)
RETURNS TABLE(
  table_name text,
  deleted_count bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_cutoff_date timestamptz := NOW() - (p_days_old || ' days')::interval;
BEGIN
  -- Delete old messages first (due to foreign key)
  DELETE FROM messages
  WHERE is_deleted = true AND deleted_at < v_cutoff_date;
  RETURN QUERY SELECT 'messages'::text, COUNT(*)::bigint FROM messages WHERE false;

  -- Delete old conversations
  DELETE FROM conversations
  WHERE is_deleted = true AND deleted_at < v_cutoff_date;
  RETURN QUERY SELECT 'conversations'::text, COUNT(*)::bigint FROM conversations WHERE false;

  -- Delete old ticket replies
  DELETE FROM ticket_replies
  WHERE is_deleted = true AND deleted_at < v_cutoff_date;
  RETURN QUERY SELECT 'ticket_replies'::text, COUNT(*)::bigint FROM ticket_replies WHERE false;

  -- Delete old tickets
  DELETE FROM tickets
  WHERE is_deleted = true AND deleted_at < v_cutoff_date;
  RETURN QUERY SELECT 'tickets'::text, COUNT(*)::bigint FROM tickets WHERE false;

  -- Delete old prompts
  DELETE FROM prompts
  WHERE is_deleted = true AND deleted_at < v_cutoff_date;
  RETURN QUERY SELECT 'prompts'::text, COUNT(*)::bigint FROM prompts WHERE false;

  -- Delete old announcements
  DELETE FROM announcements
  WHERE is_deleted = true AND deleted_at < v_cutoff_date;
  RETURN QUERY SELECT 'announcements'::text, COUNT(*)::bigint FROM announcements WHERE false;
END;
$$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION soft_delete_conversation(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION soft_delete_ticket(uuid, uuid) TO authenticated;
-- purge_deleted_records should only be called by service role
