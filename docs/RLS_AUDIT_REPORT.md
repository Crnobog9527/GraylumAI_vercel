# RLS 审计报告

**审计日期**: 2026-01-22
**审计人**: Claude Code
**状态**: ✅ 全部通过

## 审计结果汇总

| 表名 | RLS 启用 | SELECT | INSERT | UPDATE | DELETE | 状态 |
|------|----------|--------|--------|--------|--------|------|
| profiles | ✅ | ✅ 自己 | - | ✅ 自己 | - | ✅ |
| conversations | ✅ | ✅ 自己 | ✅ 自己 | ✅ 自己 | ✅ 自己 | ✅ |
| messages | ✅ | ✅ 对话所有者 | ✅ 对话所有者 | - | ✅ 对话所有者 | ✅ |
| credit_transactions | ✅ | ✅ 自己 | ✅ 自己/管理员 | - | - | ✅ |
| ai_models | ✅ | ✅ 活跃模型 | - | - | - | ✅ |
| system_settings | ✅ | ✅ 认证用户 | - | - | - | ✅ |
| tickets | ✅ | ✅ 自己 | ✅ 自己 | ✅ 自己 | - | ✅ |
| ticket_replies | ✅ | ✅ 工单所有者 | ✅ 工单所有者/管理员 | - | - | ✅ |
| credit_packages | ✅ | ✅ 活跃包 | - | - | - | ✅ |
| invitations | ✅ | ✅ 创建者 | ✅ 创建者 | - | - | ✅ |
| invitation_records | ✅ | ✅ 邀请人/被邀请人 | - | - | - | ✅ |
| user_activity_logs | ✅ | ✅ 自己 | ✅ 自己/管理员 | - | - | ✅ |
| announcements | ✅ | ✅ 活跃公告 | - | - | - | ✅ |
| prompts | ✅ | ✅ 活跃提示词 | - | - | - | ✅ |
| membership_plans | ✅ | ✅ 认证用户 | - | - | - | ✅ |
| modules | ✅ | ✅ 活跃模块 | - | - | - | ✅ |
| token_stats | ✅ | ✅ 自己 | ✅ 自己 | - | - | ✅ |
| billing_history | ✅ | ✅ 自己 | ✅ 自己 | - | - | ✅ |
| ai_usage_logs | ✅ | ✅ 自己 | ✅ 自己 | - | - | ✅ |
| diagnostic_results | ✅ | ✅ 管理员 | ✅ 管理员/Service | - | - | ✅ |
| application_logs | ✅ | ✅ 自己/管理员 | ✅ Service | - | - | ✅ |

## 管理员权限

所有表都配置了管理员全权访问策略：
- `is_admin()` 函数检查 `profiles.role = 'admin'`
- 管理员可以绕过所有 RLS 限制

## 安全亮点

1. **用户数据隔离**: 用户只能访问自己的数据
2. **关联数据保护**: messages 通过 conversation_id 关联检查
3. **公共数据可读**: ai_models, announcements 等公共数据允许认证用户读取
4. **Service Role 支持**: 支持后端服务通过 service_role 插入数据

## 迁移文件

| 文件 | 配置的表 |
|------|---------|
| 0001_ai_billing_tables.sql | token_stats, billing_history, ai_usage_logs |
| 0002_enable_rls_all_tables.sql | 16 个核心业务表 |
| 0005_diagnostics.sql | diagnostic_results |
| 0006_application_logs.sql | application_logs |

## 结论

**RLS 策略全部就绪**，符合安全要求。
