# ADMIN-SECRETS：后台管理第三方业务密钥 — 实施方案

> 写于 2026-10-14，依据 staging `49211928`；2026-10-16 按已合并的实现更新。总控 2026-10-14 已确认方案，公共机制用迁移 0259。
> **当前状态**：公共机制已由 #1009 合并（替代 #975，迁移 0259 已应用到 staging，部署后页面验收 PASS，只用 Firecrawl 假值并已清除）。第 1–4 节描述的是**已经上线到 staging 的实际实现**；第 10 节列出仍未完成的后续任务和各自的验收项。
> 方案确认不等于合并、迁移应用或配置变更授权。本仓库是公开仓库：本文、PR 和测试里只出现假的密钥字符串，不出现任何真实密钥、真实密钥的末 4 位或指纹前缀。

## 0. Owner 决定和本任务范围

Owner 2026-10-14（选项 A）原话：

> 业务第三方密钥改为后台填写，加密存放、只写不读；系统底层密钥继续放 Vercel

这条决定已由总控写进 Master Plan 第 2.1 节（#976）。本文只引用。

| 归类 | 密钥（槽位） | 本任务 |
| --- | --- | --- |
| 业务第三方密钥（改为后台填写） | OpenRouter（`openrouter`）、Post for Me API 密钥（`postforme`）、Post for Me Webhook 共享密钥（`postforme_webhook`）、TikHub（`tikhub`）、Parallel（`parallel`）、Firecrawl（`firecrawl`），共 **6 个槽位** | 做 |
| 系统底层密钥（继续放 Vercel） | 数据库连接、Supabase service role、Stripe、Upstash Redis、hCaptcha、开户赠送 HMAC 等 | 不动 |

**这次要做到什么**：管理员能在后台填写、替换、清除上面 6 个槽位的密钥；密钥在数据库里加密存放，任何接口都不把原文还给浏览器；每次改动都有审计记录；服务端有一个统一的取用工具；所有调用方改用这个工具；OpenRouter 现在明文存在 `ai_models.api_key` 里的密钥迁进加密存储，并最终删掉这一列。

**怎样算做完**：第 10 节列出的后续任务全部合并并在 staging 验证；正式环境由 Owner 在后台填好密钥（REL-1 核对，第 8 节）；过渡期的环境变量后备和全仓旧引用按第 4.4 节清理完毕。

**不做什么**：不动系统底层密钥；不做"测试连接"按钮（会产生付费调用，需要时由各调用方的 PR 单独提）；不做密钥自动轮换和到期提醒；不做多把同类密钥的分流或负载均衡。

## 1. 存放方式（已实现，#1009）

### 1.1 用 Supabase Vault

staging 已装 `supabase_vault` 0.3.1（schema `vault`）。Vault 把密文存在 `vault.secrets` 表里，用带认证的加密算法（libsodium AEAD）。

- **加密主密钥在哪里**：由 Supabase 在它的后端系统里生成和保管，**不和数据一起存在数据库里**（[Supabase Vault 文档](https://supabase.com/docs/guides/database/vault#encryption-key-location)）。数据库备份、导出、复制流里只有密文。每个 Supabase 项目各有一把，staging 和正式环境互不通用；把备份恢复到别的项目也解不开（这是好事，也意味着换项目时要在新项目后台重新填写）。
- **谁能解密**：只有能读视图 `vault.decrypted_secrets` 的数据库角色。平台默认只有 `postgres` 和 `service_role` 有这个权限（`anon`、`authenticated` 对 `vault` 下的表和视图没有任何权限）。另外，Supabase 控制台（Owner 本人登录）也能看到 Vault 里的明文，这属于平台所有者权限，不是网站的漏洞。
- **Graylum 自己的约束**：服务端代码只通过专用读取函数 `platform_secret_read` 取明文（第 4 节），不直接查 `vault.decrypted_secrets`。`service_role` 对 `vault` 的平台默认权限我们不去收回（这些对象归 `supabase_admin` 所有，迁移收不回，强行改也会和平台升级冲突）；`service_role` 本来就是只放在 Vercel 服务端的系统底层密钥，它泄露时整个数据库都失守，所以这不是新增的风险。

### 1.2 数据库对象（迁移 `0259_platform_secrets.sql`）

1. 迁移**不创建扩展**（Supabase 平台自带 `supabase_vault`）。没有 Vault 时函数报 `PLATFORM_SECRET_VAULT_MISSING`，不会退化成明文存放。正式库是否已装，上线前请 Owner 授权做只读核对（第 8 节）。
2. 表 `public.platform_secrets`：每个槽位一行，**不存原文**。

   | 列 | 说明 |
   | --- | --- |
   | `slot` text 主键 | 固定清单（CHECK 约束）：`openrouter`、`postforme`、`postforme_webhook`、`tikhub`、`parallel`、`firecrawl` |
   | `vault_secret_id` uuid | 指向 `vault.secrets.id`；清除后为空 |
   | `last4` text | 原文最后 4 位；清除后为空（CHECK：和 `vault_secret_id` 同时为空或同时有值） |
   | `revision` bigint | 每次写入、替换、清除加 1，用于防并发覆盖 |
   | `updated_by` uuid | 操作的管理员。不设外键，不挡管理员账号注销 |
   | `updated_at` timestamptz | 服务端时间 |

   打开 RLS、不建任何策略；`REVOKE ALL ... FROM PUBLIC, anon, authenticated, service_role`——**连 `service_role` 也不能直接读写这张表**，只能通过下面的函数。
3. 函数：全部 `SECURITY DEFINER`、`SET search_path=public,pg_temp`、归 `postgres` 所有；先对 `PUBLIC, anon, authenticated, service_role` 全部 `REVOKE EXECUTE`，再只把下面 4 个对外函数 `GRANT EXECUTE ... TO service_role`。

   | 函数 | 作用 |
   | --- | --- |
   | `platform_secret_set(p_slot, p_value, p_expected_revision, p_actor)` | 填写或替换。检查 `p_actor` 是启用中、未删除的管理员；检查 slot 在清单里；值的长度 16–1024、只能是不含空格的可打印 ASCII；`p_expected_revision` 不等于当前值时报 `PT409`。第一次写入用 `vault.create_secret(值, 'graylum.platform.<slot>')`（先删除同名的残留条目），之后用 `vault.update_secret`。写 `last4`、`revision+1`、操作人和时间，写一条审计（第 3 节）。返回全部槽位的状态（不含原文） |
   | `platform_secret_clear(p_slot, p_expected_revision, p_actor)` | 清除。管理员和版本检查同上；从 `vault.secrets` 删除这一条，`vault_secret_id`、`last4` 置空，`revision+1`，写审计。没填过时清除是幂等的空操作，不写审计 |
   | `platform_secret_status()` | 返回每个槽位的 `configured`、`last4`、`revision`、`updated_by`、`updated_at`。不返回原文、不返回 `vault_secret_id` |
   | `platform_secret_read(p_slot)` | 返回原文；没填时返回 NULL；Vault 条目丢失时报 `PLATFORM_SECRET_VAULT_ENTRY_MISSING`。**只给服务端取用工具用**，后台接口不调用它 |

   另有内部函数 `platform_secret_check`（输入、管理员和 Vault 检查），不授权给任何角色。同一 slot 的写入和清除用 `pg_advisory_xact_lock` 串行。所有报错只带错误码，不把参数拼进错误信息。

### 1.3 本机和 CI 的测试库

本机和 CI 用的是普通 PostgreSQL 镜像，没有 `supabase_vault`。因为迁移不创建扩展、函数体只在调用时才用到 `vault`，公共的空库建库和指纹回放不受影响。本任务的数据库测试在建库后另外装一个只用于测试的 Vault 替身（`packages/db/tests/platform-secrets/vault_stub.sql`），由 `packages/db/tests/platform-secrets/run-local.mjs` 加载。替身不能应用到 staging 或正式环境。

## 2. 后台交互：只能写，不能读（已实现，#1009）

- 位置：单独的后台子页面 `/admin/secrets`（"第三方密钥"），组件 `apps/web/src/components/admin/PlatformSecretsSettings.tsx`，文案和状态逻辑在 `platformSecretsView.ts`，后台侧边栏一行入口。
- 每个槽位一行，显示：名称、用途、状态、末 4 位、更新时间、更新人邮箱。"当前来源"有三种：
  - **后台已填写**（`source='admin'`）：显示后台那把的末 4 位；
  - **未填写，正在使用 Vercel 环境变量**（`source='env'`，只在过渡期、且该槽位允许后备、且环境变量确实有值时出现，见第 4.3 节）：显示环境变量名和末 4 位，提示"建议在这里填写"；
  - **未配置**（`source='none'`）：相关功能会明确报"未配置"。
- 操作：
  - **填写 / 替换**：密码输入框，从不预填；提交后输入框清空。提交时带上页面读到的 `revision`，别人刚改过时提示"这把密钥刚被其他管理员修改过，已重新读取"。OpenRouter 的替换旁边额外提示：换密钥后 staging 测试窗口要同步更新，用旧密钥发起、还没对账的调用无法再查账（第 5.2 节）。
  - **清除**：二次确认。**确认文案按槽位区分**：
    - 该槽位允许后备、并且对应的环境变量确实有值：写明"清除后会改用 Vercel 环境变量 `<变量名>`（末 4 位 xxxx）"；
    - 其他情况（包括 **OpenRouter——它不设后备**，以及允许后备但环境变量没值的槽位）：写明"清除后没有可用的密钥，相关功能会停止并提示'未配置'"。

    也就是说，即使 Vercel 里还留着 `OPENROUTER_API_KEY`，清除 OpenRouter 时也只会提示"相关功能会停止"，不会让人以为会退回环境变量。
- 接口（tRPC `packages/api/src/routers/platformSecrets.ts`，全部 `adminProcedure`）：
  - `status`：返回上面显示需要的字段；环境变量那一列只返回变量名、"有没有"和末 4 位，由服务端计算（OpenRouter 的这一列为空）。
  - `set`：输入 slot、值、revision；按 slot 校验格式（OpenRouter 以 `sk-or-` 开头；Post for Me API 密钥为 `pfm_live_`/`pfm_test_` 加 8–128 位字母数字；Webhook 共享密钥和三家搜索只做 16–1024 位、不含空格的可打印 ASCII 检查）。成功后**只返回状态**，不回显值，并作废本实例的缓存。
  - `clear`：输入 slot、revision；成功后作废本实例的缓存。
  - 没有任何返回原文的接口。
- 请求日志：Sentry 上报沿用现有的全局脱敏（`apps/web/src/lib/sentry-scrub.ts` 只保留错误码、URL 模板化，`/admin/secrets` 已登记为静态路由）；服务端和数据库的报错只带错误码，不含输入值。

## 3. 审计（已实现，#1009）

复用现有的管理员审计表 `user_activity_logs`（Owner 2026-10-12 已定按账务记录保留 3 年），不新建表。每次写入、替换、清除写一行：

| 字段 | 内容 |
| --- | --- |
| `admin_id` | 操作的管理员 |
| `action` | `platform_secret_set` / `platform_secret_replace` / `platform_secret_clear`（OR-1 的迁移会另外写 `platform_secret_migrate`，见第 5.3 节） |
| `action_type` | `settings` |
| `details` | `{ slot, last4, previousLast4, revision, previousRevision }` |
| 时间 | 表自带的创建时间 |

`details` 不放原文，也不放原文的哈希（哈希可以用来离线比对猜测值，末 4 位已足够辨认）。

## 4. 服务端怎么取用（已实现，#1009）

模块 `packages/api/src/services/platformSecrets/`，调用方使用：

```ts
getPlatformSecret(admin, slot, deps?): Promise<{ value: string; source: 'admin' | 'env' }>
invalidatePlatformSecret(slot)
```

`admin` 是服务端的 service role Supabase 客户端（只需要 `rpc`）。失败时抛 `PlatformSecretError`，`code` 为 `PLATFORM_SECRET_NOT_CONFIGURED` 或 `PLATFORM_SECRET_UNAVAILABLE`。

### 4.1 缓存和生效时间

- 每个服务器实例在内存里缓存读到的结果 **60 秒**（包括"后台没填"这个结果）；同一槽位的并发读取合并成一次查询。
- 管理员保存或清除后，处理这次请求的实例立即作废自己的缓存；作废前已经发出的读取不能再把旧值写回缓存。其他实例最迟 60 秒后读到新值，所以**换密钥后最多 60 秒全站生效**。已经发出去的请求继续用旧密钥跑完。
- 原文只存在内存里，不写进日志、错误信息、返回值、数据库其他表或任何持久化位置。

### 4.2 取不到时

| 情况 | 行为 |
| --- | --- |
| 后台已填写 | 用后台的值，`source='admin'` |
| 后台没填（或已清除），该槽位允许后备且环境变量有值 | 用环境变量，`source='env'` |
| 后台没填，也没有可用的环境变量 | 抛 `PLATFORM_SECRET_NOT_CONFIGURED`，调用方按"未配置"明确报错 |
| 读数据库失败或超时（1 秒） | 抛 `PLATFORM_SECRET_UNAVAILABLE`。**不回退到环境变量，也不使用过期缓存**：数据库读不到时我们不知道后台是不是填了另一把，悄悄换成别的密钥会让对账和测试窗口绑定出错 |

### 4.3 过渡期的环境变量后备（按槽位区分）

后备清单写在 `slots.ts` 的 `PLATFORM_SECRET_ENV_FALLBACK`：

| 槽位 | 后备环境变量 | 理由 |
| --- | --- | --- |
| `postforme` | `POSTFORME_API_KEY` | 现有 `postForMe/config.ts` 读它；后备让接入 PR 和 Owner 填写后台可以各自先后完成，不会出现空档 |
| `postforme_webhook` | `POSTFORME_WEBHOOK_SECRET` | #991 的 Webhook 校验按原设计读它（#991 尚未合并）；同上 |
| `tikhub`、`parallel`、`firecrawl` | `TIKHUB_API_KEY`、`PARALLEL_API_KEY`、`FIRECRAWL_API_KEY` | 搜索供应商的调用方还没接线（RT-3a 的适配器只接受传入的 `apiKey`）。如果 Vercel 里没配这几个变量，后备只是不起作用 |
| `openrouter` | **不设后备** | 新对话引擎（Runtime）明确"不用环境变量"，并且要求密钥指纹等于测试窗口报价里登记的 `account`（`openrouter-key:<sha256>`）。环境变量 `OPENROUTER_API_KEY` 里的那把和后台那把不一定相同，退回去会让指纹校验失败或悄悄换了计费账号。OpenRouter 改由迁移一次性把现有密钥搬进 Vault（第 5 节） |

后台已填写时一律以后台为准，环境变量被忽略。

### 4.4 过渡期什么时候结束、结束时清理什么

**条件**：6 个槽位在 staging 和正式环境的后台都已填写（正式环境由 Owner 操作），所有调用方都已改用 `getPlatformSecret`（第 10 节的 Post for Me、搜索、OR-1 都已合并）。

**结束过渡期的 PR**（第 10 节 T-END）要做：

1. 删除 `PLATFORM_SECRET_ENV_FALLBACK` 的后备（全部改为不设后备）和读取环境变量的代码，后台页面不再显示"正在使用 Vercel 环境变量"这种状态。
2. 删除 `envValidator` 里对应的条目（届时已改为可选的 `POSTFORME_API_KEY` 等；`OPENROUTER_API_KEY` 由 OR-1 先删）。
3. **全仓核对并同步更新旧环境变量引用**。开工时用 `git grep -n -E "OPENROUTER_API_KEY|POSTFORME_API_KEY|POSTFORME_WEBHOOK_SECRET|TIKHUB_API_KEY|PARALLEL_API_KEY|FIRECRAWL_API_KEY"` 全仓核对，以核对结果为准。2026-10-16 在 staging 上已知的位置：
   - 文档：`docs/RELEASE_PREP_CHECKLIST.md`（第 33 行）、`docs/DEPLOYMENT.md`（第 41 行）、`docs/ARCHITECTURE.md`（第 202 行）、`docs/runbooks/STAGING_REPRODUCIBILITY.md`（第 301、324 行）、`docs/runbooks/INCIDENT_RESPONSE.md`（第 128 行），改成"在后台第三方密钥页填写"；
   - 配置：`.env.example`（第 38 行）、`turbo.json`（第 13 行）、`.github/workflows/ci.yml`（第 223 行，只是给本机运行时的占位值）；
   - 种子说明：`packages/db/seeds/staging_non_secret_baseline.sql` 第 26 行的注释；
   - 代码和测试：`packages/api/src/lib/envValidator.ts` 及其测试、`packages/api/src/services/providerUtils.ts` 及其测试（这两处由 OR-1 先处理）、`postForMe/config.ts` 和 `client.test.ts`（由 Post for Me 接入先处理）。
   - 不在范围：`AC0_OPENROUTER_API_KEY`（`scripts/ac0Probe`、`scripts/stg-mentor-live.mjs`）是本机测量脚本单独使用的密钥，不是业务密钥，不动；`docs/archive/`、执行记录和证据文件是历史记录，不改。
   - CI 文件只删不再使用的变量声明，不改任何检查的内容和范围；如果核对时发现某项检查依赖这些变量，先停下来报告总控，按 AGENTS.md 第 1 节处理，不自己放宽。
4. 合并并部署后，请 Owner 从 Vercel（staging 和正式）删掉这 6 个变量：`OPENROUTER_API_KEY`、`POSTFORME_API_KEY`、`POSTFORME_WEBHOOK_SECRET`、`TIKHUB_API_KEY`、`PARALLEL_API_KEY`、`FIRECRAWL_API_KEY`（删 Vercel 变量属于平台设置，由 Owner 操作）。

这个 PR 作为本任务的最后一步，在 REL-1 之前完成。

## 5. 现状迁移：OpenRouter（未开始，见第 10 节 OR-1、OR-2）

### 5.1 现状（2026-10-14 只读核对 staging）

- `ai_models` 5 行全部启用，都填了 `api_key`，而且是**同一把**（只比较了哈希，没有读原文）。所以 OpenRouter 在 Vault 里只设一个平台级槽位，不按模型分。
- `anon`、`authenticated` 对 `api_key` 列没有任何权限（0142 的列级授权）；`postgres`、`service_role` 能读写。
- 代码里直接读 `ai_models.api_key` 的地方：`services/runtime/stagingTransport.ts`（发请求和查账时取密钥，并校验指纹）、`services/runtime/admission.ts` + `positioningGate.ts` 的 `windowBoundKey`（定位前置判断）、`services/fusion/models.ts`（评审团准入时校验指纹）、`services/models/tryReasoning.ts`、`services/models/runtimeEligibility.ts`（"请先配置 API 密钥"）、`services/artifacts/modelPolicy.ts`、`routers/model.ts`（后台模型的保存和连接测试）、`services/diagnostics.ts` / `routers/diagnostics.ts`、`services/providerUtils.ts`（旧的 `OPENROUTER_API_KEY` 后备）、`scripts/cdcB2Fixture.ts`；前端 `apps/web/src/app/admin/models/page.tsx` 有密钥输入框。OR-1 开工时用 grep 重新核对。

### 5.2 指纹不会失效

测试窗口（`runtime_test_windows.call_policies[].account`）登记的是 `openrouter-key:` 加密钥原文的 sha256。迁移只是把**同一个原文**从 `ai_models.api_key` 搬进 Vault，读出来再算哈希结果完全相同，所以现有测试窗口、查账恢复（`automaticRecovery`、`financialRecovery`、`fusion/recovery`）都不受影响。迁移前后各做一次只读核对：只比较 `ai_models` 里的指纹前 8 位和从 Vault 读出值的指纹前 8 位是否相等（只在执行窗口内比较，不写进 PR）。

以后在后台**替换** OpenRouter 密钥，和今天在模型页换密钥一样，会让旧测试窗口绑定失效、旧密钥发起的运行无法再查账（这是现有行为，不是本任务引入的）。后台替换按钮旁已有提示（第 2 节）。

### 5.3 迁移步骤（分两个 PR）

**OR-1（high，迁移号届时由总控分配）——搬进 Vault，代码改读 Vault，列保留**
1. 迁移：如果 `platform_secrets` 里 `openrouter` 还没填，并且 `ai_models` 里非空的 `api_key` 去掉首尾空白后**恰好只有一种值**，就在数据库内部把它写进 Vault（原文不出数据库），`updated_by` 为空，写一条 `platform_secret_migrate` 审计（`admin_id` 为空）。0259 的 `platform_secret_set` 要求有效的管理员，所以这一步在迁移里直接调用 `vault.create_secret` 并更新 `platform_secrets`，不走 `platform_secret_set`。有两种以上不同的值时迁移报错停止，由总控请 Owner 决定用哪把；一行都没有时什么也不做（正式环境可能就是这种情况，由 Owner 在后台填写）。可以重复执行：已经有 `openrouter` 时直接跳过。
2. 代码：5.1 列出的读取点全部改成 `getPlatformSecret(admin, 'openrouter')`；指纹校验逻辑原样保留，只换密钥来源。后台模型页去掉密钥输入框，改成指向"第三方密钥"页；`routers/model.ts` 不再接收和写入 `api_key`。`providerUtils` 的 `OPENROUTER_API_KEY` 后备删掉，`envValidator` 不再要求它（第 4.4 节第 3 项里这两处的旧引用由 OR-1 先清掉）。
3. `ai_models.api_key` 列暂时保留，但**它不是可靠的回滚依据**：OR-1 上线后管理员在后台替换 OpenRouter 密钥，Vault 会更新而这一列不会，列里可能是已经作废的旧密钥。所以回滚时必须先把 Vault 里的当前值写回这一列（见第 5 步），不能直接撤回代码。OR-1 到 OR-2 之间应尽量短。
   另外：仓库里的集成测试和测试夹具直接往 `ai_models.api_key` 写测试值，OR-1 要把它们改成写入测试用的 Vault 替身（开工时用 grep 全仓核对一遍）。
4. 验证：本机集成测试（Runtime 恢复、评审团准入、定位前置判断改读 Vault 后行为不变）；staging 应用迁移后用现有测试窗口做一次真实调用（在已批准的测试预算内），确认没有 `RUNTIME_PROVIDER_BINDING_DENIED`。
5. 回滚：先在数据库里执行 PR 附带的回滚脚本（不随迁移自动执行）：用 `platform_secret_read('openrouter')` 取 Vault 里的当前值，写回所有 OpenRouter 模型行的 `api_key`（原文只在数据库内部流转），再撤回代码。这样不管 OR-1 之后有没有在后台换过密钥，撤回后用的都是当前有效的那把。回滚脚本在 OR-1 的本机测试里覆盖"上线后换过密钥再回滚"这一情况。

**OR-2（high）——删掉明文列**
1. 前提：OR-1 已在 staging 部署并验证通过，正式环境的 Vault 里也已有 OpenRouter 密钥（或者确认正式环境本来就没有）。
2. 迁移：先把 `api_key` 全部置空，再 `ALTER TABLE ai_models DROP COLUMN IF EXISTS api_key`；同时清理 0142 留下的列级授权写法，避免以后的迁移再引用这一列。可重复执行。
3. 同一个 PR 里改掉还引用这一列的工具和文档，否则删列后会直接报错：
   - `scripts/check-staging-db-readiness.mjs`（统计 `api_key is not null` 的地方）改成统计 `platform_secret_status()` 里已填写的密钥数量；
   - `docs/runbooks/STAGING_REPRODUCIBILITY.md` 里对应的说明；
   - `packages/db/tests/run-ai-models-column-grants.mjs`（0142 列级授权的测试）按删列后的结构调整或退役；
   - `packages/db/seeds/staging_non_secret_baseline.sql`（INSERT 列表和冲突更新里的 `api_key`）去掉这一列，并确认它在新结构上仍可重复执行（`packages/db/tests/entitlements/run-local.mjs` 会重复加载它）；
   - 开工时再用 grep 全仓核对一遍 `api_key`，以上清单以核对结果为准。
4. 回滚：数据已在 Vault，不会丢。PR 里附一份**不应用**的反向迁移：重新加回 `api_key` 列，并用 `platform_secret_read('openrouter')` 填回去，配合撤回 OR-1 的代码使用。按 AGENTS.md 第 4 节，需要保留的数据不能用"撤回代码"代替恢复，这份脚本就是恢复方式。

## 6. 删除和注销

这些密钥是平台级配置，不属于任何用户的数据，不进入账号注销和数据删除的范围。`platform_secrets.updated_by` 不设外键，不会挡管理员账号注销；审计行按现有的 `user_activity_logs` 注销规则处理（`erasure_audit_details`），`details` 里只有槽位、末 4 位和版本。

## 7. 接入顺序和 PR 拆分

每个调用方单独一个 PR（或由对应任务的 PR 顺带完成），都在公共机制合并之后开工。冲突由总控协调。

| 顺序 | PR | 风险 | 状态 | 改哪里 |
| --- | --- | --- | --- | --- |
| 1 | **本方案**（#972，只改文档、Master Plan 第 7.1 节和路线图站点） | — | 本 PR | `docs/launch/tasks/ADMIN-SECRETS.md` 等 |
| 2 | **公共机制**（迁移 0259） | high | **已完成**：#1009 合并（替代 #975），0259 已应用 staging，部署后页面验收 PASS | 见第 1–4 节 |
| 3 | **Post for Me 两把密钥接入**（第 10 节 PFM） | high | 未开始；归 #990/#991（PUBLISH-MONITOR，Codex） | `postForMe/config.ts` 和 Webhook 校验 |
| 4 | **搜索供应商接入**（第 10 节 RT） | high | 未开始；归 RESEARCH-TOOLS 接线 PR（RT-3b） | 调用适配器前取 `apiKey` |
| 5 | **OpenRouter OR-1**（第 10 节 OR-1，等总控通知再开工） | high | 未开始 | 见第 5.3 节 |
| 6 | **OpenRouter OR-2**（第 10 节 OR-2） | high | 未开始（OR-1 之后） | 见第 5.3 节 |
| 7 | **结束过渡期**（第 10 节 T-END） | high | 未开始（3–6 全部完成后） | 见第 4.4 节 |
| 8 | **正式环境核对**（第 10 节 REL） | — | 归 REL-1 | 见第 8 节 |

## 8. 正式环境

- 正式环境的密钥由 Owner 本人在正式站后台填写，AI 不经手。
- REL-1 清单需包含以下核对（只读核对，正式库要在上线前请 Owner 授权后才能读）。#976 写入 REL-1 时按"五把密钥"写的，需要总控同步改为 6 个槽位：
  1. 正式库已装 `supabase_vault`，并已应用 0259；
  2. 后台"第三方密钥"页里 **6 个槽位**（OpenRouter、Post for Me API 密钥、Post for Me Webhook 共享密钥、TikHub、Parallel、Firecrawl）的状态都是"后台已填写"（只看状态和末 4 位，不读原文）；Post for Me 后台填写的 Webhook 共享密钥和 Graylum 后台填写的一致（由 Owner 对照末 4 位）；
  3. OpenRouter OR-2 已应用，正式库 `ai_models` 已没有 `api_key` 列；
  4. 过渡期已结束（第 4.4 节），Vercel 正式环境里已没有第 4.4 节第 4 项列出的 6 个变量。

## 9. 公共机制的测试（已在 #1009 完成）

#1009 已覆盖：管理员能写、普通用户和未登录被拒；数据库层拒绝非管理员和停用、删除的管理员；`anon`、`authenticated` 调不了函数、读不到表；`status`/`set`/`clear` 的返回和报错不含假原文；审计不含原文、`last4` 和版本正确；旧 `revision` 报冲突且不写审计；允许后备的槽位读环境变量、`openrouter` 不读；清除后的状态和读取；数据库读失败不回退、不用过期缓存；60 秒缓存和保存后立即作废；0259 可重复执行；页面组件（输入框不预填、保存后清空、三种状态、按槽位区分的清除确认）。部署后页面验收（只用 Firecrawl 假值并清除，不碰 OpenRouter）PASS，记录在 #1009。

**没有验证的**：真实 Vault 只在 staging 上验证了 Firecrawl 一个槽位；正式库的 Vault 未核对（第 8 节）。

## 10. 后续任务和验收项

下面每一项都是独立的后续任务，由总控按第 7 节的顺序派发。每项完成时，PR 里逐条写明验收结果。

### PFM — Post for Me 两把密钥接入（归 #990/#991）

改动：
- `services/publishMonitor/postForMe/config.ts` 的 `postForMeApiKey` 改为调用 `getPlatformSecret(admin, 'postforme')`（变成异步，调用处一起改）；
- #991 的 **Webhook 校验**改为调用 `getPlatformSecret(admin, 'postforme_webhook')` 取共享密钥，不直接读 `POSTFORME_WEBHOOK_SECRET`；
- `envValidator` 里的 `POSTFORME_API_KEY` 改为可选（如果 #991 给 `POSTFORME_WEBHOOK_SECRET` 加了条目，也改为可选），保留格式检查。

验收：
1. 后台填了 `postforme` 时用后台的值；只有环境变量时用环境变量（`source='env'`）；两边都没有时调用方报"未配置"，不发请求。
2. Webhook：后台填了 `postforme_webhook` 时按后台的值校验；签名不对的请求被拒；只有环境变量时按环境变量校验；两边都没有时 Webhook 一律拒绝并记日志，不放行。
3. 取不到数据库（`PLATFORM_SECRET_UNAVAILABLE`）时，发布调用和 Webhook 都明确失败，不退回环境变量。
4. 测试里用假值；日志、报错和返回不含原文。
5. 删除环境变量后（模拟过渡期结束）只靠后台的值，发布和 Webhook 都正常——证明 T-END 删除变量后不会让回调全部被拒。

### RT — 搜索供应商接入（归 RESEARCH-TOOLS 的 RT-3b 接线 PR）

改动：调用 TikHub、Parallel、Firecrawl 适配器前，用 `getPlatformSecret(admin, 'tikhub' | 'parallel' | 'firecrawl')` 取 `apiKey` 传入；适配器本身不用改。

验收：同 PFM 第 1、3、4 条；"未配置"时按 RESEARCH-TOOLS 的规则如实告知取不到数据，不扣费。

### OR-1 — OpenRouter 搬进 Vault、代码改读 Vault（等总控通知再开工）

改动和步骤见第 5.3 节 OR-1。

验收：
1. 迁移可重复执行；只有一种值时搬入并写 `platform_secret_migrate` 审计，多种值时报错停止，没有值时什么也不做。
2. staging 应用前后指纹前 8 位一致（只在执行窗口内比较）。
3. 第 5.1 节列出的读取点全部改读 Vault（grep 核对 `api_key` 已无读取）；后台模型页没有密钥输入框。
4. 本机集成测试：Runtime 恢复、评审团准入、定位前置判断行为不变。
5. staging 用现有测试窗口做一次真实调用（已批准的测试预算内），没有 `RUNTIME_PROVIDER_BINDING_DENIED`。
6. 回滚脚本覆盖"上线后换过密钥再回滚"。
7. `providerUtils` 和 `envValidator` 不再读或要求 `OPENROUTER_API_KEY`。

### OR-2 — 删掉 `ai_models.api_key`（OR-1 之后）

改动和步骤见第 5.3 节 OR-2。

验收：删列迁移可重复执行；第 5.3 节 OR-2 第 3 项列出的工具、测试和种子都已同步，并在新结构上通过；附带不应用的反向迁移，并在本机验证能恢复。

### T-END — 结束过渡期（PFM、RT、OR-1、OR-2 都完成后）

改动见第 4.4 节。

验收：
1. `PLATFORM_SECRET_ENV_FALLBACK` 不再有任何后备，后台页面不再出现"正在使用 Vercel 环境变量"。
2. 第 4.4 节第 3 项的全仓 `git grep` 结果只剩明确列为"不在范围"的位置；`RELEASE_PREP_CHECKLIST`、`DEPLOYMENT`、`ARCHITECTURE`、`STAGING_REPRODUCIBILITY`、`INCIDENT_RESPONSE`、`.env.example`、`turbo.json`、CI 文件都不再要求这些变量。
3. CI 全绿，且没有改任何检查的内容和范围。
4. 部署后在 staging 删除这 6 个 Vercel 变量（由 Owner 操作），Post for Me 发布、Webhook、三家搜索和 OpenRouter 调用都仍然正常。

### REL — 正式环境核对（归 REL-1）

验收：第 8 节的 4 项全部满足。正式库的读取需要 Owner 在当时授权。
