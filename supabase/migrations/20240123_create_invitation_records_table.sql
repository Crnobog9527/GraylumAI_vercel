-- Create invitation_records table for tracking invitation relationships
CREATE TABLE IF NOT EXISTS invitation_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invite_code TEXT NOT NULL,
  inviter_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  inviter_email TEXT,
  invitee_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  invitee_email TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'registered', 'rewarded', 'rejected')),
  risk_level TEXT NOT NULL DEFAULT 'low' CHECK (risk_level IN ('low', 'medium', 'high')),
  block_reason TEXT,
  inviter_reward INTEGER NOT NULL DEFAULT 0,
  invitee_reward INTEGER NOT NULL DEFAULT 0,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  rewarded_at TIMESTAMP WITH TIME ZONE
);

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_invitation_records_inviter ON invitation_records(inviter_id);
CREATE INDEX IF NOT EXISTS idx_invitation_records_invitee ON invitation_records(invitee_id);
CREATE INDEX IF NOT EXISTS idx_invitation_records_status ON invitation_records(status);
CREATE INDEX IF NOT EXISTS idx_invitation_records_risk_level ON invitation_records(risk_level);
CREATE INDEX IF NOT EXISTS idx_invitation_records_created_at ON invitation_records(created_at DESC);

-- Enable RLS
ALTER TABLE invitation_records ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Admins can view all invitation records"
  ON invitation_records FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );

CREATE POLICY "Users can view their own invitation records"
  ON invitation_records FOR SELECT
  USING (inviter_id = auth.uid() OR invitee_id = auth.uid());

CREATE POLICY "System can insert invitation records"
  ON invitation_records FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Admins can update invitation records"
  ON invitation_records FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );
