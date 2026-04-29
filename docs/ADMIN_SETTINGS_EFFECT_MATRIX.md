# Admin Settings Effect Matrix

Last updated: 2026-04-28

## Status Legend

- `verified`: Automated proof exists for `admin change -> affected surface changes`
- `partial`: Persistence exists or runtime consumer exists, but no complete effect proof yet
- `gap`: No reliable automated proof yet
- `retired-reference`: Still stored/admin-editable but not treated as production truth

## High-Value Settings

| Setting key | Admin owner page | Runtime / user surface | Expected effect | Existing automated proof | Status |
| --- | --- | --- | --- | --- | --- |
| `site_name` | `/admin/settings` | landing title, layout metadata, header/footer/admin sidebar | Brand/title updates after save | `admin-config.spec.ts` | `verified` |
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
| `billing_credits_per_usd` | `/admin/settings` | AI chat billing runtime | Converts provider USD cost into credits for pre-deduct and settlement | `billing.test.ts`, `ai.test.ts` | `verified` |
| `billing_token_price_multiplier` | `/admin/settings` | AI chat billing runtime | Applies runtime multiplier to token/search cost for pre-deduct and settlement | `billing.test.ts`, `ai.test.ts` | `verified` |
| `billing_min_pre_deduct` | `/admin/settings` | AI chat billing runtime | Sets the minimum AI request pre-deduct amount | `billing.test.ts`, `ai.test.ts` | `verified` |
| `billing_max_pre_deduct` | `/admin/settings` | AI chat billing runtime | Caps the maximum AI request pre-deduct amount | `billing.test.ts`, `ai.test.ts` | `verified` |
| `billing_safety_margin` | `/admin/settings` | AI chat billing runtime | Adds a safety margin to estimated AI request pre-deducts | `billing.test.ts`, `ai.test.ts` | `verified` |
| `billing_require_model_pricing` | `/admin/settings` | AI chat billing runtime | Rejects AI requests before pre-deduct when model pricing is missing or input/output price is zero | `billing.test.ts`, `ai.test.ts` | `verified` |
| `enable_smart_routing` | `/admin/settings` | AI runtime, diagnostics | Routing can be enabled/disabled | `admin.spec.ts`, `chat.spec.ts`, `admin-config.spec.ts` preview effect proof | `verified` |
| `enable_smart_search_decision` | `/admin/settings` | AI runtime | Automatic search decision can be enabled/disabled | `admin-config.spec.ts` preview effect proof via deployed `ai_usage_logs.metadata.webSearchRequested` | `verified` |
| `checkin_day1-5` | `/admin/settings` | profile check-in dialog, claim result | Reward ladder changes | `admin-config.spec.ts`, `user-extended.spec.ts` | `verified` |
| `checkin_monthly_bonus` | `/admin/settings` | profile check-in dialog/result | Monthly bonus amount changes | `admin-config.spec.ts`, `user-extended.spec.ts` | `verified` |
| `invite_inviter_reward` | `/admin/settings` | profile invite dialog, invite claim result | Inviter reward amount changes | `admin-config.spec.ts`, `user-supplemental.spec.ts` | `verified` |
| `invite_invitee_reward` | `/admin/settings` | signup success + invite dialog | Invitee reward amount changes | `admin-config.spec.ts`, `user-supplemental.spec.ts` | `verified` |
| `invite_rebate_percent` | `/admin/settings` | billing rebate path | Invite rebate changes | `invitationRebate.test.ts`, `admin-config.spec.ts` | `verified` |
| `invite_binding_days` | `/admin/settings` | billing rebate path | Rebate binding window changes | `invitationRebate.test.ts`, `admin-config.spec.ts` | `verified` |
| `invite_daily_reward_limit` | `/admin/settings` | invite claim path | Daily cap changes | `invitationRuntime.ts`, `invitationRebate.test.ts` | `verified` |
| `invite_monthly_count_limit` | `/admin/settings` | invite claim path | Monthly cap changes | `invitationRuntime.ts`, `invitationRebate.test.ts` | `verified` |
| `invite_total_reward_limit` | `/admin/settings` | invite claim path | Lifetime cap changes | `invitationRuntime.ts`, `invitationRebate.test.ts` | `verified` |
| `invite_same_ip_hour_limit` | `/admin/settings` | signup/invite claim path | Hourly same-IP cap changes | `invitationRuntime.ts`, `invitationRebate.test.ts` | `verified` |
| `invite_same_ip_day_limit` | `/admin/settings` | signup/invite claim path | Daily same-IP cap changes | `invitationRuntime.ts`, `invitationRebate.test.ts` | `verified` |
| `invite_risk_auto_reject` | `/admin/settings` | invite claim path | High-risk invite auto-reject behavior changes | `invitationRuntime.ts`, `invitationRebate.test.ts` | `verified` |

## Reference / Compatibility Settings

| Setting key | Notes | Status |
| --- | --- | --- |
| `input_credits_per_1k` | UI marks this as reference-only; actual per-model billing lives in model config | `retired-reference` |
| `output_credits_per_1k` | UI marks this as reference-only; actual per-model billing lives in model config | `retired-reference` |
| `web_search_credits` | Reference display only; runtime uses dedicated routing/search cost path | `retired-reference` |
| `first_purchase_bonus_percent` | Historical billing field; current purchase/fulfillment runtime does not consume it | `retired-reference` |

## Billing Runtime Defaults

The PR 2A billing runtime settings affect the AI chat main path for both pre-deduct and final settlement. PR 2B extends the same dynamic `ai_models` pricing + billing runtime settings path to `settleAbort`, so interrupted stream settlement no longer uses legacy hardcoded model prices. Missing or invalid values fall back to safe defaults:

| Setting key | Safe default |
| --- | --- |
| `billing_credits_per_usd` | `1000` |
| `billing_token_price_multiplier` | `1.5` |
| `billing_min_pre_deduct` | `10` |
| `billing_max_pre_deduct` | `10000` |
| `billing_safety_margin` | `0.2` |
| `billing_require_model_pricing` | `true` |

When `billing_require_model_pricing=true`, missing model pricing or zero input/output model pricing rejects the AI request before pre-deduct, so no credits are charged. The same missing/zero-price guard now applies before `settleAbort` calls `atomic_abort_settle`, so an interrupted request cannot silently settle against `MODEL_PRICING`.

`MODEL_PRICING`, `calculateTokenCost`, `estimateRequestCost`, and `costCalculator.ts` remain in code as legacy / explicit fallback / test-only estimator paths. They must not be used as the default production billing path.

Remaining PR 2B debt: `atomic_abort_settle` does not accept arbitrary metadata, so `billing_history.abort_settle.metadata` cannot yet persist a pricing snapshot through the RPC path without a future migration. The TypeScript fallback path and abort usage log can carry the pricing/settings snapshot, but RPC-level abort-settle metadata remains a follow-up item.

## Completion Rule

No setting may be marked complete unless:

1. The admin UI can save it.
2. The persisted value can be re-read.
3. The intended downstream surface changes in the same acceptance flow.
4. If the setting affects security, billing, or destructive behavior, the effect is asserted through the actual runtime path.

## Non-Payment Closure Note

All non-payment settings are now either:

- `verified` with automated or runtime proof, or
- `retired-reference` because they are no longer treated as production truth.

The only intentionally excluded unfinished area is Stripe enablement and the external credentials / `price_xxx` values it still requires.

Preview-only runtime acceptance for `enable_smart_routing` and `enable_smart_search_decision` is now closed on the locked Vercel preview through deployed runtime probes rather than local persistence-only checks.

## Latest Local Regression

The 2026-04-24 historical cleanup pass re-ran the local Chromium admin settings suite after stabilizing `/admin/settings` loading, bulk saves, maintenance-mode redirects, chat runtime assertions, package CRUD, and prompt CRUD.

- `pnpm --dir apps/web test:e2e admin-config.spec.ts --project=chromium`: `10 passed / 2 skipped`
- The skipped cases remain environment-gated preview runtime proofs for smart routing and smart search, not local settings persistence gaps.
- `maintenance_mode` is covered by direct `/maintenance` access, public redirect behavior, and admin bypass behavior in `admin-config.spec.ts`.
