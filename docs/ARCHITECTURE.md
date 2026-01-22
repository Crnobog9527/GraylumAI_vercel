# GraylumAI Architecture

## System Overview

GraylumAI is a production-ready AI chat application built with modern technologies, featuring intelligent model routing, cost optimization, and enterprise-grade security.

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
│  │ (Anthropic)  │  │ Service      │  │ (Compression)        │  │
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
│  │ PostgreSQL   │  │ (Type-safe)  │  │ (21 Tables)          │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    External Services                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ Anthropic    │  │ Sentry       │  │ Vercel               │  │
│  │ Claude API   │  │ (Monitoring) │  │ (Hosting/Analytics)  │  │
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
│       │   │   ├── (chat)/     # Chat interface
│       │   │   ├── admin/      # Admin dashboard
│       │   │   └── api/        # API routes
│       │   ├── components/     # React components
│       │   ├── hooks/          # Custom React hooks
│       │   └── trpc/           # tRPC client setup
│       ├── sentry.*.config.ts  # Sentry configuration
│       └── next.config.ts      # Next.js configuration
│
├── packages/
│   ├── api/                    # Backend API package
│   │   ├── src/
│   │   │   ├── routers/        # tRPC routers
│   │   │   ├── services/       # Business logic
│   │   │   │   ├── ai.ts       # AI engine
│   │   │   │   ├── billing.ts  # Credit system
│   │   │   │   ├── modelRouter.ts    # Smart routing
│   │   │   │   └── contextManager.ts # Context compression
│   │   │   ├── lib/            # Utilities
│   │   │   │   ├── logger.ts   # Structured logging
│   │   │   │   └── rateLimiter.ts
│   │   │   └── middleware/     # Request middleware
│   │   └── index.ts
│   │
│   └── db/                     # Database package
│       ├── schema.ts           # Drizzle schema
│       ├── migrations/         # SQL migrations
│       └── index.ts
│
├── docs/                       # Documentation
├── .github/                    # CI/CD workflows
└── vercel.json                 # Vercel configuration
```

## Key Components

### 1. AI Engine (`packages/api/src/services/ai.ts`)

Handles all AI interactions with Claude API:
- Streaming responses
- Tool use (web search)
- Request idempotency
- Abort handling

### 2. Smart Model Router (`packages/api/src/services/modelRouter.ts`)

Intelligent routing based on query complexity:

| Query Type | Model | Criteria |
|------------|-------|----------|
| Simple | claude-3-5-haiku | Short queries, simple tasks |
| Complex | claude-sonnet-4 | Code, analysis, long context |
| Realtime | claude-sonnet-4 + Web Search | News, weather, stock keywords |

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

All 21 tables have RLS policies:
- Users can only access their own data
- Admins have elevated access for management
- Service role bypasses for system operations

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
6. Stream AI response (ai.ts → Anthropic API)
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
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key |
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

1. **RLS**: Row-level security on all tables
2. **Rate Limiting**: Per-user request limits
3. **Consumption Circuit Breaker**: Spending limits
4. **Request Signing**: HMAC-SHA256 validation
5. **Environment Validation**: Runtime checks for required vars
6. **Dependabot**: Automated dependency updates
7. **Security Scanning**: GitHub Actions workflow
