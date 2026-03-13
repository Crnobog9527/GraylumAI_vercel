# 预发布演练 Runbook

## 目的

在 Stripe 接入前，先对非支付主链路做一次完整预发布演练，确保部署环境、回调、监控、配置生效和管理员操作闭环都成立。

## 前置条件

必须准备：

- 一个锁定的 Vercel preview / staging URL
- 对应的 Deployment Protection bypass cookie
- E2E 管理员账号
- E2E 普通用户账号
- 预发布环境所需的非支付环境变量

如果缺少 preview URL 或 bypass cookie，不允许把演练结论记为通过。

## 推荐命令

本地基线：

```bash
pnpm release:preflight
```

预发布环境演练：

```bash
pnpm release:preflight:preview -- --preview-url <preview-url> --bypass-cookie <cookie>
```

隔离 destructive 演练：

```bash
pnpm release:preflight:destructive -- --preview-url <preview-url> --bypass-cookie <cookie>
```

## 必验范围

### 认证

- 登录
- 注册
- 验证邮箱
- Google 登录
- redirect 回跳

### 聊天

- 流式输出
- `route_upgraded`
- abort
- diagnostics runtime proof
- 设置项对运行时生效

### 用户中心

- 资料页
- 安全页
- 工单
- 签到
- 邀请
- 积分/订阅展示

### 后台

- settings
- packages
- announcements
- users
- tickets
- diagnostics
- ops read pages

### 全局能力

- 维护模式
- 品牌配置
- 首页 / 聊天页设置生效
- 工单附件授权访问

## 证据

统一输出到：

```text
.release-output/preflight/<timestamp>/
```

最少保留：

- `00-release-preflight-summary.md`
- 日志文件
- Playwright HTML/trace/失败截图
- 本轮锁定的 preview URL

## 失败处理

如果失败，按以下顺序归类：

1. 部署环境配置错误
2. 真实代码缺陷
3. 测试假设过时
4. 外部依赖异常

只修复阻塞上线的问题；不要在演练阶段顺手扩功能。
