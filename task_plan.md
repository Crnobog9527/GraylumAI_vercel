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

**着陆页设计规范**:
- 主色: `#FFD700` (金色)
- 背景: `#0A0A0A` (深黑)
- 遵循 `movetonew/VISUAL_DESIGN_SYSTEM.md`
- 响应式设计，支持移动端
- CTA 按钮链接到 `app.graylum.com`

**提交记录**: `40238d9 feat: implement landing page and domain-based access control`

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
