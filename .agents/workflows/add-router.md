---
description: 新增 tRPC API 路由
---

# 🔗 新增 API 路由 (Add tRPC Router)

在后端新增一套 tRPC 路由的方法与约定。

## 1. 创建 Router 文件
在 `packages/api/src/routers/` 新建类似于 `[feature].ts` 的文件。
```typescript
import { router, publicProcedure, protectedProcedure, adminProcedure } from '../trpc';
import { z } from 'zod';

export const featureRouter = router({
  getFeature: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      // 业务逻辑
    })
});
```

## 2. 导出到 Root Router
修改 `packages/api/src/root.ts`：
- `import { featureRouter } from './routers/feature';`
- 在 `appRouter` 中添加 `feature: featureRouter,`

## 3. 调用 API
前端在页面或组件中使用 `trpc.feature.getFeature.useQuery({ id })` 获取数据。
