---
description: 新增前端页面
---

# 📄 新增前端页面 (Add Page)

为 GraylumAI Web 项目新增页面的规范。

## 1. 确认路径与布局
决定页面需要放在 `apps/web/src/app/(chat)`、`apps/web/src/app/admin` 还是新的业务目录下。

## 2. 页面结构 (Page Structure)
- 创建 `page.tsx`。
- 如果需要服务端渲染获取初始状态，使用 Server Component。否则使用 `use client` 并依赖 `trpc` 查询数据。
- 引入对应的 `layout.tsx` 提供共享布局。

## 3. 样式与状态
- 统一使用 TailwindCSS 进行原子类编写，颜色一律调用 CSS 变量，例如 `bg-[var(--bg-primary)]`。
- 如果页面包含表单，使用 Radix UI 或 shadcn/ui 组件。

## 4. Auth 与权限
确保页面处于正确的 auth 分支。如果是公开页面，请修改 `apps/web/middleware.ts` 中的 `PUBLIC_PATHS`。如果属于管理员页面，使用 `adminProcedure` 和前端身份检查机制。
