-- Migration: Create tickets, ticket_replies, and invitations tables
-- Date: 2024-01-14
-- Description: Tables required for Phase 9-10 of GraylumAI migration

-- ============================================
-- 1. TICKETS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Create index for faster user queries
CREATE INDEX IF NOT EXISTS idx_tickets_user_id ON tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_created_at ON tickets(created_at DESC);

-- ============================================
-- 2. TICKET_REPLIES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS ticket_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Create index for faster ticket replies lookup
CREATE INDEX IF NOT EXISTS idx_ticket_replies_ticket_id ON ticket_replies(ticket_id);
CREATE INDEX IF NOT EXISTS idx_ticket_replies_user_id ON ticket_replies(user_id);
CREATE INDEX IF NOT EXISTS idx_ticket_replies_created_at ON ticket_replies(created_at DESC);

-- ============================================
-- 3. INVITATIONS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  used_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Create index for faster invitation lookups
CREATE INDEX IF NOT EXISTS idx_invitations_code ON invitations(code);
CREATE INDEX IF NOT EXISTS idx_invitations_created_by ON invitations(created_by);
CREATE INDEX IF NOT EXISTS idx_invitations_status ON invitations(status);

-- ============================================
-- 4. ROW LEVEL SECURITY (Optional - currently disabled based on findings)
-- ============================================
-- Note: RLS is currently disabled for ai_models table.
-- If you want to enable RLS for these new tables, uncomment and adjust the following:

-- ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE ticket_replies ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;

-- Tickets: Users can only see their own tickets
-- CREATE POLICY "Users can view own tickets" ON tickets FOR SELECT USING (auth.uid() = user_id);
-- CREATE POLICY "Users can create own tickets" ON tickets FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Ticket Replies: Users can only see replies to their tickets
-- CREATE POLICY "Users can view own ticket replies" ON ticket_replies FOR SELECT
--   USING (user_id = auth.uid() OR ticket_id IN (SELECT id FROM tickets WHERE user_id = auth.uid()));
-- CREATE POLICY "Users can create replies to own tickets" ON ticket_replies FOR INSERT
--   WITH CHECK (ticket_id IN (SELECT id FROM tickets WHERE user_id = auth.uid()));

-- Invitations: Only admins should manage invitations (requires role check)
-- CREATE POLICY "Admin can manage invitations" ON invitations FOR ALL USING (true);

-- ============================================
-- DONE
-- ============================================
-- Execute this SQL in Supabase SQL Editor to create the required tables.
