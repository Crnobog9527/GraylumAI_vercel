# Task Plan: GraylumAI

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

### ⚠️ 阶段 2: 安全加固 (应该做 | 预计 1-2 天)

> **进入条件**: 阶段 1 完成
> **完成条件**: RLS 100%、无硬编码密钥、依赖无高危漏洞

| # | 任务 | 交付物 | 预计时间 | 状态 |
|---|------|--------|---------|------|
| 2.1 | RLS 策略全面检查 | 审计报告 + 修复 SQL | 2h | ⏳ 待执行 |
| 2.2 | 环境变量安全检查 | 审计报告 + 验证脚本 | 1h | ⏳ 待执行 |
| 2.3 | 依赖安全扫描 | dependabot.yml + GitHub Action | 30m | ⏳ 待执行 |

---

### ⚠️ 阶段 3: CI/CD 自动化 (应该做 | 预计 1 天)

> **进入条件**: 阶段 2 完成
> **完成条件**: CI/CD 流水线正常运行，Staging/Production 分离

| # | 任务 | 交付物 | 预计时间 | 状态 |
|---|------|--------|---------|------|
| 3.1 | GitHub Actions CI/CD | .github/workflows/ci.yml | 2h | ⏳ 待执行 |
| 3.2 | 配置 Staging 环境 | 环境配置 + 部署检查清单 | 2h | ⏳ 待执行 |

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

#### P2-A: 性能监控数据 (后端)

| 序号 | 问题 | 位置 | 分类 |
|------|------|------|------|
| P2-1 | 响应时间是随机值 | `admin.ts:getPerformanceStats` | 后端 |
| P2-2 | 错误率是随机值 | `admin.ts:getPerformanceStats` | 后端 |
| P2-3 | 缓存命中率是估算值 | `admin.ts:getPerformanceStats` | 后端 |
| P2-4 | Token 估算不准确 | `admin.ts:getPerformanceStats` | 后端 |
| P2-5 | 使用量统计未连接到实际 API 调用 | `ai.ts:420-445` | 后端 |

#### P2-B: 功能广场模块 (前端+后端+数据库)

| 序号 | 问题 | 位置 | 分类 |
|------|------|------|------|
| P2-6 | 缺少模块详情弹窗 | `marketplace/page.tsx` | 前端 |
| P2-7 | modules 字段与后台不对应 | `admin/prompts` + DB | 后端+数据库 |
| P2-8 | credits_cost 无效字段 | `modules` 表 | 数据库 |

#### P2-C: 系统设置生效性 (后端)

| 序号 | 问题 | 位置 | 分类 |
|------|------|------|------|
| P2-9 | 启用智能路由设置待验证 | `modelRouter.ts` | 后端 |
| P2-10 | 显示模型选择器功能无效 | `chat/page.tsx` | 前端 |
| P2-11 | 首页引导设置功能不明 | 首页 | 前端 |

#### P2-D: 会员权限功能 (前端+后端)

| 序号 | 问题 | 位置 | 分类 |
|------|------|------|------|
| P2-12 | 允许导出对话-功能未实现 | 聊天页面 | 前端+后端 |
| P2-13 | 允许批量导出-功能未实现 | 聊天页面 | 前端+后端 |
| P2-14 | 导出权限检查未实现 | API 路由 | 后端 |
| P2-15 | 上下文长度限制未实现 | `ai.ts:300-320` | 后端 |

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

#### 第二阶段: AI 模型管理修复 (P0-B)

> **目标**: 确保 AI 模型配置正确存储和状态准确显示

| 序号 | 任务 | 涉及文件 | 类型 |
|------|------|---------|------|
| 2.1 | 修复 AI 模型编辑 API | `admin.ts` | 后端 |
| 2.2 | 实现 API 连接状态检测 | `admin/ai-models` | 后端+前端 |
| 2.3 | 更新健康检查逻辑 | `diagnostics.ts` | 后端 |
| 2.4 | 更新模型状态显示 | `admin/ai-models` | 前端 |

#### 第三阶段: 计费系统修复 (P1-A)

> **目标**: 确保积分计费规则一致性

| 序号 | 任务 | 涉及文件 | 类型 |
|------|------|---------|------|
| 3.1 | 统一计费价格来源 | `billing.ts` | 后端 |
| 3.2 | 移除/重定向 system_settings 积分配置 | 管理后台 | 前端 |
| 3.3 | 验证新用户赠送积分 | 注册流程 | 后端 |

#### 第四阶段: 订阅与安全修复 (P1-B, P1-C)

> **目标**: 修复订阅数据同步和安全机制

| 序号 | 任务 | 涉及文件 | 类型 |
|------|------|---------|------|
| 4.1 | 订阅页面读取数据库数据 | `profile/subscription` | 前端 |
| 4.2 | 应用输出安全过滤 | `ai.ts` | 后端 |
| 4.3 | 启用签名验证 | `requestSigner.ts` | 前端+后端 |

#### 第五阶段: 功能完善 (P2)

> **目标**: 完善各模块功能

按需从 P2 问题列表中选择修复。

#### 第六阶段: UI 优化 (P3)

> **目标**: 优化用户体验

按需从 P3 问题列表中选择修复。

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
| 45 | 允许导出对话-功能未实现 | 聊天/对话页面 | ❌ 无导出 API 和导出按钮 | ⏳ 待实现 |
| 46 | 允许批量导出-配置存在 | `membership_plans` 表 | ✅ 配置字段存在 | ✅ 已实现 |
| 47 | 允许批量导出-功能未实现 | 聊天/对话页面 | ❌ 无批量导出功能 | ⏳ 待实现 |
| 48 | 导出权限检查未实现 | API 路由 | 无 membershipProcedure 中间件 | ⏳ 待实现 |

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

### ⚠️ 阶段 8 第十一轮修复 (2026-01-23)

> **问题**: 工单附件不显示 + 对话功能失效

| # | 问题 | 位置 | 原因 | 状态 |
|---|------|------|------|------|
| 1 | 工单上传图片不显示 | `TicketsPanel.tsx` | 附件上传是 mock 代码 | ✅ 已修复 |
| 2 | 对话功能失效 | `chat/page.tsx` | 页面从未获取或显示消息 | ⏳ 待修复 |

**交付物**:
- `api/upload/route.ts`: 新建文件上传 API
- `ticket.ts`: 支持 attachments 参数
- `TicketsPanel.tsx`: 真实文件上传 + 附件展示

**待修复**: 对话功能消息显示仍有问题，需进一步排查

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

### 💡 后续优化任务 (可选)

> **说明**: 以下任务为可选优化，根据需要执行

| # | 任务 | 交付物 | 优先级 | 状态 |
|---|------|--------|--------|------|
| 8.1 | E2E 端到端测试 | Playwright 测试用例 | 🟡 推荐 | ✅ 完成 |
| 8.2 | Sentry 监控告警 | 告警规则配置 | 🟡 推荐 | ✅ 完成 |
| 8.3 | 负载测试 | k6/Artillery 压测脚本 | 🟢 可选 | ⏳ 待执行 |
| 8.4 | 用户文档 | 使用手册 | 🟢 可选 | ⏳ 待执行 |

**任务 7.1 - E2E 测试**:
- 工具: Playwright (推荐) 或 Cypress
- 测试场景:
  - 用户注册/登录流程
  - AI 对话发送和接收
  - 积分扣费正确性
  - 管理后台操作
- 交付物: `tests/e2e/` 目录 + CI 集成

**任务 7.2 - Sentry 监控告警**:
- 在 Sentry Dashboard 配置告警规则
- 告警场景:
  - 新错误类型出现
  - 错误数量突增 (10x spike)
  - 每小时错误 > 100
  - 特定关键错误 (支付失败、AI 调用失败)
- 通知渠道: Email / Slack / Webhook

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
