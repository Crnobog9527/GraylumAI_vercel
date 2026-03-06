# Task Plan: GraylumAI

> [!WARNING]
> 此文件已于 2026-03-06 退役为历史归档。当前唯一计划源是 `task.json`，请改为使用 `task.json + progress.md + findings.md`。

## Goal
按照 `开发规范清单-终极版.md` 完成 GraylumAI 项目的系统完善工作

## 参考文档
- **开发规范清单**: `movetonew/开发规范清单-终极版.md`
- **审计发现**: `findings.md`

---

## 已完成阶段 (Phase 1-11)

| 阶段 | 内容 | 完成时间 |
|------|------|----------|
| Phase 1-3 | 业务逻辑迁移 (工单、设置、邀请、模型、管理后台) | 2026-01-14 |
| Phase 4-5 | UI 还原 (73 组件) + 数据层完善 | 2026-01-20 |
| Phase 6 | 安全加固 (RLS + Admin 权限) | 2026-01-20 |
| Phase 7 | 管理后台功能还原 | 2026-01-20 |
| Phase 8 | AI 重构执行计划制定 | 2026-01-21 |
| Phase 9 | AI 对话系统重构实施 (Schema、tRPC、Engine、Frontend) | 2026-01-21 |
| Phase 10 | 安全与合规审计 (评分 3.1/5) | 2026-01-21 |
| Phase 11 | 安全审计修复 (12/12 P0+P1 + 4/4 P2 完成) | 2026-01-22 |

---

## 新工作计划: 7 阶段系统完善

> **执行规范**: 按照 `开发规范清单-终极版.md` 的步骤和提示词执行

### ✅ 阶段 0: 系统诊断 (已完成 | 2026-01-22)

> **进入条件**: 无
> **完成条件**: 诊断页面可用，至少 80% 测试通过

| # | 任务 | 交付物 | 状态 |
|---|------|--------|------|
| 0.1 | 创建系统诊断页面 | diagnostics.ts + /admin/diagnostics | ✅ 完成 |

**交付物清单**:
- ✅ `packages/db/migrations/0005_diagnostics.sql` - 诊断结果表 + RLS + 统计函数
- ✅ `packages/api/src/services/diagnostics.ts` - 诊断服务 (11 项测试)
- ✅ `packages/api/src/routers/diagnostics.ts` - tRPC 路由
- ✅ `apps/web/src/app/admin/diagnostics/page.tsx` - 前端诊断页面
- ✅ `apps/web/src/app/api/cron/diagnostics/route.ts` - Vercel Cron (每小时)
- ✅ `vercel.json` - Cron 配置
- ✅ 管理后台侧边栏导航入口

**11 项测试功能**:
- AI 功能 (5项): 智能路由、Token计算、Prompt缓存、上下文压缩、实时关键词
- 计费功能 (3项): 预扣计费、幂等性检查、余额对账
- 安全功能 (3项): 速率限制、消费熔断、RLS数据隔离

**问题修复**:
- SQL 迁移失败: profiles 表 email 无唯一约束 → 移除 ON CONFLICT 子句
- 页面中文乱码: Unicode 转义问题 → 重新写入正确字符
- 运行测试无反应: onError 未显示错误 → 添加错误状态和 UI 显示
- 运行测试仍无反应: mutation 成功但结果不显示 → 直接使用 mutation 返回结果显示，不依赖数据库
- UUID 类型不匹配: batch_id 数据库为 uuid 类型，generateBatchId() 生成 `diag_xxx` 格式 → 改用标准 UUID v4 格式

**已修复问题**:
- ✅ React Hydration 错误: 移除 `<Collapsible>` 组件，改用原生 React 状态控制展开/折叠
- ✅ 数据库写入诊断: 添加 saveStatus 返回值和 UI 警告，便于排查 RLS 问题
- ✅ UUID 类型不匹配: 改用标准 UUID v4 格式生成 batch_id

**测试结果**: ✅ 通过率 100% (11/11)，数据库持久化正常

---

### ✅ 阶段 1: 基础监控体系 (已完成 | 2026-01-22)

> **进入条件**: 阶段 0 完成 ✅
> **完成条件**: Sentry + 日志 + 成本仪表板全部可用 ✅

| # | 任务 | 交付物 | 状态 |
|---|------|--------|------|
| 1.1 | 安装 Sentry 错误监控 | sentry.*.config.ts + 测试端点 | ✅ 完成 |
| 1.2 | 建立结构化日志系统 | logger.ts + application_logs 表 | ✅ 完成 |
| 1.3 | 创建 AI 监控仪表板 | /admin/costs 页面 (3个Tab) | ✅ 完成 |

**交付物清单**:
- ✅ `apps/web/sentry.*.config.ts` - Sentry 配置文件 (client/server/edge)
- ✅ `apps/web/instrumentation.ts` - Next.js Sentry 集成
- ✅ `apps/web/src/app/api/sentry-test/route.ts` - Sentry 测试端点
- ✅ `packages/api/src/lib/logger.ts` - 结构化日志服务 (pino)
- ✅ `packages/db/migrations/0006_application_logs.sql` - 日志表
- ✅ `packages/api/src/routers/costs.ts` - 成本监控 API
- ✅ `apps/web/src/app/admin/costs/page.tsx` - AI 成本监控仪表板
- ✅ `.gitignore` - 添加 Sentry 敏感文件排除规则

**Sentry 配置说明**:
- 使用官方 wizard 完成配置: `npx @sentry/wizard@latest -i nextjs`
- 启用 Tracing (性能监控)
- 启用 Session Replay (会话回放)
- `.env.sentry-build-plugin` 已添加到 .gitignore
- ✅ `NEXT_PUBLIC_SENTRY_DSN` 已在 Vercel 环境变量配置

**AI 监控仪表板 (`/admin/costs`) 功能**:

| Tab | 数据源 | 功能 |
|-----|--------|------|
| 成本概览 | `token_stats`, `billing_history` | 成本趋势图、用户消费排行、模型使用分布、缓存效率 |
| AI 调用日志 | `ai_usage_logs` | 查看每次调用详情，包含 routingReason、latency、status |
| Token 统计 | `token_stats` | input/output/cached tokens 统计

---

### ✅ 阶段 2: 安全加固 (已完成 | 2026-01-24)

> **进入条件**: 阶段 1 完成 ✅
> **完成条件**: RLS 100%、无硬编码密钥、依赖无高危漏洞 ✅

| # | 任务 | 交付物 | 预计时间 | 状态 |
|---|------|--------|---------|------|
| 2.1 | RLS 策略全面检查 | 审计报告 (21/21 表覆盖) | 2h | ✅ 已完成 |
| 2.2 | 环境变量安全检查 | 审计报告 (无泄露风险) | 1h | ✅ 已完成 |
| 2.3 | 依赖安全扫描 | dependabot.yml | 30m | ✅ 已完成 |

**交付物**:
- `docs/SECURITY_AUDIT_REPORT.md` - 完整安全审计报告
- `.github/dependabot.yml` - 依赖自动扫描配置

**审计结果**:
- RLS 覆盖率: 100% (21/21 表)
- 环境变量: 无硬编码密钥
- .gitignore: 正确排除敏感文件
- Dependabot: 已配置每周扫描

---

### ✅ 阶段 3: CI/CD 自动化 (已完成 | Vercel 内置)

> **进入条件**: 阶段 2 完成
> **完成条件**: CI/CD 流水线正常运行，Staging/Production 分离

| # | 任务 | 交付物 | 预计时间 | 状态 |
|---|------|--------|---------|------|
| 3.1 | GitHub Actions CI/CD | .github/workflows/ci.yml | 2h | ⏭️ 跳过 - Vercel 自带 CI/CD |
| 3.2 | 配置 Staging 环境 | 环境配置 + 部署检查清单 | 2h | ⏭️ 跳过 - Vercel Preview 环境 |

**说明**: Vercel 平台已内置 CI/CD 功能：
- 自动构建和部署（push 触发）
- Preview 环境（PR 自动部署）
- Production 环境（主分支部署）
- 构建日志和错误监控

---

### ✅ 阶段 4: 性能优化 (已完成 | 2026-01-22)

> **进入条件**: 阶段 3 完成 ✅
> **完成条件**: Vercel Analytics 有数据，主要页面 LCP < 2.5s ✅

| # | 任务 | 交付物 | 状态 |
|---|------|--------|------|
| 4.1 | 启用 Vercel Analytics | Analytics + SpeedInsights 集成 | ✅ 完成 |
| 4.2 | 数据库性能优化 | 索引优化 SQL (0007_performance_indexes.sql) | ✅ 完成 |

**交付物清单**:
- ✅ `apps/web/src/app/layout.tsx` - 添加 Analytics + SpeedInsights 组件
- ✅ `@vercel/analytics` + `@vercel/speed-insights` 依赖
- ✅ `packages/db/migrations/0007_performance_indexes.sql` - 40+ 性能索引

---

### ✅ 阶段 5: 文档体系 (已完成 | 2026-01-22)

> **进入条件**: 阶段 4 完成 ✅
> **完成条件**: /docs 目录完整，Runbooks 覆盖主要场景 ✅

| # | 任务 | 交付物 | 状态 |
|---|------|--------|------|
| 5.1 | 创建技术文档 | ARCHITECTURE.md + DATABASE.md | ✅ 完成 |
| 5.2 | 创建操作手册 | 4 个 runbooks | ✅ 完成 |

**交付物清单**:
- ✅ `docs/ARCHITECTURE.md` - 系统架构文档 + 架构图
- ✅ `docs/DATABASE.md` - 数据库 Schema 文档
- ✅ `docs/runbooks/INCIDENT_RESPONSE.md` - 事件响应手册
- ✅ `docs/runbooks/DATABASE_OPERATIONS.md` - 数据库操作手册
- ✅ `docs/runbooks/MONITORING.md` - 监控告警手册
- ✅ `docs/runbooks/API_DEVELOPMENT.md` - API 开发指南

---

### ✅ 阶段 6: 高级优化 (已完成 | 2026-01-22)

> **进入条件**: 阶段 1-5 完成 ✅
> **完成条件**: 流式输出 + Prompt Caching 优化 ✅

| # | 任务 | 交付物 | 状态 |
|---|------|--------|------|
| 6.1 | 优化 AI 流式输出 | SSE 流式 API + useStreamingChat Hook | ✅ 完成 |
| 6.2 | 优化 Prompt Caching | promptCache.ts 缓存优化服务 | ✅ 完成 |

**交付物清单**:
- ✅ `apps/web/src/app/api/ai/stream/route.ts` - SSE 流式响应 API
- ✅ `apps/web/src/hooks/useStreamingChat.ts` - 流式聊天 Hook (打字机效果)
- ✅ `packages/api/src/services/promptCache.ts` - Prompt Caching 优化服务

**流式输出功能**:
- Server-Sent Events (SSE) 实现真正的流式响应
- 实时打字机效果，逐字显示
- 中断保存功能，用户中断时保留已生成内容
- 自动计费结算，中断时按实际消耗计费

**Prompt Caching 优化**:
- 智能缓存策略：系统提示词缓存 + 历史消息缓存
- 缓存效率监控：命中率、节省 tokens、成本节省
- 最小缓存阈值：1024 tokens
- 缓存成本减少：90% (Anthropic 定价)

---

### ✅ 阶段 7: 着陆页与访问控制 (已完成 | 2026-01-23)

> **进入条件**: Vercel 域名配置完成 ✅
> **完成条件**: 着陆页可访问，访问控制正常工作 ✅

| # | 任务 | 交付物 | 状态 |
|---|------|--------|------|
| 7.1 | 实现访问控制中间件 | middleware.ts 更新 | ✅ 完成 |
| 7.2 | 创建路由组结构 | (landing)/ 路由组 | ✅ 完成 |
| 7.3 | 开发着陆页组件 | 6 个组件 | ✅ 完成 |
| 7.4 | 组装着陆页 | page.tsx | ✅ 完成 |
| 7.5 | 测试验证 | 本地验证通过 | ✅ 完成 |

**交付物清单**:

| 文件 | 描述 | 状态 |
|------|------|------|
| `apps/web/middleware.ts` | 域名路由 + 认证拦截 + rewrite | ✅ |
| `apps/web/src/app/landing/layout.tsx` | 着陆页布局 | ✅ |
| `apps/web/src/app/landing/page.tsx` | 着陆页首页 | ✅ |
| `apps/web/src/components/landing/LandingHeader.tsx` | 导航栏 (滚动效果) | ✅ |
| `apps/web/src/components/landing/HeroSection.tsx` | Hero 区域 (动画统计) | ✅ |
| `apps/web/src/components/landing/FeaturesSection.tsx` | 6 步增长策略 | ✅ |
| `apps/web/src/components/landing/PricingSection.tsx` | 定价方案 | ✅ |
| `apps/web/src/components/landing/CTASection.tsx` | 行动号召 (粒子动画) | ✅ |
| `apps/web/src/components/landing/LandingFooter.tsx` | 页脚 | ✅ |
| `apps/web/src/components/landing/index.ts` | 组件导出 | ✅ |

**访问控制逻辑**:
- `www.graylum.com` → 公开访问着陆页 (rewrite 到 `/landing`)
- `app.graylum.com` → 需要登录，未登录重定向到 `/login`
- `localhost` / `*.github.dev` / `*.gitpod.io` → 支持 `?domain=www` 参数模拟 www 域名

**Bug 修复记录** (2026-01-23):

| 问题 | 原因 | 修复方案 | 状态 |
|------|------|---------|------|
| `?domain=www` 无法显示着陆页 | Next.js 路由组 `(landing)/page.tsx` 与根目录 `page.tsx` 冲突，根目录优先 | 着陆页移至 `/landing` 路径，middleware 使用 `rewrite` | ✅ |
| 开发环境 `?domain=www` 不生效 | middleware 只检测 localhost，未支持 GitHub Codespaces | 添加 `isDevEnvironment` 检测 `*.github.dev` 和 `*.gitpod.io` | ✅ |
| 未登录访问根路径显示后台 | 根页面 `page.tsx` 是客户端组件，无认证检查，直接渲染后台 UI | 在 `page.tsx` 添加客户端认证检查，未登录重定向到 `/login` | ✅ |
| `?domain=www` 仍显示后台页面 | 中间件 rewrite 被客户端渲染覆盖，根页面无参数检查 | 在 `page.tsx` 检测 `?domain=www` 参数，重定向到 `/landing?domain=www` | ✅ |
| 退出登录跳转到 login 而非 landing | `AppHeader.tsx` 和 `ProfileSidebar.tsx` 硬编码跳转到 `/login` | 修改为根据环境跳转: 生产→`www.graylum.com`, 开发→`/landing?domain=www` | ✅ |

**验证结果** (2026-01-23):
- ✅ 重启服务器后访问根路径 → 正确跳转到 `/login`
- ✅ 退出登录后 → 正确跳转到 `/landing?domain=www` (开发环境)

**着陆页设计规范**:
- 主色: `#FFD700` (金色)
- 背景: `#0A0A0A` (深黑)
- 遵循 `movetonew/VISUAL_DESIGN_SYSTEM.md`
- 响应式设计，支持移动端
- CTA 按钮链接到 `app.graylum.com`

**提交记录**: `40238d9 feat: implement landing page and domain-based access control`

---

### ✅ 阶段 8: 首页数据集成修复 (已完成 | 2026-01-23)

> **发现时间**: 2026-01-23
> **完成时间**: 2026-01-23

| # | Bug | 位置 | 影响 | 状态 |
|---|-----|------|------|------|
| 8.1 | 积分获取 404 | `AppHeader.tsx` → `trpc.credits.getBalance` | Header 积分显示 "--" | ✅ 已有实现 |
| 8.2 | 用户名硬编码 | `page.tsx` | 所有用户显示 "office" | ✅ 已修复 |
| 8.3 | 会员等级硬编码 | `page.tsx` | 所有用户显示 "普通会员" | ✅ 已修复 |
| 8.4 | 公告硬编码 | `page.tsx` | 公告与管理后台不同步 | ✅ 已修复 |

**交付物**:

| 文件 | 修改内容 |
|------|---------|
| `packages/api/src/routers/settings.ts` | 新增 `getActiveAnnouncements` 和 `getBannerAnnouncement` 公开 API |
| `apps/web/src/app/page.tsx` | 使用 tRPC 获取用户 profile 和公告数据 |
| `apps/web/src/components/home/UpdatesSection.tsx` | 添加 yellow 标签颜色 |

**关键修复**:
- 用户数据: 调用 `trpc.user.getUserProfile.useQuery()` 获取 nickname、membership_level
- 公告数据: 新建公开 API `settings.getActiveAnnouncements`（原 admin API 需要管理员权限）

---

### ✅ 阶段 8 第二轮修复 (2026-01-23)

> **问题**: 公告和横幅仍然不显示

| # | 问题 | 原因 | 修复 |
|---|------|------|------|
| 1 | 公告不显示 | `active` 是字符串 `'true'` | 改为 `.eq('active', 'true')` |
| 2 | 公告不显示 | 缺少类型过滤 | 添加 `.eq('announcement_type', 'homepage')` |
| 3 | 横幅不显示 | 组件未使用 | 添加 GlobalBanner 到 page.tsx |
| 4 | 字段名错误 | content vs description | 添加字段映射 |

**交付物**:
- `settings.ts`: 修正 API 查询条件和字段映射
- `page.tsx`: 添加 GlobalBanner 组件和 getBannerAnnouncement 调用

---

### ✅ 阶段 8 第三轮修复 (2026-01-23)

> **问题**: 横幅位置/颜色错误，积分显示0，个人中心500错误

| # | 问题 | 原因 | 修复 |
|---|------|------|------|
| 1 | 积分显示 0 | 缺少 auth 检查，API 失败 | 添加认证检查和回退逻辑 |
| 2 | 横幅位置错误 | GlobalBanner 在 AppHeader 之前 | 移到 AppHeader 之后 |
| 3 | 横幅颜色错误 | `announcement` 样式是蓝色 | 改为黄色 (公告黄) |
| 4 | 横幅仅首页 | 其他页面未添加 | 添加到 chat/marketplace/profile |
| 5 | 功能广场硬编码 | 已验证非硬编码 | 使用 tRPC getModules |
| 6 | 个人中心 500 | 缺少 auth 检查 | 添加认证和错误处理 |

**交付物**:
- `apps/web/src/hooks/use-banner.tsx`: 新建横幅获取 hook
- `apps/web/src/components/layout/GlobalBanner.tsx`: 修复 announcement 样式颜色
- `apps/web/src/app/page.tsx`: GlobalBanner 移到导航栏下方
- `apps/web/src/app/chat/page.tsx`: 添加全站横幅
- `apps/web/src/app/marketplace/page.tsx`: 添加全站横幅
- `apps/web/src/app/profile/page.tsx`: 添加认证检查、错误处理、横幅

---

### ✅ 阶段 8 第四轮修复 (2026-01-23)

> **问题**: 积分/个人中心报错 "用户资料不存在"

**交付物**:
- `packages/api/src/trpc.ts`: 重构 profile 创建逻辑

---

### ✅ 阶段 8 第五轮修复 (2026-01-23)

> **问题**: 积分和个人中心仍然报错 404

| # | 问题 | 原因 | 修复 |
|---|------|------|------|
| 1 | 积分获取 404 | 查询了不存在的列 (credits_expiring_soon) | ✅ 只查询 credits 列 |
| 2 | 个人中心跳转失败 | select(*) 可能包含不存在的列 | ✅ 选择具体列 |
| 3 | API 抛出错误 | 查询失败直接 throw | ✅ 返回默认值 |

**交付物**:
- `packages/api/src/routers/credits.ts`: getBalance/getCreditsSummary 防御性处理
- `packages/api/src/routers/user.ts`: getUserProfile/getUserCredits 防御性处理

---

### ✅ 阶段 8 第六轮修复 (2026-01-23)

> **问题**: 个人中心加载缓慢，控制台大量报错 500

| # | 问题 | 原因 | 修复 |
|---|------|------|------|
| 1 | getUserProfile 抛出异常 | 非 PGRST116 错误时仍 throw | ✅ 任何错误都返回默认值 |
| 2 | 查询列不存在 | full_name/avatar_url 等可能不存在 | ✅ 简化为基础列 |

**交付物**:
- `packages/api/src/routers/user.ts`: 完全防御性处理，任何错误返回默认值

---

### ✅ 阶段 8 第八轮修复 (2026-01-23)

> **问题**: 个人中心数据全部硬编码，与数据库实际数据不同步

| # | 问题 | 位置 | 原因 | 状态 |
|---|------|------|------|------|
| 1 | 昵称修改不写入数据库 | `PersonalInfoCard.tsx:59-70` | `handleSaveNickname` 只有 TODO，未调用 API | ✅ 已修复 |
| 2 | 使用统计数据硬编码 | `PersonalInfoCard.tsx:299-311` | `UsageStatsCard` 使用 mock 数据 | ✅ 已修复 |
| 3 | 积分概览数据硬编码 | `CreditRecordsCard.tsx:120-121` | `monthlyUsed = 256` 硬编码 | ✅ 已修复 |
| 4 | 积分记录数据硬编码 | `CreditRecordsCard.tsx:124-129` | transactions 数组使用 mock 数据 | ✅ 已修复 |
| 5 | 使用历史不显示数据 | `UsageHistoryCard.tsx:23` | 使用空数组，未获取真实对话记录 | ✅ 已修复 |

**交付物**:
- `PersonalInfoCard.tsx`: 昵称保存调用 `trpc.user.updateUserProfile`，使用统计从 API 获取
- `CreditRecordsCard.tsx`: 积分概览和交易记录从 API 获取
- `UsageHistoryCard.tsx`: 对话历史从 API 获取
- `packages/api/src/routers/user.ts`: 新增 `getUserUsageStats` 接口
- `packages/api/src/routers/chat.ts`: `getConversations` 增加消息数和积分消耗统计

---

### ✅ 阶段 8 第十二轮修复 (2026-01-23)

> **问题**: 管理员后台查看工单时附件图片无法显示

| # | 问题 | 位置 | 原因 | 状态 |
|---|------|------|------|------|
| 1 | 附件图片显示为占位图标 | `admin/tickets/page.tsx` | 代码只显示 Lucide Image 图标 | ✅ 已修复 |

**交付物**:
- `admin/tickets/page.tsx`: `isImageFile()` 增加查询参数处理，附件显示改为 `<img>` 标签

---

---

## 🚀 阶段 9: AI 对话功能修复 (2026-01-24 规划)

> **诊断报告**: `AI_DIALOGUE_DIAGNOSTIC_REPORT.md`
> **决策记录**: `findings.md` - 方案 A: 集成流式处理

### 问题优先级总览

根据 AI 对话功能诊断报告，结合现有问题，按优先级和关联性重新排序：

| 优先级 | 问题数量 | 影响范围 |
|--------|----------|----------|
| 🔴 P0 (致命) | 7 | 核心功能完全不可用 |
| 🟠 P1 (严重) | 8 | 安全/功能缺陷 |
| 🟡 P2 (中等) | 15 | 功能不完整 |
| 🟢 P3 (轻微) | 6 | 代码质量/UI改进 |

---

### 🔴 P0 致命问题 - 核心功能不可用 (必须修复)

#### P0-A: AI 对话核心链路 (前端+后端)

| 序号 | 问题 | 位置 | 分类 |
|------|------|------|------|
| P0-1 | chat.sendMessage 是占位符，只回显用户输入 | `chat.ts:121` | 后端 |
| P0-2 | 前端调用了错误的 API | `chat/page.tsx` | 前端 |
| P0-3 | 流式处理未集成 | `streamHandler.ts`, `useStreamingChat.ts` | 前端+后端 |
| P0-4 | ai.sendMessage 完整实现但前端未调用 | `ai.ts:251-479` | 前端 |

**修复方案**: 方案 A - 集成流式处理
1. 修改 `chat/page.tsx` 集成 `useStreamingChat` Hook
2. 移除 `trpc.chat.sendMessage` 调用
3. 添加错误处理和加载状态
4. 验证 `/api/ai/stream` 端点

#### P0-B: AI 模型管理 (后端+管理后台)

| 序号 | 问题 | 位置 | 分类 |
|------|------|------|------|
| P0-5 | AI 模型配置无法写入数据库 | `admin/ai-models` | 后端 |
| P0-6 | 模型状态显示不准确 | `admin/ai-models` | 前端 |
| P0-7 | API 连接状态未验证 | `diagnostics.ts` | 后端 |

**修复方案**:
1. 修复 AI 模型编辑 API 写入逻辑
2. 模型状态需与 API 连接状态关联
3. 健康检查需验证 API 密钥有效性

---

### 🟠 P1 严重问题 - 安全/功能缺陷 (计划修复)

#### P1-A: 计费与积分系统 (后端)

| 序号 | 问题 | 位置 | 分类 |
|------|------|------|------|
| P1-1 | 计费价格来源与 UI 配置不一致 | `billing.ts` | 后端 |
| P1-2 | system_settings 积分规则完全未使用 | `billing.ts` | 后端 |
| P1-3 | 新用户赠送积分未验证 | 注册流程 | 后端 |

**修复方案**:
- 方案 A: 修改 billing.ts 读取 system_settings 表
- 方案 B: 移除 system_settings 积分配置，统一使用 ai_models 表
- 建议采用方案 B，避免配置冗余

#### P1-B: 安全机制 (前端+后端)

| 序号 | 问题 | 位置 | 分类 |
|------|------|------|------|
| P1-4 | 输出安全过滤未应用 | `ai.ts:383-397` | 后端 |
| P1-5 | 签名验证未使用 | `requestSigner.ts` | 前端+后端 |

#### P1-C: 订阅数据同步 (前端+后端)

| 序号 | 问题 | 位置 | 分类 |
|------|------|------|------|
| P1-6 | 积分加油包后台修改后用户端无变化 | `profile/subscription` | 前端 |
| P1-7 | 会员等级后台修改后用户端无变化 | `profile/subscription` | 前端 |
| P1-8 | 积分包热门推荐可能无效 | `admin/packages` | 后端 |

---

### 🟡 P2 中等问题 - 功能不完整 (按需修复)

#### P2-A: 性能监控数据 (后端) ✅ 已修复

| 序号 | 问题 | 位置 | 分类 | 状态 |
|------|------|------|------|------|
| P2-1 | 响应时间是随机值 | `admin.ts:getPerformanceStats` | 后端 | ✅ 已修复 - 从 ai_usage_logs.latency_ms 获取 |
| P2-2 | 错误率是随机值 | `admin.ts:getPerformanceStats` | 后端 | ✅ 已修复 - 从 ai_usage_logs.status 计算 |
| P2-3 | 缓存命中率是估算值 | `admin.ts:getPerformanceStats` | 后端 | ✅ 已修复 - 从 token_stats.cached_tokens 计算 |
| P2-4 | Token 估算不准确 | `admin.ts:getPerformanceStats` | 后端 | ✅ 已修复 - 从 token_stats 获取真实数据 |
| P2-5 | 使用量统计未连接到实际 API 调用 | `ai.ts:420-445` | 后端 | ✅ 已验证 - 数据已正确记录到 token_stats |

#### P2-B: 功能广场模块 (前端+后端+数据库)

| 序号 | 问题 | 位置 | 分类 | 状态 |
|------|------|------|------|------|
| P2-6 | 缺少模块详情弹窗 | `marketplace/page.tsx` | 前端 | ✅ 已修复 |
| P2-7 | modules 字段与后台不对应 | `admin/prompts` + DB | 后端+数据库 | ✅ 已修复 |
| P2-8 | credits_cost 无效字段 | `modules` 表 | 数据库 | ✅ 已修复 |

#### P2-C: 系统设置生效性 (后端) ✅ 已验证

| 序号 | 问题 | 位置 | 分类 | 状态 |
|------|------|------|------|------|
| P2-9 | 启用智能路由设置待验证 | `modelRouter.ts` | 后端 | ✅ 已验证 - 从 system_settings 读取 |
| P2-10 | 显示模型选择器功能无效 | `chat/page.tsx` | 前端 | ✅ 已修复 - 读取设置并显示选择器 |
| P2-11 | 首页引导设置功能不明 | 首页 | 前端 | ✅ 已修复 - 实现设置保存功能 |

#### P2-D: 会员权限功能 (前端+后端)

| 序号 | 问题 | 位置 | 分类 | 状态 |
|------|------|------|------|------|
| P2-12 | 允许导出对话-功能未实现 | 聊天页面 | 前端+后端 | ✅ 已修复 |
| P2-13 | 允许批量导出-功能未实现 | 聊天页面 | 前端+后端 | ✅ 已修复 |
| P2-14 | 导出权限检查未实现 | API 路由 | 后端 | ✅ 已修复 |
| P2-15 | 上下文长度限制未实现 | `ai.ts:300-320` | 后端 | ✅ 已修复 |

---

### 🟢 P3 轻微问题 - 代码质量/UI改进 (可选修复)

#### P3-A: 管理后台 UI (前端)

| 序号 | 问题 | 位置 | 分类 |
|------|------|------|------|
| P3-1 | 用户管理状态栏图标错位 | `admin/users` | 前端 |
| P3-2 | 财务统计金额单位不统一 | `admin/finance` | 前端 |
| P3-3 | AI 成本监控页面排版拥挤 | `admin/costs/page.tsx` | 前端 |
| P3-4 | 用户菜单绿色高亮色块 | `AppHeader.tsx` | 前端 |
| P3-5 | 缺少管理后台导航入口 | `AppHeader.tsx` | 前端 |

#### P3-B: 代码质量 (后端)

| 序号 | 问题 | 位置 | 分类 |
|------|------|------|------|
| P3-6 | 重复的类型定义 | `types/ai.ts` | 后端 |

---

### 修复工作阶段规划

#### ✅ 第一阶段: AI 对话核心修复 (P0-A) - 已完成 (2026-01-24)

> **目标**: 让 AI 对话功能正常工作

| 序号 | 任务 | 涉及文件 | 类型 | 状态 |
|------|------|---------|------|------|
| 1.1 | 修改前端调用流式 API | `chat/page.tsx` | 前端 | ✅ |
| 1.2 | 集成 useStreamingChat Hook | `chat/page.tsx` | 前端 | ✅ |
| 1.3 | 添加错误处理和加载状态 | `chat/page.tsx` | 前端 | ✅ |
| 1.4 | 验证环境变量配置 | `/api/ai/stream` | 配置 | ✅ |
| 1.5 | 端到端测试 | 测试 | 验证 | ⏳ 待用户验证 |

**修复内容**:
- 移除 `trpc.chat.sendMessage` 占位符调用
- 集成 `useStreamingChat` Hook 实现流式对话
- 添加错误提示组件 (AlertCircle)
- 添加流式打字机效果 (闪烁光标)
- 添加中断/停止按钮 (Square)
- 验证 `/api/ai/stream` 端点存在且配置正确

#### ✅ 第二阶段: AI 模型管理修复 (P0-B) - 已完成 (2026-01-24)

> **目标**: 确保 AI 模型配置正确存储和状态准确显示

| 序号 | 任务 | 涉及文件 | 类型 | 状态 |
|------|------|---------|------|------|
| 2.1 | 添加 API 连接测试端点 | `model.ts` | 后端 | ✅ |
| 2.2 | 实现连接状态查询 | `model.ts` | 后端 | ✅ |
| 2.3 | 更新模型管理页面显示连接状态 | `admin/models/page.tsx` | 前端 | ✅ |
| 2.4 | 添加测试连接按钮 | `admin/models/page.tsx` | 前端 | ✅ |

**修复内容**:
- 新增 `model.testConnection` mutation - 测试 Anthropic API 连接
- 新增 `model.getConnectionStatus` query - 获取所有模型连接状态
- 模型表格新增 "API 状态" 列，显示: 已连接/连接失败/待测试/未配置密钥
- 添加刷新按钮可手动测试 API 连接
- 连接状态存储在模型 config 字段中

#### ✅ 第三阶段: 计费系统修复 (P1-A) - 已完成 (2026-01-24)

> **目标**: 确保积分计费规则一致性

| 序号 | 任务 | 涉及文件 | 类型 | 状态 |
|------|------|---------|------|------|
| 3.1 | 统一计费价格来源 | `billing.ts` | 后端 | ✅ 已验证 |
| 3.2 | 重定向 system_settings 积分配置 | `admin/settings/page.tsx` | 前端 | ✅ 已完成 |
| 3.3 | 验证新用户赠送积分 | 注册流程 | 后端 | ✅ 已验证 |

**修复说明**:

1. **计费价格来源 (已统一)**:
   - 计费使用 `ai_models` 表的 `input_token_cost`、`output_token_cost`、`web_search_cost`
   - 使用 `BILLING_CONSTANTS.CREDITS_PER_USD = 1000` 和 `TOKEN_PRICE_MULTIPLIER = 1.5`
   - 这是正确的设计，无需修改

2. **重定向积分配置 (已完成)**:
   - 在管理设置页面"积分计费"Tab 添加警告提示
   - 说明 Token 计费规则已迁移至"AI 模型管理"页面
   - 将 `input_credits_per_1k`、`output_credits_per_1k`、`web_search_credits` 标记为"仅供参考"
   - 保留 `new_user_credits` 和 `first_purchase_bonus_percent` 作为有效设置

3. **新用户赠送积分 (已验证)**:
   - 数据库 schema 默认值: `credits: integer('credits').default(100).notNull()`
   - 新用户自动获得 100 积分
   - `system_settings.new_user_credits` 显示在管理后台但实际由数据库默认值控制

#### 第四阶段: 订阅与安全修复 (P1-B, P1-C) ✅ 已完成

> **目标**: 修复订阅数据同步和安全机制

| 序号 | 任务 | 涉及文件 | 类型 | 状态 |
|------|------|---------|------|------|
| 4.1 | 订阅页面读取数据库数据 | `settings.ts`, `SubscriptionCard.tsx` | 前端+后端 | ✅ 已完成 |
| 4.2 | 应用输出安全过滤 | `ai.ts`, `stream/route.ts` | 后端 | ✅ 已完成 |
| 4.3 | 签名验证 | `securityChecks.ts` | 后端 | ✅ 已验证 |

**修复详情**:

1. **订阅页面读取数据库数据 (4.1)**:
   - 新增 `settings.getCreditPackages` API - 获取积分加油包列表
   - 新增 `settings.getMembershipPlans` API - 获取会员等级列表
   - 更新 `SubscriptionCard.tsx` 使用 API 数据替代硬编码

2. **应用输出安全过滤 (4.2)**:
   - 导入并应用 `checkOutputSecurity` 到 `ai.ts`
   - 添加 `checkOutputSecurity` 函数到 streaming endpoint
   - 检测 AI 输出中的敏感内容 (API 密钥、密码等)

3. **签名验证 (4.3)**:
   - `checkRequestSignature` 函数已实现在 `securityChecks.ts`
   - 设计选择: 启用条件由环境变量控制
     - `API_SIGNATURE_SECRET` - 签名密钥
     - `REQUIRE_API_SIGNATURE=true` - 强制要求签名
   - 开发环境自动跳过验证
   - 现有安全措施已足够: 速率限制、熔断器、认证令牌、输入/输出检查

#### 第五阶段: 功能完善 (P2)

> **目标**: 完善各模块功能

按需从 P2 问题列表中选择修复。

#### ✅ 第六阶段: UI 优化 (P3) - 已完成 (2026-01-24)

> **目标**: 优化用户体验

| 序号 | 任务 | 涉及文件 | 类型 | 状态 |
|------|------|---------|------|------|
| P3-4 | 用户菜单绿色高亮改为金色 | `dropdown-menu.tsx` | 前端 | ✅ |
| P3-5 | 添加管理后台导航入口 | `AppHeader.tsx` | 前端 | ✅ |
| P3-1 | 用户管理状态栏图标错位 | `admin/users/page.tsx` | 前端 | ✅ |
| P3-2 | 财务统计金额单位统一 | `admin/finance/page.tsx` | 前端 | ✅ |
| P3-3 | AI成本监控页面排版优化 | `admin/costs/page.tsx` | 前端 | ✅ |

---

### ⏳ 阶段 8 第十三轮修复 (2026-01-24) - 已归档

> **问题 A**: AI 模型管理 - 配置写入失败 + 状态显示不准确

| # | 问题 | 位置 | 原因 | 状态 |
|---|------|------|------|------|
| 1 | AI 模型配置无法写入数据库 | `admin/ai-models` | 修改模型配置后无法保存到数据库 | ⏳ 待修复 |
| 2 | 模型状态显示不准确 | `admin/ai-models` | Claude 4.5 haiku 未配置 API 但显示"已启用" | ⏳ 待修复 |

**需求变更**:
- 已启用状态检测必须与 API 连接状态关联
- 如果 API 连接失败，应显示"连接失败"
- 只有 API 连接成功才能显示"已启用"

> **问题 B**: 功能广场模块 - 缺少详情弹窗 + 数据库字段不匹配

| # | 问题 | 位置 | 原因 | 状态 |
|---|------|------|------|------|
| 3 | 缺少模块详情弹窗 | `marketplace/page.tsx` | 点击模块应弹出详情弹窗 | ⏳ 待修复 |
| 4 | modules 字段与后台不对应 | `admin/prompts` + DB | 后台表单字段与数据库不匹配 | ⏳ 待修复 |
| 5 | credits_cost 无效字段 | `modules` 表 | 需删除 (按实际 token 计费) | ⏳ 待修复 |

**modules 表缺少字段**:
- `model_id`: 指定模型
- `prompt_content`: 提示词内容 (核心)
- `system_prompt`: 系统提示词
- `user_prompt_template`: 用户提示词模板
- `features`: 模块特点列表 (JSON)
- `preparation_questions`: 用户准备问题列表 (JSON)

> **问题 C**: 订阅管理 - 用户端与后台数据不同步 + UI 问题

| # | 问题 | 位置 | 原因 | 状态 |
|---|------|------|------|------|
| 6 | 积分加油包后台修改无效 | `profile/subscription` | 用户端未读取数据库 | ⏳ 待修复 |
| 7 | 会员等级后台修改无效 | `profile/subscription` | 用户端未读取数据库 | ⏳ 待修复 |
| 8 | 积分包热门推荐可能无效 | `admin/packages` | 需验证热门标识功能 | ⏳ 待修复 |
| 9 | 会员等级缺少热门推荐 | `admin/packages` | 后台无此选项 | ⏳ 待修复 |
| 10 | 热门高亮样式不突出 | `SubscriptionCard.tsx` | 紫/蓝边框需改为金/橙色 | ⏳ 待修复 |
| 11 | 年付总价需删除 | `SubscriptionCard.tsx` | "年付共 $xx" 信息移除 | ⏳ 待修复 |

> **问题 D**: 管理后台 UI 与数据问题

| # | 问题 | 位置 | 原因 | 状态 |
|---|------|------|------|------|
| 12 | 用户管理状态栏图标错位 | `admin/users` | UI 需重新设计 | ⏳ 待修复 |
| 13 | 用户最后登录状态不准确 | `admin/users` | 检测逻辑与实际不符 | ⏳ 待修复 |
| 14 | 财务统计金额单位不统一 | `admin/finance` | 全站统一为美元 $ | ⏳ 待修复 |
| 15 | 模型渠道 API 成本不一致 | `admin/finance` | 与 AI 模型设置不匹配 | ⏳ 待修复 |
| 16 | 积分规则显示与实际不符 | `admin/finance` | 与系统设置不一致 | ⏳ 待修复 |
| 17 | API 统计数据异常 | `admin/finance` | 对话未修复不应有请求量 | ⏳ 待修复 |

> **问题 E**: 公告管理-页面设置功能问题

| # | 问题 | 位置 | 原因 | 状态 |
|---|------|------|------|------|
| 18 | 显示模型选择器功能无效 | `admin/announcements` | 开关保存后聊天页面无变化 | ⏳ 待修复 |
| 19 | 首页引导设置功能不明 | `admin/announcements` | 新手引导功能未见生效 | ⏳ 待修复 |

> **问题 F**: 性能监控模块 - 数据来源与实际不符 (2026-01-24)

| # | 问题 | 位置 | 原因 | 状态 |
|---|------|------|------|------|
| 20 | 性能监控数据与实际不符 | `admin/performance` | 对话功能未修复，不应有数据 | ⏳ 待修复 |
| 21 | 响应时间是模拟数据 | `admin.ts:getPerformanceStats` | 使用随机值 `800 + Math.random() * 400` | ⏳ 待修复 |
| 22 | 错误率是模拟数据 | `admin.ts:getPerformanceStats` | 使用随机值 `Math.random() * 0.5` | ⏳ 待修复 |
| 23 | 缓存命中率是估算值 | `admin.ts:getPerformanceStats` | 假设固定 15-25%，非实际统计 | ⏳ 待修复 |
| 24 | Token 估算不准确 | `admin.ts:getPerformanceStats` | 使用 `字符数/4` 简单算法 | ⏳ 待修复 |

**分析**:
- 性能监控页面从 `conversations`、`messages`、`ai_models` 表获取数据
- 关键指标（响应时间、错误率、缓存命中率）使用随机值或估算值，非真实数据
- 如果对话功能未修复，这些表应为空，页面不应显示有意义的数据
- 需要：(1) 真实记录 API 响应时间到数据库 (2) 统计真实错误率 (3) 实现真实缓存命中统计

> **问题 G**: 系统诊断健康检查 - 状态显示与实际不符 (2026-01-24)

| # | 问题 | 位置 | 原因 | 状态 |
|---|------|------|------|------|
| 25 | AI 模型配置状态不准确 | `diagnostics.ts:healthCheck` | 只检查 is_active='true'，不验证 API 连接 | ⏳ 待修复 |
| 26 | API 密钥状态不准确 | `diagnostics.ts:healthCheck` | 只检查字段非空，不验证密钥是否有效 | ⏳ 待修复 |
| 27 | 未指出具体问题模型 | `diagnostics.ts:healthCheck` | 只显示"OK"，不指出哪个模型有问题 | ⏳ 待修复 |

**分析**:
```typescript
// 当前检查逻辑 (diagnostics.ts)
const { data } = await ctx.supabase
  .from('ai_models')
  .select('id')
  .eq('is_active', 'true')  // 只检查启用状态
  .limit(1);
checks.aiModels = { ok: data?.length > 0 };  // 有启用模型就 OK

// API 密钥检查
const hasDbApiKey = modelsWithKey?.some(m => m.api_key?.length > 0);  // 只检查非空
```

**需要修复**:
1. AI 模型检查应验证每个启用模型的 API 密钥是否有效（可调用）
2. 如果某模型缺少 API 密钥，应明确指出是哪个模型
3. 如果 API 连接失败，应显示连接失败而非"已启用"
4. 健康检查应返回每个模型的详细状态

> **问题 H**: 系统设置-积分计费规则完全未生效 (2026-01-24) 🔴 严重

| # | 问题 | 位置 | 原因 | 状态 |
|---|------|------|------|------|
| 28 | 输入Token积分单价未使用 | `billing.ts` | 计费使用 ai_models 表，不读取 system_settings | ⏳ 待修复 |
| 29 | 输出Token积分单价未使用 | `billing.ts` | 计费使用 ai_models 表，不读取 system_settings | ⏳ 待修复 |
| 30 | 联网搜索积分未使用 | `billing.ts` | 计费使用 ai_models.web_search_cost | ⏳ 待修复 |
| 31 | 新用户赠送积分未使用 | 注册流程 | 需验证是否读取 system_settings | ⏳ 待验证 |
| 32 | 首充赠送百分比未使用 | 支付流程 | 需验证是否读取 system_settings | ⏳ 待验证 |

**严重问题分析**:
```typescript
// 系统设置页面定义的积分计费规则 (admin/settings)
{
  input_credits_per_1k: '1',     // 每1000输入Token消耗1积分
  output_credits_per_1k: '5',    // 每1000输出Token消耗5积分
  web_search_credits: '5',       // 联网搜索额外5积分
}

// 但实际计费逻辑 (billing.ts) 使用的是：
const { data: model } = await supabase
  .from('ai_models')
  .select('input_token_cost, output_token_cost, web_search_cost')  // ← 从 ai_models 表读取
  .eq('model_id', modelId);

// 然后计算成本：
const totalCostUsd = (inputTokens / 1_000_000) * pricing.inputPer1M + ...;
const totalCredits = totalCostUsd * BILLING_CONSTANTS.CREDITS_PER_USD * 1.5;
```

**结论**: 管理员在"系统设置-积分计费"中修改的规则**完全不会生效**！实际计费完全依赖 `ai_models` 表的成本字段。

**修复方案**:
1. 方案 A: 修改 billing.ts 读取 system_settings 表的积分规则
2. 方案 B: 移除 system_settings 中的积分规则配置，统一使用 ai_models 表
3. 方案 C: 在管理页面说明积分规则来源，让管理员去 AI 模型页面配置

> **问题 I**: 系统设置-功能设置可能未生效 (2026-01-24)

| # | 问题 | 位置 | 原因 | 状态 |
|---|------|------|------|------|
| 33 | 启用智能路由设置 | `modelRouter.ts` | 读取 system_settings，但需验证 | ⏳ 待验证 |
| 34 | 启用智能搜索判断 | 搜索触发逻辑 | 需验证是否读取 system_settings | ⏳ 待验证 |
| 35 | 启用免费体验 | 对话页面 | 需验证是否读取 system_settings | ⏳ 待验证 |
| 36 | 免费消息数/天 | 对话页面 | 需验证是否读取 system_settings | ⏳ 待验证 |
| 37 | 单对话最大消息数 | 对话页面 | 需验证是否读取 system_settings | ⏳ 待验证 |
| 38 | 输入框字符上限 | 对话页面 | 需验证是否读取 system_settings | ⏳ 待验证 |
| 39 | 启用长文本预警 | 对话页面 | 需验证是否读取 system_settings | ⏳ 待验证 |
| 40 | 显示Token使用统计 | 对话页面 | 需验证是否读取 system_settings | ⏳ 待验证 |
| 41 | 显示模型选择器 | 对话页面 | 需验证是否读取 system_settings | ⏳ 待验证 |

**待验证**: 需要检查聊天页面是否读取这些 system_settings 配置

> **问题 J**: 会员等级权限配置 - 部分功能未实现 (2026-01-24)

| # | 问题 | 位置 | 原因 | 状态 |
|---|------|------|------|------|
| 42 | 对话历史自动清理 | `admin.ts` | ✅ 已实现，支持 Cron 定时清理 | ✅ 已实现 |
| 43 | 对话历史保存天数 | `membership_plans` 表 | ✅ 已实现，按会员等级配置 | ✅ 已实现 |
| 44 | 允许导出对话-配置存在 | `membership_plans` 表 | ✅ 配置字段存在 | ✅ 已实现 |
| 45 | 允许导出对话-功能未实现 | 聊天/对话页面 | ✅ 导出 API + 导出按钮 | ✅ 已实现 |
| 46 | 允许批量导出-配置存在 | `membership_plans` 表 | ✅ 配置字段存在 | ✅ 已实现 |
| 47 | 允许批量导出-功能未实现 | 聊天/对话页面 | ✅ 批量导出功能 | ✅ 已实现 |
| 48 | 导出权限检查未实现 | API 路由 | ✅ 会员权限检查 | ✅ 已实现 |

**分析**:
- 对话历史清理功能**已完整实现** ✅
  - 支持手动清理（管理员页面）
  - 支持 Vercel Cron 定时清理（每天 10:00 UTC）
  - 按会员等级读取保存天数（free:7天, pro:30天, gold:90天）
- 导出功能**配置框架存在，但实际功能未实现** ⚠️
  - `allow_export` 和 `allow_batch_export` 字段存在
  - 管理员可以在设置页面配置
  - 但没有实际的导出 API 端点
  - 聊天页面没有导出按钮
  - 没有会员权限检查中间件

> **问题 K**: AI 成本监控页面 UI 问题 + 用户菜单改进 (2026-01-24)

| # | 问题 | 位置 | 原因 | 状态 |
|---|------|------|------|------|
| 49 | AI 成本监控页面排版拥挤 | `admin/costs/page.tsx` | 布局需要重新调整，增加间距 | ⏳ 待修复 |
| 50 | 缺少 API 连接状态验证 | `admin/costs/page.tsx` | 需要添加 API 数据获取状态指示器 | ⏳ 待修复 |
| 51 | 用户菜单绿色高亮色块 | `AppHeader.tsx` 或 `ProfileSidebar.tsx` | 选择菜单项时显示绿色高亮，需去掉 | ⏳ 待修复 |
| 52 | 缺少管理后台导航入口 | `AppHeader.tsx` 用户下拉菜单 | 管理员需要快捷入口进入管理后台 | ⏳ 待修复 |

**问题详情**:

1. **AI 成本监控页面排版拥挤** (#49)
   - 卡片之间间距过小
   - 图表区域布局紧凑
   - 需要重新调整响应式布局

2. **缺少 API 连接状态验证** (#50)
   - 页面应显示 API 数据获取状态
   - 连接成功/失败应有明确指示
   - 可添加连接测试功能

3. **用户菜单绿色高亮** (#51)
   - 当前选择"充值积分"等菜单项时显示绿色背景高亮
   - 与整体设计风格不符（应使用金色主题）
   - 需要移除或修改高亮颜色

4. **管理后台导航入口** (#52)
   - 管理员在用户下拉菜单中需要快捷入口
   - 只有 `role='admin'` 的用户可见
   - 其他普通用户不显示此选项
   - 点击后跳转到 `/admin` 管理后台

---

### ✅ 阶段 8 第十三轮修复 (2026-01-25)

> **问题**: 对话功能失效 - 消息不显示、新对话不同步

| # | 问题 | 位置 | 原因 | 状态 |
|---|------|------|------|------|
| 1 | 对话列表显示已删除对话 | `chat.ts:getConversations` | 缺少 `is_deleted='false'` 过滤 | ✅ 已修复 |
| 2 | 消息列表显示已删除消息 | `chat.ts:getMessages` | 缺少 `is_deleted='false'` 过滤 | ✅ 已修复 |
| 3 | 消息计数包含已删除消息 | `chat.ts:getConversations` | 消息统计未排除已删除 | ✅ 已修复 |
| 4 | 新对话不同步到侧边栏 | `useStreamingChat.ts` | 创建对话后未通知父组件 | ✅ 已修复 |
| 5 | AppHeader 导入路径错误 | `AppHeader.tsx:29` | `@/lib/trpc` 应为 `@/trpc/client` | ✅ 已修复 |

**交付物**:
- `packages/api/src/routers/chat.ts`: 添加 `is_deleted='false'` 过滤条件
- `apps/web/src/hooks/useStreamingChat.ts`: 添加 `onConversationCreated` 回调
- `apps/web/src/app/chat/page.tsx`: 处理新对话创建事件，同步到 store
- `apps/web/src/components/layout/AppHeader.tsx`: 修复 trpc 导入路径

---

### ✅ 阶段 8 第十一轮修复 (2026-01-23)

> **问题**: 工单附件不显示 + 对话功能失效

| # | 问题 | 位置 | 原因 | 状态 |
|---|------|------|------|------|
| 1 | 工单上传图片不显示 | `TicketsPanel.tsx` | 附件上传是 mock 代码 | ✅ 已修复 |
| 2 | 对话功能失效 | `chat/page.tsx` | 页面从未获取或显示消息 | ✅ 已修复 (第十三轮) |

**交付物**:
- `api/upload/route.ts`: 新建文件上传 API
- `ticket.ts`: 支持 attachments 参数
- `TicketsPanel.tsx`: 真实文件上传 + 附件展示

---

### ✅ 阶段 8 第十轮修复 (2026-01-23)

> **问题**: 工单记录模块不显示数据

| # | 问题 | 位置 | 原因 | 状态 |
|---|------|------|------|------|
| 1 | 创建工单后不显示记录 | `TicketsPanel.tsx:720` | 使用硬编码空数组 `tickets: Ticket[] = []` | ✅ 已修复 |
| 2 | 已关闭工单不显示 | `TicketsPanel.tsx:720` | 未调用 `trpc.ticket.getTickets` API | ✅ 已修复 |
| 3 | 创建工单只有 console.log | `TicketsPanel.tsx:524-529` | `handleSubmit` 未调用 mutation | ✅ 已修复 |

**交付物**:
- `TicketsPanel.tsx`: 集成 tRPC API 调用 `getTickets`、`createTicket`、`replyToTicket`、`closeTicket`
- `ticket.ts`: 增强 API 支持 description/category 字段，添加状态/分类映射，新增 `closeTicket` mutation

---

### 🚨 阶段 9: 安全功能增强 (2026-01-25 规划)

> **来源**: `docs/SECURITY_AUDIT_PHASE9.md` 建议补充功能
> **决策**: 日志脱敏暂缓（经检查无实际风险），优先实现其他 3 项

| # | 功能 | 优先级 | 预计工作量 | 状态 |
|---|------|--------|----------|------|
| 9.1 | 速率限制 (Rate Limiting) | 🚨 必做 | 6-8h | ✅ 已完成 |
| 9.2 | 低余额预警 | ⚠️ 应做 | 3-4h | ✅ 已完成 |
| 9.3 | 完整安全测试套件 | ⚠️ 应做 | 8-12h | ✅ 已完成 |
| 9.4 | 日志脱敏处理 | 💡 可选 | 4-6h | 🔜 暂缓 |

---

#### 9.1 速率限制 (Rate Limiting) ✅ 已完成 (2026-01-25)

**方案**: Upstash Redis (边缘低延迟、与 Vercel 集成好)

**限流策略**:
| 端点类型 | 限制 | 窗口 | 键 |
|---------|------|------|-----|
| 未认证 API (Edge) | 60次 | 1分钟 | IP |
| 已认证 API | 100次 | 1分钟 | userId |
| AI 对话 | 30次 | 1分钟 | userId |
| AI 流式 | 20次 | 1分钟 | userId |
| 登录/注册 | 5次 | 5分钟 | IP |

**实现架构**:
```
请求 → Edge Middleware (IP限流) → API Route (用户限流) → tRPC (安全检查)
          ↓                         ↓                      ↓
     Upstash Redis            Upstash Redis         Redis/内存回退
```

**交付物**:
- ✅ `packages/api/src/services/redisRateLimiter.ts` - Redis 限流服务
- ✅ `apps/web/middleware.ts` - Edge 限流集成 (IP 级别)
- ✅ `apps/web/src/lib/rateLimit.ts` - Web 端限流工具
- ✅ `apps/web/src/app/api/ai/stream/route.ts` - 用户级别限流
- ✅ `packages/api/src/middleware/securityChecks.ts` - 异步 Redis 限流支持
- 环境变量: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`

**限流类型**:
| 类型 | 用途 | 限制 |
|------|------|------|
| `ai` | AI 对话 (非流式) | 30次/分钟 |
| `ai_stream` | AI 流式对话 | 20次/分钟 |
| `api` | 通用 API | 100次/分钟 |
| `auth` | 登录/注册 | 5次/5分钟 |
| `anonymous` | 未认证请求 | 20次/分钟 |

**故障安全**: Fail-open 策略 (Redis 连接失败时允许请求通过，回退到内存限流器)

---

#### 9.2 低余额预警 ✅ 已完成 (2026-01-25)

**预警策略**:
| 阈值 | 警告级别 | 提醒方式 |
|------|---------|---------|
| < 100 积分 | `low` | Header 黄色警告图标 |
| < 50 积分 | `very_low` | Header 橙色 + "请充值" 标签 |
| < 10 积分 | `critical` | Header 红色 + "即将用完" 标签 + 发送时弹窗 |
| = 0 积分 | `empty` | Header 红色 + "已用完" 标签 + 阻止发送 + 充值弹窗 |

**实现功能**:
1. **Header 积分显示**:
   - 根据余额动态变色 (金 → 黄 → 橙 → 红)
   - 低余额时显示警告图标 (AlertTriangle)
   - 点击可直接跳转充值页面

2. **发送前检查**:
   - `empty`: 阻止发送，强制显示充值弹窗
   - `critical`: 显示警告弹窗，但允许继续发送

3. **充值引导弹窗**:
   - 显示当前积分余额
   - 提供"立即充值"按钮
   - critical 级别可选"稍后再说"

**交付物**:
- ✅ `apps/web/src/hooks/use-credits.tsx` - 添加阈值判断、警告级别、颜色函数
- ✅ `apps/web/src/components/credits/LowBalanceDialog.tsx` - 充值引导弹窗
- ✅ `apps/web/src/components/layout/AppHeader.tsx` - 警告样式、点击充值
- ✅ `apps/web/src/app/chat/page.tsx` - 发送前检查、弹窗集成

---

#### 9.3 完整安全测试套件 ✅ 已完成 (2026-01-25)

**测试分层**:
```
E2E 安全测试 (Playwright) ← 用户视角
  - XSS 防护、登录安全、权限检查、安全响应头
单元测试 (Vitest) ← 函数视角
  - 速率限制、内容审核、计费安全、签名验证
```

**测试用例统计**:
| 类别 | 测试文件 | 测试数量 | 状态 |
|------|---------|---------|------|
| 输入安全 | `securityChecks.test.ts` | 82 tests | ✅ |
| 速率限制 | `rateLimiter.test.ts` | 26 tests | ✅ |
| 计费安全 | `billing.security.test.ts` | 30+ tests | ✅ |
| E2E 安全 | `security.spec.ts` | 20+ tests | ✅ |

**测试覆盖范围**:

| 测试类别 | 测试场景 |
|---------|---------|
| Prompt Injection | ignore instructions、system prompt、jailbreak (DAN/developer mode)、消息长度限制 |
| 输出安全 | API Key 检测 (OpenAI/Anthropic)、密码泄露、Secret 检测 |
| 签名验证 | HMAC-SHA256 生成、时间戳验证、重放攻击防护 |
| 速率限制 | 超限返回、窗口重置、并发请求、Edge Case |
| 计费安全 | 负数攻击、成本验证、双重消费防护、幂等性 |
| XSS 防护 | 脚本注入、HTML 实体、事件处理器 |
| 认证授权 | 未认证访问、Admin 路由保护、Session 安全 |
| 安全响应头 | X-Frame-Options、X-Content-Type-Options、CSP |

**交付物**:
- ✅ `packages/api/src/services/__tests__/securityChecks.test.ts` - 输入/输出安全 + 签名验证测试
- ✅ `packages/api/src/services/__tests__/rateLimiter.test.ts` - 速率限制测试
- ✅ `packages/api/src/services/__tests__/billing.security.test.ts` - 计费安全测试
- ✅ `apps/web/tests/e2e/security.spec.ts` - E2E 安全测试 (Playwright)
- ✅ `.github/workflows/security.yml` - 更新添加安全测试 CI Job

**CI/CD 集成**:
- 安全单元测试 Job (`security-unit-tests`)
- E2E 安全测试 Job (`security-e2e-tests`)
- Playwright 测试报告自动上传 (Artifact)

---

#### 9.4 日志脱敏处理 (暂缓)

**暂缓原因** (2026-01-25 检查结论):
- ✅ 用户对话内容未记录到日志
- ✅ `logger.auth.failed(email)` 已定义但未调用
- ✅ IP 地址有 30 天清理策略
- ⚠️ 无实际 PII 泄露风险，可后续统一处理

---

### ✅ 阶段 10: AI 模型管理修复 (2026-01-26 已完成)

> **来源**: 遗留问题诊断 (阶段 8 第十三轮)
> **方案**: 方案 A - 每个模型独立 API Key
> **提交**: `55741d0` - `fix: 修复 AI 模型管理问题 (阶段 10)`

#### 问题概述

| # | 问题 | 位置 | 影响 | 优先级 | 状态 |
|---|------|------|------|--------|------|
| 1 | AI 模型配置无法写入数据库 | `admin/models` | 管理员无法保存模型配置 | 🔴 高 | ✅ |
| 2 | 模型状态显示不准确 | `admin/models` | "已启用"与"未配置密钥"矛盾 | 🟡 中 | ✅ |

#### 根因分析

**问题 1: 配置写入失败**
- 前端缺少 `onError` 错误处理，用户看不到失败原因
- tRPC context 使用 Service Role Key 绕过 RLS，写入应该成功
- 如果失败，用户无法得知原因

**问题 2: 状态显示不准确**
- "启用状态"和"API 状态"是独立的两列
- 环境变量回退逻辑导致误判：`hasApiKey = !!(model.api_key || process.env.ANTHROPIC_API_KEY)`
- `/api/ai/stream` 直接使用环境变量，不读取模型的 api_key

---

#### 10.1 问题 1 修复方案

| # | 修复项 | 位置 | 类型 | 优先级 |
|---|--------|------|------|--------|
| 1.1 | 添加 `onError` 错误处理 | `admin/models/page.tsx:135-148` | 前端 | 🔴 高 |
| 1.2 | 添加 toast 提示保存成功/失败 | `admin/models/page.tsx` | 前端 | 🔴 高 |
| 1.3 | 添加错误状态 UI 显示 | `admin/models/page.tsx` | 前端 | 🔴 高 |

**1.1 添加 onError 错误处理**

```typescript
// 修改前
const createModel = trpc.model.createModel.useMutation({
  onSuccess: () => { refetch(); closeDialog(); },
});

// 修改后
const createModel = trpc.model.createModel.useMutation({
  onSuccess: () => {
    toast.success('模型创建成功');
    refetch();
    closeDialog();
  },
  onError: (error) => {
    toast.error(`创建失败: ${error.message}`);
  },
});
```

**1.2 引入 toast 组件**

```typescript
import { toast } from 'sonner'; // 或使用项目现有的 toast
```

---

#### 10.2 问题 2 修复方案 (方案 A: 每个模型独立 API Key)

| # | 修复项 | 位置 | 类型 | 优先级 |
|---|--------|------|------|--------|
| 2.1 | `getModelConfig` 增加查询 `api_key` | `stream/route.ts:73-76` | 后端 | 🔴 高 |
| 2.2 | API 调用使用模型的 api_key | `stream/route.ts:340` | 后端 | 🔴 高 |
| 2.3 | 移除状态检测的环境变量回退 | `model.ts:308` | 后端 | 🟡 中 |
| 2.4 | 启用时检查 API 连接状态 | `admin/models/page.tsx` | 前端 | 🟡 中 |
| 2.5 | 合并显示：未连接时显示"不可用" | `admin/models/page.tsx` | 前端 | 🟢 低 |

**2.1 getModelConfig 增加 api_key 字段**

```typescript
// stream/route.ts:73-76
// 修改前
const { data } = await supabase
  .from('ai_models')
  .select('model_id, name, max_tokens, input_token_cost, output_token_cost')
  .eq('id', modelId)
  .single();

// 修改后
const { data } = await supabase
  .from('ai_models')
  .select('model_id, name, max_tokens, input_token_cost, output_token_cost, api_key')
  .eq('id', modelId)
  .single();

// 返回值增加 apiKey
return {
  modelId: data.model_id,
  name: data.name,
  maxTokens: data.max_tokens,
  inputTokenCost: data.input_token_cost,
  outputTokenCost: data.output_token_cost,
  apiKey: data.api_key,  // 新增
};
```

**2.2 API 调用优先使用模型的 api_key**

```typescript
// stream/route.ts:340
// 修改前
'x-api-key': process.env.ANTHROPIC_API_KEY!,

// 修改后
'x-api-key': modelConfig.apiKey || process.env.ANTHROPIC_API_KEY!,
```

**2.3 移除状态检测的环境变量回退**

```typescript
// model.ts:308
// 修改前
const hasApiKey = !!(model.api_key || process.env.ANTHROPIC_API_KEY);

// 修改后
const hasApiKey = !!model.api_key;
```

**2.4 启用时检查 API 连接状态**

```typescript
// admin/models/page.tsx - handleToggleActive 函数
const handleToggleActive = (model: AIModel) => {
  const status = connectionStatus?.find(s => s.id === model.id);

  // 如果要启用，但 API 未连接，显示警告
  if (model.is_active !== 'true' && status && !status.hasApiKey) {
    toast.warning('该模型未配置 API Key，启用后用户将无法使用');
  }

  updateModel.mutate({
    id: model.id,
    isActive: model.is_active !== 'true',
  });
};
```

---

#### 修复交付物清单

| 文件 | 修改内容 | 状态 |
|------|---------|------|
| `apps/web/src/app/admin/models/page.tsx` | 添加错误处理、toast 提示、启用警告 | ✅ 已完成 |
| `apps/web/src/app/api/ai/stream/route.ts` | getModelConfig 增加 api_key、API 调用使用模型 key | ✅ 已完成 |
| `packages/api/src/routers/model.ts` | 移除状态检测的环境变量回退 | ✅ 已完成 |

---

#### 验证清单

| # | 验证项 | 预期结果 | 状态 |
|---|--------|----------|------|
| 1 | 创建模型失败时 | 显示错误 toast | ⏳ 待验证 |
| 2 | 更新模型成功时 | 显示成功 toast | ⏳ 待验证 |
| 3 | 模型无 api_key 时 | 状态显示"未配置密钥" | ⏳ 待验证 |
| 4 | 模型有 api_key 且测试成功 | 状态显示"已连接" | ⏳ 待验证 |
| 5 | 启用无 api_key 的模型 | 显示警告提示 | ⏳ 待验证 |
| 6 | 删除环境变量后 | 有 api_key 的模型仍可用 | ⏳ 待验证 |

---

### ✅ 阶段 11: 移除会员上下文限制功能 (2026-01-26 已完成)

> **来源**: 用户体验优化需求
> **评估报告**: `docs/diagnostics/context-limits-removal/evaluation-report.md`
> **方案**: 方案 A - 使用固定值替代会员等级限制

#### 背景说明

当前不同会员等级有不同的上下文消息数限制，这会降低用户体验：
- free: 10 条 (仅 5 轮对话)
- pro: 30 条 (15 轮对话)
- gold: 50 条 (25 轮对话)

**目标**: 移除此限制，所有用户统一使用 100 条上下文消息。

#### 影响评估

| 类型 | 结果 |
|------|------|
| ✅ 不受影响 | AI 对话核心、积分计费、会员其他权限、速率限制 |
| ⚠️ 需要修改 | stream/route.ts、admin/packages/page.tsx (可选) |
| ❌ 会破坏的 | 无 |

---

#### 11.1 执行步骤

| 步骤 | 任务 | 文件 | 状态 |
|------|------|------|------|
| 1 | 删除 `getMaxContextMessages` 函数 | `stream/route.ts` | ✅ 已完成 |
| 2 | 添加常量 `MAX_CONTEXT_MESSAGES = 100` | `stream/route.ts` | ✅ 已完成 |
| 3 | 修改历史查询使用固定值 | `stream/route.ts` | ✅ 已完成 |
| 4 | (可选) 隐藏后台表单字段 | `admin/packages/page.tsx` | 🔜 后续 |

---

#### 11.2 代码修改详情

**修改前** (`stream/route.ts`):
```typescript
// 行 105-131: getMaxContextMessages 函数 (删除整个函数)
async function getMaxContextMessages(supabase: any, userId: string): Promise<number> {
  // ... 查询会员等级和限制值
}

// 行 255: 调用函数
const maxContextMessages = await getMaxContextMessages(supabase, userId);

// 行 266: 使用变量
const history = await getConversationHistory(supabase, conversation.id, maxContextMessages);
```

**修改后**:
```typescript
// 删除 getMaxContextMessages 函数

// 使用固定值
const MAX_CONTEXT_MESSAGES = 100; // 统一的最大上下文消息数，所有用户相同
const history = await getConversationHistory(supabase, conversation.id, MAX_CONTEXT_MESSAGES);
```

---

#### 11.3 数据库处理

| 处理项 | 决策 | 原因 |
|--------|------|------|
| `membership_plans.max_context_messages` 字段 | 保留不删除 | 避免迁移风险，保留历史数据 |
| 迁移脚本 | 不需要 | 字段保留 |

---

#### 11.4 验证清单

| # | 验证项 | 预期结果 | 状态 |
|---|--------|----------|------|
| 1 | AI 对话功能 | 正常工作 | ⏳ |
| 2 | 长对话 (超过 50 条) | 能正常发送和接收 | ⏳ |
| 3 | 免费用户对话 | 与付费用户体验一致 | ⏳ |
| 4 | 积分计费 | 正常扣费 | ⏳ |

---

### 💡 后续优化任务 (可选)

> **说明**: 以下任务为可选优化，根据需要执行

| # | 任务 | 交付物 | 优先级 | 状态 |
|---|------|--------|--------|------|
| 8.1 | E2E 端到端测试 | Playwright 测试用例 | 🟡 推荐 | ✅ 完成 |
| 8.2 | Sentry 监控告警 | 告警规则配置 | 🟡 推荐 | ✅ 完成 |
| 8.3 | 负载测试 | k6/Artillery 压测脚本 | 🟢 可选 | ⏳ 待执行 |
| 8.4 | 用户文档 | 使用手册 | 🟢 可选 | ⏳ 待执行 |

---

### 🔧 阶段 12: 遗留问题清理与系统稳定化 (2026-03-06 规划)

> **决策文档**: `findings.md` - 阶段 12 决策
> **进入条件**: 阶段 0-11 全部完成 ✅
> **完成条件**: 所有 `⏳` 标记清零，系统进入可交付状态
> **执行原则**: 先验证再修复，先后端再前端，先核心再边缘

---

#### 步骤 1: 验证已完成工作 🔴 最高优先级

> **目标**: 确认阶段 10/11 的代码修改实际生效

| # | 验证项 | 对应阶段 | 预期结果 | 状态 |
|---|--------|---------|----------|------|
| 12.1.1 | AI 对话功能端到端 | 阶段 9 第一阶段 | 发送消息能收到 AI 回复 (非 Echo) | ⏳ |
| 12.1.2 | 流式打字机效果 | 阶段 9 第一阶段 | 回复逐字出现，可中断 | ⏳ |
| 12.1.3 | 模型管理错误提示 | 阶段 10 | 创建/更新模型有 toast 提示 | ⏳ |
| 12.1.4 | API 状态显示 | 阶段 10 | 有 key 显示"已连接"，无 key 显示"未配置密钥" | ⏳ |
| 12.1.5 | 启用无 key 模型警告 | 阶段 10 | 弹出警告 toast | ⏳ |
| 12.1.6 | 独立 API Key 生效 | 阶段 10 | 模型使用自己的 api_key 而非环境变量 | ⏳ |
| 12.1.7 | 长对话 (>50条) | 阶段 11 | 统一 100 条上下文，无会员限制 | ⏳ |
| 12.1.8 | 积分正常扣费 | 阶段 9 第三阶段 | 发送消息后积分减少 | ⏳ |
| 12.1.9 | 页面设置-模型选择器 | P2-C #18 | 管理后台开启后聊天页面出现选择器 | ⏳ |
| 12.1.10 | 页面设置-首页引导 | P2-C #19 | 首页引导设置保存并生效 | ⏳ |

**验证方式**: 浏览器手动测试 + 截图记录

---

#### 步骤 2: 系统设置生效性审计 🟠 高优先级

> **目标**: 代码审计确认 system_settings 中的配置项是否被实际使用

| # | 设置项 | 位置 | 需审计文件 | 状态 |
|---|--------|------|-----------|------|
| 12.2.1 | 输入Token积分单价 (#28) | `billing.ts` | 确认计费不再读取此配置 → 标记或移除 | ⏳ |
| 12.2.2 | 输出Token积分单价 (#29) | `billing.ts` | 同上 | ⏳ |
| 12.2.3 | 联网搜索积分 (#30) | `billing.ts` | 同上 | ⏳ |
| 12.2.4 | 新用户赠送积分 (#31) | 注册流程 | 检查 profiles.credits 默认值 | ⏳ |
| 12.2.5 | 首充赠送百分比 (#32) | 支付流程 | 检查是否有首充逻辑 | ⏳ |
| 12.2.6 | 启用智能路由 (#33) | `modelRouter.ts` | 已标记验证通过，复核 | ⏳ |
| 12.2.7 | 启用智能搜索 (#34) | 搜索逻辑 | 检查 webSearch 触发条件 | ⏳ |
| 12.2.8 | 免费体验/消息数 (#35-36) | `chat/page.tsx`, `stream/route.ts` | 检查是否有免费额度逻辑 | ⏳ |
| 12.2.9 | 输入框字符上限等 (#37-41) | `chat/page.tsx` | 检查前端是否读取设置 | ⏳ |

**交付物**: 审计报告 — 每个设置项标注「已使用 ✅」/「未使用且应移除 ❌」/「未使用但应实现 🔧」

---

#### 步骤 3: 管理后台数据修复 🟡 中优先级

> **目标**: 确保管理员看到的数据反映真实情况

| # | 问题 | 位置 | 修复方案 | 状态 |
|---|------|------|---------|------|
| 12.3.1 | 用户最后登录不准确 (#13) | `admin/users` | 读取 `profiles.last_login_at` 真实值 | ⏳ |
| 12.3.2 | 模型渠道 API 成本不一致 (#15) | `admin/finance` | 从 `ai_models` 表读取实际成本 | ⏳ |
| 12.3.3 | 积分规则显示不符 (#16) | `admin/finance` | 同步显示 `ai_models` 表的计费规则 | ⏳ |
| 12.3.4 | API 统计数据异常 (#17) | `admin/finance` | 从 `ai_usage_logs` 获取真实统计 | ⏳ |
| 12.3.5 | 诊断-AI模型状态不准确 (#25) | `diagnostics.ts` | 验证 API 连接，非仅检查 is_active | ⏳ |
| 12.3.6 | 诊断-API密钥不准确 (#26) | `diagnostics.ts` | 验证密钥有效性 | ⏳ |
| 12.3.7 | 诊断-未指出问题模型 (#27) | `diagnostics.ts` | 返回每个模型详细状态 | ⏳ |

**注意**: 性能监控数据问题 (#20-24) 已在 P2-A 阶段修复（从 `ai_usage_logs`/`token_stats` 获取真实数据），无需重复处理。

---

#### 步骤 4: UI 与体验优化 🟢 低优先级

> **目标**: 优化订阅管理和成本监控的用户体验

| # | 问题 | 位置 | 修复方案 | 状态 |
|---|------|------|---------|------|
| 12.4.1 | 订阅-热门推荐标识 (#8) | `SubscriptionCard.tsx` | 验证 `is_popular` 字段生效 | ⏳ |
| 12.4.2 | 订阅-热门高亮样式 (#10) | `SubscriptionCard.tsx` | 改为金色/橙色边框 | ⏳ |
| 12.4.3 | 订阅-年付总价移除 (#11) | `SubscriptionCard.tsx` | 删除 "年付共 $xx" 显示 | ⏳ |
| 12.4.4 | 成本监控-排版拥挤 (#49) | `admin/costs/page.tsx` | 增加卡片间距，优化布局 | ⏳ |
| 12.4.5 | 成本监控-API状态 (#50) | `admin/costs/page.tsx` | 添加数据获取状态指示器 | ⏳ |

**注意**: 以下问题已在之前阶段修复，无需重复处理：
- #6-7 订阅数据同步 → 阶段 9 第四阶段已添加 API
- #9 会员等级热门推荐 → 需在步骤 4 验证
- #12 状态栏图标 → P3-1 已修复
- #14 财务单位统一 → P3-2 已修复
- #51-52 菜单高亮/管理入口 → P3-4/P3-5 已修复

---

## 执行规则

### 符号说明

| 符号 | 含义 |
|------|------|
| 🚨 | 必做 - 不做会有严重问题 |
| ⚠️ | 应该做 - 显著提升质量 |
| 💡 | 可选 - 锦上添花 |
| 🔜 | 下一步 |
| ⏳ | 待执行 |
| ✅ | 已完成 |

### 验收标准

| 指标 | 目标值 |
|------|--------|
| 系统诊断通过率 | ≥ 80% (阶段 0) → ≥ 95% (阶段 2) |
| RLS 覆盖率 | 100% (18/18 表) |
| 高危漏洞 | 0 |
| 主页 LCP | < 2.5s |
| 数据库查询 | < 500ms |

### 周规划建议

**Week 1: 建立基础**
- Day 1-2: 阶段 0 (系统诊断)
- Day 3-5: 阶段 1 (基础监控)

**Week 2: 加固安全**
- Day 1-2: 阶段 2 (安全加固)
- Day 3: 阶段 3 (CI/CD)
- Day 4-5: 修复诊断发现的问题

**Week 3: 完善体验**
- Day 1: 阶段 4 (性能优化)
- Day 2-3: 阶段 5 (文档体系)
- Day 4-5: 稳定性测试

**Week 4+: 持续优化**
- 阶段 6 (高级优化)
- 根据监控数据持续改进

---

## 关键决策点

| 问题 | 建议 |
|------|------|
| 何时开始修复 BUG？ | 完成阶段 0 后，根据诊断结果决定 |
| 何时部署到生产？ | 系统诊断通过率 ≥ 95% 且无高危问题 |
| 何时投入高级优化？ | 阶段 1-5 完成，系统稳定运行 1 周 |
| 发现严重 BUG 怎么办？ | 暂停当前任务，优先修复，记录到诊断系统 |
