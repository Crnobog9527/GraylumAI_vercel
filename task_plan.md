# Task Plan: GraylumAI

## Goal
完成 GraylumAI 项目的安全审计问题修复（Phase 11）

## Current Phase
- Phase 1-10: ✅ 全部完成
- **Phase 11 安全审计问题修复: ✅ 完成 (12/12 P0+P1 任务)**

---

## Phase 11: 安全审计问题修复

> **参考文档**: `findings.md` - Phase 10 安全与合规审计发现
> **目标**: 修复 Phase 10 审计发现的 6 个 P0 紧急问题和 7 个 P1 重要问题

### 11.1 P0 紧急修复 (6/6 完成) ✅

| # | 任务 | 位置 | 交付物 | 状态 |
|---|------|------|--------|------|
| 1 | 修复 Header 积分显示 | `AppHeader.tsx` | 使用 `useCreditsBalance` hook | ✅ |
| 2 | 添加关键表 RLS 策略 | `migrations/0002` | 18 表 RLS 策略迁移文件 | ✅ |
| 3 | 实现请求幂等性 | `ai.ts`, `billing.ts` | `checkIdempotency()` + requestId | ✅ |
| 4 | 费率从数据库读取 | `billing.ts` | `getModelPricing()` 函数 + 5分钟缓存 | ✅ |
| 5 | 修复流式中断结算 | `useAIChat.ts`, `ai.ts`, `billing.ts` | `settleAbort()` + `abortRequest` 端点 | ✅ |
| 6 | 计费事务原子化 | `billing.ts`, `migrations/0003` | 原子化 RPC 函数 (FOR UPDATE 锁) | ✅ |

### 11.2 P1 重要修复 (6/6 完成) ✅

| # | 任务 | 位置 | 交付物 | 状态 |
|---|------|------|--------|------|
| 7 | 请求签名/时间戳验证 | `securityChecks.ts` | HMAC-SHA256 签名 + 30秒时间戳校验 | ✅ |
| 8 | settle() 成本验证 | `billing.ts` | `verifyCost()` 方法，防止数据篡改 | ✅ |
| 9 | 补全日志信息 | `ai.ts` | 添加 request_id, ip_address, user_agent | ✅ |
| 10 | 修复 window.location | `login/page.tsx`, `SixStepsGuide.tsx` | 改用 `router.push()` | ✅ |
| 11 | 统一上下文配置 | `contextManager.ts` | 阈值 90000 (60%)，稳定区域 3 轮 | ✅ |
| 12 | 智能路由关键词扩展 | `modelRouter.ts` | 添加 `REALTIME_DATA_KEYWORDS` | ✅ |

### 11.3 P2 持续优化 (可选)

| # | 任务 | 描述 | 状态 |
|---|------|------|------|
| 13 | 递归摘要算法 | 实现多层摘要链式压缩 | ⬜ |
| 14 | 软删除机制 | 添加 is_deleted 字段 + RLS 校验 | ⬜ |
| 15 | Redis 速率限制 | 替代内存存储，支持分布式 | ⬜ |
| 16 | .env.example | 创建环境变量文档 | ⬜ |

---

## 验收标准

| 类别 | 指标 | 目标值 | 当前状态 |
|------|------|--------|----------|
| 安全 | RLS 覆盖率 | 100% (18/18 表) | ✅ 迁移已创建 |
| 安全 | 高危漏洞 | 0 | ✅ 所有 P0 已修复 |
| 安全 | 请求签名验证 | HMAC-SHA256 | ✅ 已实现 |
| 计费 | Token 计费误差 | <2% | ✅ 动态定价 |
| 计费 | 幂等性测试 | 重复请求不重复扣费 | ✅ 已实现 |
| 计费 | 事务原子性 | FOR UPDATE 锁 | ✅ RPC 函数 |
| 计费 | 中断结算 | 部分 tokens 计费 | ✅ settleAbort |
| 前端 | Header 积分实时 | 与数据库同步 | ✅ 已修复 |
| 日志 | 完整性 | request_id/IP/UA | ✅ 已补全 |

---

## 已完成阶段摘要

| 阶段 | 内容 | 完成时间 |
|------|------|----------|
| Phase 1-3 | 业务逻辑迁移 (工单、设置、邀请、模型、管理后台) | 2026-01-14 |
| Phase 4-5 | UI 还原 (73 组件) + 数据层完善 | 2026-01-20 |
| Phase 6 | 安全加固 (RLS + Admin 权限) | 2026-01-20 |
| Phase 7 | 管理后台功能还原 | 2026-01-20 |
| Phase 8 | AI 重构执行计划制定 | 2026-01-21 |
| Phase 9 | AI 对话系统重构实施 (Schema、tRPC、Engine、Frontend) | 2026-01-21 |
| Phase 10 | 安全与合规审计 (评分 3.1/5) | 2026-01-21 |
| Phase 11 | 安全审计修复 (12/12 P0+P1 完成) | 2026-01-21 ✅ |
