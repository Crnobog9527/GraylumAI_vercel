/*
 * AUTH-1: make the persisted profile default match the server-side opening
 * grant contract. New profiles start at zero and receive the one-time grant
 * only after the service-role ledger RPC succeeds.
 *
 * This migration is expand-only and does not rewrite existing balances.
 */

ALTER TABLE public.profiles
  ALTER COLUMN credits SET DEFAULT 0;
