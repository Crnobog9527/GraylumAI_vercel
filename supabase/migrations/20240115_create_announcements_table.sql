-- Migration: Create announcements table
-- Date: 2024-01-15
-- Description: Table for system announcements management

-- ============================================
-- 1. ANNOUNCEMENTS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'info',  -- info, warning, success, error
  priority INTEGER DEFAULT 0,  -- Higher = more important
  active TEXT NOT NULL DEFAULT 'true',
  start_date TIMESTAMPTZ DEFAULT now(),
  end_date TIMESTAMPTZ,  -- NULL means no end date
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Create indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_announcements_active ON announcements(active);
CREATE INDEX IF NOT EXISTS idx_announcements_priority ON announcements(priority DESC);
CREATE INDEX IF NOT EXISTS idx_announcements_start_date ON announcements(start_date);
CREATE INDEX IF NOT EXISTS idx_announcements_end_date ON announcements(end_date);
CREATE INDEX IF NOT EXISTS idx_announcements_created_at ON announcements(created_at DESC);

-- ============================================
-- DONE
-- ============================================
-- Execute this SQL in Supabase SQL Editor to create the announcements table.
