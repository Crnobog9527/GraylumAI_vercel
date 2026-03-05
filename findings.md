# Findings & Decisions

## 📋 阶段 12: 遗留问题清理与系统稳定化 (2026-03-06)

> **决策时间**: 2026-03-06
> **触发**: 阶段 0-11 全部完成后，对三份核心文档 (task_plan.md / progress.md / findings.md) 进行全面复盘
> **目标**: 清理所有遗留待办项，使系统进入稳定可交付状态

### 复盘发现

对 `task_plan.md` 中所有 `⏳ 待修复` / `⏳ 待验证` 标记进行交叉验证后，发现：

| 分类 | 数量 | 说明 |
|------|------|------|
| 真正已修复但归档区未更新 | ~15 | P2-B/P2-C/P2-D/P3 等在后续阶段修复，但归档区标记未同步 |
| 阶段 10/11 修复完成但未验证 | 10 | 代码已改，验证步骤从未执行 |
| 系统设置生效性未验证 | 9 | system_settings 多项配置未确认是否被读取 |
| 管理后台数据准确性 | 8 | 财务统计、性能监控、诊断检查的数据来源问题 |
| 订阅管理 UI 问题 | 6 | 热门推荐、样式、年付总价等 |
| 成本监控 UI + 用户菜单 | 4 | 排版拥挤、API 状态、绿色高亮、管理入口 |

### 决策: 4 步骤分阶段清理

**执行原则**: 先验证再修复，先后端再前端，先核心再边缘

#### 步骤 1: 验证已完成工作 (阶段 10/11)
- **优先级**: 🔴 最高
- **内容**: 在浏览器中手动验证 AI 对话功能、模型管理、积分计费
- **理由**: 代码已写完但从未验证，是整个系统最大的不确定性

#### 步骤 2: 系统设置生效性审计 (#28-41)
- **优先级**: 🟠 高
- **内容**: 代码审计聊天页面和流式端点，确认 system_settings 哪些配置被读取
- **理由**: 避免管理员看到的设置面板是"假的"

#### 步骤 3: 管理后台数据修复 (#13, #15-17, #20-27)
- **优先级**: 🟡 中
- **内容**: 修复财务统计、性能监控、诊断健康检查的数据来源
- **理由**: 影响管理员决策的数据准确性

#### 步骤 4: UI 与体验优化 (#6-11, #18-19, #49-52)
- **优先级**: 🟢 低
- **内容**: 订阅管理样式、页面设置功能、成本监控排版
- **理由**: 不影响核心功能，属于体验优化

### 关于归档区遗留标记的处理

**决策**: 不修改归档区历史记录（保持原始状态），在新阶段 12 中统一跟踪实际状态。

| 归档区问题 | 实际状态 | 阶段 12 处理 |
|-----------|---------|-------------|
| #1-2 AI 模型配置/状态 | ✅ 阶段 10 已修复 | 步骤 1 验证 |
| #3-5 功能广场模块 | ✅ P2-B 已修复 | 无需处理 |
| #6-11 订阅管理 | ⚠️ #6-7 已有 API 但 UI 未更新 | 步骤 4 |
| #12 状态栏图标 | ✅ P3-1 已修复 | 无需处理 |
| #14 财务单位统一 | ✅ P3-2 已修复 | 无需处理 |
| #18-19 页面设置 | ✅ P2-C 标记已修复 | 步骤 1 验证 |
| #51-52 菜单高亮/管理入口 | ✅ P3-4/P3-5 已修复 | 无需处理 |

---

## 🔄 工作范式整合: auto-coding-agent-demo (2026-03-06)

> **来源**: [SamuelQZQ/auto-coding-agent-demo](https://github.com/SamuelQZQ/auto-coding-agent-demo)
> **决策**: 部分借鉴，采用混合范式（结构化任务 + 对话式协作）

### 评估结论

该项目为从零开发的全自动编程实验，核心是 `CLAUDE.md` + `task.json` + `progress.txt` 的三件套。经评估：
- **适合借鉴**: 结构化任务队列、环境初始化、阻塞处理规则、进度日志标准化
- **不适合套用**: 无人值守执行、跳过权限检查、简单 lint+build 验证

### 整合的具体内容

| 借鉴项 | 落地方式 | 文件 |
|--------|---------|------|
| 结构化任务队列 | `task.json` 26 项任务，含 passes/blocked/priority/type 字段 | `task.json` |
| 环境初始化脚本 | `init.sh` 检查 Node/pnpm/env/dev server/任务进度 | `init.sh` |
| 标准化执行流程 | `/do-next` workflow 定义 6 步执行循环 | `.agents/workflows/do-next.md` |
| 阻塞处理规则 | 写入 `/do-next` workflow，禁止假装完成 | `.agents/workflows/do-next.md` |
| 进度日志格式 | 三段式：完成内容 / 验证方式 / 备注 | `/do-next` workflow |
| 单任务单 commit | 每完成一个修复项独立 commit | `/do-next` workflow |

### 与原项目的关键差异

| 维度 | auto-coding-agent-demo | GraylumAI 混合范式 |
|------|----------------------|-------------------|
| 人工参与 | 最小化 | 每阶段审阅 |
| 执行方式 | `--dangerously-skip-permissions` | 对话式协作 |
| 任务格式 | JSON only | JSON (task.json) + Markdown (task_plan.md) 并行 |
| 验证方式 | lint + build + Playwright | 代码审计 + 浏览器测试 + 数据验证 |

---

## 🔴 AI 对话功能诊断报告 (2026-01-24)

> **诊断文档**: `AI_DIALOGUE_DIAGNOSTIC_REPORT.md`

### 根本原因

**AI 对话功能完全无法工作的核心原因**：前端调用了占位符 API (`chat.sendMessage`)，而完整的 AI 实现从未被集成。

存在三套独立实现但未正确连接：
1. `chat.sendMessage` - **占位符**（当前被调用，只回显输入）
2. `ai.sendMessage` - **完整实现**（从未被调用）
3. 流式处理链路 - **完整实现**（从未被调用）

### 问题汇总

| 优先级 | 问题数量 | 影响范围 |
|--------|----------|----------|
| P0 (致命) | 4 | 功能完全不可用 |
| P1 (严重) | 3 | 功能缺陷或安全风险 |
| P2 (中等) | 3 | 功能不完整 |
| P3 (轻微) | 2 | 代码质量问题 |

### P0 致命问题

| ID | 问题 | 位置 | 原因 |
|----|------|------|------|
| P0-1 | chat.sendMessage 是占位符 | `packages/api/src/routers/chat.ts:121` | 只回显用户输入，未调用 AI |
| P0-2 | 前端调用错误的 API | `apps/web/src/app/chat/page.tsx` | 调用 chat.sendMessage 而非 ai.sendMessage |
| P0-3 | 流式处理未集成 | `streamHandler.ts`, `useStreamingChat.ts` | 完整实现存在但从未被调用 |
| P0-4 | ai.sendMessage 前端未调用 | `packages/api/src/routers/ai.ts:251-479` | 完整实现存在但前端从未调用 |

### P1 严重问题

| ID | 问题 | 位置 | 原因 |
|----|------|------|------|
| P1-1 | 输出安全过滤未应用 | `packages/api/src/routers/ai.ts:383-397` | 代码标记为 TODO |
| P1-2 | 签名验证未使用 | `packages/api/src/services/requestSigner.ts` | 前端从未签名，后端验证可选 |
| P1-3 | 计费价格来源与 UI 不一致 | `packages/api/src/services/billing.ts` | 从 ai_models 表读取，非 system_settings |

### P2 中等问题

| ID | 问题 | 位置 | 原因 |
|----|------|------|------|
| P2-1 | 前端缺少错误处理 | `apps/web/src/app/chat/page.tsx` | 无 onError 回调 |
| P2-2 | 使用量统计未连接 | `packages/api/src/routers/ai.ts:420-445` | ai.sendMessage 从未被调用 |
| P2-3 | 上下文长度限制未实现 | `packages/api/src/routers/ai.ts:300-320` | 代码标记为 TODO |

### P3 轻微问题

| ID | 问题 | 位置 | 原因 |
|----|------|------|------|
| P3-1 | 重复的类型定义 | `packages/api/src/types/ai.ts` + 内联类型 | 维护困难 |
| P3-2 | 环境变量验证不完整 | `apps/web/src/app/api/ai/stream/route.ts` | 缺少详细日志 |

---

## ✅ 修复方案: 集成流式处理（方案 A）

> **推荐方案**：集成流式处理（方案 A）

### 方案概述

| 属性 | 值 |
|------|------|
| 优先级 | P0 |
| 工作量 | 中等 |
| 风险 | 低 |

### 架构修正

```
当前状态 (错误):
┌─────────────────┐     调用      ┌───────────────────┐
│  Chat Page      │ ────────────→ │ chat.sendMessage  │ (占位符!)
│  (前端)         │               │ 只回显输入        │
└─────────────────┘               └───────────────────┘

目标状态 (正确):
┌─────────────────┐     调用      ┌───────────────────┐
│  Chat Page      │ ────────────→ │ /api/ai/stream    │
│  (前端)         │  SSE 连接     │ + StreamHandler   │
│  + useStreaming │               │ + 计费集成        │
│    Chat Hook    │               │ + 智能路由        │
└─────────────────┘               └───────────────────┘
```

### 修复步骤

| 步骤 | 任务 | 涉及文件 | 工作量 |
|------|------|---------|--------|
| 1 | 修改前端调用流式 API | `apps/web/src/app/chat/page.tsx` | 中 |
| 2 | 集成 useStreamingChat Hook | `apps/web/src/hooks/useStreamingChat.ts` | 小 |
| 3 | 添加错误处理和加载状态 | `apps/web/src/app/chat/page.tsx` | 小 |
| 4 | 验证环境变量配置 | `.env`, Vercel 环境变量 | 小 |
| 5 | 测试计费和智能路由 | 端到端测试 | 中 |

### 关键代码修改

**1. 前端 chat/page.tsx 修改**:
```typescript
// 移除
const sendMessage = trpc.chat.sendMessage.useMutation({...});

// 替换为
import { useStreamingChat } from '@/hooks/useStreamingChat';
const { sendMessage, isStreaming, error } = useStreamingChat({
  conversationId,
  onMessage: (content) => { /* 更新消息列表 */ },
  onComplete: () => { /* 刷新消息列表 */ },
  onError: (error) => { /* 显示错误提示 */ },
});
```

**2. 验证环境变量**:
```bash
ANTHROPIC_API_KEY=sk-ant-xxx  # 必须配置
DATABASE_URL=xxx              # 必须配置
```

---

## 🚨 待修复问题 (2026-01-23)

### 对话功能失效

| # | 问题 | 位置 | 原因 | 状态 |
|---|------|------|------|------|
| 1 | 对话功能失效 | `chat/page.tsx` | 前端调用了占位符 API | ⏳ 待修复 |

**问题描述**: 发送对话后只收到 "Echo: [原消息]" 回复，AI 功能完全不可用。

**根本原因** (2026-01-24 诊断确认):
- 前端调用 `trpc.chat.sendMessage`（占位符）
- 完整的 AI 实现在 `trpc.ai.sendMessage` 和流式处理链路中
- 三套实现从未正确集成

**修复方案**: 方案 A - 集成流式处理（见上文）

---

## ✅ 已修复问题 (2026-01-23)

### 工单附件功能

| # | 问题 | 位置 | 原因 | 状态 |
|---|------|------|------|------|
| 1 | 工单上传图片不显示 | `TicketsPanel.tsx` | 附件上传是 mock 代码，未实际上传到存储 | ✅ 已修复 |
| 2 | 管理员后台附件图片不显示 | `admin/tickets/page.tsx` | 代码只显示 Lucide Image 图标，未渲染实际 `<img>` 标签 | ✅ 已修复 |

**修复内容**:
- 创建 `/api/upload/route.ts` 文件上传 API，支持上传到 Supabase Storage
- `ticket.ts` 路由支持 attachments 参数
- `TicketsPanel.tsx` 实现真实文件上传和附件展示
- `admin/tickets/page.tsx` 修复附件图片渲染，使用 `<img>` 标签

---

## 🚨 首页数据集成 Bug (2026-01-23)

### 问题发现

用户登录后，首页存在 4 个严重的数据集成问题：

| # | 问题 | 影响 | 严重程度 |
|---|------|------|---------|
| 1 | 积分 API 404 | Header 积分显示 "--" | 🔴 P0 |
| 2 | 用户名硬编码 | 所有用户显示 "office" | 🔴 P0 |
| 3 | 会员等级硬编码 | 所有用户显示 "普通会员" | 🔴 P0 |
| 4 | 公告硬编码 | 管理后台公告无法显示 | 🟡 P1 |

### 根本原因分析

**1. 积分 API 404 (`credits.getBalance`)**

- **位置**: `apps/web/src/hooks/use-credits.tsx:19`
- **调用**: `trpc.credits.getBalance.useQuery()`
- **可能原因**:
  - tRPC context 中 `profileId` 未正确设置
  - Supabase 认证 token 未正确传递到 API
  - 路由配置问题

**2. 用户数据硬编码**

- **位置**: `apps/web/src/app/page.tsx:66-71`
- **当前代码**:
```javascript
const user = {
  full_name: 'office',                    // ❌ 硬编码
  email: 'office@example.com',            // ❌ 硬编码
  membership_level: 'free',               // ❌ 硬编码
  membership_expiry_date: undefined
};
```
- **修复方案**: 调用 `trpc.user.getProfile.useQuery()` 获取真实数据

**3. 公告数据硬编码**

- **位置**: `apps/web/src/app/page.tsx:74-84`
- **当前代码**:
```javascript
const announcements = [
  {
    id: '1',
    title: '应用上线特惠',               // ❌ 硬编码
    description: '黄金会员年卡 5 折...',  // ❌ 硬编码
    ...
  }
];
```
- **修复方案**: 调用 `trpc.admin.getActiveAnnouncements.useQuery()` 获取

### 修复任务清单

| # | 任务 | 交付物 | 状态 |
|---|------|--------|------|
| 1 | 调试积分 API 404 | 修复 tRPC context | ✅ 已有 |
| 2 | 集成用户 profile 数据 | page.tsx 调用 tRPC | ✅ 完成 |
| 3 | 集成公告 API | page.tsx 调用 announcements API | ✅ 完成 |
| 4 | 测试验证 | 确保数据正确显示 | ✅ 完成 |

### 修复详情 (2026-01-23)

**修改的文件**:

| 文件 | 修改内容 |
|------|---------|
| `packages/api/src/routers/settings.ts` | 新增 `getActiveAnnouncements` 和 `getBannerAnnouncement` 公开 API |
| `apps/web/src/app/page.tsx` | 使用 tRPC 获取用户 profile 和公告数据 |
| `apps/web/src/components/home/UpdatesSection.tsx` | 添加 yellow 标签颜色支持 |

**关键修复**:

1. **用户数据**: 调用 `trpc.user.getUserProfile.useQuery()` 获取真实用户数据
   ```javascript
   const user = {
     full_name: userProfile?.nickname || userProfile?.email?.split('@')[0] || '用户',
     membership_level: userProfile?.membership_level || 'free',
   };
   ```

2. **公告数据**: 新建公开 API `settings.getActiveAnnouncements`
   - 原 `admin.getActiveAnnouncements` 使用 `adminProcedure`，普通用户无法访问
   - 新 API 使用 `publicProcedure`，返回活跃公告列表

3. **积分 API**: 检查发现 `credits.getBalance` 实现正确，404 可能是 session 时序问题
   - tRPC provider 已正确配置 Authorization header
   - 建议：确保 auth session 稳定后再请求

---

## 着陆页与访问控制实施决策 (2026-01-23)

### 任务概述

实现标准 SaaS 网站的访问逻辑：
- **www.graylum.com** - 公开营销着陆页
- **app.graylum.com** - 应用后台（需登录）
- **graylum.com** - 重定向到 www

### 技术架构决策

#### 1. 路由组结构

**决策**: 使用 Next.js 16 路由组分离着陆页和应用

```
apps/web/src/app/
├── (landing)/              # 公开页面 (www 域名)
│   ├── layout.tsx          # 着陆页独立布局
│   └── page.tsx            # 着陆页首页
├── (app)/                  # 应用页面 (app 域名)
│   ├── layout.tsx          # 应用布局 (带 tRPC Provider)
│   ├── page.tsx            # 应用首页 (Dashboard)
│   ├── admin/              # 管理后台
│   ├── chat/               # AI 对话
│   ├── marketplace/        # 应用市场
│   ├── profile/            # 个人设置
│   └── login/              # 登录页面
├── layout.tsx              # 根布局 (共享)
└── globals.css             # 全局样式
```

**理由**:
- 路由组 `()` 不影响 URL 结构
- 允许独立的布局和样式
- 便于维护和扩展

#### 2. 中间件访问控制策略

**决策**: 修改 `middleware.ts` 实现域名路由和认证拦截

```typescript
// 访问控制逻辑
const hostname = request.headers.get('host') || ''
const isAppDomain = hostname.startsWith('app.')
const isWwwDomain = hostname.startsWith('www.') || !hostname.includes('.')

// app 域名: 检查登录状态
if (isAppDomain) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user && !isPublicPath) {
    return NextResponse.redirect(new URL('/login', request.url))
  }
}
// www 域名: 允许所有访问
```

**公开路径**: `/login`, `/api/*`, `/_next/*`, `/favicon.ico`

#### 3. 着陆页组件架构

**决策**: 创建独立的着陆页组件目录

```
apps/web/src/components/landing/
├── LandingHeader.tsx       # 导航栏 (滚动效果)
├── HeroSection.tsx         # Hero 区域
├── FeaturesSection.tsx     # 6 步增长策略展示
├── PricingSection.tsx      # 定价方案
├── CTASection.tsx          # 行动号召
└── LandingFooter.tsx       # 页脚
```

#### 4. 设计规范

**决策**: 遵循 `VISUAL_DESIGN_SYSTEM.md` 设计系统

| 元素 | 值 | 用途 |
|------|----|----|
| 主色 | `#FFD700` | CTA 按钮、强调文字 |
| 背景 | `#0A0A0A` | 页面背景 |
| 次级背景 | `#1A1A1A` | 卡片、容器 |
| 文字主色 | `#FFFFFF` | 标题、重要内容 |
| 文字次色 | `#B0B0B0` | 描述文字 |

#### 5. CTA 链接策略

**决策**: 所有行动按钮链接到 `app.graylum.com`

- "免费开始" → `https://app.graylum.com/login?action=signup`
- "登录" → `https://app.graylum.com/login`
- "查看定价" → `https://app.graylum.com/login?redirect=/pricing`

### 实施步骤

| 步骤 | 任务 | 预计交付 |
|------|------|---------|
| 1 | 修改中间件添加域名路由 | middleware.ts |
| 2 | 创建 `(landing)` 路由组 | layout.tsx, page.tsx |
| 3 | 移动现有页面到 `(app)` 组 | 文件重组织 |
| 4 | 开发着陆页组件 | 6 个组件 |
| 5 | 测试验证 | 本地 + 生产 |

### 潜在风险与解决方案

| 风险 | 解决方案 |
|------|---------|
| 本地开发无多域名 | 使用环境变量 `NEXT_PUBLIC_APP_ENV` 控制行为 |
| 样式冲突 | 路由组独立布局，不共享 Provider |
| SEO 影响 | 着陆页添加适当的 meta 标签和 sitemap |

---

## 开发规范决策 (2026-01-22)

### 采用新的 7 阶段开发流程

**决策**: 全面采用 `开发规范清单-终极版.md` 作为项目后续维护的标准流程。

**来源**: `movetonew/开发规范清单-终极版.md` (1244 行，2026-01-22 创建)

**核心原则**:
1. **先建监控，再修 BUG** - 没有监控就是盲修
2. **从内到外** - 先保证核心功能（AI、计费）正常
3. **小步快跑** - 每完成一步就验证
4. **留有记录** - 所有测试结果都保存
5. **成本意识** - AI API 成本监控

**7 阶段执行路线**:

| 阶段 | 内容 | 紧急程度 | 重要程度 | 状态 |
|------|------|---------|---------|------|
| **阶段 0** | 系统诊断 | 🔴 高 | 🔴 高 | 🔜 下一步 |
| **阶段 1** | 基础监控 (Sentry + 日志 + 成本仪表板) | 🔴 高 | 🔴 高 | ⏳ 待执行 |
| **阶段 2** | 安全加固 (RLS + 环境变量 + 依赖扫描) | 🟡 中 | 🔴 高 | ⏳ 待执行 |
| **阶段 3** | CI/CD 自动化 | 🟡 中 | 🟡 中 | ⏳ 待执行 |
| **阶段 4** | 性能优化 | 🟢 低 | 🟡 中 | ⏳ 待执行 |
| **阶段 5** | 文档体系 | 🟢 低 | 🟡 中 | ⏳ 待执行 |
| **阶段 6** | 高级优化 | 🟢 低 | 🟢 低 | ⏳ 待执行 |

**阶段 0 首要任务**: 创建系统诊断页面 (`/admin/diagnostics`)
- 11 项测试功能 (AI 5项 + 计费 3项 + 安全 3项)
- Vercel Cron 每小时自动测试
- 测试账号 system-test@graylum.internal

---

## Tech Stack Versions (2026-01-21)

| Category | Package | Version |
|----------|---------|---------|
| **Framework** | Next.js | 16.1.4 |
| | React | 19.2.3 |
| | TypeScript | 5.9.3 |
| **Styling** | Tailwind CSS | 4.1.18 |
| **State & Data** | @tanstack/react-query | 5.90.19 |
| | @trpc/* | 11.8.1 |
| **Database** | @supabase/supabase-js | 2.90.1 |
| | drizzle-orm | 0.45.1 |
| | postgres | 3.4.8 |
| **Validation** | zod | 4.3.5 |
| **UI** | lucide-react | 0.562.0 |
| | @radix-ui/* | 1.1.x - 2.2.x |
| **Build** | turbo | 2.7.5 |
| | pnpm | 10.27.0 |

---

## Phase 10 安全与合规审计发现 (2026-01-21)

### 审计总览

| 类别 | 评分 | 状态 |
|------|------|------|
| 计费安全 | 3.5/5 | ⚠️ 需改进 |
| 前端功能 | 3.0/5 | ⚠️ 需改进 |
| API 安全 | 4.0/5 | ✅ 良好 |
| 数据隐私 | 2.5/5 | 🔴 需修复 |
| AI 优化 | 3.0/5 | ⚠️ 需改进 |
| 可观测性 | 2.5/5 | 🔴 需修复 |
| **总体评分** | **3.1/5** | ⚠️ 部分达标 |

---

### 🔴 P0 严重问题 (必须修复)

#### 1. 费率配置未对齐
- **位置**: `packages/api/src/types/billing.ts:283-305`, `packages/api/src/services/costCalculator.ts:68-114`
- **问题**: 计费系统使用硬编码 `MODEL_PRICING` 常量，完全忽略数据库 `ai_models.token_rate` 字段
- **影响**: 管理后台修改费率无效，需要修改代码重新部署
- **建议**: 创建 `getModelPricing(modelId)` 函数，从数据库实时读取费率

#### 2. Header 积分硬编码
- **位置**: `apps/web/src/components/layout/AppHeader.tsx:38`
- **代码**: `const [credits] = useState(100); // TODO: Get from user context`
- **影响**: 全站所有页面积分显示为硬编码的 100，与实际积分不同步
- **建议**: 调用 `trpc.credits.getBalance.useQuery()` 获取实时积分

#### 3. RLS 策略缺失
- **位置**: `packages/db/migrations/`
- **问题**: 18 个表中仅 3 个启用 RLS (token_stats, billing_history, ai_usage_logs)
- **缺失表**: profiles, conversations, messages, creditTransactions, tickets, ticketReplies, userActivityLogs, prompts, invitationRecords, systemSettings, aiModels 等 15 个
- **影响**: 用户可能越权访问他人数据
- **建议**: 为所有用户数据表添加 `USING (auth.uid() = user_id)` RLS 策略

#### 4. 流式中断未正确实现
- **位置**: `apps/web/src/hooks/useAIChat.ts`, `packages/api/src/routers/ai.ts`
- **问题**:
  - useAIChat 使用 tRPC mutation 而非流式接口
  - abortControllerRef 定义但未被正确使用
  - 中断后无积分结算机制
- **影响**: 用户点击中断后，后端继续计算并扣全额积分
- **建议**: 实现真正的 SSE 流式 API，中断时计算已消耗 tokens 进行部分结算

#### 5. 请求幂等性缺失
- **位置**: `packages/api/src/routers/ai.ts:295-339`
- **问题**: AI 路由的 preDeduct/settle 调用缺少 idempotencyKey
- **影响**: 网络重试可能导致重复扣费
- **建议**: 生成唯一 requestId，添加幂等性检查

#### 6. 事务原子性不足
- **位置**: `packages/api/src/services/billing.ts`
- **问题**:
  - 使用 Supabase REST API，无法使用 PostgreSQL 事务
  - preDeduct/settle/refund 三步操作非原子性
  - 记录插入与余额更新分离
- **影响**: 并发情况下可能数据不一致
- **建议**: 使用 Supabase RPC 函数实现原子操作

---

### 🟡 P1 中等问题 (计划修复)

#### 7. 请求签名/时间戳未实现
- **位置**: `packages/api/src/middleware/securityChecks.ts`
- **问题**: 无 API 请求签名验证，无时间戳校验
- **影响**: 无法防止重放攻击
- **建议**: 实现 HMAC-SHA256 签名 + 30秒时间戳校验

#### 8. 上下文压缩阈值配置不一致
- **位置**: `packages/api/src/services/contextManager.ts:25`
- **问题**:
  - 当前阈值 80000/150000 = 53.3%，非要求的 60%
  - contextManager 稳定区域 5 轮，promptCacheBuilder 稳定区域 3 轮
- **建议**: 统一配置为 90000 (60%) 和 3 轮

#### 9. 递归摘要算法未实现 ✅ 已修复
- **位置**: `packages/api/src/services/contextManager.ts`
- **问题**: 仅实现单层摘要，无递归压缩机制
- **修复**: 实现 `generateRecursiveSummary()` 方法，支持多层摘要链式压缩，最多 5 层，每层压缩比 30%

#### 10. 智能路由关键词不完整
- **位置**: `packages/api/src/services/modelRouter.ts:48-67`
- **问题**: 缺少实时数据关键词（新闻、天气、股票、实时、最新等）
- **影响**: 无法识别需要 Web Search 的查询
- **建议**: 添加 `REALTIME_DATA_KEYWORDS` 正则匹配

#### 11. settle() 缺少成本验证
- **位置**: `packages/api/src/services/billing.ts:229-326`
- **问题**: 接收 actualCredits 参数但未验证与 usage 对应
- **建议**: 添加 `calculateTokenCost(modelId, usage)` 验证

#### 12. 日志信息不完整
- **位置**: `packages/api/src/routers/ai.ts:353-360`
- **问题**: ai_usage_logs 记录缺少 request_id、ip_address、user_agent
- **建议**: 从请求上下文提取并传递完整日志信息

#### 13. 路由系统 window.location 使用
- **位置**:
  - `apps/web/src/app/login/page.tsx:22`
  - `apps/web/src/components/home/SixStepsGuide.tsx:60`
- **问题**: 使用 window.location.href 替代 Next.js useRouter
- **建议**: 改用 `router.push()`

---

### ✅ 已达标项目

| # | 检查项 | 评分 | 位置 |
|---|--------|------|------|
| 1 | 后端积分计算 | 5/5 | billing.ts - calculateTokenCost() |
| 2 | 三段式计费 | 5/5 | billing.ts - preDeduct/settle/refund |
| 3 | tRPC 权限保护 | 5/5 | ai.ts - 全部使用 protectedProcedure |
| 4 | 速率限制 | 5/5 | securityChecks.ts - 60次/分钟 |
| 5 | 消费熔断 | 5/5 | securityChecks.ts - 10000/小时 |
| 6 | 内容审核 | 5/5 | contentModerator.ts - 双向审查 |
| 7 | Prompt 注入防御 | 5/5 | contentModerator.ts - 9种模式检测 |
| 8 | Sidebar 对话切换 | 5/5 | ChatSidebar.tsx + useChatStore |
| 9 | Prompt Caching | 5/5 | promptCacheBuilder.ts - cache_control |
| 10 | 环境安全 | 4/5 | 无通配符 CORS，.env 正确忽略 |
| 11 | CHECK 约束 | 5/5 | profiles.credits >= 0 |

---

### 技术决策

| 决策 | 理由 |
|------|------|
| 费率应从数据库读取 | 硬编码无法通过管理后台配置 |
| 使用 RPC 函数实现原子计费 | REST API 无法保证事务原子性 |
| 所有用户数据表需 RLS | 防止越权访问 |
| 流式 API 需支持中断结算 | 避免用户被扣全额但未完成生成 |
| 请求需唯一 ID | 支持幂等性和链路追踪 |

---

## 数据库表结构

### 核心表
| 表名 | 字段 | 用途 |
|------|------|------|
| `profiles` | id, email, nickname, avatar_url, role, credits, status, membership_level, created_at | 用户资料 |
| `conversations` | id, user_id, title, model_id, created_at | 对话 |
| `messages` | id, conversation_id, role, content, created_at | 消息 |
| `credit_transactions` | id, user_id, amount, type, description, created_at | 积分交易 |

### AI 相关表
| 表名 | 字段 | 用途 |
|------|------|------|
| `ai_models` | id, name, provider, endpoint, config, token_rate, created_at | AI 模型配置 |
| `token_stats` | id, user_id, conversation_id, model_id, input_tokens, output_tokens, cost | Token 统计 |
| `billing_history` | id, user_id, operation, amount, balance_before, balance_after | 计费历史 |
| `ai_usage_logs` | id, user_id, model_id, status, response_time, created_at | AI 使用日志 |

### 业务表
| 表名 | 用途 |
|------|------|
| `tickets` | 工单 |
| `ticket_replies` | 工单回复 |
| `credit_packages` | 积分包 |
| `membership_plans` | 会员套餐 |
| `invitations` | 邀请码 |
| `invitation_records` | 邀请记录 |
| `announcements` | 公告 |
| `prompts` | 提示词模块 |
| `modules` | 功能模块 |
| `system_settings` | 系统设置 |

---

## Environment Variables

```
NEXT_PUBLIC_SUPABASE_URL=<your-supabase-url>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<your-anon-key>
SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>
```

---

## Resources

- **UI 复刻规则**: `movetonew/UIfix_rule.md`
- **AI 重构计划**: `movetonew/GraylumAI_分阶段重构执行计划.md`
- **设计简报**: `AI_REFACTOR_DESIGN_BRIEF.md`
- **旧项目备份**: `/home/user/graylumAi-backup-ref/`
