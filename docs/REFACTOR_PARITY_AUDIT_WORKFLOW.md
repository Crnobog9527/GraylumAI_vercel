# 重构一致性验收工作流

## 目标

这套工作流用于回答一个具体问题：

> 当前重构后的 GraylumAI 站点，是否在 `登录 + 聊天 + 后台` 这三条主流程上，与 Base44 旧仓库所表达的功能保持了足够一致的颗粒度。

它不要求你先理解全部代码，也不要求你先修 bug。第一阶段只做三件事：

1. 冻结旧仓库基线
2. 采集新站证据
3. 整理差异清单，交给开发者修复

## 一键入口

首轮核心回归包：

```bash
pnpm audit:parity
```

如果你要继续做第二轮“细颗粒度能力”验收：

```bash
pnpm audit:parity:extended
```

如果你还想把完整 Playwright 套件一起纳入证据包：

```bash
pnpm audit:parity:full
```

## 运行前提

### 旧版本资料

当前版本默认采用“旧仓库代码对照”，因为旧站可能已经不可访问。

至少满足以下其一：

- 可以访问旧版 GitHub 仓库代码
- 可以访问旧仓库中的 README、文档、截图、录屏、操作说明

### 新站测试环境

至少保证：

- 已登录 Vercel CLI，并且当前仓库已正确关联目标项目
- `.env.local` 中已配置 E2E 账号
- 若要跑完整用户链路，提供以下变量：

```bash
E2E_TEST_EMAIL=...
E2E_TEST_PASSWORD=...
E2E_ADMIN_EMAIL=...
E2E_ADMIN_PASSWORD=...
```

Playwright 现在会自动从根目录 [`.env.local`](/Volumes/灰度映画/灰度映画/美国怀俄明州-Grayscale Luminary LLC/Graylum_AI/GraylumAI_vercel/.env.local) 读取这些变量。

如果这些测试账号缺失，相关 Playwright 流程会跳过。跳过不等于通过，必须在最终验收里标记为“证据不足”。

当前工作流默认不会启动本地 `pnpm dev`。它会先部署一个 Vercel Preview，再直接对该线上预览地址执行 Playwright，用来规避本地地域网络对模型供应商 API 的影响。

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
  旧仓库基线模板
- `manual/02-function-comparison-matrix.md`
  功能对照矩阵模板
- `manual/03-issue-list.md`
  可直接给开发者的修复问题单模板

最新一次运行路径会写入：

```text
.audit-output/refactor-parity/latest-run.txt
```

## 推荐填写位置

对非开发者更友好的做法，是把本轮人工填写内容同步到仓库内的可见目录：

```text
docs/refactor-parity/current-audit/
```

建议至少维护这 3 份文件：

- `legacy-repo-baseline.draft.md`
- `function-comparison-matrix.draft.md`
- `issue-list.draft.md`

这样你不需要在隐藏目录 `.audit-output/` 里找文件，也更方便把初稿直接发给开发者。

## 推荐执行顺序

### 1. 先跑自动化采集

```bash
pnpm audit:parity
```

先让系统自动帮你把“新站事实”收集出来，包括：

- API 单元测试结果
- Vercel Preview 部署地址
- 关键 E2E 结果
- Playwright 失败证据

如果首轮主流程已通过，再跑：

```bash
pnpm audit:parity:extended
```

这会额外补第二轮能力证据，目前覆盖：

- 聊天重命名
- 聊天导出
- 后台模型测试连接
- 后台用户积分调整与回滚

### 2. 冻结旧仓库基线

打开旧版 GitHub 仓库，按 `manual/01-old-site-baseline.md` 逐项填写：

- 旧仓库中的页面/接口/组件路径
- 从代码推断出的用户操作步骤
- 从代码推断出的预期结果
- 证据位置（文件路径、截图、提交、文档）
- 置信度（高 / 中 / 低）

这里记录的不是“代码怎么写”，而是“从旧仓库代码可以稳定推断出用户应该看到什么行为”。

推荐优先查看这些信息源：

- 路由文件和页面组件
- 表单文案、按钮文案、空态/错误态文案
- API handler / router 的输入输出
- README、产品说明、截图、录屏

如果旧仓库代码里只能推断出大致意图，必须把该项标记为 `中` 或 `低` 置信度，避免把猜测当作验收标准。

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
- 线上关键 E2E：`PLAYWRIGHT_BASE_URL=<preview-url> pnpm --dir apps/web test:e2e:critical`
- 线上扩展 E2E：`PLAYWRIGHT_BASE_URL=<preview-url> pnpm --dir apps/web test:e2e:parity:extended`
- 线上完整 E2E：`PLAYWRIGHT_BASE_URL=<preview-url> pnpm --dir apps/web test:e2e`
- 预览部署与保护绕过：由 `pnpm audit:parity` 自动完成

## 交付给开发者时必须包含

最少交付 3 份内容：

1. 功能对照矩阵
2. 证据包路径
3. 问题清单

如果只说“感觉有问题”，开发者无法高效修复；如果能明确到“旧仓库表达了什么行为、新站怎样、怎么复现、证据在哪里”，修复速度会快很多。
