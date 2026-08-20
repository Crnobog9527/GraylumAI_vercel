# SEC-1 RPC Classification Evidence

This candidate records the repository-side classification used by migration
`0050_sec1_privileged_rpc_execute_posture_closure.sql`. It is a bounded,
repository-only evidence artifact for Issue #342 / `SEC-1-ISSUE-342-C5`.

## Authority and root cause carried forward

- Source gate: Issue #342 comment `5354056021`.
- Continuation gate: Issue #342 comment `5355216950`.
- Accepted C4 production evidence: 29 public `SECURITY DEFINER` functions,
  production ACL drift confirmed after hardening, and no verified current
  signature-mismatch root cause.
- Exact historical ACL writer: unresolved; this candidate therefore performs
  forward-only convergence using complete `regprocedure` identities.
- No Supabase or production read is performed by this candidate.

## Exact-signature classification

The accepted C4 production inventory and the repository lineage reconcile to
the following complete identities. `UNKNOWN=0`.

| Exact `regprocedure` | Class | Target EXECUTE posture |
| --- | --- | --- |
| `public.atomic_abort_settle(uuid,uuid,integer,jsonb,text,text)` | SERVICE_ROLE_ONLY | service_role |
| `public.atomic_apply_credit_ledger_entry(uuid,integer,text,text,text)` | SERVICE_ROLE_ONLY | service_role |
| `public.atomic_apply_invitation_rebate(uuid,integer,text,integer,integer,integer,timestamp with time zone,timestamp with time zone,text)` | SERVICE_ROLE_ONLY | service_role |
| `public.atomic_claim_invitation_code(text,uuid,text,text,text,text,integer,integer,text,text)` | SERVICE_ROLE_ONLY | service_role |
| `public.atomic_downgrade_canceled_subscription_profile(text)` | SERVICE_ROLE_ONLY | service_role |
| `public.atomic_finalize_ai_abort(uuid,uuid,text,text,text,numeric,integer,uuid,jsonb,jsonb,jsonb,text,integer,integer,integer,text,text)` | SERVICE_ROLE_ONLY | service_role |
| `public.atomic_finalize_ai_failure(uuid,text,text,uuid,uuid,text,integer,integer,text,text,jsonb)` | SERVICE_ROLE_ONLY | service_role |
| `public.atomic_finalize_ai_success(uuid,uuid,text,text,text,numeric,integer,uuid,jsonb,jsonb,jsonb,text,integer,integer,integer,text,text)` | SERVICE_ROLE_ONLY | service_role |
| `public.atomic_fulfill_credit_package(text,text)` | SERVICE_ROLE_ONLY | service_role |
| `public.atomic_fulfill_membership_invoice(text,text,integer,text,text,text,timestamp with time zone,timestamp with time zone)` | SERVICE_ROLE_ONLY | service_role |
| `public.atomic_pre_deduct(uuid,integer,text,uuid)` | SERVICE_ROLE_ONLY | service_role |
| `public.atomic_reconcile_stripe_refund(uuid,text,text,text,text,integer,text,text,text,text,text,text,timestamp with time zone,boolean,boolean)` | SERVICE_ROLE_ONLY | service_role |
| `public.atomic_refund(uuid,uuid,text)` | SERVICE_ROLE_ONLY | service_role |
| `public.atomic_settle(uuid,uuid,integer,jsonb,jsonb)` | SERVICE_ROLE_ONLY | service_role |
| `public.auto_close_stale_tickets(integer)` | SERVICE_ROLE_ONLY | service_role |
| `public.claim_daily_checkin(uuid)` | AUTHENTICATED_SELF_GUARDED | authenticated, service_role |
| `public.cleanup_old_diagnostic_results(integer)` | SERVICE_ROLE_ONLY | service_role |
| `public.cleanup_old_logs()` | SERVICE_ROLE_ONLY | service_role |
| `public.deduct_credits_atomic(uuid,integer,text,text,text,text)` | SERVICE_ROLE_ONLY | service_role |
| `public.get_diagnostic_summary(integer)` | SERVICE_ROLE_ONLY | service_role |
| `public.get_error_summary(integer)` | SERVICE_ROLE_ONLY | service_role |
| `public.get_log_stats(timestamp with time zone,timestamp with time zone)` | SERVICE_ROLE_ONLY | service_role |
| `public.get_test_history(text,integer)` | SERVICE_ROLE_ONLY | service_role |
| `public.get_user_credits(uuid)` | SERVICE_ROLE_ONLY | service_role |
| `public.is_admin()` | RLS_HELPER | service_role only; no direct client execute |
| `public.purge_deleted_records(integer)` | SERVICE_ROLE_ONLY | service_role |
| `public.soft_delete_conversation(uuid,uuid)` | AUTHENTICATED_SELF_GUARDED | authenticated only |
| `public.soft_delete_ticket(uuid,uuid)` | SERVICE_ROLE_ONLY | service_role |
| `public.validate_invitation_code(text)` | PUBLIC_INTENDED | anon, authenticated, service_role |

No `OBSOLETE` identity is silently dropped. `rls_auto_enable()` and
`ensure_rls` are the separately accepted C4 infrastructure boundary and are
not application RPC identities in this candidate.

## Convergence and caller alignment

- Migration `0050` sets `search_path = public, pg_temp` and re-converges exact
  ACLs only when the exact function identity exists.
- Every `atomic_*` overload listed here, every `cleanup_*` overload listed
  here, and `purge_deleted_records(integer)` are denied to `PUBLIC`, `anon`,
  and `authenticated`.
- `soft_delete_conversation(uuid,uuid)` is the only business body change. It
  fails closed when `auth.uid()` is null or differs from `p_user_id`, then
  preserves ownership checking, conversation soft delete, related-message
  soft delete, and the boolean return contract.
- `rls_auto_enable()` / `ensure_rls` receive no ACL, search-path, execution,
  drop, replace, or body mutation.
- Diagnostics now receive the existing `ctx.supabaseAdmin` client. Only the
  five C5-identified privileged RPC calls use it:
  `atomic_pre_deduct`, `atomic_refund`, `get_diagnostic_summary`,
  `get_test_history`, and `cleanup_old_diagnostic_results`.
- Ordinary diagnostics table reads and RLS/user-scoped checks remain on
  `ctx.supabase`.

## Validation boundary

This artifact does not assert staging or production parity. Migration `0050`
is not applied by candidate generation; no SQL, database access, deployment,
mark-ready, review, or merge is authorized by this candidate.
