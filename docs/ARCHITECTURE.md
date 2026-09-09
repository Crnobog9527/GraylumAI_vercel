# GraylumAI Architecture

## System Overview

GraylumAI is a Next.js/tRPC application using Supabase for data and authentication. This overview describes repository structure; release readiness requires candidate-specific evidence.

```
┌─────────────────────────────────────────────────────────────────┐
│                         Client Layer                            │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐ │
│  │   Next.js   │  │   React 19  │  │   TanStack Query        │ │
│  │   App Router│  │   RSC       │  │   (Client State)        │ │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         API Layer                               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐ │
│  │   tRPC      │  │   Next.js   │  │   Middleware            │ │
│  │   Routers   │  │   API Routes│  │   (Auth, Rate Limit)    │ │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                       Service Layer                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ AI Engine    │  │ Billing      │  │ Context Manager      │  │
│  │ (OpenRouter) │  │ Service      │  │ (Compression)        │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ Model Router │  │ Rate Limiter │  │ Logger               │  │
│  │ (Smart)      │  │ (Memory)     │  │ (Pino + DB)          │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                       Data Layer                                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ Supabase     │  │ Drizzle ORM  │  │ Row Level Security   │  │
│  │ PostgreSQL   │  │ (Type-safe)  │  │ (Per-table)          │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    External Services                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ OpenRouter   │  │ Sentry       │  │ Vercel               │  │
│  │ Model API    │  │ (Monitoring) │  │ (Hosting/Analytics)  │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Project Structure

```
GraylumAI_vercel/
├── apps/
│   └── web/                    # Next.js 16 Application
│       ├── src/
│       │   ├── app/            # App Router pages
│       │   │   ├── chat/       # Chat interface
│       │   │   ├── admin/      # Admin dashboard
│       │   │   └── api/        # API routes
│       │   ├── components/     # React components
│       │   ├── hooks/          # Custom React hooks
│       │   └── trpc/           # tRPC client setup
│       ├── sentry.*.config.ts  # Sentry configuration
│       ├── next.config.ts      # Next.js configuration
│       └── vercel.json         # Vercel configuration
│
├── packages/
│   ├── api/                    # Backend API package
│   │   ├── src/
│   │   │   ├── routers/        # tRPC routers
│   │   │   │   └── ai.ts       # AI request entry points
│   │   │   ├── services/       # Business logic
│   │   │   │   ├── chatRuntime.ts # Runtime orchestration
│   │   │   │   ├── rateLimiter.ts # Request rate limits
│   │   │   │   ├── billing.ts  # Credit system
│   │   │   │   ├── modelRouter.ts    # Smart routing
│   │   │   │   └── contextManager.ts # Context compression
│   │   │   ├── lib/            # Utilities
│   │   │   │   └── logger.ts   # Structured logging
│   │   │   └── middleware/     # Request middleware
│   │   └── package.json
│   │
│   └── db/                     # Database package
│       ├── schema.ts           # Drizzle schema
│       ├── migrations/         # SQL migrations
│       └── package.json
│
├── docs/                       # Documentation
└── .github/                    # CI/CD workflows
```

## Key Components

### 1. AI Router (`packages/api/src/routers/ai.ts`)

Handles AI provider interactions; Claude uses the OpenRouter-compatible path:
- Streaming responses
- Tool use (web search)
- Request idempotency
- Abort handling

### 2. Smart Model Router (`packages/api/src/services/modelRouter.ts`)

Routing decisions combine task classification with runtime configuration loaded by `chatRuntime.ts`. `primary_model_id` and `assistant_model_id` refer to database model records; the selected model is not fixed to an old provider model name. Search decisions and provider capability are evaluated separately. See [settings effects](ADMIN_SETTINGS_EFFECT_MATRIX.md).

### 3. Three-Phase Billing (`packages/api/src/services/billing.ts`)

```
Pre-deduct → AI Call → Settle/Refund
    │           │          │
    ▼           ▼          ▼
Deduct      Execute     Calculate
estimate    request     actual cost
```

- **Pre-deduct**: Reserve credits based on estimated cost
- **Settle**: Adjust to actual usage after completion
- **Refund**: Return unused credits on abort

### 4. Context Compression (`packages/api/src/services/contextManager.ts`)

Manages conversation context within token limits:
- Threshold: 60% of model's input limit (90,000 tokens)
- Recursive summarization for long conversations
- Preserves recent messages while compressing history

### 5. Row Level Security (RLS)

Access depends on both PostgreSQL grants and table-specific RLS policies. Server admin procedures authenticate and authorize the caller before using privileged database access. `service_role` bypasses RLS but still needs the table/column privileges used by each query; it does not make missing grants harmless.

## Admin Settings and Module Removal

The settings page loads `admin.getSettingsDashboard` and model option queries, then saves through `settings.updateSystemSettingsBulk`. The server rechecks the administrator, validates model references, and upserts the batch. `ai_models.id` is the settings reference; `model_id` is the provider identifier shown to help selection.

The modules dashboard uses `admin.getPromptsDashboard`. Confirmed removal calls `admin.removePrompts` with up to 100 IDs and executes one atomic database DELETE guarded by existing foreign keys. After server success, the UI removes the submitted IDs from cached rows and counts, including IDs already absent on a replay; returned `deletedIds` determine the success message count. It then refreshes in the background. A refresh failure retains the confirmed result with an error notice. `removePrompt` remains for compatibility; `deletePrompt` and `batchDeletePrompts` disable modules.

See [admin operations](runbooks/ADMIN_OPERATIONS.md) for API inputs, failure handling and verification.

## Data Flow

### Chat Request Flow

```
1. User sends message
       │
       ▼
2. Rate limit check (rateLimiter.ts)
       │
       ▼
3. Pre-deduct credits (billing.ts)
       │
       ▼
4. Smart model routing (modelRouter.ts)
       │
       ▼
5. Context compression if needed (contextManager.ts)
       │
       ▼
6. Stream AI response (ai.ts → configured provider)
       │
       ▼
7. Settle billing with actual usage
       │
       ▼
8. Log to ai_usage_logs + token_stats
```

### Authentication Flow

```
1. User authenticates via Supabase Auth
       │
       ▼
2. JWT token issued
       │
       ▼
3. Token verified in tRPC context
       │
       ▼
4. User ID attached to request
       │
       ▼
5. RLS policies filter data access
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | Supabase PostgreSQL connection |
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Supabase anonymous key |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role key |
| `OPENROUTER_API_KEY` | For OpenRouter models | Server-side provider credential; official Anthropic key is retired |
| `NEXT_PUBLIC_SENTRY_DSN` | No | Sentry error tracking |

## Monitoring & Observability

### Error Tracking (Sentry)
- Client-side errors
- Server-side errors
- Edge function errors
- Session replay for debugging

### Logging (Pino + PostgreSQL)
- Structured JSON logs
- Database persistence for audit
- Auto-cleanup after 30 days

### Analytics (Vercel)
- Page views and performance
- Core Web Vitals (LCP, FID, CLS)
- Speed Insights

### AI Cost Dashboard (`/admin/costs`)
- Cost trends and projections
- Per-user spending breakdown
- Model usage distribution
- Cache efficiency metrics

## Security Measures

1. **Database access**: Table-specific RLS and least-privilege grants
2. **Rate Limiting**: Per-user request limits
3. **Consumption Circuit Breaker**: Spending limits
4. **Request Signing**: HMAC-SHA256 validation
5. **Environment Validation**: Runtime checks for required vars
6. **Dependabot**: Automated dependency updates
7. **Security Scanning**: GitHub Actions workflow
