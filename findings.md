# Findings & Decisions

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
