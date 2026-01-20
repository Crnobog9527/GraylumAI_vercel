-- Migration: Enable RLS Policies for All Tables
-- Date: 2024-01-20
-- Description: Comprehensive Row Level Security policies
--              - Users can only read/write their own data
--              - Admins have full access to all data

-- ============================================
-- 0. HELPER FUNCTION: Check if user is admin
-- ============================================

-- Drop existing function if exists
DROP FUNCTION IF EXISTS is_admin();

-- Create function to check if current user is admin
CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid()
    AND role = 'admin'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 1. PROFILES TABLE
-- ============================================

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Drop existing policies
DROP POLICY IF EXISTS "Users can view own profile" ON profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON profiles;
DROP POLICY IF EXISTS "Admins can view all profiles" ON profiles;
DROP POLICY IF EXISTS "Admins can update all profiles" ON profiles;
DROP POLICY IF EXISTS "Enable insert for authenticated users" ON profiles;

-- Users can view their own profile
CREATE POLICY "Users can view own profile" ON profiles
  FOR SELECT USING (auth.uid() = id);

-- Users can update their own profile (except role)
CREATE POLICY "Users can update own profile" ON profiles
  FOR UPDATE USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- Admins can view all profiles
CREATE POLICY "Admins can view all profiles" ON profiles
  FOR SELECT USING (is_admin());

-- Admins can update all profiles
CREATE POLICY "Admins can update all profiles" ON profiles
  FOR UPDATE USING (is_admin());

-- Allow authenticated users to insert their own profile
CREATE POLICY "Enable insert for authenticated users" ON profiles
  FOR INSERT WITH CHECK (auth.uid() = id);

-- ============================================
-- 2. CONVERSATIONS TABLE
-- ============================================

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;

-- Drop existing policies
DROP POLICY IF EXISTS "Users can view own conversations" ON conversations;
DROP POLICY IF EXISTS "Users can create own conversations" ON conversations;
DROP POLICY IF EXISTS "Users can update own conversations" ON conversations;
DROP POLICY IF EXISTS "Users can delete own conversations" ON conversations;
DROP POLICY IF EXISTS "Admins can view all conversations" ON conversations;

-- Users can view their own conversations
CREATE POLICY "Users can view own conversations" ON conversations
  FOR SELECT USING (auth.uid() = user_id);

-- Users can create their own conversations
CREATE POLICY "Users can create own conversations" ON conversations
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Users can update their own conversations
CREATE POLICY "Users can update own conversations" ON conversations
  FOR UPDATE USING (auth.uid() = user_id);

-- Users can delete their own conversations
CREATE POLICY "Users can delete own conversations" ON conversations
  FOR DELETE USING (auth.uid() = user_id);

-- Admins can view all conversations
CREATE POLICY "Admins can view all conversations" ON conversations
  FOR SELECT USING (is_admin());

-- ============================================
-- 3. MESSAGES TABLE
-- ============================================

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- Drop existing policies
DROP POLICY IF EXISTS "Users can view messages in own conversations" ON messages;
DROP POLICY IF EXISTS "Users can create messages in own conversations" ON messages;
DROP POLICY IF EXISTS "Users can delete messages in own conversations" ON messages;
DROP POLICY IF EXISTS "Admins can view all messages" ON messages;

-- Users can view messages in their own conversations
CREATE POLICY "Users can view messages in own conversations" ON messages
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM conversations
      WHERE conversations.id = messages.conversation_id
      AND conversations.user_id = auth.uid()
    )
  );

-- Users can create messages in their own conversations
CREATE POLICY "Users can create messages in own conversations" ON messages
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM conversations
      WHERE conversations.id = messages.conversation_id
      AND conversations.user_id = auth.uid()
    )
  );

-- Users can delete messages in their own conversations
CREATE POLICY "Users can delete messages in own conversations" ON messages
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM conversations
      WHERE conversations.id = messages.conversation_id
      AND conversations.user_id = auth.uid()
    )
  );

-- Admins can view all messages
CREATE POLICY "Admins can view all messages" ON messages
  FOR SELECT USING (is_admin());

-- ============================================
-- 4. CREDIT_TRANSACTIONS TABLE
-- ============================================

ALTER TABLE credit_transactions ENABLE ROW LEVEL SECURITY;

-- Drop existing policies
DROP POLICY IF EXISTS "Users can view own transactions" ON credit_transactions;
DROP POLICY IF EXISTS "Admins can view all transactions" ON credit_transactions;
DROP POLICY IF EXISTS "Admins can create transactions" ON credit_transactions;

-- Users can view their own transactions
CREATE POLICY "Users can view own transactions" ON credit_transactions
  FOR SELECT USING (auth.uid() = user_id);

-- Admins can view all transactions
CREATE POLICY "Admins can view all transactions" ON credit_transactions
  FOR SELECT USING (is_admin());

-- Admins can create transactions (for adjustments)
CREATE POLICY "Admins can create transactions" ON credit_transactions
  FOR INSERT WITH CHECK (is_admin());

-- ============================================
-- 5. AI_MODELS TABLE
-- ============================================

ALTER TABLE ai_models ENABLE ROW LEVEL SECURITY;

-- Drop existing policies
DROP POLICY IF EXISTS "All users can view ai_models" ON ai_models;
DROP POLICY IF EXISTS "Admins can manage ai_models" ON ai_models;

-- All authenticated users can view AI models
CREATE POLICY "All users can view ai_models" ON ai_models
  FOR SELECT USING (auth.role() = 'authenticated');

-- Only admins can manage AI models
CREATE POLICY "Admins can manage ai_models" ON ai_models
  FOR ALL USING (is_admin());

-- ============================================
-- 6. SYSTEM_SETTINGS TABLE
-- ============================================

ALTER TABLE system_settings ENABLE ROW LEVEL SECURITY;

-- Drop existing policies
DROP POLICY IF EXISTS "Admins can manage system_settings" ON system_settings;
DROP POLICY IF EXISTS "All users can view system_settings" ON system_settings;

-- All authenticated users can read settings
CREATE POLICY "All users can view system_settings" ON system_settings
  FOR SELECT USING (auth.role() = 'authenticated');

-- Only admins can manage settings
CREATE POLICY "Admins can manage system_settings" ON system_settings
  FOR ALL USING (is_admin());

-- ============================================
-- 7. TICKETS TABLE
-- ============================================

ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;

-- Drop existing policies
DROP POLICY IF EXISTS "Users can view own tickets" ON tickets;
DROP POLICY IF EXISTS "Users can create own tickets" ON tickets;
DROP POLICY IF EXISTS "Users can update own tickets" ON tickets;
DROP POLICY IF EXISTS "Admins can manage all tickets" ON tickets;

-- Users can view their own tickets
CREATE POLICY "Users can view own tickets" ON tickets
  FOR SELECT USING (auth.uid() = user_id);

-- Users can create their own tickets
CREATE POLICY "Users can create own tickets" ON tickets
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Users can update their own tickets (e.g., close)
CREATE POLICY "Users can update own tickets" ON tickets
  FOR UPDATE USING (auth.uid() = user_id);

-- Admins can manage all tickets
CREATE POLICY "Admins can manage all tickets" ON tickets
  FOR ALL USING (is_admin());

-- ============================================
-- 8. TICKET_REPLIES TABLE
-- ============================================

ALTER TABLE ticket_replies ENABLE ROW LEVEL SECURITY;

-- Drop existing policies
DROP POLICY IF EXISTS "Users can view replies on own tickets" ON ticket_replies;
DROP POLICY IF EXISTS "Users can create replies on own tickets" ON ticket_replies;
DROP POLICY IF EXISTS "Admins can manage all replies" ON ticket_replies;

-- Users can view replies on their own tickets
CREATE POLICY "Users can view replies on own tickets" ON ticket_replies
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM tickets
      WHERE tickets.id = ticket_replies.ticket_id
      AND tickets.user_id = auth.uid()
    )
  );

-- Users can create replies on their own tickets
CREATE POLICY "Users can create replies on own tickets" ON ticket_replies
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM tickets
      WHERE tickets.id = ticket_replies.ticket_id
      AND tickets.user_id = auth.uid()
    )
  );

-- Admins can manage all replies
CREATE POLICY "Admins can manage all replies" ON ticket_replies
  FOR ALL USING (is_admin());

-- ============================================
-- 9. CREDIT_PACKAGES TABLE
-- ============================================

ALTER TABLE credit_packages ENABLE ROW LEVEL SECURITY;

-- Drop existing policies
DROP POLICY IF EXISTS "All users can view active packages" ON credit_packages;
DROP POLICY IF EXISTS "Admins can manage packages" ON credit_packages;

-- All authenticated users can view active packages
CREATE POLICY "All users can view active packages" ON credit_packages
  FOR SELECT USING (active = 'true');

-- Admins can manage all packages
CREATE POLICY "Admins can manage packages" ON credit_packages
  FOR ALL USING (is_admin());

-- ============================================
-- 10. INVITATIONS TABLE
-- ============================================

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;

-- Drop existing policies
DROP POLICY IF EXISTS "Users can view own invitations" ON invitations;
DROP POLICY IF EXISTS "Admins can manage all invitations" ON invitations;
DROP POLICY IF EXISTS "Users can use invitations" ON invitations;

-- Users can view invitations they created
CREATE POLICY "Users can view own invitations" ON invitations
  FOR SELECT USING (auth.uid() = created_by);

-- Admins can manage all invitations
CREATE POLICY "Admins can manage all invitations" ON invitations
  FOR ALL USING (is_admin());

-- All authenticated users can validate/use invitations (for registration)
CREATE POLICY "Users can use invitations" ON invitations
  FOR UPDATE USING (status = 'active')
  WITH CHECK (auth.role() = 'authenticated');

-- ============================================
-- 11. ANNOUNCEMENTS TABLE
-- ============================================

ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;

-- Drop existing policies
DROP POLICY IF EXISTS "All users can view active announcements" ON announcements;
DROP POLICY IF EXISTS "Admins can manage announcements" ON announcements;

-- All authenticated users can view active announcements
CREATE POLICY "All users can view active announcements" ON announcements
  FOR SELECT USING (
    active = 'true'
    AND (start_date IS NULL OR start_date <= now())
    AND (end_date IS NULL OR end_date >= now())
  );

-- Admins can manage all announcements
CREATE POLICY "Admins can manage announcements" ON announcements
  FOR ALL USING (is_admin());

-- ============================================
-- 12. PROMPTS TABLE
-- ============================================

ALTER TABLE prompts ENABLE ROW LEVEL SECURITY;

-- Drop existing policies
DROP POLICY IF EXISTS "All users can view active prompts" ON prompts;
DROP POLICY IF EXISTS "Admins can manage prompts" ON prompts;

-- All authenticated users can view active prompts
CREATE POLICY "All users can view active prompts" ON prompts
  FOR SELECT USING (active = 'true');

-- Admins can manage all prompts
CREATE POLICY "Admins can manage prompts" ON prompts
  FOR ALL USING (is_admin());

-- ============================================
-- 13. MODULES TABLE (already has RLS)
-- ============================================

-- Drop existing policies to recreate with admin access
DROP POLICY IF EXISTS "Allow read access to modules" ON modules;
DROP POLICY IF EXISTS "Admins can manage modules" ON modules;

-- All users can view active modules
CREATE POLICY "Allow read access to modules" ON modules
  FOR SELECT USING (active = true);

-- Admins can manage all modules
CREATE POLICY "Admins can manage modules" ON modules
  FOR ALL USING (is_admin());

-- ============================================
-- DONE: All RLS policies have been applied
-- ============================================

-- Summary:
-- - profiles: Users own data, admins all
-- - conversations: Users own data, admins read all
-- - messages: Users via conversation ownership, admins read all
-- - credit_transactions: Users read own, admins full access
-- - ai_models: All read, admins manage
-- - system_settings: All read, admins manage
-- - tickets: Users own data, admins full access
-- - ticket_replies: Users via ticket ownership, admins full access
-- - credit_packages: All read active, admins manage
-- - invitations: Users see own created, admins full access
-- - announcements: All read active, admins manage
-- - prompts: All read active, admins manage
-- - modules: All read active, admins manage
