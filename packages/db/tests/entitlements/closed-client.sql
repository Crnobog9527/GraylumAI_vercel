-- Fresh disposable session; fixture closure does not call any provider or touch external state.
UPDATE public.profiles SET status = 'deleted', is_deleted = 'true' WHERE id = '00000000-0000-4000-8000-00000000e001';
INSERT INTO public.account_erasure_requests (profile_id, request_id) VALUES
('00000000-0000-4000-8000-00000000e001', '00000000-0000-4000-8000-00000000e099');
SET ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000e001","role":"authenticated"}',false);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.membership_plans) THEN RAISE EXCEPTION 'closed account read accepted'; END IF;
  BEGIN
    UPDATE public.membership_plans SET allow_fusion_review = true WHERE level = 'free';
    RAISE EXCEPTION 'closed account write accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
