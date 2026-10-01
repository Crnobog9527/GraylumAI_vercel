-- Only synthetic local fixtures; run against the disposable empty replay database.
INSERT INTO public.membership_plans (id, name, level, monthly_price, monthly_credits, allow_export) VALUES
('00000000-0000-4000-8000-00000000e011', 'ENTITLEMENTS free', 'free', 0, 100, 'false'),
('00000000-0000-4000-8000-00000000e012', 'ENTITLEMENTS pro', 'pro', 990, 200, 'true'),
('00000000-0000-4000-8000-00000000e013', 'ENTITLEMENTS gold', 'gold', 1990, 300, 'true');
INSERT INTO public.profiles (id, role, status, is_deleted) VALUES
('00000000-0000-4000-8000-00000000e001', 'user', 'active', 'false');

INSERT INTO public.system_settings (key, value) VALUES
('entitlements_private_fixture', '"private test value"'::jsonb),
('site_name', '"public test value"'::jsonb)
ON CONFLICT (key) DO NOTHING;
