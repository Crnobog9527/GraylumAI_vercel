# Database Schema Documentation

## Overview

GraylumAI uses Supabase PostgreSQL with Drizzle ORM. All tables have Row Level Security (RLS) enabled.

## Entity Relationship Diagram

```
┌─────────────┐       ┌─────────────────┐       ┌─────────────┐
│  profiles   │◄──────│  conversations  │───────►│  ai_models  │
│  (users)    │       │                 │       │             │
└──────┬──────┘       └────────┬────────┘       └─────────────┘
       │                       │
       │              ┌────────┴────────┐
       │              ▼                 ▼
       │       ┌─────────────┐   ┌─────────────┐
       │       │  messages   │   │ token_stats │
       │       └─────────────┘   └─────────────┘
       │
       ├──────────────┬──────────────┬──────────────┐
       ▼              ▼              ▼              ▼
┌─────────────┐ ┌───────────┐ ┌───────────┐ ┌────────────┐
│   tickets   │ │  billing  │ │ ai_usage  │ │ invitations│
│             │ │  _history │ │ _logs     │ │            │
└─────────────┘ └───────────┘ └───────────┘ └────────────┘
```

## Core Tables

### profiles
User accounts linked to Supabase Auth.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid (PK) | References auth.users.id |
| email | text | User email |
| nickname | text | Display name |
| avatar_url | text | Profile picture URL |
| role | enum | 'user' \| 'admin' |
| status | enum | 'active' \| 'disabled' \| 'banned' |
| membership_level | enum | 'free' \| 'pro' \| 'gold' |
| credits | integer | Available credits (default: 100) |
| last_login_at | timestamp | Last login time |
| is_deleted | text | Soft delete flag |
| created_at | timestamp | Account creation time |

### conversations
Chat conversation containers.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid (PK) | Auto-generated |
| user_id | uuid (FK) | Owner profile |
| title | text | Conversation title |
| model_id | uuid (FK) | Preferred AI model |
| summary | text | Compressed context summary |
| summary_tokens | integer | Token count of summary |
| summary_metadata | jsonb | Recursive summary layers |
| is_deleted | text | Soft delete flag |
| created_at | timestamp | Creation time |

### messages
Individual chat messages.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid (PK) | Auto-generated |
| conversation_id | uuid (FK) | Parent conversation |
| role | enum | 'user' \| 'assistant' |
| content | text | Message content |
| is_deleted | text | Soft delete flag |
| created_at | timestamp | Message time |

## AI & Billing Tables

### ai_models
Available AI models configuration.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid (PK) | Model identifier |
| name | text | Display name |
| model_id | text | API model ID (e.g., claude-sonnet-4) |
| provider | enum | 'anthropic' \| 'openai' \| 'google' |
| max_tokens | integer | Max output tokens |
| input_limit | integer | Max input tokens |
| input_token_cost | integer | Cost per 1M input tokens (micro-USD) |
| output_token_cost | integer | Cost per 1M output tokens |
| web_search_cost | integer | Cost per 1K searches |
| is_active | text | Model enabled flag |

### token_stats
Per-request token usage tracking.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid (PK) | Record identifier |
| conversation_id | uuid (FK) | Related conversation |
| user_id | uuid (FK) | User who made request |
| model_used | text | Actual model used |
| input_tokens | integer | Input token count |
| output_tokens | integer | Output token count |
| cached_tokens | integer | Prompt cache hits |
| web_search_count | integer | Web searches performed |
| total_cost_usd | decimal(12,6) | USD cost |
| total_credits | integer | Credits consumed |
| created_at | timestamp | Request time |

### billing_history
Three-phase billing audit trail.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid (PK) | Record identifier |
| user_id | uuid (FK) | User account |
| transaction_id | uuid (FK) | Related credit transaction |
| operation_type | enum | 'pre_deduct' \| 'settle' \| 'refund' |
| amount | integer | Credit change (negative for deduct) |
| reason | text | Operation description |
| metadata | jsonb | Additional data (usage info, etc.) |
| created_at | timestamp | Operation time |

### ai_usage_logs
Detailed AI request logging for debugging.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid (PK) | Log identifier |
| user_id | uuid (FK) | Requesting user |
| conversation_id | uuid (FK) | Related conversation |
| request_id | text | Anthropic request ID |
| model_id | text | Requested model |
| status | enum | 'success' \| 'failed' \| 'timeout' \| 'rate_limited' |
| error_message | text | Error details if failed |
| latency_ms | integer | Request duration |
| ip_address | text | Client IP |
| metadata | jsonb | Debug information |
| created_at | timestamp | Request time |

## Business Tables

### tickets
Support ticket system.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid (PK) | Ticket identifier |
| user_id | uuid (FK) | Submitting user |
| title | text | Ticket title |
| description | text | Detailed description |
| category | enum | 'bug' \| 'feature' \| 'question' \| etc. |
| priority | enum | 'low' \| 'medium' \| 'high' \| 'urgent' |
| status | enum | 'open' \| 'in_progress' \| 'closed' |
| attachments | jsonb | Attachment URLs array |
| is_deleted | text | Soft delete flag |
| created_at | timestamp | Submission time |

### ticket_replies
Responses to support tickets.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid (PK) | Reply identifier |
| ticket_id | uuid (FK) | Parent ticket |
| user_id | uuid (FK) | Reply author |
| content | text | Reply content |
| is_admin | text | Admin reply flag |
| attachments | jsonb | Attachment URLs |
| created_at | timestamp | Reply time |

### credit_packages
Purchasable credit bundles.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid (PK) | Package identifier |
| name | text | Package name |
| price | integer | Price in cents |
| credits_amount | integer | Credits included |
| bonus_credits | integer | Extra credits |
| is_popular | text | Featured flag |
| active | text | Available for purchase |

### invitations
Invitation code system.

| Column | Type | Description |
|--------|------|-------------|
| code | text (PK) | Invitation code |
| created_by | uuid (FK) | Creator profile |
| used_by | uuid (FK) | User who used code |
| status | enum | 'active' \| 'used' \| 'expired' |
| created_at | timestamp | Creation time |

### announcements
System announcements and banners.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid (PK) | Announcement identifier |
| title | text | Announcement title |
| content | text | Full content |
| type | enum | 'info' \| 'warning' \| 'success' \| 'promo' |
| announcement_type | enum | 'homepage' \| 'banner' |
| priority | integer | Display order |
| active | text | Visibility flag |
| start_date | timestamp | Display start |
| end_date | timestamp | Display end |

## System Tables

### system_settings
Key-value configuration store.

| Column | Type | Description |
|--------|------|-------------|
| key | text (PK) | Setting identifier |
| value | jsonb | Setting value |

### user_activity_logs
Admin action audit trail.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid (PK) | Log identifier |
| user_id | uuid (FK) | Affected user |
| admin_id | uuid (FK) | Acting admin |
| action | text | Action description |
| action_type | enum | 'status_change' \| 'role_change' \| etc. |
| details | jsonb | Action details |
| ip_address | text | Admin IP |
| created_at | timestamp | Action time |

### application_logs
Structured application logs.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid (PK) | Log identifier |
| level | text | 'info' \| 'warn' \| 'error' |
| message | text | Log message |
| context | text | Log category |
| metadata | jsonb | Additional data |
| user_id | uuid | Related user |
| created_at | timestamp | Log time |

### diagnostics_results
System health check results.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid (PK) | Result identifier |
| batch_id | uuid | Test batch grouping |
| category | text | Test category |
| test_name | text | Test identifier |
| passed | boolean | Test result |
| message | text | Result message |
| metadata | jsonb | Test details |
| created_at | timestamp | Test time |

## Migrations

| File | Description |
|------|-------------|
| 0001_ai_billing_tables.sql | Token stats, billing history, AI logs |
| 0002_enable_rls_all_tables.sql | RLS policies for all tables |
| 0003_atomic_billing_rpc.sql | Atomic billing RPC functions |
| 0004_recursive_summary_and_soft_delete.sql | Context compression support |
| 0005_diagnostics.sql | System diagnostics tables |
| 0006_application_logs.sql | Application logging table |
| 0007_performance_indexes.sql | 40+ performance indexes |

## Performance Indexes

Key indexes for common queries:

```sql
-- User's conversations
idx_conversations_user_id ON conversations(user_id)

-- Messages in conversation (critical for chat)
idx_messages_conversation_created ON messages(conversation_id, created_at)

-- Cost reporting
idx_token_stats_user_created ON token_stats(user_id, created_at DESC)

-- AI usage analysis
idx_ai_usage_logs_user_created ON ai_usage_logs(user_id, created_at DESC)
```

See `0007_performance_indexes.sql` for complete index list.

## RLS Policies

All tables have:
1. **User policies**: Users can only access their own data
2. **Admin policies**: Admins can access all data
3. **Service role**: Bypasses RLS for system operations

Example policy structure:
```sql
-- Users can read their own conversations
CREATE POLICY "Users can view own conversations" ON conversations
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- Admins can read all conversations
CREATE POLICY "Admins can view all conversations" ON conversations
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );
```
