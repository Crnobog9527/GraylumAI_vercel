# ENTITLEMENTS PR-1 本地验证

入口：`node packages/db/tests/entitlements/run-local.mjs --local-only`。
仅使用现有 baseline runner 创建的隔离 Docker 数据库；拒绝 CI 模式，不读取 `.env`、
不接受数据库 URL，不连接远程库。测试身份与计划均为合成数据。

覆盖：

- 未知/重复等级迁移拒绝；空库重建和 D3=4；在旧计划上初始化 D4；不改变价格、积分、旧导出权限。
- service_role 写入并读回；匿名、普通用户各用全新 psql 会话读取公开配置允许、修改拒绝；
  service-role 新会话可写，已封闭身份受现有 account-open RLS 拒绝。
- 严格字段类型、NOT NULL、非负安全整数；D3 的 2/8 允许与 1/9/小数/字符串/空值拒绝。
- 重复迁移保留管理员改值，前后完整结构指纹相等。
- 回退演练保留计划数据且旧结构前后相等；恢复后再跑客户端权限测试。
- 已有后台 preview fixture 安装和取消订阅降级 SQL smoke 与新必填列兼容。
- baseline runner 的 account-open audit、通用重复应用与回退检查同时执行。

API 测试见 `services/membershipEntitlements.test.ts` 和 `routers/entitlements.test.ts`；
后者使用真实 tRPC 中间件，数据库连接由本地内存 fixture 替代。SQL 测试补充真实角色 ACL/RLS。
这些证据不是 Fusion/LIB-DOCS 消费者事务准入、实际上传、正在运行执行或远程 staging 验收。

`rollback.sql` 只用于本地演练。实际恢复先退 API；新配置列和 D3 值需要备份并由总控审批处理，
不能自行应用。首次发布应先应用迁移再部署 API，期间暂停后台新增计划。

共享 built 指纹等待 #537 → #538 → #539 合并后，由本任务同步 staging、复核迁移编号、
运行 `node packages/db/tests/run-db-baseline-replay.mjs --local-only --write-built` 后提交。
