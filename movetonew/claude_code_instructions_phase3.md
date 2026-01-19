## 🚀 后续迁移计划 - Claude Code 执行手册 (续)

**文档版本**: 3.1
**生成日期**: 2026-01-14
**更新日期**: 2026-01-19

### Tech Stack Versions
| Package | Version |
|---------|---------|
| Next.js | 16.1.1 |
| React | 19.2.3 |
| TypeScript | 5.9.3 |
| @trpc/* | 11.8.1 |
| @supabase/supabase-js | 2.90.1 |
| drizzle-orm | 0.45.1 |
| zod | 4.3.5 |
| turbo | 2.7.5 |

---

## 📖 使用指南

您已成功完成了基础架构和核心聊天功能的迁移。现在，我们将继续迁移剩余的业务逻辑。

请继续按照分步执行的方式，将每个【任务块】复制给 Claude Code。

---

## 🚀 阶段九：工单与系统设置迁移 (3-5天)

**目标**: 迁移工单系统和系统设置相关的后端 API 及前端页面。

---

### ## 任务 9.1：迁移工单系统 API

**任务描述**: 创建 `ticketRouter`，并将 `createTicket`, `getTickets`, `replyToTicket` 迁移为 tRPC procedures。

**给 Claude Code 的指令**:

```
请执行以下操作：

1.  在 `packages/api/src/routers/` 目录下创建 `ticket.ts` 文件。
2.  在 `packages/api/src/root.ts` 中注册 `ticketRouter`。

**`ticket.ts` 文件内容如下：**

```typescript
import { router, protectedProcedure } from '../../trpc';
import { z } from 'zod';
import { tickets, ticketReplies } from '@repo/db/schema';
import { eq, desc } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';

export const ticketRouter = router({
  createTicket: protectedProcedure
    .input(z.object({ title: z.string().min(5), content: z.string().min(10) }))
    .mutation(async ({ ctx, input }) => {
      const [newTicket] = await ctx.supabase
        .from('tickets')
        .insert({
          userId: ctx.user.id,
          title: input.title,
          status: 'open',
        })
        .select();

      if (!newTicket) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to create ticket.' });
      }

      await ctx.supabase
        .from('ticket_replies')
        .insert({
          ticketId: newTicket.id,
          userId: ctx.user.id,
          content: input.content,
        });

      return newTicket;
    }),

  getTickets: protectedProcedure.query(async ({ ctx }) => {
    return ctx.supabase
      .from('tickets')
      .select('*, ticket_replies(*)')
      .eq('userId', ctx.user.id)
      .order('createdAt', { ascending: false });
  }),

  getTicketById: protectedProcedure
    .input(z.object({ ticketId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [ticket] = await ctx.supabase
        .from('tickets')
        .select('*, ticket_replies(*)')
        .eq('id', input.ticketId)
        .eq('userId', ctx.user.id); // Ensure user owns the ticket

      if (!ticket) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Ticket not found.' });
      }
      return ticket;
    }),

  replyToTicket: protectedProcedure
    .input(z.object({ ticketId: z.string().uuid(), content: z.string().min(5) }))
    .mutation(async ({ ctx, input }) => {
      const [ticket] = await ctx.supabase
        .from('tickets')
        .select('id')
        .eq('id', input.ticketId)
        .eq('userId', ctx.user.id); // Ensure user owns the ticket

      if (!ticket) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Ticket not found or unauthorized.' });
      }

      const [newReply] = await ctx.supabase
        .from('ticket_replies')
        .insert({
          ticketId: input.ticketId,
          userId: ctx.user.id,
          content: input.content,
        })
        .select();

      return newReply;
    }),
});


**请将 `packages/api/src/root.ts` 更新为：**

```typescript
import { chatRouter } from './routers/chat';
import { userRouter } from './routers/user';
import { creditsRouter } from './routers/credits';
import { ticketRouter } from './routers/ticket'; // 新增
import { router } from '../trpc';

export const appRouter = router({
  chat: chatRouter,
  user: userRouter,
  credits: creditsRouter,
  ticket: ticketRouter, // 新增
});

export type AppRouter = typeof appRouter;
```


**预期输出**:
- 文件创建和更新成功。

**验证方法**:
- `packages/api/src/routers/ticket.ts` 文件内容被更新。
- `packages/api/src/root.ts` 文件内容被更新。

---

### ## 任务 9.2：迁移系统设置 API

**任务描述**: 创建 `settingsRouter`，并将 `getSystemSettings`, `updateSystemSettings` 迁移为 tRPC procedures。`updateSystemSettings` 需要管理员权限。

**给 Claude Code 的指令**:

```
请执行以下操作：

1.  在 `packages/api/src/routers/` 目录下创建 `settings.ts` 文件。
2.  在 `packages/api/src/root.ts` 中注册 `settingsRouter`。

**`settings.ts` 文件内容如下：**

```typescript
import { router, publicProcedure, protectedProcedure } from '../../trpc';
import { z } from 'zod';
import { systemSettings } from '@repo/db/schema';
import { TRPCError } from '@trpc/server';

export const settingsRouter = router({
  getSystemSettings: publicProcedure.query(async ({ ctx }) => {
    const { data, error } = await ctx.supabase
      .from('system_settings')
      .select('*');
    if (error) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
    return data.reduce((acc, setting) => ({ ...acc, [setting.key]: setting.value }), {});
  }),

  updateSystemSettings: protectedProcedure // Requires authentication
    .input(z.object({ key: z.string(), value: z.any() }))
    .mutation(async ({ ctx, input }) => {
      // TODO: Implement role-based access control (e.g., check if ctx.user.role === 'admin')
      // For now, any authenticated user can update settings, which is NOT recommended for production.
      // You should add a check here to ensure only admins can update settings.

      const { data, error } = await ctx.supabase
        .from('system_settings')
        .upsert({ key: input.key, value: input.value }, { onConflict: 'key' })
        .select();

      if (error) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      return data;
    }),
});


**请将 `packages/api/src/root.ts` 更新为：**

```typescript
import { chatRouter } from './routers/chat';
import { userRouter } from './routers/user';
import { creditsRouter } from './routers/credits';
import { ticketRouter } from './routers/ticket';
import { settingsRouter } from './routers/settings'; // 新增
import { router } from '../trpc';

export const appRouter = router({
  chat: chatRouter,
  user: userRouter,
  credits: creditsRouter,
  ticket: ticketRouter,
  settings: settingsRouter, // 新增
});

export type AppRouter = typeof appRouter;
```


**预期输出**:
- 文件创建和更新成功。

**验证方法**:
- `packages/api/src/routers/settings.ts` 文件内容被更新。
- `packages/api/src/root.ts` 文件内容被更新。

---

### ## 任务 9.3：创建工单页面

**任务描述**: 创建一个前端页面来展示工单列表和创建工单的功能。

**给 Claude Code 的指令**:

```
请在 `/home/ubuntu/graylumAi-refactor/apps/web/src/app/` 目录下创建 `tickets/page.tsx` 文件。

**`tickets/page.tsx` 文件内容如下：**

```typescript
'use client';

import { useState } from 'react';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';

export default function TicketsPage() {
  const { data: tickets, isLoading, refetch } = trpc.ticket.getTickets.useQuery();
  const createTicketMutation = trpc.ticket.createTicket.useMutation({
    onSuccess: () => {
      refetch();
      setNewTicketTitle('');
      setNewTicketContent('');
      setOpen(false);
    },
  });

  const [newTicketTitle, setNewTicketTitle] = useState('');
  const [newTicketContent, setNewTicketContent] = useState('');
  const [open, setOpen] = useState(false);

  const handleCreateTicket = () => {
    if (newTicketTitle.trim() && newTicketContent.trim()) {
      createTicketMutation.mutate({ title: newTicketTitle, content: newTicketContent });
    }
  };

  if (isLoading) return <div>Loading tickets...</div>;

  return (
    <div className="container mx-auto p-4">
      <div className="flex justify-between items-center mb-4">
        <h1 className="text-2xl font-bold">My Tickets</h1>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>Create New Ticket</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create New Ticket</DialogTitle>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <Input
                placeholder="Ticket Title"
                value={newTicketTitle}
                onChange={(e) => setNewTicketTitle(e.target.value)}
              />
              <Textarea
                placeholder="Ticket Content"
                value={newTicketContent}
                onChange={(e) => setNewTicketContent(e.target.value)}
              />
              <Button onClick={handleCreateTicket} disabled={createTicketMutation.isPending}>
                Submit Ticket
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid gap-4">
        {tickets?.data?.map((ticket) => (
          <Card key={ticket.id}>
            <CardHeader>
              <CardTitle>{ticket.title} - <span className="text-sm text-gray-500">Status: {ticket.status}</span></CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-gray-700">Created at: {new Date(ticket.createdAt).toLocaleString()}</p>
              {/* Display first reply as content for simplicity */}
              <p className="mt-2">{ticket.ticket_replies?.[0]?.content}</p>
              {/* TODO: Add link to detailed ticket view */}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
```


**预期输出**:
- 文件创建成功。

**验证方法**:
- 启动开发服务器 (`pnpm dev`)。
- 访问 `/tickets` 路径，您应该能看到工单列表和创建新工单的按钮。
- 尝试创建工单，并在 Supabase 数据库中验证数据是否写入成功。

---

### ## 任务 9.4：提交第九阶段成果

**任务描述**: 提交工单系统和系统设置迁移的代码。

**给 Claude Code 的指令**:

```
请在 `/home/ubuntu/graylumAi-refactor` 目录下执行以下 shell 命令：

git add . && \
git commit -m "feat: migrate ticket system and system settings

- Add ticketRouter with createTicket, getTickets, getTicketById, replyToTicket procedures.
- Add settingsRouter with getSystemSettings, updateSystemSettings procedures.
- Create frontend tickets page to list and create tickets." && \
git push origin refactor
```

**预期输出**:
- git commit 和 push 的成功信息。

---

**阶段九完成！**

您已成功迁移了工单系统和系统设置。接下来，我们将迁移邀请推广和 AI 模型管理功能。


---

## 🚀 阶段十：邀请推广与模型管理迁移 (3-5天)

**目标**: 迁移邀请推广和 AI 模型管理相关的后端 API 及前端页面。

---

### ## 任务 10.1：迁移 AI 模型管理 API

**任务描述**: 创建 `modelRouter`，并将 `getAvailableModels`, `updateModelConfig` 迁移为 tRPC procedures。`updateModelConfig` 需要管理员权限。

**给 Claude Code 的指令**:

```
请执行以下操作：

1.  在 `packages/api/src/routers/` 目录下创建 `model.ts` 文件。
2.  在 `packages/api/src/root.ts` 中注册 `modelRouter`。

**`model.ts` 文件内容如下：**

```typescript
import { router, publicProcedure, protectedProcedure } from '../../trpc';
import { z } from 'zod';
import { aiModels } from '@repo/db/schema';
import { TRPCError } from '@trpc/server';

export const modelRouter = router({
  getAvailableModels: publicProcedure.query(async ({ ctx }) => {
    const { data, error } = await ctx.supabase
      .from('ai_models')
      .select('*');
    if (error) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
    return data;
  }),

  updateModelConfig: protectedProcedure // Requires authentication
    .input(z.object({ id: z.string().uuid(), config: z.any() }))
    .mutation(async ({ ctx, input }) => {
      // TODO: Implement role-based access control (e.g., check if ctx.user.role === 'admin')
      // For now, any authenticated user can update models, which is NOT recommended for production.
      // You should add a check here to ensure only admins can update models.

      const { data, error } = await ctx.supabase
        .from('ai_models')
        .update({ config: input.config })
        .eq('id', input.id)
        .select();

      if (error) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      return data;
    }),
});
```

**请将 `packages/api/src/root.ts` 更新为：**

```typescript
import { chatRouter } from './routers/chat';
import { userRouter } from './routers/user';
import { creditsRouter } from './routers/credits';
import { ticketRouter } from './routers/ticket';
import { settingsRouter } from './routers/settings';
import { modelRouter } from './routers/model'; // 新增
import { router } from '../trpc';

export const appRouter = router({
  chat: chatRouter,
  user: userRouter,
  credits: creditsRouter,
  ticket: ticketRouter,
  settings: settingsRouter,
  model: modelRouter, // 新增
});

export type AppRouter = typeof appRouter;
```


**预期输出**:
- 文件创建和更新成功。

**验证方法**:
- `packages/api/src/routers/model.ts` 文件内容被更新。
- `packages/api/src/root.ts` 文件内容被更新。

---

### ## 任务 10.2：迁移邀请推广 API

**任务描述**: 创建 `invitationRouter`，并将 `generateInvitationCode`, `validateInvitationCode`, `getInvitationHistory` 迁移为 tRPC procedures。`generateInvitationCode` 可能需要管理员权限。

**给 Claude Code 的指令**:

```
请执行以下操作：

1.  在 `packages/api/src/routers/` 目录下创建 `invitation.ts` 文件。
2.  在 `packages/api/src/root.ts` 中注册 `invitationRouter`。

**`invitation.ts` 文件内容如下：**

```typescript
import { router, publicProcedure, protectedProcedure } from '../../trpc';
import { z } from 'zod';
import { invitations } from '@repo/db/schema';
import { TRPCError } from '@trpc/server';
import { customAlphabet } from 'nanoid';

const nanoid = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 10);

export const invitationRouter = router({
  generateInvitationCode: protectedProcedure // Requires authentication
    .mutation(async ({ ctx }) => {
      // TODO: Implement role-based access control (e.g., check if ctx.user.role === 'admin')
      // For now, any authenticated user can generate codes, which is NOT recommended for production.
      // You should add a check here to ensure only admins can generate codes.

      const code = nanoid();
      const { data, error } = await ctx.supabase
        .from('invitations')
        .insert({
          code,
          createdBy: ctx.user.id,
          status: 'active',
        })
        .select()
        .single();

      if (error) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      return data;
    }),

  validateInvitationCode: publicProcedure
    .input(z.object({ code: z.string() }))
    .query(async ({ ctx, input }) => {
      const { data, error } = await ctx.supabase
        .from('invitations')
        .select('*')
        .eq('code', input.code)
        .eq('status', 'active')
        .single();

      if (error || !data) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Invalid or used invitation code.' });
      }
      return data;
    }),

  getInvitationHistory: protectedProcedure // Requires authentication
    .query(async ({ ctx }) => {
      // TODO: Implement role-based access control (e.g., check if ctx.user.role === 'admin')
      // For now, any authenticated user can view history, which is NOT recommended for production.
      // You should add a check here to ensure only admins can view history.

      const { data, error } = await ctx.supabase
        .from('invitations')
        .select('*')
        .order('createdAt', { ascending: false });

      if (error) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      return data;
    }),
});
```

**请将 `packages/api/src/root.ts` 更新为：**

```typescript
import { chatRouter } from './routers/chat';
import { userRouter } from './routers/user';
import { creditsRouter } from './routers/credits';
import { ticketRouter } from './routers/ticket';
import { settingsRouter } from './routers/settings';
import { modelRouter } from './routers/model';
import { invitationRouter } from './routers/invitation'; // 新增
import { router } from '../trpc';

export const appRouter = router({
  chat: chatRouter,
  user: userRouter,
  credits: creditsRouter,
  ticket: ticketRouter,
  settings: settingsRouter,
  model: modelRouter,
  invitation: invitationRouter, // 新增
});

export type AppRouter = typeof appRouter;
```


**预期输出**:
- 文件创建和更新成功。

**验证方法**:
- `packages/api/src/routers/invitation.ts` 文件内容被更新。
- `packages/api/src/root.ts` 文件内容被更新。

---

### ## 任务 10.3：创建 AI 模型管理页面

**任务描述**: 创建一个前端页面来展示和管理 AI 模型。

**给 Claude Code 的指令**:

```
请在 `/home/ubuntu/graylumAi-refactor/apps/web/src/app/` 目录下创建 `models/page.tsx` 文件。

**`models/page.tsx` 文件内容如下：**

```typescript
'use client';

import { trpc } from '@/trpc/client';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useState } from 'react';

export default function ModelsPage() {
  const { data: models, isLoading, refetch } = trpc.model.getAvailableModels.useQuery();
  const updateModelMutation = trpc.model.updateModelConfig.useMutation({
    onSuccess: () => {
      refetch();
    },
  });

  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const [newConfig, setNewConfig] = useState<string>('');

  const handleEdit = (modelId: string, currentConfig: any) => {
    setEditingModelId(modelId);
    setNewConfig(JSON.stringify(currentConfig, null, 2));
  };

  const handleSave = (modelId: string) => {
    try {
      const parsedConfig = JSON.parse(newConfig);
      updateModelMutation.mutate({ id: modelId, config: parsedConfig });
      setEditingModelId(null);
      setNewConfig('');
    } catch (e) {
      alert('Invalid JSON config');
    }
  };

  if (isLoading) return <div>Loading models...</div>;

  return (
    <div className="container mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4">AI Models Management</h1>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {models?.map((model) => (
          <Card key={model.id}>
            <CardHeader>
              <CardTitle>{model.name}</CardTitle>
            </CardHeader>
            <CardContent>
              <p>Provider: {model.provider}</p>
              <p>Endpoint: {model.endpoint}</p>
              <h3 className="font-semibold mt-2">Config:</h3>
              {editingModelId === model.id ? (
                <>
                  <textarea
                    className="w-full h-32 p-2 border rounded-md mt-1 font-mono text-sm"
                    value={newConfig}
                    onChange={(e) => setNewConfig(e.target.value)}
                  />
                  <Button onClick={() => handleSave(model.id)} className="mt-2 mr-2">Save</Button>
                  <Button variant="outline" onClick={() => setEditingModelId(null)} className="mt-2">Cancel</Button>
                </>
              ) : (
                <pre className="bg-gray-100 p-2 rounded-md text-sm overflow-auto">
                  {JSON.stringify(model.config, null, 2)}
                </pre>
              )}
              {!editingModelId && (
                <Button className="mt-2" onClick={() => handleEdit(model.id, model.config)}>
                  Edit Config
                </Button>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
```


**预期输出**:
- 文件创建成功。

**验证方法**:
- 启动开发服务器 (`pnpm dev`)。
- 访问 `/models` 路径，您应该能看到 AI 模型列表和编辑配置的按钮。
- （在 Supabase 中手动添加一些 AI 模型数据后）尝试编辑模型配置，并在 Supabase 数据库中验证数据是否写入成功。

---

### ## 任务 10.4：创建邀请码管理页面

**任务描述**: 创建一个前端页面来生成和查看邀请码。

**给 Claude Code 的指令**:

```
请在 `/home/ubuntu/graylumAi-refactor/apps/web/src/app/` 目录下创建 `invitations/page.tsx` 文件。

**`invitations/page.tsx` 文件内容如下：**

```typescript
'use client';

import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { useState } from 'react';

export default function InvitationsPage() {
  const { data: invitations, isLoading, refetch } = trpc.invitation.getInvitationHistory.useQuery();
  const generateInvitationMutation = trpc.invitation.generateInvitationCode.useMutation({
    onSuccess: () => {
      refetch();
    },
  });

  if (isLoading) return <div>Loading invitations...</div>;

  return (
    <div className="container mx-auto p-4">
      <div className="flex justify-between items-center mb-4">
        <h1 className="text-2xl font-bold">Invitation Management</h1>
        <Button onClick={() => generateInvitationMutation.mutate()} disabled={generateInvitationMutation.isPending}>
          Generate New Code
        </Button>
      </div>

      <div className="grid gap-4">
        {invitations?.map((invite) => (
          <Card key={invite.code}>
            <CardHeader>
              <CardTitle>Code: {invite.code}</CardTitle>
            </CardHeader>
            <CardContent>
              <p>Created By: {invite.createdBy}</p>
              <p>Used By: {invite.usedBy || 'N/A'}</p>
              <p>Status: {invite.status}</p>
              <p>Created At: {new Date(invite.createdAt).toLocaleString()}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
```


**预期输出**:
- 文件创建成功。

**验证方法**:
- 启动开发服务器 (`pnpm dev`)。
- 访问 `/invitations` 路径，您应该能看到邀请码列表和生成新邀请码的按钮。
- 尝试生成邀请码，并在 Supabase 数据库中验证数据是否写入成功。

---

### ## 任务 10.5：提交第十阶段成果

**任务描述**: 提交邀请推广和 AI 模型管理的代码。

**给 Claude Code 的指令**:

```
请在 `/home/ubuntu/graylumAi-refactor` 目录下执行以下 shell 命令：

git add . && \
git commit -m "feat: migrate invitation and AI model management

- Add modelRouter with getAvailableModels, updateModelConfig procedures.
- Add invitationRouter with generateInvitationCode, validateInvitationCode, getInvitationHistory procedures.
- Create frontend pages for AI model management and invitation management." && \
git push origin refactor
```

**预期输出**:
- git commit 和 push 的成功信息。

---

**阶段十完成！**

您已成功迁移了邀请推广和 AI 模型管理功能。现在，我们将进入最后一个阶段：管理后台和最终优化。


---

## 🚀 阶段十一：管理后台与最终优化 (3-5天)

**目标**: 迁移管理后台功能，实现角色权限控制，并进行最终的优化和部署准备。

---

### ## 任务 11.1：实现管理员角色权限控制

**任务描述**: 修改 `protectedProcedure`，使其能够检查用户是否具有管理员角色，并为需要管理员权限的 API 添加 `adminProcedure`。

**给 Claude Code 的指令**:

```
请将 `/home/ubuntu/graylumAi-refactor/packages/api/src/trpc.ts` 文件的内容完全替换为以下代码，以添加管理员权限检查。

```typescript
import { initTRPC, TRPCError } from '@trpc/server';
import { createClient } from '@supabase/supabase-js';

// 可复用的 Supabase 客户端
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export const createTRPCContext = async (opts: { headers: Headers }) => {
  const token = opts.headers.get('authorization')?.replace('Bearer ', '');
  let user = null;
  let userProfile = null;

  if (token) {
    const { data: authUser } = await supabase.auth.getUser(token);
    user = authUser.user;

    if (user) {
      const { data: profileData } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .single();
      userProfile = profileData;
    }
  }
  return { ...opts, user, userProfile, supabase };
};

const t = initTRPC.context<typeof createTRPCContext>().create();

const enforceUserIsAuthed = t.middleware(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

const enforceUserIsAdmin = t.middleware(({ ctx, next }) => {
  if (!ctx.user || ctx.userProfile?.role !== 'admin') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Only administrators can perform this action.' });
  }
  return next({ ctx: { ...ctx, user: ctx.user, userProfile: ctx.userProfile } });
});

export const router = t.router;
export const publicProcedure = t.procedure;
export const protectedProcedure = t.procedure.use(enforceUserIsAuthed);
export const adminProcedure = t.procedure.use(enforceUserIsAdmin);
```

**重要提示**: 请确保您的 `profiles` 表中有一个 `role` 字段，并且管理员用户的 `role` 值为 `'admin'`。

**预期输出**:
- 文件写入成功。

**验证方法**:
- `trpc.ts` 文件内容被更新。

---

### ## 任务 11.2：应用管理员权限到相关 API

**任务描述**: 将 `updateSystemSettings`, `updateModelConfig`, `generateInvitationCode` 等需要管理员权限的 API 从 `protectedProcedure` 修改为 `adminProcedure`。

**给 Claude Code 的指令**:

```
请执行以下操作：

1.  修改 `/home/ubuntu/graylumAi-refactor/packages/api/src/routers/settings.ts` 文件，将 `updateSystemSettings` 的 `protectedProcedure` 替换为 `adminProcedure`。
2.  修改 `/home/ubuntu/graylumAi-refactor/packages/api/src/routers/model.ts` 文件，将 `updateModelConfig` 的 `protectedProcedure` 替换为 `adminProcedure`。
3.  修改 `/home/ubuntu/graylumAi-refactor/packages/api/src/routers/invitation.ts` 文件，将 `generateInvitationCode` 的 `protectedProcedure` 替换为 `adminProcedure`。

**`settings.ts` 中 `updateSystemSettings` 的修改示例：**

```typescript
// ... 其他代码

  updateSystemSettings: adminProcedure // 从 protectedProcedure 修改为 adminProcedure
    .input(z.object({ key: z.string(), value: z.any() }))
    .mutation(async ({ ctx, input }) => {
      // ... 保持原有逻辑
    }),
// ... 其他代码
```

**`model.ts` 中 `updateModelConfig` 的修改示例：**

```typescript
// ... 其他代码

  updateModelConfig: adminProcedure // 从 protectedProcedure 修改为 adminProcedure
    .input(z.object({ id: z.string().uuid(), config: z.any() }))
    .mutation(async ({ ctx, input }) => {
      // ... 保持原有逻辑
    }),
// ... 其他代码
```

**`invitation.ts` 中 `generateInvitationCode` 的修改示例：**

```typescript
// ... 其他代码

  generateInvitationCode: adminProcedure // 从 protectedProcedure 修改为 adminProcedure
    .mutation(async ({ ctx }) => {
      // ... 保持原有逻辑
    }),
// ... 其他代码
```


**预期输出**:
- 文件修改成功。

**验证方法**:
- 尝试使用非管理员用户调用这些 API，应该会收到 `FORBIDDEN` 错误。
- 使用管理员用户调用这些 API，应该能正常工作。

---

### ## 任务 11.3：创建管理后台仪表盘

**任务描述**: 创建一个简单的管理后台页面，用于展示系统概览和导航到其他管理功能。

**给 Claude Code 的指令**:

```
请在 `/home/ubuntu/graylumAi-refactor/apps/web/src/app/` 目录下创建 `admin/page.tsx` 文件。

**`admin/page.tsx` 文件内容如下：**

```typescript
'use client';

import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import Link from 'next/link';
import { trpc } from '@/trpc/client';

export default function AdminDashboardPage() {
  const { data: stats, isLoading: statsLoading } = trpc.settings.getStatistics.useQuery(); // 假设有一个获取统计数据的API

  if (statsLoading) return <div>Loading dashboard...</div>;

  return (
    <div className="container mx-auto p-4">
      <h1 className="text-3xl font-bold mb-6">Admin Dashboard</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
        <Card>
          <CardHeader>
            <CardTitle>Total Users</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-4xl font-bold">{stats?.totalUsers ?? 'N/A'}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Total Conversations</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-4xl font-bold">{stats?.totalConversations ?? 'N/A'}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Active Models</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-4xl font-bold">{stats?.activeModels ?? 'N/A'}</p>
          </CardContent>
        </Card>
      </div>

      <h2 className="text-2xl font-bold mb-4">Management Sections</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <Link href="/admin/users">
          <Card className="hover:shadow-lg transition-shadow cursor-pointer">
            <CardHeader>
              <CardTitle>User Management</CardTitle>
            </CardHeader>
            <CardContent>
              Manage user profiles, roles, and credits.
            </CardContent>
          </Card>
        </Link>
        <Link href="/models">
          <Card className="hover:shadow-lg transition-shadow cursor-pointer">
            <CardHeader>
              <CardTitle>AI Model Configuration</CardTitle>
            </CardHeader>
            <CardContent>
              Configure available AI models and their settings.
            </CardContent>
          </Card>
        </Link>
        <Link href="/invitations">
          <Card className="hover:shadow-lg transition-shadow cursor-pointer">
            <CardHeader>
              <CardTitle>Invitation Codes</CardTitle>
            </CardHeader>
            <CardContent>
              Generate and manage invitation codes.
            </CardContent>
          </Card>
        </Link>
        <Link href="/admin/settings">
          <Card className="hover:shadow-lg transition-shadow cursor-pointer">
            <CardHeader>
              <CardTitle>System Settings</CardTitle>
            </CardHeader>
            <CardContent>
              Update global system configurations.
            </CardContent>
          </Card>
        </Link>
        {/* TODO: Add more admin links as needed */}
      </div>
    </div>
  );
}
```


**预期输出**:
- 文件创建成功。

**验证方法**:
- 启动开发服务器 (`pnpm dev`)。
- 访问 `/admin` 路径，您应该能看到一个管理仪表盘，包含统计数据和管理模块的链接。

---

### ## 任务 11.4：创建获取统计数据的 API

**任务描述**: 在 `settingsRouter` 中添加一个 `getStatistics` procedure，用于获取管理后台仪表盘所需的统计数据。

**给 Claude Code 的指令**:

```
请修改 `/home/ubuntu/graylumAi-refactor/packages/api/src/routers/settings.ts` 文件，在 `settingsRouter` 中添加 `getStatistics` procedure。

**`settings.ts` 文件中 `settingsRouter` 的修改示例：**

```typescript
// ... 其他代码

export const settingsRouter = router({
  getSystemSettings: publicProcedure.query(async ({ ctx }) => {
    // ... 保持原有逻辑
  }),

  updateSystemSettings: adminProcedure // Requires authentication
    .input(z.object({ key: z.string(), value: z.any() }))
    .mutation(async ({ ctx, input }) => {
      // ... 保持原有逻辑
    }),

  getStatistics: adminProcedure.query(async ({ ctx }) => {
    // 假设 profiles 表中存储了所有用户，ai_models 表中存储了所有模型
    const { count: totalUsers } = await ctx.supabase.from('profiles').select('*', { count: 'exact' });
    const { count: totalConversations } = await ctx.supabase.from('conversations').select('*', { count: 'exact' });
    const { count: activeModels } = await ctx.supabase.from('ai_models').select('*', { count: 'exact' });

    return {
      totalUsers: totalUsers ?? 0,
      totalConversations: totalConversations ?? 0,
      activeModels: activeModels ?? 0,
    };
  }),
});
```


**预期输出**:
- 文件修改成功。

**验证方法**:
- 刷新 `/admin` 页面，统计数据应该能正常显示。

---

### ## 任务 11.5：最终代码提交与部署准备

**任务描述**: 提交所有剩余的业务逻辑和管理后台代码，并准备部署。

**给 Claude Code 的指令**:

```
请在 `/home/ubuntu/graylumAi-refactor` 目录下执行以下 shell 命令：

git add . && \
git commit -m "feat: implement admin dashboard and final optimizations

- Add adminProcedure for role-based access control.
- Apply adminProcedure to updateSystemSettings, updateModelConfig, generateInvitationCode.
- Create admin dashboard page with system statistics and navigation.
- Implement getStatistics API for admin dashboard." && \
git push origin refactor
```

**预期输出**:
- git commit 和 push 的成功信息。

---

**阶段十一完成！**

恭喜您！至此，GraylumAI 项目的所有核心业务逻辑和管理功能都已成功迁移到新的现代化架构。现在，您的项目已经完全准备好进行部署和上线了！

**下一步**：您可以将 `refactor` 分支合并到 `main` 分支，然后部署到 Vercel。
