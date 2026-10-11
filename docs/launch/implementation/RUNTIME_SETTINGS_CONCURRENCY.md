# RUNTIME-PROD 止损设置并发写入

风险 high：全站运行开关。只改后端，不改 #795 前端、计费规则或环境配置，不合并。

## 接口交接给 #795

- `runtimeRateLimits.setStopNewCalls({ stopped: boolean })`：数据库事务内只改停止字段；
  返回 `{ config, source }` 是该次事务写入结果，不在服务层先读后整份覆盖。
- `runtimeRateLimits.update(config)`：兼容原参数形状。`stopNewCalls: true` 表示停止意图，
  转到原子停止接口，只设置停止开关，不写随请求携带的额度。`false` 只更新四个次数额度字段，
  不能清除停止开关；旧页面的一键暂停继续生效。旧协议无法区分恢复意图与过期额度表单，
  因此恢复调用必须使用专用接口；停止期间旧页面保存额度也只会保持停止，待 #795 接线后分开操作。
- `runtimeRateLimits.stopLossConfig()`：返回 `{ config, revision, source }`。
  历史配置和未配置状态的 revision 都为 0；config.version=1 仍是结构版本。
- `runtimeRateLimits.updateStopLoss({ config, expectedVersion: revision })`：必需期望版本。
  数据库持有 0202 的共享锁后比对版本并写入；旧版本返回 PT409，服务层映射为
  tRPC CONFLICT / HTTP 409。缺失版本拒绝写入；每次成功保存递增 revision。
- 前端从读取结果保存 revision，冲突后重新读取；取消前端的非原子预检作为正确性依据。
  原来通过 `update` 操作停止的客户端必须切换到专用接口。

## 数据与最小实现

继续使用 system_settings 两条既有配置和 0202 的 (201,1) 事务锁，无新表、无第二套账本。
支付渠道的 0173/0175 触发器仅覆盖支付键，无法复用其写入函数；沿用其终止型 PT409 冲突约定。
PostgREST 的普通更新不能仅修改 JSON 内单字段，所以必须补专用数据库函数。
止损修订号放在原值内，与配置同一行、同一次提交；现有数据库解析器允许此元数据。
数据库保存和读取兼容历史对象及 JSON 字符串，原始迁移不改。

## 当前交付边界

总控于 2026-10-11 为 #797 分配 **0208**：
`packages/db/migrations/0208_runtime_settings_concurrency.sql`。
前置 #796／0207 已合并，本任务已同步 staging `21854dbc`，使用截至 0208 的正式完整迁移链。
指纹由完整回放生成，不手工拼接。完整链 CI 和当前 head 机器人审查通过后转为可审查，
停下等总控审计。不合并、不应用远端迁移。

部署需数据库迁移和后端接口先到位，再让 #795 接线；不要回滚为旧的整份覆盖写入。
迁移会拒绝旧后端 service-role 对这两个键的整行直写，避免滚动发布期间覆盖新开关或绕过版本检查。
三个专用 SECURITY DEFINER 函数明确归属 postgres；写入触发器只允许此身份修改两个受保护键。
旧实例保存会失败，需刷新到新后端/前端；不能为了兼容旧写入撤掉保护。
迁移不删除配置或改变已有阈值。恢复办法：迁移后旧实例保存失败属于预期，切换到支持专用 RPC 的后端后重新读取再保存。
若新后端暂不能使用，暂停管理保存操作并前向修复；保留现有停止开关、额度及修订号，
不回退数据库直写保护，不重新开放旧实例整份覆盖。停止状态的恢复也必须通过专用接口。
不访问远程数据库、不运行付费模型、不启动浏览器。

## 验证入口

- `node packages/db/tests/run-db-baseline-replay.mjs --local-only --write-built`：正式完整链、逐位置重复迁移及结构指纹。

- `pnpm --filter @repo/api exec vitest run src/routers/runtimeRateLimits.test.ts src/services/runtime/stopLossSettings.test.ts`
- `node packages/db/tests/runtime-settings-concurrency/run-local.mjs --local-only`
  创建并销毁本地 PostgreSQL 17，按正式迁移链一次性完整建库并复验 0208；通过 pg_blocking_pids 证明两个
  真实连接存在锁等待，覆盖停止/恢复与次数额度、美元上限的两种交错顺序，以及两次相同期望
  版本保存的冲突、首次保存、历史 JSON 字符串、ABA、权限和失败回滚。
