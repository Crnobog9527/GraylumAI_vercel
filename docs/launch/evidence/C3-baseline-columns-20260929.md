# C3 基线列候选（2026-09-29）

基线 `6a370bc5198fe2cc779d3a83d898fd149bee2069`。主结论与本机失败见 [主文档](C3-db-inventory-20260929.md)。

范围：16个没有迁移CREATE的表，其schema声明列逐一列出。`无迁移列定义` 指未发现对应表的 CREATE/ADD；证据为schema声明行及主文档中的迁移引用。`已有ADD` 列属于后续迁移，列在这里防止误算缺失；不建议重复放进0000。

这不是可执行DDL，也不是精确历史初始类型的重建。类型/默认值/约束须结合迁移顺序核实；当前text布尔镜像与早期策略已被本机证明不兼容。迁移中已定义但不在schema里的其他列不属本表遗漏。所有线上状态未核实。

## profiles

| 列 | schema声明证据 | 迁移列定义 |
| --- | --- | --- |
| `id` | `packages/db/schema.ts:7` | 无迁移列定义 |
| `email` | `packages/db/schema.ts:8` | 无迁移列定义 |
| `nickname` | `packages/db/schema.ts:9` | 无迁移列定义 |
| `avatar_url` | `packages/db/schema.ts:10` | 无迁移列定义 |
| `role` | `packages/db/schema.ts:11` | 无迁移列定义 |
| `status` | `packages/db/schema.ts:12` | 无迁移列定义 |
| `membership_level` | `packages/db/schema.ts:13` | 无迁移列定义 |
| `credits` | `packages/db/schema.ts:14` | 无迁移列定义 |
| `last_login_at` | `packages/db/schema.ts:15` | 无迁移列定义 |
| `last_ip` | `packages/db/schema.ts:16` | 无迁移列定义 |
| `is_deleted` | `packages/db/schema.ts:17` | 已有ADD：`packages/db/migrations/0004_recursive_summary_and_soft_delete.sql:24` |
| `deleted_at` | `packages/db/schema.ts:18` | 已有ADD：`packages/db/migrations/0004_recursive_summary_and_soft_delete.sql:27` |
| `created_at` | `packages/db/schema.ts:19` | 无迁移列定义 |

## conversations

| 列 | schema声明证据 | 迁移列定义 |
| --- | --- | --- |
| `id` | `packages/db/schema.ts:23` | 无迁移列定义 |
| `user_id` | `packages/db/schema.ts:24` | 无迁移列定义 |
| `title` | `packages/db/schema.ts:25` | 无迁移列定义 |
| `model_id` | `packages/db/schema.ts:26` | 无迁移列定义 |
| `skill_mode` | `packages/db/schema.ts:27` | 已有ADD：`packages/db/migrations/0069_v3_chat_skill.sql:4` |
| `agent_slice_mode` | `packages/db/schema.ts:28` | 已有ADD：`packages/db/migrations/0091_agent_slice_entry.sql:3` |
| `module_id` | `packages/db/schema.ts:29` | 已有ADD：`packages/db/migrations/0069_v3_chat_skill.sql:5` |
| `summary` | `packages/db/schema.ts:30` | 无迁移列定义 |
| `summary_tokens` | `packages/db/schema.ts:31` | 无迁移列定义 |
| `summary_updated_at` | `packages/db/schema.ts:32` | 无迁移列定义 |
| `summary_metadata` | `packages/db/schema.ts:33` | 已有ADD：`packages/db/migrations/0004_recursive_summary_and_soft_delete.sql:11` |
| `is_deleted` | `packages/db/schema.ts:34` | 已有ADD：`packages/db/migrations/0004_recursive_summary_and_soft_delete.sql:31` |
| `deleted_at` | `packages/db/schema.ts:35` | 已有ADD：`packages/db/migrations/0004_recursive_summary_and_soft_delete.sql:34` |
| `created_at` | `packages/db/schema.ts:36` | 无迁移列定义 |

## messages

| 列 | schema声明证据 | 迁移列定义 |
| --- | --- | --- |
| `id` | `packages/db/schema.ts:40` | 无迁移列定义 |
| `conversation_id` | `packages/db/schema.ts:41` | 无迁移列定义 |
| `role` | `packages/db/schema.ts:42` | 无迁移列定义 |
| `content` | `packages/db/schema.ts:43` | 无迁移列定义 |
| `is_deleted` | `packages/db/schema.ts:44` | 已有ADD：`packages/db/migrations/0004_recursive_summary_and_soft_delete.sql:38` |
| `deleted_at` | `packages/db/schema.ts:45` | 已有ADD：`packages/db/migrations/0004_recursive_summary_and_soft_delete.sql:41` |
| `created_at` | `packages/db/schema.ts:46` | 无迁移列定义 |

## credit_transactions

| 列 | schema声明证据 | 迁移列定义 |
| --- | --- | --- |
| `bill2_run_id` | `packages/db/schema.ts:50` | 已有ADD：`packages/db/migrations/0105_v3_bill2_authoritative_runs.sql:45` |
| `id` | `packages/db/schema.ts:51` | 无迁移列定义 |
| `user_id` | `packages/db/schema.ts:52` | 无迁移列定义 |
| `amount` | `packages/db/schema.ts:53` | 无迁移列定义 |
| `type` | `packages/db/schema.ts:54` | 无迁移列定义 |
| `ledger_type` | `packages/db/schema.ts:55` | 已有ADD：`packages/db/migrations/0044_credit_transactions_v2_semantics.sql:14` |
| `reason_code` | `packages/db/schema.ts:56` | 已有ADD：`packages/db/migrations/0044_credit_transactions_v2_semantics.sql:15` |
| `counts_as_spend` | `packages/db/schema.ts:57` | 已有ADD：`packages/db/migrations/0044_credit_transactions_v2_semantics.sql:16` |
| `source_type` | `packages/db/schema.ts:58` | 已有ADD：`packages/db/migrations/0044_credit_transactions_v2_semantics.sql:17` |
| `source_id` | `packages/db/schema.ts:59` | 已有ADD：`packages/db/migrations/0044_credit_transactions_v2_semantics.sql:18` |
| `source_order_id` | `packages/db/schema.ts:60` | 已有ADD：`packages/db/migrations/0044_credit_transactions_v2_semantics.sql:19` |
| `source_refund_id` | `packages/db/schema.ts:61` | 已有ADD：`packages/db/migrations/0044_credit_transactions_v2_semantics.sql:20` |
| `grant_period_key` | `packages/db/schema.ts:62` | 已有ADD：`packages/db/migrations/0044_credit_transactions_v2_semantics.sql:21` |
| `description` | `packages/db/schema.ts:63` | 无迁移列定义 |
| `idempotency_key` | `packages/db/schema.ts:64` | 已有ADD：`packages/db/migrations/0018_payment_fulfillment_atomicity.sql:5` |
| `balance_before` | `packages/db/schema.ts:65` | 已有ADD：`packages/db/migrations/0024_atomic_apply_credit_ledger_entry.sql:5` |
| `balance_after` | `packages/db/schema.ts:66` | 已有ADD：`packages/db/migrations/0024_atomic_apply_credit_ledger_entry.sql:6` |
| `metadata` | `packages/db/schema.ts:67` | 已有ADD：`packages/db/migrations/0044_credit_transactions_v2_semantics.sql:22` |
| `created_at` | `packages/db/schema.ts:68` | 无迁移列定义 |

## ai_models

| 列 | schema声明证据 | 迁移列定义 |
| --- | --- | --- |
| `id` | `packages/db/schema.ts:77` | 无迁移列定义 |
| `name` | `packages/db/schema.ts:78` | 无迁移列定义 |
| `model_id` | `packages/db/schema.ts:79` | 无迁移列定义 |
| `provider` | `packages/db/schema.ts:80` | 无迁移列定义 |
| `api_key` | `packages/db/schema.ts:81` | 无迁移列定义 |
| `api_endpoint` | `packages/db/schema.ts:82` | 无迁移列定义 |
| `description` | `packages/db/schema.ts:83` | 无迁移列定义 |
| `max_tokens` | `packages/db/schema.ts:84` | 无迁移列定义 |
| `input_limit` | `packages/db/schema.ts:85` | 无迁移列定义 |
| `enable_web_search` | `packages/db/schema.ts:86` | 无迁移列定义 |
| `input_token_cost` | `packages/db/schema.ts:87` | 无迁移列定义 |
| `output_token_cost` | `packages/db/schema.ts:88` | 无迁移列定义 |
| `input_token_cost_above_200k` | `packages/db/schema.ts:89` | 无迁移列定义 |
| `output_token_cost_above_200k` | `packages/db/schema.ts:90` | 无迁移列定义 |
| `web_search_cost` | `packages/db/schema.ts:91` | 无迁移列定义 |
| `token_counting_supported` | `packages/db/schema.ts:92` | 已有ADD：`packages/db/migrations/0014_ai_runtime_closure.sql:18` |
| `token_counting_method` | `packages/db/schema.ts:93` | 已有ADD：`packages/db/migrations/0014_ai_runtime_closure.sql:19` |
| `tokenizer_family` | `packages/db/schema.ts:96` | 已有ADD：`packages/db/migrations/0014_ai_runtime_closure.sql:20` |
| `is_active` | `packages/db/schema.ts:97` | 无迁移列定义 |
| `config` | `packages/db/schema.ts:98` | 无迁移列定义 |
| `created_at` | `packages/db/schema.ts:99` | 无迁移列定义 |
| `updated_at` | `packages/db/schema.ts:100` | 无迁移列定义 |

## system_settings

| 列 | schema声明证据 | 迁移列定义 |
| --- | --- | --- |
| `key` | `packages/db/schema.ts:104` | 无迁移列定义 |
| `value` | `packages/db/schema.ts:105` | 无迁移列定义 |

## tickets

| 列 | schema声明证据 | 迁移列定义 |
| --- | --- | --- |
| `id` | `packages/db/schema.ts:111` | 无迁移列定义 |
| `user_id` | `packages/db/schema.ts:112` | 无迁移列定义 |
| `title` | `packages/db/schema.ts:113` | 无迁移列定义 |
| `description` | `packages/db/schema.ts:114` | 无迁移列定义 |
| `category` | `packages/db/schema.ts:115` | 无迁移列定义 |
| `priority` | `packages/db/schema.ts:116` | 无迁移列定义 |
| `attachments` | `packages/db/schema.ts:117` | 无迁移列定义 |
| `status` | `packages/db/schema.ts:118` | 无迁移列定义 |
| `is_deleted` | `packages/db/schema.ts:119` | 已有ADD：`packages/db/migrations/0004_recursive_summary_and_soft_delete.sql:45` |
| `deleted_at` | `packages/db/schema.ts:120` | 已有ADD：`packages/db/migrations/0004_recursive_summary_and_soft_delete.sql:48` |
| `created_at` | `packages/db/schema.ts:121` | 无迁移列定义 |
| `updated_at` | `packages/db/schema.ts:122` | 无迁移列定义 |

## ticket_replies

| 列 | schema声明证据 | 迁移列定义 |
| --- | --- | --- |
| `id` | `packages/db/schema.ts:126` | 无迁移列定义 |
| `ticket_id` | `packages/db/schema.ts:127` | 无迁移列定义 |
| `user_id` | `packages/db/schema.ts:128` | 无迁移列定义 |
| `content` | `packages/db/schema.ts:129` | 无迁移列定义 |
| `is_admin` | `packages/db/schema.ts:130` | 无迁移列定义 |
| `attachments` | `packages/db/schema.ts:131` | 无迁移列定义 |
| `is_deleted` | `packages/db/schema.ts:132` | 已有ADD：`packages/db/migrations/0004_recursive_summary_and_soft_delete.sql:52` |
| `deleted_at` | `packages/db/schema.ts:133` | 已有ADD：`packages/db/migrations/0004_recursive_summary_and_soft_delete.sql:55` |
| `created_at` | `packages/db/schema.ts:134` | 无迁移列定义 |

## credit_packages

| 列 | schema声明证据 | 迁移列定义 |
| --- | --- | --- |
| `id` | `packages/db/schema.ts:138` | 无迁移列定义 |
| `name` | `packages/db/schema.ts:139` | 无迁移列定义 |
| `price` | `packages/db/schema.ts:140` | 无迁移列定义 |
| `credits_amount` | `packages/db/schema.ts:141` | 无迁移列定义 |
| `bonus_credits` | `packages/db/schema.ts:142` | 无迁移列定义 |
| `stripe_price_id` | `packages/db/schema.ts:143` | 已有ADD：`packages/db/migrations/0012_stripe_payments.sql:5` |
| `sort_order` | `packages/db/schema.ts:144` | 无迁移列定义 |
| `is_popular` | `packages/db/schema.ts:145` | 无迁移列定义 |
| `active` | `packages/db/schema.ts:146` | 无迁移列定义 |
| `created_at` | `packages/db/schema.ts:147` | 无迁移列定义 |

## invitations

| 列 | schema声明证据 | 迁移列定义 |
| --- | --- | --- |
| `code` | `packages/db/schema.ts:151` | 无迁移列定义 |
| `created_by` | `packages/db/schema.ts:152` | 无迁移列定义 |
| `used_by` | `packages/db/schema.ts:153` | 无迁移列定义 |
| `status` | `packages/db/schema.ts:154` | 无迁移列定义 |
| `created_at` | `packages/db/schema.ts:155` | 无迁移列定义 |

## user_activity_logs

| 列 | schema声明证据 | 迁移列定义 |
| --- | --- | --- |
| `id` | `packages/db/schema.ts:159` | 无迁移列定义 |
| `user_id` | `packages/db/schema.ts:160` | 无迁移列定义 |
| `admin_id` | `packages/db/schema.ts:161` | 无迁移列定义 |
| `action` | `packages/db/schema.ts:162` | 无迁移列定义 |
| `action_type` | `packages/db/schema.ts:163` | 无迁移列定义 |
| `details` | `packages/db/schema.ts:164` | 无迁移列定义 |
| `ip_address` | `packages/db/schema.ts:165` | 无迁移列定义 |
| `created_at` | `packages/db/schema.ts:166` | 无迁移列定义 |

## announcements

| 列 | schema声明证据 | 迁移列定义 |
| --- | --- | --- |
| `id` | `packages/db/schema.ts:182` | 无迁移列定义 |
| `title` | `packages/db/schema.ts:183` | 无迁移列定义 |
| `content` | `packages/db/schema.ts:184` | 无迁移列定义 |
| `type` | `packages/db/schema.ts:185` | 无迁移列定义 |
| `announcement_type` | `packages/db/schema.ts:186` | 无迁移列定义 |
| `banner_style` | `packages/db/schema.ts:187` | 无迁移列定义 |
| `banner_link` | `packages/db/schema.ts:188` | 无迁移列定义 |
| `icon` | `packages/db/schema.ts:189` | 无迁移列定义 |
| `icon_color` | `packages/db/schema.ts:190` | 无迁移列定义 |
| `tag` | `packages/db/schema.ts:191` | 无迁移列定义 |
| `tag_color` | `packages/db/schema.ts:192` | 无迁移列定义 |
| `priority` | `packages/db/schema.ts:193` | 无迁移列定义 |
| `active` | `packages/db/schema.ts:194` | 无迁移列定义 |
| `is_deleted` | `packages/db/schema.ts:195` | 已有ADD：`packages/db/migrations/0004_recursive_summary_and_soft_delete.sql:66` |
| `deleted_at` | `packages/db/schema.ts:196` | 已有ADD：`packages/db/migrations/0004_recursive_summary_and_soft_delete.sql:69` |
| `start_date` | `packages/db/schema.ts:197` | 无迁移列定义 |
| `end_date` | `packages/db/schema.ts:198` | 无迁移列定义 |
| `created_by` | `packages/db/schema.ts:199` | 无迁移列定义 |
| `created_at` | `packages/db/schema.ts:200` | 无迁移列定义 |
| `updated_at` | `packages/db/schema.ts:201` | 无迁移列定义 |

## prompts

| 列 | schema声明证据 | 迁移列定义 |
| --- | --- | --- |
| `id` | `packages/db/schema.ts:205` | 无迁移列定义 |
| `name` | `packages/db/schema.ts:206` | 无迁移列定义 |
| `description` | `packages/db/schema.ts:207` | 无迁移列定义 |
| `content` | `packages/db/schema.ts:208` | 无迁移列定义 |
| `system_prompt` | `packages/db/schema.ts:210` | 无迁移列定义 |
| `user_prompt_template` | `packages/db/schema.ts:211` | 无迁移列定义 |
| `model_id` | `packages/db/schema.ts:212` | 无迁移列定义 |
| `platform` | `packages/db/schema.ts:213` | 无迁移列定义 |
| `features` | `packages/db/schema.ts:214` | 无迁移列定义 |
| `user_questions` | `packages/db/schema.ts:215` | 无迁移列定义 |
| `icon` | `packages/db/schema.ts:216` | 无迁移列定义 |
| `category` | `packages/db/schema.ts:218` | 无迁移列定义 |
| `is_system` | `packages/db/schema.ts:219` | 无迁移列定义 |
| `active` | `packages/db/schema.ts:220` | 无迁移列定义 |
| `sort_order` | `packages/db/schema.ts:221` | 无迁移列定义 |
| `is_deleted` | `packages/db/schema.ts:222` | 已有ADD：`packages/db/migrations/0004_recursive_summary_and_soft_delete.sql:59` |
| `deleted_at` | `packages/db/schema.ts:223` | 已有ADD：`packages/db/migrations/0004_recursive_summary_and_soft_delete.sql:62` |
| `created_by` | `packages/db/schema.ts:224` | 无迁移列定义 |
| `created_at` | `packages/db/schema.ts:225` | 无迁移列定义 |
| `updated_at` | `packages/db/schema.ts:226` | 无迁移列定义 |

## invitation_records

| 列 | schema声明证据 | 迁移列定义 |
| --- | --- | --- |
| `id` | `packages/db/schema.ts:232` | 无迁移列定义 |
| `invite_code` | `packages/db/schema.ts:233` | 无迁移列定义 |
| `inviter_id` | `packages/db/schema.ts:234` | 无迁移列定义 |
| `inviter_email` | `packages/db/schema.ts:235` | 无迁移列定义 |
| `invitee_id` | `packages/db/schema.ts:236` | 无迁移列定义 |
| `invitee_email` | `packages/db/schema.ts:237` | 无迁移列定义 |
| `status` | `packages/db/schema.ts:238` | 无迁移列定义 |
| `risk_level` | `packages/db/schema.ts:239` | 无迁移列定义 |
| `block_reason` | `packages/db/schema.ts:240` | 无迁移列定义 |
| `inviter_reward` | `packages/db/schema.ts:241` | 无迁移列定义 |
| `invitee_reward` | `packages/db/schema.ts:242` | 无迁移列定义 |
| `ip_address` | `packages/db/schema.ts:243` | 无迁移列定义 |
| `user_agent` | `packages/db/schema.ts:244` | 无迁移列定义 |
| `created_at` | `packages/db/schema.ts:245` | 无迁移列定义 |
| `rewarded_at` | `packages/db/schema.ts:246` | 无迁移列定义 |

## membership_plans

| 列 | schema声明证据 | 迁移列定义 |
| --- | --- | --- |
| `id` | `packages/db/schema.ts:271` | 无迁移列定义 |
| `name` | `packages/db/schema.ts:272` | 无迁移列定义 |
| `level` | `packages/db/schema.ts:273` | 无迁移列定义 |
| `monthly_price` | `packages/db/schema.ts:274` | 无迁移列定义 |
| `yearly_price` | `packages/db/schema.ts:275` | 无迁移列定义 |
| `stripe_monthly_price_id` | `packages/db/schema.ts:276` | 已有ADD：`packages/db/migrations/0012_stripe_payments.sql:8` |
| `stripe_yearly_price_id` | `packages/db/schema.ts:277` | 已有ADD：`packages/db/migrations/0012_stripe_payments.sql:9` |
| `monthly_credits` | `packages/db/schema.ts:278` | 无迁移列定义 |
| `yearly_credits` | `packages/db/schema.ts:279` | 无迁移列定义 |
| `monthly_bonus_credits` | `packages/db/schema.ts:280` | 无迁移列定义 |
| `package_discount` | `packages/db/schema.ts:281` | 无迁移列定义 |
| `features` | `packages/db/schema.ts:282` | 无迁移列定义 |
| `history_retention_days` | `packages/db/schema.ts:283` | 无迁移列定义 |
| `max_context_messages` | `packages/db/schema.ts:284` | 已有ADD：`packages/db/migrations/0009_context_length_limit.sql:15` |
| `allow_export` | `packages/db/schema.ts:285` | 无迁移列定义 |
| `allow_batch_export` | `packages/db/schema.ts:286` | 无迁移列定义 |
| `is_active` | `packages/db/schema.ts:287` | 无迁移列定义 |
| `sort_order` | `packages/db/schema.ts:288` | 无迁移列定义 |
| `created_at` | `packages/db/schema.ts:289` | 无迁移列定义 |
| `updated_at` | `packages/db/schema.ts:290` | 无迁移列定义 |

## modules

| 列 | schema声明证据 | 迁移列定义 |
| --- | --- | --- |
| `id` | `packages/db/schema.ts:521` | 无迁移列定义 |
| `skill_id` | `packages/db/schema.ts:522` | 已有ADD：`packages/db/migrations/0062_skill_1a_db_publish_contract.sql:80` |
| `title` | `packages/db/schema.ts:523` | 无迁移列定义 |
| `description` | `packages/db/schema.ts:524` | 无迁移列定义 |
| `full_description` | `packages/db/schema.ts:525` | 无迁移列定义 |
| `icon` | `packages/db/schema.ts:526` | 无迁移列定义 |
| `category` | `packages/db/schema.ts:527` | 无迁移列定义 |
| `platform` | `packages/db/schema.ts:530` | 无迁移列定义 |
| `model_id` | `packages/db/schema.ts:533` | 已有ADD：`packages/db/migrations/0008_modules_schema_update.sql:12` |
| `prompt_content` | `packages/db/schema.ts:534` | 已有ADD：`packages/db/migrations/0008_modules_schema_update.sql:16` |
| `system_prompt` | `packages/db/schema.ts:535` | 已有ADD：`packages/db/migrations/0008_modules_schema_update.sql:20` |
| `user_prompt_template` | `packages/db/schema.ts:536` | 已有ADD：`packages/db/migrations/0008_modules_schema_update.sql:24` |
| `features` | `packages/db/schema.ts:539` | 已有ADD：`packages/db/migrations/0008_modules_schema_update.sql:40` |
| `examples` | `packages/db/schema.ts:540` | 已有ADD：`packages/db/migrations/0008_modules_schema_update.sql:44` |
| `preparation_questions` | `packages/db/schema.ts:541` | 已有ADD：`packages/db/migrations/0008_modules_schema_update.sql:28` |
| `usage_count` | `packages/db/schema.ts:544` | 无迁移列定义 |
| `credits_multiplier` | `packages/db/schema.ts:545` | 无迁移列定义 |
| `sort_order` | `packages/db/schema.ts:546` | 无迁移列定义 |
| `is_featured` | `packages/db/schema.ts:547` | 无迁移列定义 |
| `active` | `packages/db/schema.ts:548` | 无迁移列定义 |
| `image_url` | `packages/db/schema.ts:551` | 已有ADD：`packages/db/migrations/0036_public_module_display_fields.sql:6` |
| `badge_type` | `packages/db/schema.ts:552` | 已有ADD：`packages/db/migrations/0036_public_module_display_fields.sql:7` |
| `badge_text` | `packages/db/schema.ts:553` | 已有ADD：`packages/db/migrations/0036_public_module_display_fields.sql:8` |
| `credits_display` | `packages/db/schema.ts:554` | 已有ADD：`packages/db/migrations/0036_public_module_display_fields.sql:9` |
| `link_url` | `packages/db/schema.ts:555` | 已有ADD：`packages/db/migrations/0036_public_module_display_fields.sql:10` |
| `link_module_id` | `packages/db/schema.ts:556` | 已有ADD：`packages/db/migrations/0036_public_module_display_fields.sql:11` |
| `created_by` | `packages/db/schema.ts:559` | 已有ADD：`packages/db/migrations/0008_modules_schema_update.sql:32` |
| `created_at` | `packages/db/schema.ts:560` | 无迁移列定义 |
| `updated_at` | `packages/db/schema.ts:561` | 已有ADD：`packages/db/migrations/0008_modules_schema_update.sql:36` |

## 额外依赖与复跑范围

主文档表级引用证明这些表必须早于0001/0002存在；逐列行号保留完整类型/default/FK声明入口，不把注释当约束。PK/UNIQUE/FK及后续删除动作详见 [用户数据事实表](C3-user-data-20260929.md)。

检查方式：按表查所有大小写不敏感 `CREATE TABLE` 和 `ALTER TABLE … ADD [COLUMN] [IF NOT EXISTS]`，再人工核对schema字段与后续迁移。此表不解析运行时生成的任意SQL，不证明远端缺列。
