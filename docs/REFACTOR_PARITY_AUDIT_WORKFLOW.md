# 重构一致性验收工作流

## 目标

这套工作流用于回答一个具体问题：

> 当前重构后的 GraylumAI 站点，是否在 `登录 + 聊天 + 后台` 这三条主流程上，与 Base44 旧站保持了足够一致的功能颗粒度。

它不要求你先理解全部代码，也不要求你先修 bug。第一阶段只做三件事：

1. 冻结旧站基线
2. 采集新站证据
3. 整理差异清单，交给开发者修复

## 一键入口

首轮核心回归包：

```bash
pnpm audit:parity
```

如果你还想把完整 Playwright 套件一起纳入证据包：

```bash
pnpm audit:parity:full
```

## 运行前提

### 旧站资料

至少满足以下其一：

- 可以访问 Base44 旧站
- 可以访问旧仓库并找到截图/录屏/操作说明

### 本地环境

至少保证：

- `.env.local` 已能支持本地开发运行
- 若要跑完整用户链路，提供以下变量：

```bash
E2E_TEST_EMAIL=...
E2E_TEST_PASSWORD=...
E2E_ADMIN_EMAIL=...
E2E_ADMIN_PASSWORD=...
```

如果这些测试账号缺失，相关 Playwright 流程会跳过。跳过不等于通过，必须在最终验收里标记为“证据不足”。

## 输出目录

每次执行都会生成一个独立目录：

```text
.audit-output/refactor-parity/<timestamp>/
```

其中包含：

- `00-command-results.md`
  说明本轮跑了哪些命令、是否通过、证据在哪里
- `logs/`
  API 测试和 Playwright 命令原始日志
- `evidence/playwright/`
  Playwright HTML 报告、JSON 报告、失败截图、trace、issue-report
- `manual/01-old-site-baseline.md`
  旧站基线模板
- `manual/02-function-comparison-matrix.md`
  功能对照矩阵模板
- `manual/03-issue-list.md`
  可直接给开发者的修复问题单模板

最新一次运行路径会写入：

```text
.audit-output/refactor-parity/latest-run.txt
```

## 推荐执行顺序

### 1. 先跑自动化采集

```bash
pnpm audit:parity
```

先让系统自动帮你把“新站事实”收集出来，包括：

- API 单元测试结果
- 关键 E2E 结果
- Playwright 失败证据

### 2. 冻结旧站基线

打开 Base44 旧站，按 `manual/01-old-site-baseline.md` 逐项填写：

- 入口路径
- 操作步骤
- 旧站预期结果
- 旧站证据位置

这里记录的是“用户真实看到的行为”，不是代码实现方式。

### 3. 填功能对照矩阵

在 `manual/02-function-comparison-matrix.md` 中按模块比对：

- 登录
- 聊天
- 后台

每一项只判断：

- 一致
- 部分一致
- 缺失
- 有缺陷

### 4. 整理问题清单

把所有差异都写进 `manual/03-issue-list.md`，并按严重程度打标：

- `P0`：无法登录、无法聊天、后台打不开、关键数据错乱
- `P1`：主流程能走但结果不对、状态误导、权限异常
- `P2`：体验退化、文案/空态/加载态不一致
- `P3`：样式细节、边角交互

## 与现有巡检资产的关系

本工作流不是替代现有测试，而是把已有资产组织成一套可交付的验收包。

直接复用的资产包括：

- API 测试：`pnpm test:api`
- 关键 E2E：`pnpm --dir apps/web test:e2e:critical`
- 完整 E2E：`pnpm --dir apps/web test:e2e`
- 本地 E2E 说明：[docs/LOCAL_E2E_AUDIT_WORKFLOW.md](./LOCAL_E2E_AUDIT_WORKFLOW.md)

## 交付给开发者时必须包含

最少交付 3 份内容：

1. 功能对照矩阵
2. 证据包路径
3. 问题清单

如果只说“感觉有问题”，开发者无法高效修复；如果能明确到“旧站怎样、新站怎样、怎么复现、证据在哪里”，修复速度会快很多。
