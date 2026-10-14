# ADMIN-SECRETS：后台管理第三方业务密钥 — 实施方案

> 写于 2026-10-14，依据 staging `49211928`。总控 2026-10-14 已确认方案，公共机制用迁移 0259；确认时的协调安排见第 7 节。方案确认不等于合并、迁移应用或配置变更授权。
> 本仓库是公开仓库：本文、PR 和测试里只出现假的密钥字符串，不出现任何真实密钥、真实密钥的末 4 位或指纹前缀。

## 0. Owner 决定和本任务范围

Owner 2026-10-14（选项 A）原话：

> 业务第三方密钥改为后台填写，加密存放、只写不读；系统底层密钥继续放 Vercel

这条决定由总控写进 Master Plan 第 2.1 节（日期、原话、取代的旧做法：业务第三方密钥放 Vercel 环境变量、OpenRouter 密钥存 `ai_models.api_key`）。本文只引用；在 2.1 节补记之前，以本节原话为依据。

| 归类 | 密钥 | 本任务 |
| --- | --- | --- |
| 业务第三方密钥（改为后台填写） | OpenRouter、Post for Me、TikHub、Parallel、Firecrawl | 做 |
| 系统底层密钥（继续放 Vercel） | 数据库连接、Supabase service role、Stripe、Upstash Redis、hCaptcha、开户赠送 HMAC 等 | 不动 |

**这次要做到什么**：管理员能在后台填写、替换、清除上面 5 把业务密钥；密钥在数据库里加密存放，任何接口都不把原文还给浏览器；每次改动都有审计记录；服务端有一个统一的取用工具；OpenRouter 现在明文存在 `ai_models.api_key` 里的密钥迁进加密存储，并最终删掉这一列。

**怎样算做完**：第 7 节列出的全部 PR 合并并在 staging 验证；正式环境由 Owner 在后台填好密钥（REL-1 核对）；过渡期的环境变量后备按第 4.4 节下线。

**不做什么**：不动系统底层密钥；不做"测试连接"按钮（会产生付费调用，需要时由各调用方的 PR 单独提）；不做密钥自动轮换和到期提醒；不做多把同类密钥的分流或负载均衡。

## 1. 存放方式

### 1.1 用 Supabase Vault

staging 已装 `supabase_vault` 0.3.1（schema `vault`，2026-10-14 只读核对，`vault.secrets` 目前 0 行）。Vault 把密文存在 `vault.secrets` 表里，用带认证的加密算法（libsodium AEAD）。

- **加密主密钥在哪里**：由 Supabase 在它的后端系统里生成和保管，**不和数据一起存在数据库里**（[Supabase Vault 文档](https://supabase.com/docs/guides/database/vault#encryption-key-location)）。数据库备份、导出、复制流里只有密文。每个 Supabase 项目各有一把，staging 和正式环境互不通用；把备份恢复到别的项目也解不开（这是好事，也意味着换项目时要在新项目后台重新填写）。
- **谁能解密**：只有能读视图 `vault.decrypted_secrets` 的数据库角色。平台默认只有 `postgres` 和 `service_role` 有这个权限（只读核对：`anon`、`authenticated` 对 `vault` 下的表和视图没有任何权限）。另外，Supabase 控制台（Owner 本人登录）也能看到 Vault 里的明文，这属于平台所有者权限，不是网站的漏洞。
- **Graylum 自己的约束**：服务端代码只通过一个专用读取函数取明文（第 4 节），不直接查 `vault.decrypted_secrets`。`service_role` 的平台默认权限我们不去收回（这些对象归 `supabase_admin` 所有，迁移收不回，强行改也会和平台升级冲突）；`service_role` 本来就是只放在 Vercel 服务端的系统底层密钥，它泄露时整个数据库都失守，所以这不是新增的风险。

### 1.2 新增的数据库对象（迁移 0259，只放公共机制）

1. 迁移**不创建扩展**（Supabase 平台自带 `supabase_vault`，归 `supabase_admin` 管理）。函数在调用时检查 `vault.secrets` 是否存在，不存在就报 `PLATFORM_SECRET_VAULT_MISSING`，不会退化成明文存放。正式库是否已装，上线前请 Owner 授权做只读核对（第 8 节）。
2. 表 `public.platform_secrets`：每把密钥一行，**不存原文**。

   | 列 | 说明 |
   | --- | --- |
   | `slot` text 主键 | 固定清单：`openrouter`、`postforme`、`tikhub`、`parallel`、`firecrawl`（CHECK 约束） |
   | `vault_secret_id` uuid | 指向 `vault.secrets.id`；清除后为空 |
   | `last4` text | 原文最后 4 位；清除后为空 |
   | `revision` bigint | 每次写入、替换、清除加 1，用于防并发覆盖 |
   | `updated_by` uuid | 操作的管理员；系统迁移写入时为空。不设外键，不挡管理员账号注销 |
   | `updated_at` timestamptz | 服务端时间 |

   打开 RLS、不建任何策略；`REVOKE ALL ... FROM PUBLIC, anon, authenticated`，只给 `service_role` 读（状态函数也能读，见下）。
3. 四个函数，全部 `SECURITY DEFINER`、`SET search_path=public,pg_temp`、归 `postgres` 所有；`REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated`，只 `GRANT EXECUTE ... TO service_role`。Supabase 对 `public` 下新函数默认授权给 `anon`/`authenticated`，所以必须显式收回，测试逐个断言。

   | 函数 | 作用 |
   | --- | --- |
   | `platform_secret_set(p_slot, p_value, p_expected_revision, p_actor)` | 填写或替换。检查 `p_actor` 是启用中、未删除的管理员；检查 slot 在清单里；值的长度 16–1024、不含空白和控制字符；`p_expected_revision` 不等于当前值时报 `PT409`。第一次用 `vault.create_secret(值, 'graylum.platform.<slot>')`，之后用 `vault.update_secret`。写 `last4`、`revision+1`、操作人和时间，写一条审计（第 3 节）。返回状态（不含原文） |
   | `platform_secret_clear(p_slot, p_expected_revision, p_actor)` | 清除。管理员和版本检查同上；从 `vault.secrets` 删除这一条，`vault_secret_id`、`last4` 置空，`revision+1`，写审计。没填过时清除是幂等的空操作，不写审计 |
   | `platform_secret_status()` | 返回每个 slot 的 `configured`、`last4`、`revision`、`updated_by`、`updated_at`。不返回原文、不返回 `vault_secret_id` |
   | `platform_secret_read(p_slot)` | 返回原文；没填时返回 NULL。**只给服务端取用工具用**，后台接口不调用它 |

   同一 slot 的写入和清除用 `pg_advisory_xact_lock` 串行。函数里所有报错只带错误码，不把参数拼进错误信息，避免原文进入数据库日志（Supabase 默认不在出错日志里记录绑定参数，测试用假值核对报错文本不含原文）。

### 1.3 本机和 CI 的测试库

本机和 CI 用的是普通 PostgreSQL 镜像，没有 `supabase_vault`。因为迁移不创建扩展、函数体只在调用时才用到 `vault`，公共的空库建库和指纹回放不受影响，`expected-differences.json` 不用改。本任务自己的数据库测试在建库后另外装一个只用于测试的 Vault 替身（`packages/db/tests/platform-secrets/vault_stub.sql`）：提供同名、同参数的 `vault.secrets`、`vault.decrypted_secrets`、`vault.create_secret`、`vault.update_secret`，用 pgcrypto 和写死在测试文件里的假主密钥加密，权限按 staging 实测的样子授予。替身不能应用到 staging 或正式环境。

## 2. 后台交互：只能写，不能读

- 位置：单独的后台子页面 `/admin/secrets`（"第三方密钥"），组件放在 `apps/web/src/components/admin/PlatformSecretsSettings.tsx`，后台侧边栏加一行入口。不改 `admin/settings/page.tsx`（总控 2026-10-14 安排，避开 #958）。
- 每把密钥一行，显示：名称、状态、末 4 位、更新时间、更新人。状态三种：
  - **后台已填写**：显示后台那把的末 4 位；
  - **未填写，正在使用 Vercel 环境变量**（只在过渡期、且该 slot 允许后备时出现，见第 4.4 节）：显示环境变量那把的末 4 位，提示"建议在这里填写"；
  - **未配置**：相关功能会明确报"未配置"。
- 操作：
  - **填写 / 替换**：密码输入框，从不预填；提交后输入框清空。提交时带上页面读到的 `revision`，别人刚改过时提示"已被其他管理员修改，请刷新"。
  - **清除**：二次确认，确认文字写明"清除后（过渡期内）会改用 Vercel 环境变量；没有环境变量时相关功能停止"。
- 接口（tRPC，`adminProcedure`，路由文件 `packages/api/src/routers/platformSecrets.ts`）：
  - `status`：返回第 2 节显示需要的字段；环境变量那一列只返回"有没有"和末 4 位，由服务端计算。
  - `set`：输入 slot、值、revision；按 slot 用 zod 校验格式（OpenRouter 以 `sk-or-` 开头；Post for Me 与 #939 一致，`pfm_live_`/`pfm_test_` 开头；三家搜索先只做长度和字符集检查）。成功后**只返回状态**，不回显值。
  - `clear`：输入 slot、revision。
  - 没有任何返回原文的接口。测试对每个接口的返回做"不含假原文"的断言。
- 请求日志：tRPC 的错误日志和 Sentry 上报对 `set` 的输入做脱敏（值字段一律替换成 `[redacted]`），测试覆盖校验失败、数据库报错两种路径。

## 3. 审计

复用现有的管理员审计表 `user_activity_logs`（Owner 2026-10-12 已定按账务记录保留 3 年，不走 30 天日志清理），不新建表。每次写入、替换、清除、系统迁移写一行：

| 字段 | 内容 |
| --- | --- |
| `admin_id` | 操作的管理员（系统迁移为空） |
| `action` | `platform_secret_set` / `platform_secret_replace` / `platform_secret_clear` / `platform_secret_migrate` |
| `action_type` | `settings` |
| `details` | `{ slot, last4, previousLast4, revision, previousRevision }` |
| 时间 | 表自带的创建时间 |

`details` 不放原文，也不放原文的哈希（哈希可以用来离线比对猜测值，末 4 位已足够辨认）。测试用一个带特殊标记的假值，写入、替换、清除后扫描 `user_activity_logs` 和 `application_logs` 全表，断言标记不出现。

## 4. 服务端怎么取用

新模块 `packages/api/src/services/platformSecrets/`，对外只导出：

```ts
getPlatformSecret(slot: PlatformSecretSlot, deps?): Promise<{ value: string; source: 'admin' | 'env' }>
invalidatePlatformSecret(slot)
```

### 4.1 缓存和生效时间

- 每个服务器实例在内存里缓存读到的结果 **60 秒**（包括"后台没填"这个结果）。
- 管理员保存或清除后，处理这次请求的实例立即作废自己的缓存；其他实例最迟 60 秒后读到新值。所以**换密钥后最多 60 秒全站生效**。已经发出去的请求继续用旧密钥跑完。
- 原文只存在内存里，不写进日志、错误信息、返回值、数据库其他表或任何持久化位置。

### 4.2 取不到时

| 情况 | 行为 |
| --- | --- |
| 后台已填写 | 用后台的值 |
| 后台没填（或已清除），该 slot 允许后备且环境变量有值 | 用环境变量，`source='env'` |
| 后台没填，也没有可用的环境变量 | 抛 `PLATFORM_SECRET_NOT_CONFIGURED`，调用方按"未配置"明确报错 |
| 读数据库失败或超时（1 秒） | 抛 `PLATFORM_SECRET_UNAVAILABLE`。**不回退到环境变量，也不使用过期缓存**：数据库读不到时我们不知道后台是不是填了另一把，悄悄换成别的密钥会让对账和测试窗口绑定出错 |

### 4.3 过渡期是否兼容环境变量：评估结论

同意总控的建议，但**按 slot 区分**：

| slot | 后备环境变量 | 理由 |
| --- | --- | --- |
| `postforme` | `POSTFORME_API_KEY` | #939/#971 现在读它；后备让接入 PR 和 Owner 填写后台可以各自先后完成，不会出现空档 |
| `tikhub`、`parallel`、`firecrawl` | `TIKHUB_API_KEY`、`PARALLEL_API_KEY`、`FIRECRAWL_API_KEY` | 搜索供应商的调用方还没接线（RT-3a 的适配器只接受传入的 `apiKey`）。如果 Vercel 里还没配这几个变量，后备只是不起作用 |
| `openrouter` | **不设后备** | 新对话引擎（Runtime）现在就明确"不用环境变量"，并且要求密钥指纹等于测试窗口报价里登记的 `account`（`openrouter-key:<sha256>`）。环境变量 `OPENROUTER_API_KEY` 里的那把和后台那把不一定相同，退回去会让指纹校验失败或悄悄换了计费账号。OpenRouter 改由迁移一次性把现有密钥搬进 Vault（第 5 节），不存在空档 |

后台已填写时一律以后台为准，环境变量被忽略。

### 4.4 过渡期什么时候结束

条件：五把密钥在 staging 和正式环境的后台都已填写、所有调用方都已接入。之后单独一个小 PR 删除环境变量后备代码和 `envValidator` 里对应的条目，再请 Owner 从 Vercel 删掉这些变量（删 Vercel 变量属于平台设置，由 Owner 操作）。这个 PR 作为本任务的最后一步，写进 REL-1 之前完成。

## 5. 现状迁移：OpenRouter

### 5.1 现状（2026-10-14 只读核对 staging）

- `ai_models` 5 行全部启用，都填了 `api_key`，而且是**同一把**（只比较了哈希，没有读原文）。所以 OpenRouter 在 Vault 里只设一个平台级 slot，不按模型分。
- `anon`、`authenticated` 对 `api_key` 列没有任何权限（0142 的列级授权）；`postgres`、`service_role` 能读写。
- 代码里直接读 `ai_models.api_key` 的地方：`services/runtime/stagingTransport.ts`（发请求和查账时取密钥，并校验指纹）、`services/runtime/admission.ts` + `positioningGate.ts` 的 `windowBoundKey`（定位前置判断）、`services/fusion/models.ts`（评审团准入时校验指纹）、`services/models/tryReasoning.ts`、`services/models/runtimeEligibility.ts`（"请先配置 API 密钥"）、`services/artifacts/modelPolicy.ts`、`routers/model.ts`（后台模型的保存和连接测试）、`services/diagnostics.ts` / `routers/diagnostics.ts`、`services/providerUtils.ts`（旧的 `OPENROUTER_API_KEY` 后备）、`scripts/cdcB2Fixture.ts`；前端 `apps/web/src/app/admin/models/page.tsx` 有密钥输入框。

### 5.2 指纹不会失效

测试窗口（`runtime_test_windows.call_policies[].account`）登记的是 `openrouter-key:` 加密钥原文的 sha256。迁移只是把**同一个原文**从 `ai_models.api_key` 搬进 Vault，读出来再算哈希结果完全相同，所以现有测试窗口、查账恢复（`automaticRecovery`、`financialRecovery`、`fusion/recovery`）都不受影响。迁移前后各做一次只读核对：只比较 `ai_models` 里的指纹前 8 位和从 Vault 读出值的指纹前 8 位是否相等（只在执行窗口内比较，不写进 PR）。

以后在后台**替换** OpenRouter 密钥，和今天在模型页换密钥一样，会让旧测试窗口绑定失效、旧密钥发起的运行无法再查账（这是现有行为，不是本任务引入的）。后台替换按钮旁边加一句提示，并在交接说明里提醒换密钥后要同步更新测试窗口。

### 5.3 迁移步骤（分两个 PR）

**OR-1（high，迁移号届时由总控分配）——搬进 Vault，代码改读 Vault，列保留**
1. 迁移：如果 `platform_secrets` 里还没有 `openrouter`，并且 `ai_models` 里非空的 `api_key` 去掉首尾空白后**恰好只有一种值**，就在数据库内部把它写进 Vault（原文不出数据库），`updated_by` 为空，写一条 `platform_secret_migrate` 审计。有两种以上不同的值时迁移报错停止，由总控请 Owner 决定用哪把；一行都没有时什么也不做（正式环境可能就是这种情况，由 Owner 在后台填写）。可以重复执行：已经有 `openrouter` 时直接跳过。
2. 代码：5.1 列出的读取点全部改成 `getPlatformSecret('openrouter')`；指纹校验逻辑原样保留，只换密钥来源。后台模型页去掉密钥输入框，改成指向"第三方密钥"区块；`routers/model.ts` 不再接收和写入 `api_key`。`providerUtils` 的 `OPENROUTER_API_KEY` 后备删掉，`envValidator` 不再要求它。
3. `ai_models.api_key` 列暂时保留，但**它不是可靠的回滚依据**：OR-1 上线后管理员在后台替换 OpenRouter 密钥，Vault 会更新而这一列不会，列里可能是已经作废的旧密钥。所以回滚时必须先把 Vault 里的当前值写回这一列（见第 5 步），不能直接撤回代码。OR-1 到 OR-2 之间应尽量短。
   另外：仓库里 9 个集成测试和测试夹具直接往 `ai_models.api_key` 写测试值，OR-1 要把它们改成通过 `platform_secret_set` 写入测试用的 Vault 替身（开工时用 grep 全仓核对一遍）。
4. 验证：本机集成测试（Runtime 恢复、评审团准入、定位前置判断改读 Vault 后行为不变）；staging 应用迁移后用现有测试窗口做一次真实调用（在已批准的测试预算内），确认没有 `RUNTIME_PROVIDER_BINDING_DENIED`。
5. 回滚：先在数据库里执行 PR 附带的回滚脚本（不随迁移自动执行）：用 `platform_secret_read('openrouter')` 取 Vault 里的当前值，写回所有 OpenRouter 模型行的 `api_key`（原文只在数据库内部流转），再撤回代码。这样不管 OR-1 之后有没有在后台换过密钥，撤回后用的都是当前有效的那把。回滚脚本在 OR-1 的本机测试里覆盖"上线后换过密钥再回滚"这一情况。

**OR-2（high）——删掉明文列**
1. 前提：OR-1 已在 staging 部署并验证通过，正式环境的 Vault 里也已有 OpenRouter 密钥（或者确认正式环境本来就没有）。
2. 迁移：先把 `api_key` 全部置空，再 `ALTER TABLE ai_models DROP COLUMN IF EXISTS api_key`；同时清理 0142 留下的列级授权写法，避免以后的迁移再引用这一列。可重复执行。
3. 同一个 PR 里改掉还引用这一列的工具和文档，否则删列后会直接报错：
   - `scripts/check-staging-db-readiness.mjs`（第 415 行统计 `api_key is not null`，第 674 行输出）改成统计 `platform_secret_status()` 里已填写的密钥数量；
   - `docs/runbooks/STAGING_REPRODUCIBILITY.md` 第 263、302、480 行对应的说明；
   - `packages/db/tests/run-ai-models-column-grants.mjs`（0142 列级授权的测试）按删列后的结构调整或退役。
   - `packages/db/seeds/staging_non_secret_baseline.sql`（INSERT 列表和冲突更新里的 `api_key`，第 232–237、302–307 行附近）去掉这一列，并确认它在新结构上仍可重复执行（`packages/db/tests/entitlements/run-local.mjs` 会重复加载它）。
   - 开工时再用 grep 全仓核对一遍 `api_key`，以上清单以核对结果为准。
4. 回滚：数据已在 Vault，不会丢。PR 里附一份**不应用**的反向迁移：重新加回 `api_key` 列，并用 `platform_secret_read('openrouter')` 填回去，配合撤回 OR-1 的代码使用。按 AGENTS.md 第 4 节，需要保留的数据不能用"撤回代码"代替恢复，这份脚本就是恢复方式。

## 6. 删除和注销

这些密钥是平台级配置，不属于任何用户的数据，不进入账号注销和数据删除的范围。`platform_secrets.updated_by` 不设外键，不会挡管理员账号注销；审计行按现有的 `user_activity_logs` 注销规则处理（`erasure_audit_details`），`details` 里本来就没有个人信息以外的敏感内容。

## 7. 接入顺序和 PR 拆分

每个调用方单独一个 PR，都在公共机制合并之后开工。冲突由总控协调，本窗口不动在途 PR 的文件。

| 顺序 | PR | 风险 | 改哪里 | 可能冲突的在途 PR |
| --- | --- | --- | --- | --- |
| 1 | **本方案**（只改文档和 Master Plan 第 7.1 节） | — | `docs/launch/tasks/ADMIN-SECRETS.md`、Master Plan 第 7.1 节加一行 | 无 |
| 2 | **公共机制**（迁移 0259） | high | 迁移 0259、`packages/db/tests/platform-secrets/`（Vault 测试替身和数据库测试）、`built-fingerprint.json`、`services/platformSecrets/`、`routers/platformSecrets.ts`、`root.ts` 注册一行、`app/admin/secrets/page.tsx`、`components/admin/PlatformSecretsSettings.tsx`、`AdminSidebar.tsx` 一行入口 | `root.ts`：#956、#962、#928（各加一行，谁后合并谁解决） |
| 3 | **Post for Me 接入**（总控安排：由 Post for Me 窗口在 #971 合并后顺手接入，不由本窗口做） | high | `services/publishMonitor/postForMe/config.ts` 的 `postForMeApiKey` 改为调用 `getPlatformSecret('postforme')`（变成异步，调用处一起改）；`envValidator` 的 `POSTFORME_API_KEY` 改为可选 | #939（建立 `config.ts`）、#971（叠在其上） |
| 4 | **搜索供应商接入**（总控安排：RT-3b 接线时直接用，总控转告 RESEARCH-TOOLS 窗口） | high | RT-3 接线时，调用适配器前用 `getPlatformSecret('tikhub'/'parallel'/'firecrawl')` 取 `apiKey` 传入；适配器本身不用改 | #956、#958、#959 都不需要改；真正冲突的是 RESEARCH-TOOLS 尚未开的接线 PR（RT-3b）。建议由 RESEARCH-TOOLS 窗口在接线时直接用这个工具，不另开 PR |
| 5 | **OpenRouter OR-1**（等总控通知再开工） | high | 见第 5.3 节 | 总控 2026-10-14：#950（0248）、#952（0250）改 Runtime 和 PAYG，#962 改 `fusion/models.ts`，0260 的窗口在改停止流程；这些合并后总控再通知 |
| 6 | **OpenRouter OR-2** | high | 删列迁移和反向迁移脚本 | 无（OR-1 之后） |
| 7 | **结束过渡期** | high | 删环境变量后备代码和 `envValidator` 条目 | 无 |

第 3、4 步由对应窗口顺带完成，本窗口负责第 2、5、6、7 步。

## 8. 正式环境

- 正式环境的密钥由 Owner 本人在正式站后台填写，AI 不经手。
- REL-1 清单由总控加入以下核对（只读核对，正式库要在上线前请 Owner 授权后才能读）：
  1. 正式库已装 `supabase_vault`；
  2. 后台"第三方密钥"区块里 5 把密钥的状态都是"后台已填写"（只看状态和末 4 位，不读原文）；
  3. OpenRouter OR-2 已应用，正式库 `ai_models` 已没有 `api_key` 列；
  4. 过渡期已结束（第 4.4 节），Vercel 正式环境里已没有这 5 个业务密钥变量。

## 9. 公共机制 PR 的测试清单

| 要证明的事 | 测试 |
| --- | --- |
| 管理员能写；普通用户、未登录被拒 | tRPC 路由测试：admin 成功；普通用户 `FORBIDDEN`；未登录 `UNAUTHORIZED` |
| 数据库层也拒绝非管理员 | SQL 测试：`p_actor` 是普通用户、已停用或已删除的管理员时 `platform_secret_set`/`clear` 报错 |
| `authenticated`、`anon` 调不了数据库函数、读不到表 | SQL 测试：分别 `SET ROLE authenticated`/`anon` 调用四个函数、查询 `platform_secrets`，全部 `permission denied` |
| 任何读取接口都拿不到明文 | 路由测试：`status`、`set`、`clear` 的返回和报错里都不含假原文；`platform_secret_status()` 返回不含原文 |
| 审计不含原文 | SQL 集成测试：写入、替换、清除后扫描 `user_activity_logs`、`application_logs`，不含假原文标记；审计行的 `last4`、`previousLast4`、`revision` 正确 |
| 并发和版本 | 旧 `revision` 提交报 `PT409`，值不变、不写审计 |
| 后台没填时退回环境变量 | 取用工具单元测试：允许后备的 slot 读环境变量并返回 `source='env'`；`openrouter` 不读环境变量 |
| 清除后的行为 | 清除后状态变为未配置（或"正在用环境变量"）；`platform_secret_read` 返回 NULL；Vault 里那一条已删除；取用工具在缓存作废后按第 4.2 节表格处理 |
| 数据库读失败不回退 | 取用工具单元测试：数据库报错或超时时抛 `PLATFORM_SECRET_UNAVAILABLE`，不读环境变量，不用过期缓存 |
| 缓存 | 60 秒内不重复查库；保存后本实例立即读到新值 |
| 迁移可以重复执行 | 建库回放：0259 在自己的历史位置连续执行两次结构不变（`run-db-baseline-replay.mjs --local-only --write-built`） |
| 页面 | 组件测试：输入框不预填、保存后清空、三种状态的显示、清除二次确认；浏览器验证交 Codex（按 Owner 的分工） |
