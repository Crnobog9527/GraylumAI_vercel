-- Migration: Create prompts table
-- Date: 2024-01-16
-- Description: Table for system prompt templates management

-- ============================================
-- 1. PROMPTS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS prompts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  content TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',  -- general, assistant, creative, coding, etc.
  is_system TEXT NOT NULL DEFAULT 'false',  -- System prompts cannot be deleted by regular admins
  active TEXT NOT NULL DEFAULT 'true',
  sort_order INTEGER DEFAULT 0,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Create indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_prompts_category ON prompts(category);
CREATE INDEX IF NOT EXISTS idx_prompts_active ON prompts(active);
CREATE INDEX IF NOT EXISTS idx_prompts_is_system ON prompts(is_system);
CREATE INDEX IF NOT EXISTS idx_prompts_sort_order ON prompts(sort_order);
CREATE INDEX IF NOT EXISTS idx_prompts_created_at ON prompts(created_at DESC);

-- ============================================
-- DONE
-- ============================================
-- Execute this SQL in Supabase SQL Editor to create the prompts table.
