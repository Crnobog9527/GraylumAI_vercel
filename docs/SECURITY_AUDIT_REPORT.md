# 安全审计报告

**审计日期**: 2026-01-24
**审计版本**: v1.0
**审计范围**: RLS 策略、环境变量、依赖安全

---

## 1. RLS (Row Level Security) 审计

### 1.1 覆盖情况

| 表名 | RLS 启用 | 策略完整性 | 文件位置 |
|------|---------|-----------|----------|
| profiles | ✅ | ✅ SELECT/UPDATE/ALL(admin) | 0002_enable_rls_all_tables.sql |
| conversations | ✅ | ✅ SELECT/INSERT/UPDATE/DELETE | 0002_enable_rls_all_tables.sql |
| messages | ✅ | ✅ SELECT/INSERT/DELETE | 0002_enable_rls_all_tables.sql |
| credit_transactions | ✅ | ✅ SELECT/INSERT/ALL(admin) | 0002_enable_rls_all_tables.sql |
| ai_models | ✅ | ✅ SELECT(active)/ALL(admin) | 0002_enable_rls_all_tables.sql |
| system_settings | ✅ | ✅ SELECT/ALL(admin) | 0002_enable_rls_all_tables.sql |
| tickets | ✅ | ✅ SELECT/INSERT/UPDATE/ALL(admin) | 0002_enable_rls_all_tables.sql |
| ticket_replies | ✅ | ✅ SELECT/INSERT/ALL(admin) | 0002_enable_rls_all_tables.sql |
| credit_packages | ✅ | ✅ SELECT(active)/ALL(admin) | 0002_enable_rls_all_tables.sql |
| invitations | ✅ | ✅ SELECT/INSERT/ALL(admin) | 0002_enable_rls_all_tables.sql |
| user_activity_logs | ✅ | ✅ SELECT/INSERT/ALL(admin) | 0002_enable_rls_all_tables.sql |
| announcements | ✅ | ✅ SELECT(active)/ALL(admin) | 0002_enable_rls_all_tables.sql |
| prompts | ✅ | ✅ SELECT(active)/ALL(admin) | 0002_enable_rls_all_tables.sql |
| invitation_records | ✅ | ✅ SELECT/ALL(admin) | 0002_enable_rls_all_tables.sql |
| membership_plans | ✅ | ✅ SELECT/ALL(admin) | 0002_enable_rls_all_tables.sql |
| modules | ✅ | ✅ SELECT(active)/ALL(admin) | 0002_enable_rls_all_tables.sql |
| token_stats | ✅ | ✅ SELECT/INSERT/ALL(service) | 0001_ai_billing_tables.sql |
| billing_history | ✅ | ✅ SELECT/INSERT/ALL(admin) | 0001_ai_billing_tables.sql |
| ai_usage_logs | ✅ | ✅ SELECT/INSERT/ALL(admin) | 0001_ai_billing_tables.sql |
| diagnostic_results | ✅ | ✅ SELECT/INSERT(admin,service) | 0005_diagnostics.sql |
| application_logs | ✅ | ✅ SELECT/INSERT(admin,service) | 0006_application_logs.sql |

**统计**: 21/21 表已启用 RLS，覆盖率 **100%**

### 1.2 策略设计原则

1. **用户数据隔离**: 用户只能访问自己的数据 (`auth.uid() = user_id`)
2. **管理员全权访问**: 管理员通过 `is_admin()` 函数获取全部权限
3. **公共数据只读**: 配置表（如 ai_models, credit_packages）允许所有用户读取激活记录
4. **服务角色绕过**: 后端服务使用 `service_role` 密钥绕过 RLS

### 1.3 辅助函数

```sql
-- is_admin() 函数定义
CREATE OR REPLACE FUNCTION is_admin()
RETURNS boolean AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid()
    AND role = 'admin'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### 1.4 应用层边界风险（新增记录，2026-03-27）

- 风险描述：
  - 存在“公开 tRPC 路由在服务端检测到 `SUPABASE_SERVICE_ROLE_KEY` 后切换到 `supabaseAdmin`”的实现模式。
  - 这会让公开接口的读取边界依赖应用代码，而不是稳定地依赖数据库 RLS。
- 已确认位置：
  - `packages/api/src/routers/settings.ts`
  - `packages/api/src/routers/modules.ts`
  - `packages/api/src/routers/invitation.ts` 的 `validateInvitationCode`
- 风险等级：`中`
- 影响：
  - 未来一旦公开接口查询字段扩张，容易再次引入“本应受 RLS 约束的数据被公开接口带出”的回归。
  - 服务端是否配置 service role 会改变公开接口行为，增加配置相关的隐性安全差异。
- 建议：
  - 公开读接口优先使用匿名/公开客户端。
  - 需要匿名校验但不适合开放整表读取的场景，改成最小权限 RPC 或更窄的专用 RLS 策略。
  - 避免在 `publicProcedure` 中基于 service role 是否存在切换到管理员客户端。
- 状态：`已记录，待专项收敛`

---

## 2. 环境变量安全审计

### 2.1 必需变量

| 变量名 | 类型 | 暴露位置 | 安全级别 |
|--------|------|---------|---------|
| `NEXT_PUBLIC_SUPABASE_URL` | 公开 | 客户端 | ✅ 安全 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 公开 | 客户端 | ✅ 安全 |
| `SUPABASE_SERVICE_ROLE_KEY` | 私密 | 服务端 | 🔒 需保护 |
| `DATABASE_URL` | 私密 | 服务端 | 🔒 需保护 |
| `OPENROUTER_API_KEY` | 私密 | 服务端 | 🔒 需保护 |

> 2026-04-25 更新：Anthropic 官方 API 已退役，Claude 模型统一通过 OpenRouter 调用；若环境中仍存在 `ANTHROPIC_API_KEY`，应在 Anthropic 后台 revoke/delete，而不是轮换为新 key。

### 2.2 可选变量

| 变量名 | 用途 | 默认值 |
|--------|------|--------|
| `NEXT_PUBLIC_SENTRY_DSN` | 错误监控 | - |
| `API_SIGNATURE_SECRET` | API 签名验证 | - |
| `REQUIRE_API_SIGNATURE` | 强制签名 | false |
| `LOG_LEVEL` | 日志级别 | production: info, dev: debug |

### 2.3 安全检查结果

- ✅ `.gitignore` 正确排除 `.env*` 文件
- ✅ `.env.example` 仅包含占位符，无实际密钥
- ✅ 代码中无硬编码密钥
- ✅ 服务端密钥仅在服务端代码中使用
- ✅ 环境变量验证器 (`envValidator.ts`) 已实现

### 2.4 环境变量验证

系统已实现 `packages/api/src/lib/envValidator.ts`:
- 启动时验证必需变量
- 检测测试密钥误用
- 验证 Supabase URL 格式
- 生产环境强制检查

---

## 3. 依赖安全

### 3.1 推荐配置

建议启用 GitHub Dependabot 自动扫描:

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
    open-pull-requests-limit: 10
```

### 3.2 手动扫描命令

```bash
# 扫描所有依赖
pnpm audit

# 仅生产依赖
pnpm audit --prod
```

---

## 4. 其他安全措施

### 4.1 已实现的安全功能

| 功能 | 状态 | 位置 |
|------|------|------|
| 输入安全检查 | ✅ | `securityChecks.ts` |
| 输出安全过滤 | ✅ | `stream/route.ts` |
| 速率限制 | ✅ | `securityChecks.ts` |
| 消费熔断器 | ✅ | `securityChecks.ts` |
| API 签名验证 | ✅ (可选) | `securityChecks.ts` |
| 内容审核 | ✅ | `contentModerator.ts` |
| 幂等性检查 | ✅ | `atomic_billing_rpc` |

### 4.2 OWASP Top 10 防护

| 风险 | 防护措施 |
|------|---------|
| A01 访问控制 | RLS + 管理员验证 |
| A02 加密失效 | HTTPS + 密钥保护 |
| A03 注入攻击 | 参数化查询 (Drizzle ORM) |
| A04 不安全设计 | 最小权限原则 |
| A05 安全配置 | 环境变量验证 |
| A06 组件漏洞 | Dependabot 扫描 |
| A07 认证失效 | Supabase Auth |
| A08 数据完整性 | 服务端验证 (Zod) |
| A09 日志监控 | Sentry + 结构化日志 |
| A10 SSRF | 无外部 URL 请求功能 |

---

## 5. 审计结论

### 5.1 安全评分

| 项目 | 评分 | 说明 |
|------|------|------|
| RLS 覆盖率 | 100% | 所有表已启用 |
| 环境变量安全 | ✅ 通过 | 无泄露风险 |
| 硬编码密钥 | ✅ 无 | 代码清洁 |
| 依赖安全 | ✅ 通过 | 生产依赖审计已清零 |

### 5.2 建议操作

1. ✅ RLS - 已完成，无需额外操作
2. ✅ 环境变量 - 已验证安全
3. ✅ 依赖扫描 - `pnpm audit --prod --json` 已清零
4. ⏳ 应用层 RLS 边界收敛 - 移除公开路由对 `supabaseAdmin` 的依赖

---

**审计人**: Claude AI
**下次审计**: 建议每月执行一次
