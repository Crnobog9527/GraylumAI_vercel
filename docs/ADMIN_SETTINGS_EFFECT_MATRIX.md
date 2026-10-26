# Admin Settings Effect Matrix

Last reconciled: 2026-09-10

Existing `verified` rows below describe the 2026-04-28 baseline, not a fresh full-platform signoff. [Admin operations](runbooks/ADMIN_OPERATIONS.md) documents the settings save contract and the scoped PR #398–400 evidence.

## Status Legend

- `verified`: Automated proof exists for `admin change -> affected surface changes`
- `partial`: Persistence exists or runtime consumer exists, but no complete effect proof yet
- `gap`: No reliable automated proof yet
- `retired-reference`: Still stored/admin-editable but not treated as production truth

## High-Value Settings

| Setting key | Admin owner page | Runtime / user surface | Expected effect | Existing automated proof | Status |
| --- | --- | --- | --- | --- | --- |
| `primary_model_id`, `assistant_model_id` | `/admin/settings` | `chatRuntime.ts` routing configuration | Select an active `ai_models.id` UUID; empty string clears the override | Real local full-form save/read-back, invalid batch atomicity, 401/403 in `workbench.integration.ts`; downstream provider effect not re-run | `partial` |
| `v3_summary_model_id`, `v3_summary_max_tokens` | `/admin/settings` | Step artifact summarization | Independently eligible model record; output cap 128–4096; unavailable/unconfigured summarizer preserves the original artifact | Local full-form persistence plus existing summary tests; not a fresh deployed provider run | `partial` |
| `site_name` | `/admin/settings` | layout metadata, landing header brand, header/footer/admin sidebar (the landing `<title>` is the fixed home title from SEO_GEO_SPEC 3.3) | Brand/title updates after save | `admin-config.spec.ts` | `verified` |
| `support_email` | `/admin/settings` | landing footer, maintenance page | Support contact changes after save | `admin-config.spec.ts` | `verified` |
| `maintenance_mode` | `/admin/settings` | `/login`, `/maintenance`, admin bypass | Public users redirected; admins remain allowed | `admin-config.spec.ts` | `verified` |
| `chat_show_model_selector` | `/admin/settings` | `/chat` | Model selector show/hide | `admin-config.spec.ts` | `verified` |
| `chat_prompt_text` | `/admin/settings` | `/chat` placeholder | Placeholder updates after save | `admin-config.spec.ts` | `verified` |
| `chat_welcome_message` | `/admin/settings` | `/chat` welcome block | Welcome copy updates after save | `admin-config.spec.ts` | `verified` |
| `home_show_onboarding` | `/admin/settings` | `/` | Onboarding guide show/hide | `admin-config.spec.ts` | `verified` |
| `home_show_featured_modules` | `/admin/settings` | `/` | Featured modules section show/hide | `admin-config.spec.ts` | `verified` |
| `enable_free_tier` | `/admin/settings` | `/chat` send path | Zero-credit user can use daily free quota only when enabled | `admin-config.spec.ts` | `verified` |
| `free_tier_messages` | `/admin/settings` | `/chat` send path | Daily free quota limit changes | `admin-config.spec.ts` | `verified` |
| `max_messages_per_conversation` | `/admin/settings` | `/api/ai/stream`, `/chat` | Conversation send blocked after limit | `admin-config.spec.ts` | `verified` |
| `max_input_characters` | `/admin/settings` | `/chat` textarea | Input length limit updates | `admin-config.spec.ts` | `verified` |
| `enable_long_text_warning` | `/admin/settings` | `/chat` | Long-text confirmation toggles on/off | `admin-config.spec.ts`, `chat.spec.ts` | `verified` |
| `long_text_warning_threshold` | `/admin/settings` | `/chat` | Confirmation threshold changes | `admin-config.spec.ts` | `verified` |
| `show_token_usage_stats` | `/admin/settings` | `/chat` | Token usage panel show/hide | `admin-config.spec.ts` | `verified` |
| `chat_billing_hint` | `/admin/settings` | `/chat` | Billing hint copy updates | `admin-config.spec.ts` | `verified` |
| `billing_credits_per_usd` | `/admin/settings` | BILL2 runtime billing (`services/billingUnit.ts`) | Converts provider USD cost into credits (q) | `billingUnit.test.ts`, `settings.test.ts` | `verified` |
| `billing_token_price_multiplier` | `/admin/settings` | BILL2 runtime billing (`services/billingUnit.ts`) | Site-wide default price multiplier (m); per-model overrides take precedence | `billingUnit.test.ts`, `settings.test.ts` | `verified` |
| `enable_smart_routing` | `/admin/settings` | AI runtime, diagnostics | Routing can be enabled/disabled | `admin.spec.ts`, `chat.spec.ts`, `admin-config.spec.ts` preview effect proof | `verified` |
| `enable_smart_search_decision` | `/admin/settings` | AI runtime | Automatic search decision can be enabled/disabled | `admin-config.spec.ts` preview effect proof via deployed `ai_usage_logs.metadata.webSearchRequested` | `verified` |
| `checkin_day1-5` | `/admin/settings` (tab removed 2026-10-26) | none — daily check-in removed by Owner 2026-10-26; old check-in credit rows still show as granted credits | No effect; no claim path remains in the app | `checkinRemoved.test.ts`, `user-extended.spec.ts` | `retired-reference` |
| `checkin_monthly_bonus` | `/admin/settings` (tab removed 2026-10-26) | none — daily check-in removed by Owner 2026-10-26 | No effect; no claim path remains in the app | `checkinRemoved.test.ts` | `retired-reference` |
| `invite_inviter_reward` | `/admin/settings` (tab removed after #958) | none — invitation rewards retired 2026-10-14 (#988, migration 0266) | No effect; no reward, rebate or claim path remains | `credit-guard-paths.sql` (no invitation RPC, tables read-only) | `retired-reference` |
| `invite_invitee_reward` | `/admin/settings` (tab removed after #958) | none — invitation rewards retired 2026-10-14 (#988, migration 0266) | No effect; no reward, rebate or claim path remains | `credit-guard-paths.sql` (no invitation RPC, tables read-only) | `retired-reference` |
| `invite_rebate_percent` | `/admin/settings` (tab removed after #958) | none — invitation rewards retired 2026-10-14 (#988, migration 0266) | No effect; no reward, rebate or claim path remains | `credit-guard-paths.sql` (no invitation RPC, tables read-only) | `retired-reference` |
| `invite_binding_days` | `/admin/settings` (tab removed after #958) | none — invitation rewards retired 2026-10-14 (#988, migration 0266) | No effect; no reward, rebate or claim path remains | `credit-guard-paths.sql` (no invitation RPC, tables read-only) | `retired-reference` |
| `invite_daily_reward_limit` | `/admin/settings` (tab removed after #958) | none — invitation rewards retired 2026-10-14 (#988, migration 0266) | No effect; no reward, rebate or claim path remains | `credit-guard-paths.sql` (no invitation RPC, tables read-only) | `retired-reference` |
| `invite_monthly_count_limit` | `/admin/settings` (tab removed after #958) | none — invitation rewards retired 2026-10-14 (#988, migration 0266) | No effect; no reward, rebate or claim path remains | `credit-guard-paths.sql` (no invitation RPC, tables read-only) | `retired-reference` |
| `invite_total_reward_limit` | `/admin/settings` (tab removed after #958) | none — invitation rewards retired 2026-10-14 (#988, migration 0266) | No effect; no reward, rebate or claim path remains | `credit-guard-paths.sql` (no invitation RPC, tables read-only) | `retired-reference` |
| `invite_same_ip_hour_limit` | `/admin/settings` (tab removed after #958) | none — invitation rewards retired 2026-10-14 (#988, migration 0266) | No effect; no reward, rebate or claim path remains | `credit-guard-paths.sql` (no invitation RPC, tables read-only) | `retired-reference` |
| `invite_same_ip_day_limit` | `/admin/settings` (tab removed after #958) | none — invitation rewards retired 2026-10-14 (#988, migration 0266) | No effect; no reward, rebate or claim path remains | `credit-guard-paths.sql` (no invitation RPC, tables read-only) | `retired-reference` |
| `invite_risk_auto_reject` | `/admin/settings` (tab removed after #958) | none — invitation rewards retired 2026-10-14 (#988, migration 0266) | No effect; no reward, rebate or claim path remains | `credit-guard-paths.sql` (no invitation RPC, tables read-only) | `retired-reference` |

## Reference / Compatibility Settings

| Setting key | Notes | Status |
| --- | --- | --- |
| `input_credits_per_1k` | UI marks this as reference-only; actual per-model billing lives in model config | `retired-reference` |
| `output_credits_per_1k` | UI marks this as reference-only; actual per-model billing lives in model config | `retired-reference` |
| `web_search_credits` | Reference display only; runtime uses dedicated routing/search cost path | `retired-reference` |
| `first_purchase_bonus_percent` | Historical billing field; current purchase/fulfillment runtime does not consume it | `retired-reference` |

## Billing Runtime Defaults

Runtime billing reads only `billing_credits_per_usd` (q) and `billing_token_price_multiplier` (m) through `services/billingUnit.ts`. A confirmed-missing row falls back to `BILLING_UNIT_DEFAULTS`; a failed read or invalid value refuses new charges (BILL-UNIT #565). The Owner-approved q=100 / m=3 is applied by writing explicit rows, not by changing these defaults:

| Setting key | Fallback when the row is missing |
| --- | --- |
| `billing_credits_per_usd` | `1000` |
| `billing_token_price_multiplier` | `1.5` |

The legacy pre-deduct service (`services/billing.ts`) and its settings `billing_min_pre_deduct`, `billing_max_pre_deduct`, `billing_safety_margin` and `billing_require_model_pricing` were removed by LEGACY-CLOSE PR-A; nothing reads them. Leftover rows in `system_settings` have no effect. See [LEGACY_CLOSE_CLEANUP_PLAN.md](launch/implementation/LEGACY_CLOSE_CLEANUP_PLAN.md).

## Completion Rule

No setting may be marked complete unless:

1. The admin UI can save it.
2. The persisted value can be re-read.
3. The intended downstream surface changes in the same acceptance flow.
4. If the setting affects security, billing, or destructive behavior, the effect is asserted through the actual runtime path.

## Evidence Boundary

The earlier non-payment closure claim applies only to its dated acceptance scope. New model-selection rows remain `partial` until their downstream effect is proven for the relevant candidate. Stripe readiness and production approval are separate; this matrix does not establish either.

Model settings store database record IDs, not provider names such as `openai/gpt-5.6-luna`. Routing model options expose only `id`, `name`, and `model_id`. Invalid, removed, or inactive routing selections reject the batch before upsert; summary-model eligibility has its own validation. A concurrent foreign-key conflict is returned as a safe `BAD_REQUEST`.

## Latest Local Regression

The 2026-04-24 historical cleanup pass re-ran the local Chromium admin settings suite after stabilizing `/admin/settings` loading, bulk saves, maintenance-mode redirects, chat runtime assertions, package CRUD, and prompt CRUD.

- `pnpm --dir apps/web test:e2e admin-config.spec.ts --project=chromium`: `10 passed / 2 skipped`
- The skipped cases remain environment-gated preview runtime proofs for smart routing and smart search, not local settings persistence gaps.
- `maintenance_mode` is covered by direct `/maintenance` access, public redirect behavior, and admin bypass behavior in `admin-config.spec.ts`.
