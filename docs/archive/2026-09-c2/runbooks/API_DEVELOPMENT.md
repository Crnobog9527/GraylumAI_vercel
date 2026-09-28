# API Development Runbook

## tRPC Router Structure

```
packages/api/src/routers/
├── ai.ts           # AI chat endpoints
├── billing.ts      # Credit management
├── conversations.ts # Conversation CRUD
├── costs.ts        # Admin cost monitoring
├── diagnostics.ts  # System diagnostics
├── models.ts       # AI model configuration
├── tickets.ts      # Support tickets
└── users.ts        # User management
```

## Creating a New Router

### Step 1: Create Router File

```typescript
// packages/api/src/routers/example.ts
import { z } from 'zod';
import { createTRPCRouter, protectedProcedure, adminProcedure } from '../trpc';

export const exampleRouter = createTRPCRouter({
  // Public procedure (still requires auth)
  getAll: protectedProcedure
    .query(async ({ ctx }) => {
      return ctx.db.select().from(examples);
    }),

  // Protected procedure with input validation
  getById: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return ctx.db
        .select()
        .from(examples)
        .where(eq(examples.id, input.id))
        .limit(1);
    }),

  // Mutation
  create: protectedProcedure
    .input(z.object({
      name: z.string().min(1).max(100),
      description: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const [result] = await ctx.db
        .insert(examples)
        .values({
          name: input.name,
          description: input.description,
          userId: ctx.user.id,
        })
        .returning();
      return result;
    }),

  // Admin-only procedure
  adminDelete: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .delete(examples)
        .where(eq(examples.id, input.id));
      return { success: true };
    }),
});
```

### Step 2: Register Router

```typescript
// packages/api/src/root.ts
import { exampleRouter } from './routers/example';

export const appRouter = createTRPCRouter({
  // ... existing routers
  example: exampleRouter,
});
```

### Step 3: Use in Frontend

```typescript
// In React component
const { data, isLoading } = api.example.getAll.useQuery();

const createMutation = api.example.create.useMutation({
  onSuccess: () => {
    utils.example.getAll.invalidate();
  },
});
```

## Procedure Types

| Type | Auth Required | Admin Only | Use Case |
|------|---------------|------------|----------|
| `publicProcedure` | No | No | Public data |
| `protectedProcedure` | Yes | No | User data |
| `adminProcedure` | Yes | Yes | Admin actions |

## Input Validation with Zod

### Common Patterns

```typescript
// UUID
z.string().uuid()

// Email
z.string().email()

// Enum
z.enum(['option1', 'option2'])

// Optional with default
z.string().optional().default('')

// Array
z.array(z.string())

// Object
z.object({
  name: z.string(),
  age: z.number().int().positive(),
})

// Pagination
z.object({
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(20),
})
```

## Error Handling

### Throwing Errors

```typescript
import { TRPCError } from '@trpc/server';

// Not found
throw new TRPCError({
  code: 'NOT_FOUND',
  message: 'Resource not found',
});

// Unauthorized
throw new TRPCError({
  code: 'UNAUTHORIZED',
  message: 'You must be logged in',
});

// Forbidden
throw new TRPCError({
  code: 'FORBIDDEN',
  message: 'You do not have permission',
});

// Bad request
throw new TRPCError({
  code: 'BAD_REQUEST',
  message: 'Invalid input',
});
```

### Error Codes

| Code | HTTP Status | Use Case |
|------|-------------|----------|
| BAD_REQUEST | 400 | Invalid input |
| UNAUTHORIZED | 401 | Not logged in |
| FORBIDDEN | 403 | No permission |
| NOT_FOUND | 404 | Resource missing |
| CONFLICT | 409 | Duplicate data |
| TOO_MANY_REQUESTS | 429 | Rate limited |
| INTERNAL_SERVER_ERROR | 500 | Server error |

## Database Operations

### Select with Relations

```typescript
const conversations = await ctx.db
  .select({
    id: conversationsTable.id,
    title: conversationsTable.title,
    model: {
      id: aiModels.id,
      name: aiModels.name,
    },
  })
  .from(conversationsTable)
  .leftJoin(aiModels, eq(conversationsTable.modelId, aiModels.id))
  .where(eq(conversationsTable.userId, ctx.user.id));
```

### Pagination

```typescript
const items = await ctx.db
  .select()
  .from(table)
  .where(conditions)
  .orderBy(desc(table.createdAt))
  .limit(input.limit)
  .offset((input.page - 1) * input.limit);

const [{ count }] = await ctx.db
  .select({ count: sql`count(*)` })
  .from(table)
  .where(conditions);

return {
  items,
  total: Number(count),
  page: input.page,
  totalPages: Math.ceil(Number(count) / input.limit),
};
```

### Soft Delete

```typescript
// Soft delete
await ctx.db
  .update(table)
  .set({
    isDeleted: 'true',
    deletedAt: new Date(),
  })
  .where(eq(table.id, input.id));

// Query excluding soft deleted
const items = await ctx.db
  .select()
  .from(table)
  .where(eq(table.isDeleted, 'false'));
```

## Logging

```typescript
import { logger } from '../lib/logger';

// Info log
logger.info('User action', {
  action: 'create_conversation',
  userId: ctx.user.id,
});

// Error log
logger.error('Operation failed', {
  error: err.message,
  userId: ctx.user.id,
  input,
});

// With context
logger.info('AI request completed', {
  context: 'ai',
  model: modelId,
  latencyMs: Date.now() - startTime,
});
```

## Testing Procedures

### Manual Testing

```bash
# Using curl (requires auth token)
curl -X POST http://localhost:3000/api/trpc/example.getAll \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TOKEN" \
  -d '{}'
```

### In Browser Console

```javascript
// Query
await window.__TRPC__.example.getAll.query();

// Mutation
await window.__TRPC__.example.create.mutate({
  name: 'Test',
});
```

## Rate Limiting

```typescript
import { rateLimiter } from '../services/rateLimiter';

// In procedure
const allowed = await rateLimiter.checkLimit(ctx.user.id, 'api');
if (!allowed) {
  throw new TRPCError({
    code: 'TOO_MANY_REQUESTS',
    message: 'Rate limit exceeded',
  });
}
```

## Streaming Responses

For AI chat streaming:

```typescript
// In router
streamChat: protectedProcedure
  .input(chatInputSchema)
  .mutation(async function* ({ ctx, input }) {
    // Yield chunks
    for await (const chunk of aiStream) {
      yield chunk;
    }
  }),
```

## Best Practices

### Do
- Validate all inputs with Zod
- Use appropriate procedure types
- Log important operations
- Handle errors gracefully
- Return consistent response shapes

### Don't
- Trust client-side data
- Expose internal errors to users
- Skip RLS by using service role unnecessarily
- Create procedures without input validation
- Ignore rate limiting for expensive operations

## Debugging

### Enable tRPC Logging

```typescript
// In trpc.ts
const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    console.error('tRPC Error:', error);
    return shape;
  },
});
```

### Check Request/Response

Browser DevTools → Network → Filter by "trpc"

### Database Query Logging

```typescript
// Temporary debugging
console.log(db.select().from(table).toSQL());
```
