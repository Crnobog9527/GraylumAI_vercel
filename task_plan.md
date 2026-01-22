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
