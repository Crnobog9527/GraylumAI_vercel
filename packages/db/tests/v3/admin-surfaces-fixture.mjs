/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Disposable admin-preview scaffolding for announcements, membership plans and
// credit packages and check-in status. Columns
// follow packages/db/schema.ts; public read policies are copied byte-for-byte
// from the authoritative migration. Synthetic rows only: no real account,
// Stripe price, provider or money state.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PUBLIC_READ_POLICIES = [
  'announcements_select_active_public',
  'membership_plans_select_active_public',
  'credit_packages_select_active_public',
];

function authoritativePolicy(source, name, terminator = '$policy$') {
  const start = source.indexOf(`CREATE POLICY "${name}"`);
  const end = source.indexOf(terminator, start);
  if (start < 0 || end < 0) throw new Error('missing authoritative policy ' + name);
  return source.slice(start, end).trim() + ';';
}

export function installAdminSurfacesPreview(sql, root) {
  const policies = readFileSync(
    resolve(root, 'packages/db/migrations/0032_admin_policy_shape_reconciliation.sql'),
    'utf8',
  );
  const checkinPolicies = readFileSync(
    resolve(root, 'packages/db/migrations/0013_checkin_rewards.sql'),
    'utf8',
  );
  // Admin suites may already have created minimal versions of these tables.
  sql(`
CREATE TABLE IF NOT EXISTS announcements(id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT '', ADD COLUMN IF NOT EXISTS content text NOT NULL DEFAULT '',
 ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'info', ADD COLUMN IF NOT EXISTS announcement_type text NOT NULL DEFAULT 'homepage',
 ADD COLUMN IF NOT EXISTS banner_style text DEFAULT 'info', ADD COLUMN IF NOT EXISTS banner_link text, ADD COLUMN IF NOT EXISTS icon text DEFAULT 'Megaphone',
 ADD COLUMN IF NOT EXISTS icon_color text DEFAULT 'text-blue-500', ADD COLUMN IF NOT EXISTS tag text, ADD COLUMN IF NOT EXISTS tag_color text DEFAULT 'blue',
 ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS active text NOT NULL DEFAULT 'true',
 ADD COLUMN IF NOT EXISTS is_deleted text NOT NULL DEFAULT 'false', ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
 ADD COLUMN IF NOT EXISTS start_date timestamptz DEFAULT now(), ADD COLUMN IF NOT EXISTS end_date timestamptz, ADD COLUMN IF NOT EXISTS created_by uuid,
 ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE IF NOT EXISTS membership_plans(id uuid PRIMARY KEY DEFAULT gen_random_uuid());
ALTER TABLE membership_plans ALTER COLUMN id SET DEFAULT gen_random_uuid(), ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT '',
 ADD COLUMN IF NOT EXISTS level text NOT NULL DEFAULT 'pro', ADD COLUMN IF NOT EXISTS monthly_price integer NOT NULL DEFAULT 990,
 ADD COLUMN IF NOT EXISTS yearly_price integer NOT NULL DEFAULT 9900, ADD COLUMN IF NOT EXISTS stripe_monthly_price_id text,
 ADD COLUMN IF NOT EXISTS stripe_yearly_price_id text, ADD COLUMN IF NOT EXISTS monthly_credits integer NOT NULL DEFAULT 1500,
 ADD COLUMN IF NOT EXISTS yearly_credits integer NOT NULL DEFAULT 20000, ADD COLUMN IF NOT EXISTS monthly_bonus_credits integer NOT NULL DEFAULT 0,
 ADD COLUMN IF NOT EXISTS package_discount integer NOT NULL DEFAULT 100, ADD COLUMN IF NOT EXISTS features jsonb NOT NULL DEFAULT '[]',
 ADD COLUMN IF NOT EXISTS history_retention_days integer NOT NULL DEFAULT 30, ADD COLUMN IF NOT EXISTS max_context_messages integer NOT NULL DEFAULT 20,
 ADD COLUMN IF NOT EXISTS allow_export text NOT NULL DEFAULT 'false', ADD COLUMN IF NOT EXISTS allow_batch_export text NOT NULL DEFAULT 'false',
 ADD COLUMN IF NOT EXISTS is_active text NOT NULL DEFAULT 'true', ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0,
 ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE IF NOT EXISTS credit_packages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL,price integer NOT NULL,
 credits_amount integer NOT NULL,bonus_credits integer NOT NULL DEFAULT 0,stripe_price_id text,sort_order integer NOT NULL DEFAULT 0,
 is_popular text NOT NULL DEFAULT 'false',active text NOT NULL DEFAULT 'true',created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS user_checkins(
 user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE, checkin_date text NOT NULL, month_key text NOT NULL,
 streak_day integer NOT NULL, reward_credits integer NOT NULL DEFAULT 0, monthly_bonus_credits integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,checkin_date));
ALTER TABLE user_checkins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON user_checkins FROM PUBLIC,anon,authenticated;
GRANT SELECT ON user_checkins TO authenticated;
GRANT ALL ON user_checkins TO service_role;
ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_packages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON announcements,membership_plans,credit_packages FROM PUBLIC,anon,authenticated;
GRANT SELECT ON announcements,membership_plans,credit_packages TO anon,authenticated;
GRANT ALL ON announcements,membership_plans,credit_packages TO service_role;
`);
  sql(authoritativePolicy(checkinPolicies, 'users_own_user_checkins_select', ';'));
  sql(PUBLIC_READ_POLICIES.map((name) => authoritativePolicy(policies, name)).join('\n'));
  // Free and Pro carry no feature list so the profile card falls back to its
  // generated defaults; the homepage row is retired data that must stay unlisted.
  sql(`
INSERT INTO membership_plans(name,level,monthly_price,yearly_price,monthly_credits,yearly_credits,features,allow_export,allow_batch_export,sort_order) VALUES
 ('Synthetic Free','free',0,0,0,0,'[]','false','false',0),
 ('Synthetic Pro','pro',990,9900,1500,20000,'[]','true','false',1),
 ('Synthetic Gold','gold',1990,19900,4000,48000,'["Synthetic gold feature"]','true','true',2);
INSERT INTO credit_packages(name,price,credits_amount,bonus_credits,sort_order) VALUES ('Synthetic 1000 credits',990,1000,100,0);
INSERT INTO announcements(title,content,announcement_type,active) VALUES ('Retired homepage notice','Must not appear in the banner admin list','homepage','true');
NOTIFY pgrst, 'reload schema';
`);
}
