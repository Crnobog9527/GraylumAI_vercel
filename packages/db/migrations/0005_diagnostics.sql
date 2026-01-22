-- Migration: 0005_diagnostics
-- Description: Create diagnostics system tables and functions for system health monitoring
-- Date: 2026-01-22

-- ============================================
-- Part 1: Diagnostic Results Table
-- ============================================

-- Create enum type for test status
DO $$ BEGIN
  CREATE TYPE diagnostic_status AS ENUM ('passed', 'failed', 'warning', 'skipped', 'error');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Create enum type for test category
DO $$ BEGIN
  CREATE TYPE diagnostic_category AS ENUM ('ai', 'billing', 'security', 'performance', 'data');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Table to store diagnostic test results
CREATE TABLE IF NOT EXISTS diagnostic_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id text NOT NULL,
  test_name text NOT NULL,
  category diagnostic_category NOT NULL,
  status diagnostic_status NOT NULL,
  message text,
  details jsonb DEFAULT '{}',
  latency_ms integer,
  run_by uuid REFERENCES profiles(id),
  run_type text DEFAULT 'manual' CHECK (run_type IN ('manual', 'cron', 'ci')),
  batch_id uuid,  -- Group results from same run
  created_at timestamptz DEFAULT NOW() NOT NULL
);

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_diagnostic_results_batch_id ON diagnostic_results(batch_id);
CREATE INDEX IF NOT EXISTS idx_diagnostic_results_test_id ON diagnostic_results(test_id);
CREATE INDEX IF NOT EXISTS idx_diagnostic_results_category ON diagnostic_results(category);
CREATE INDEX IF NOT EXISTS idx_diagnostic_results_status ON diagnostic_results(status);
CREATE INDEX IF NOT EXISTS idx_diagnostic_results_created_at ON diagnostic_results(created_at DESC);

-- ============================================
-- Part 2: Diagnostic Summary View
-- ============================================

-- Create view for latest test results
CREATE OR REPLACE VIEW diagnostic_latest_results AS
WITH ranked_results AS (
  SELECT
    *,
    ROW_NUMBER() OVER (PARTITION BY test_id ORDER BY created_at DESC) as rn
  FROM diagnostic_results
)
SELECT
  id,
  test_id,
  test_name,
  category,
  status,
  message,
  details,
  latency_ms,
  run_by,
  run_type,
  batch_id,
  created_at
FROM ranked_results
WHERE rn = 1;

-- ============================================
-- Part 3: System Test Account
-- ============================================

-- Create system test account if not exists
-- This account is used for diagnostic tests that require authentication
DO $$
DECLARE
  v_test_user_id uuid;
BEGIN
  -- Check if test user exists
  SELECT id INTO v_test_user_id
  FROM profiles
  WHERE email = 'system-test@graylum.internal';

  -- If not exists, create it
  IF v_test_user_id IS NULL THEN
    INSERT INTO profiles (
      id,
      email,
      nickname,
      role,
      status,
      credits,
      membership_level
    ) VALUES (
      gen_random_uuid(),
      'system-test@graylum.internal',
      'System Test',
      'user',
      'active',
      10000,  -- Test credits
      'free'
    );
  END IF;
END $$;

-- ============================================
-- Part 4: RLS Policies
-- ============================================

-- Enable RLS on diagnostic_results
ALTER TABLE diagnostic_results ENABLE ROW LEVEL SECURITY;

-- Admin can view all diagnostic results
DROP POLICY IF EXISTS "Admins can view all diagnostic results" ON diagnostic_results;
CREATE POLICY "Admins can view all diagnostic results" ON diagnostic_results
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid()
      AND role = 'admin'
    )
  );

-- Admin can insert diagnostic results
DROP POLICY IF EXISTS "Admins can insert diagnostic results" ON diagnostic_results;
CREATE POLICY "Admins can insert diagnostic results" ON diagnostic_results
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid()
      AND role = 'admin'
    )
  );

-- Service role can insert (for cron jobs)
DROP POLICY IF EXISTS "Service can insert diagnostic results" ON diagnostic_results;
CREATE POLICY "Service can insert diagnostic results" ON diagnostic_results
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- ============================================
-- Part 5: Cleanup Function
-- ============================================

-- Function to clean up old diagnostic results (keep last 30 days)
CREATE OR REPLACE FUNCTION cleanup_old_diagnostic_results(
  p_days_to_keep integer DEFAULT 30
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_deleted_count integer;
BEGIN
  DELETE FROM diagnostic_results
  WHERE created_at < NOW() - (p_days_to_keep || ' days')::interval;

  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RETURN v_deleted_count;
END;
$$;

-- ============================================
-- Part 6: Statistics Functions
-- ============================================

-- Function to get diagnostic summary statistics
CREATE OR REPLACE FUNCTION get_diagnostic_summary(
  p_hours integer DEFAULT 24
)
RETURNS TABLE(
  total_tests bigint,
  passed_tests bigint,
  failed_tests bigint,
  warning_tests bigint,
  pass_rate numeric,
  avg_latency_ms numeric,
  last_run timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*)::bigint as total_tests,
    COUNT(*) FILTER (WHERE status = 'passed')::bigint as passed_tests,
    COUNT(*) FILTER (WHERE status = 'failed')::bigint as failed_tests,
    COUNT(*) FILTER (WHERE status = 'warning')::bigint as warning_tests,
    ROUND(
      (COUNT(*) FILTER (WHERE status = 'passed')::numeric / NULLIF(COUNT(*), 0) * 100),
      2
    ) as pass_rate,
    ROUND(AVG(latency_ms)::numeric, 2) as avg_latency_ms,
    MAX(created_at) as last_run
  FROM diagnostic_results
  WHERE created_at >= NOW() - (p_hours || ' hours')::interval;
END;
$$;

-- Function to get test history for a specific test
CREATE OR REPLACE FUNCTION get_test_history(
  p_test_id text,
  p_limit integer DEFAULT 10
)
RETURNS TABLE(
  id uuid,
  status diagnostic_status,
  message text,
  latency_ms integer,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    dr.id,
    dr.status,
    dr.message,
    dr.latency_ms,
    dr.created_at
  FROM diagnostic_results dr
  WHERE dr.test_id = p_test_id
  ORDER BY dr.created_at DESC
  LIMIT p_limit;
END;
$$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION cleanup_old_diagnostic_results(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION get_diagnostic_summary(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION get_test_history(text, integer) TO authenticated;

-- ============================================
-- Part 7: Comments
-- ============================================

COMMENT ON TABLE diagnostic_results IS 'Stores results of system diagnostic tests';
COMMENT ON COLUMN diagnostic_results.test_id IS 'Unique identifier for the test type (e.g., ai_routing, billing_prededuct)';
COMMENT ON COLUMN diagnostic_results.batch_id IS 'Groups results from the same diagnostic run';
COMMENT ON COLUMN diagnostic_results.run_type IS 'How the test was triggered: manual, cron, or ci';
COMMENT ON VIEW diagnostic_latest_results IS 'Shows only the most recent result for each test type';
