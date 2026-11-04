BEGIN;

-- MEMBER-ONLY-MODULES (Owner 2026-11-04): a Skill limited to members is shown in the marketplace with a note, and a free user who
-- tries to use it meets the paywall (the dialog's `coach` scene). `modules.required_member_level` is the lowest membership level that
-- may use the module: NULL means everyone (the default, so every existing module is unchanged), 'pro' means Pro and Gold, 'gold'
-- means Gold only. The values are the entitlement level names (membershipLevelSchema: free, pro, gold); 'free' is not a value
-- because "everyone" is NULL. The column is public to read (the marketplace shows the note to everyone, signed in or not);
-- writing stays with the admin routes and the service role.
--
-- Repeatable: every statement is IF NOT EXISTS / guarded. Recovery: the column holds display and gating metadata only, so a
-- rollback is `ALTER TABLE public.modules DROP COLUMN IF EXISTS required_member_level;` after the code that reads it is rolled
-- back (code that finds no column reads a module as open to everyone only if the select is also rolled back).

ALTER TABLE public.modules ADD COLUMN IF NOT EXISTS required_member_level text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'public.modules'::regclass AND conname = 'modules_required_member_level_check'
  ) THEN
    ALTER TABLE public.modules ADD CONSTRAINT modules_required_member_level_check
      CHECK (required_member_level IS NULL OR required_member_level IN ('pro', 'gold'));
  END IF;
END $$;

GRANT SELECT (required_member_level) ON TABLE public.modules TO anon, authenticated;

COMMIT;
