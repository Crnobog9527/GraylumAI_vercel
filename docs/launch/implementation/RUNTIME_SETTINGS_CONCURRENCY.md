# RUNTIME-PROD 止损设置并发写入

风险 high：全站运行开关。只改后端，不改 #795 前端、计费规则或环境配置，不合并。

## 接口交接给 #795

- `runtimeRateLimits.setStopNewCalls({ stopped: boolean })`：数据库事务内只改停止字段；
  返回 `{ config, source }` 是该次事务写入结果，不在服务层先读后整份覆盖。
- `runtimeRateLimits.update(config)`：兼容原参数形状，但忽略输入 `stopNewCalls`，
  只更新四个次数额度字段。旧额度页面不能清除新设置的停止开关。
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

迁移编号已在 #795 评论申请，尚未分配。SQL 暂存于
`packages/db/tests/runtime-settings-concurrency/proposed-migration.sql`，**仅供一次性本地库验证**，
不在部署迁移目录、不代表迁移已落账。新增 API 在迁移存在前不能部署使用。
编号分配后将草案移入指定迁移、重跑完整回放并更新 built-fingerprint，重新请求当前 head 审查。
这之前 PR 保持草稿，不能认定 clean。

部署需数据库迁移和后端接口先到位，再让 #795 接线；不要回滚为旧的整份覆盖写入。
迁移不删除配置或改变已有阈值。必要时停用管理写入口并前向修复，保留现有停止状态。
不访问远程数据库、不运行付费模型、不启动浏览器。

## 验证入口

- `pnpm --filter @repo/api exec vitest run src/routers/runtimeRateLimits.test.ts src/services/runtime/stopLossSettings.test.ts`
- `node packages/db/tests/runtime-settings-concurrency/run-local.mjs --local-only`
  创建并销毁本地 PostgreSQL 17，一次性完整建库后应用草案；通过 pg_blocking_pids 证明两个
  真实连接存在锁等待，覆盖停止/恢复与次数额度、美元上限的两种交错顺序，以及两次相同期望
  版本保存的冲突、首次保存、历史 JSON 字符串、ABA、权限和失败回滚。
