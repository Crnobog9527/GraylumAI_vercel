# 十个必需检查：实际覆盖与跳过项

核实日期：2026-10-01（Asia/Shanghai）。staging 分支保护的十个名称见下表。
这是对现有执行范围的说明，不新增或降低检查要求。执行源为
[CI workflow](../../.github/workflows/ci.yml)、
[Security workflow](../../.github/workflows/security.yml)，分支保护以 GitHub 实时配置为准。

## 名称与实际工作

| 必需检查（精确名称） | 实际检查什么 | 绿灯的边界 |
| --- | --- | --- |
| Lint & Type Check | `lint-and-type`：源码大小、Web/API ESLint、Web typegen + tsc、API tsc、API 类型排除基线核验 | 存量 lint/type 基线仍存在，见下文 |
| TypeScript Check | 复用同一个 `lint-and-type` worker 的完整结果 | 不重复执行第二轮类型检查 |
| Unit Tests | `test` 和 `integration` 均成功：工作流契约、可信基线迁移账本、API 单测、PAY-1 子集、billing cron、proxy、CI safeguards；BILL2、Runtime、空库文件建库与指纹/开户审计/credit guard | 仅指定集成测试；不含所有 integration 文件 |
| Security Unit Tests | 复用完整 `test` worker，包括 API 的 `billing.security.test.ts`、`securityChecks.test.ts` 等 | 不额外执行一个独立安全测试集，也不依赖 integration worker |
| Build Check | `build-and-e2e`：Web 全量 Vitest、`pnpm build`、本地启动、secretless Chromium Security E2E | 构建和测试都实际执行；缓存不会替代结果 |
| Security E2E Tests | 复用同一个 `build-and-e2e`，Playwright 只运行 `security.spec.ts --project=chromium` | 当前 8 项执行、15 项跳过；不是 staging 完整安全验证 |
| Dependency Audit | pnpm 11.13.0 对隔离目录内的原始 `pnpm-lock.yaml` 副本执行 `pnpm audit --audit-level high` | 检查锁文件依赖漏洞；high/critical 阻断，不是业务安全扫描；C8 去掉与该输入无关的全仓安装 |
| Code Security Scan | 拒绝 Git 跟踪的 `.env` / `.env.*`，仅允许 example/sample/template | 不是静态漏洞分析，也不是完整秘密扫描 |
| Workflow Policy Check | 从可信精确基线读取政策与回归测试，运行测试后检查候选 workflow 的事件、权限、action 白名单与固定 SHA 等 | 候选不能用自己修改的政策给自己放行 |
| Secret Scan | 校验 Gitleaks 下载校验和，使用可信基线配置；6 个泄漏夹具必须检出，再扫描指定提交范围 | PR 为 base..head，push 为 before..after；schedule 为前一提交到当前；不是每次扫描全部历史 |

六个 CI 汇总检查都使用 `if: always()`；其前置 worker 缺失、失败、取消或跳过均不能算成功。
两个同源名称表示复用同一真实执行，不能将它们计为两次独立验证。
`Dependency Review` 在 PR 上另行运行，不属于十项；CodeQL 仅在 main/staging push 与定时任务运行，
不属于十项，也未在本 PR 事件中执行。

## 基线运行中实际执行的数量

来源：[CI 36767747604](https://github.com/Crnobog9527/GraylumAI_vercel/actions/runs/36767747604)，
提交 `0470e7a7519ec6b37dcd54566ad459e605782ab9`。计数是该次快照，未来以具体运行日志为准。

| 套件 | 通过 | 跳过 |
| --- | ---: | ---: |
| API（146 个文件） | 3178 | 3 |
| PAY-1 前端子集 | 23 | 3 |
| billing cron | 5 | 0 |
| proxy hostname | 22 | 0 |
| CI safeguards | 128 | 0 |
| Web 全量（62 文件通过，1 文件跳过） | 486 | 6 |
| BILL2 without-app | 79 | 0 |
| Runtime without-app（runtime 91、streaming 12） | 103 | 5 |
| Security E2E | 8 | 15 |

工作流契约基线为 7 个测试、302 个断言，无失败或跳过；C8 增加缓存行为断言后数量会上升。
不同套件有重叠，不能将各行相加当作独立用例数。

## Security E2E：15 个跳过项

来源：[security.spec.ts](../../apps/web/tests/e2e/security.spec.ts)。
CI 设置 `SECURITY_E2E_LOCAL_ONLY=true`、`E2E_ALLOW_DATABASE_FIXTURES=false`，使用本地应用和占位配置。
以下 live-runtime / 身份夹具用例不执行，HTTPS 一项为固定跳过：

| 分类 | 精确用例名称 |
| --- | --- |
| XSS（2） | `should escape script tags in user input display`；`should sanitize HTML entities in displayed content` |
| Authentication（5） | `should protect chat page from unauthenticated access`；`should protect profile page from unauthenticated access`；`should not expose session tokens in URL`；`should use secure password input`；`should not autocomplete sensitive fields` |
| Input Validation（3） | `should validate email format on login`；`should handle SQL injection attempts safely`；`should limit input length in forms` |
| Rate Limiting（1） | `should show appropriate message when rate limited` |
| HTTPS（1） | `should redirect HTTP to HTTPS in production` |
| Authenticated Security（3） | `should reject representative admin write procedures for authenticated non-admin users`；`should enforce self-only access for tickets and conversations across users`；`should return private attachment paths on upload and signed URLs on authorized ticket reads` |

执行的 8 项是 Authorization 2、Headers 4、Cookies 2，但断言本身还有局限：
admin API 拒绝检查接受 500/503；X-Frame-Options、X-Content-Type-Options 仅在存在时断言；
XSS/CSP 项是恒真 soft check；Cookie 项可能没有样本，第二项没有有效断言，第一项仅检查已有
session/token cookie 的 HttpOnly（标题中的 Secure 并未实际断言）。这些既有缺口本任务只披露，未改动。

[结果校验器](../../.github/scripts/check-playwright-results.cjs) 当前允许 skipped，
但拒绝零执行、失败、超时、中断、flaky 和未知结果；重试后恢复成功也不能掩盖 flaky。
因此 8 项通过不能证明完整安全覆盖、真实身份权限或 staging 产品验收。

## 其他跳过与未纳入的用例

### API：候选 Skill 3 项

[skill-candidate.test.ts](../../packages/api/src/services/opc/skill-candidate.test.ts)
缺 `V3_MENTOR_SKILL_CANDIDATE` 时跳过：

- `validates through the real publication and resource loader without publishing`
- `loads the revised E1 contract consistently with mentor resources and host confirmation`
- `preserves all other original files and the six-step nine-question workflow`

### PAY-1 子集排除 3 项，但 Web 全量执行它们

[根脚本](../../package.json) 的 testNamePattern 排除：

- `keeps the unavailable state safe in a local mobile browser`
- `validates disabled plan/package actions and the Portal entry in a local browser`
- `runs the actual upgrade preview, explicit confirmation and drift-reconfirmation UI locally`

这些用例在 `build-and-e2e` 的完整 Web Vitest 中运行，不能描述为整个 CI 跳过。

### Web：独立 GoTrue 验证 6 项

[authFlow.gotrue.test.ts](../../apps/web/src/lib/authFlow.gotrue.test.ts) 缺
`UNCONFIRMED_LOGIN_GOTRUE_URL` / `UNCONFIRMED_LOGIN_MAIL_URL` 时整组跳过：

- `signs up and routes the correct password to the verify page by error code`
- `answers a wrong password and an unknown email identically, both with the resend entry`
- `accepts a resend for an unknown email exactly like a real one`
- `treats a repeat sign-up as success without changing the password`
- `lands an expired confirmation link on the resend page with the fixed reason`
- `lands a valid resent link on the login page with "please log in", never a session from the fragment`

### Runtime：需要应用或浏览器的 5 项

[without-app.mjs](../../packages/db/tests/v3/without-app.mjs) 列出精确排除并验证数量；
未列出的跳过、缺失执行文件或失败都会报错。当前排除：

- `RUNTIME: browser ordinary and document Skill survive refresh, actual process restart and fresh login`
- `RUNTIME: attached organizer search=false stopAfterPrimary=false preserves original run`
- `RUNTIME: attached organizer search=true stopAfterPrimary=false preserves original run`
- `RUNTIME: attached organizer search=false stopAfterPrimary=true preserves original run`
- `RUNTIME: actual HTTP disconnect keeps late output in original scope and killed process preserves unknown without resend`

第一项需要 Chrome 与 Next 重启，中间三项需要 Next HTTP `runtime.view`，最后一项需要断开 HTTP 并杀掉应用进程。

### 未纳入，与 skipped 不同

API 普通配置仅选 `src/**/*.test.ts`；CI 集成 runner 仅选择 BILL2 的
`billing.integration.ts` 与 Runtime 的 `runtime.integration.ts`、`streaming.integration.ts`。
其余 integration 文件（包括 OPC、工作台等）未被这次 CI 选择，不计入上述 skipped 数量。
Playwright 只选 security 文件和 Chromium；其他 spec、mobile-chrome、auth setup 不在此次执行。
secretless 配置主动取消 auth setup 依赖。

## lint 与类型存量基线

核实版本中，ESLint suppression 为 Web 57 文件 / 130 处、API 102 文件 / 587 处。
正式 API tsc 排除 35 个已知有类型错误的测试文件；类型基线检查器会解除排除扫描，要求清单对应、
基线外无错误，并要求已无错误的文件移出基线。不能说这 35 个文件完全未扫描，也不能把绿灯解释为零存量错误。
相关机制和维护要求见 [工程规范](../ENGINEERING.md#7-测试与验证)。
