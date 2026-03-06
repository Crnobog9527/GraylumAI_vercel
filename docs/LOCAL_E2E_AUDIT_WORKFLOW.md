# 本地开发环境自动登录巡检范式

## 目标

这套 Playwright 巡检范式用于在本地开发环境中自动登录测试站点，优先覆盖关键业务流，并输出结构化问题证据。第一版只负责发现问题、归类问题和形成修复计划，不自动修改业务代码。

## 覆盖范围

### 普通用户
- `/landing?domain=www`
- `/`
- `/profile`
- `/chat`
- 发送消息
- 中断长回复

### 管理员
- `/admin`
- `/admin/models`
- `/admin/diagnostics`
- `/admin/users`

## 环境要求

在本地环境中提供以下变量：

```bash
E2E_TEST_EMAIL=...
E2E_TEST_PASSWORD=...
E2E_ADMIN_EMAIL=...
E2E_ADMIN_PASSWORD=...
```

如果未提供对应账号，相关巡检会自动跳过，不会伪造通过结果。

## 运行命令

首次运行前，如本机尚未安装 Playwright 浏览器：

```bash
pnpm --dir apps/web exec playwright install chromium
```

执行关键巡检：

```bash
pnpm --dir apps/web test:e2e:critical
```

如需查看完整 HTML 报告：

```bash
pnpm --dir apps/web test:e2e:report
```

## 产物位置

- HTML 报告：`apps/web/playwright-report/`
- JSON 汇总：`apps/web/test-results/report.json`
- 单测证据目录：`apps/web/test-results/artifacts/`

每个关键业务流测试都会写出两份结构化证据：

- `issue-report.json`
- `issue-report.md`

## 问题采集规则

自动采集以下问题：

1. 页面运行时异常
2. 控制台 `error` / `warning`
3. 关键请求失败或返回 `4xx/5xx`
4. 关键业务断言失败

问题默认分级：

- `P0`：页面不可用、登录失败、聊天主链路失败、管理员关键页崩溃
- `P1`：核心操作失败但可绕过、关键数据展示错误
- `P2`：非核心 UI/交互异常、弱提示、非阻断问题

## 输出结构

每份 `issue-report` 至少包含：

- 页面路径
- 账号角色
- 预期行为
- 实际结果
- 复现步骤
- 控制台或网络错误
- 建议修复方向

## 当前限制

- 只面向本地开发环境，不碰生产环境
- 依赖专用测试账号，不适合直接复用个人账号
- 优先覆盖关键业务流，不承诺一次性覆盖全站所有细节
- 流式聊天相关测试仍依赖真实模型配置和可用积分
