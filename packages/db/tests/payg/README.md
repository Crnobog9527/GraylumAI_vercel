# PAYG PR-A 本机 SQL 回归

运行完整专项：

```sh
node packages/db/tests/payg/run-local.mjs --local-only
```

入口只接受本机 Docker Unix socket，使用仓库锁定且已存在的 PostgreSQL 镜像，
`--pull=never`，端口只绑定 `127.0.0.1`。不读取数据库 URL、不调用模型或外部支付。
每次创建自己的随机名容器，并在成功或失败后删除该容器和卷。

完整模式复用 `buildFromFiles`，从空库按真实文件顺序建库，并在每个迁移的历史位置
连续执行两次、逐对象比对结构。`--local-only --development` 仅用于同范围修复迭代，
跳过历史逐迁移指纹重放；它不能替代完整模式或仓库要求的 baseline replay。

测试复用既有 B2a/inflight 的 v1 fixture 和全部原用例，再覆盖：

- 六个旧公开收尾入口对 v1/run 和 v2/call 预扣全部拒绝；普通旧钱包六入口保持可用。
- v2 零 run 预留、call hold、门槛、累计一次进位、封顶、重复回执和收尾幂等。
- 名义计价、缓存费用偏差、长上下文、分时最高价、实际费用兜底和三次查账上限。
- 确认故障对已结算前缀的补偿及未知后续退款；迟到证据不重扣。
- 注销后的未派发撤权、未知费用 hold、已结算前缀、零 call 和错误预扣绑定。
- 真实双数据库连接的重复领取、跨 run 争余额、重复回执/收尾及取消竞争。
- 计费投影允许/拒绝权限、平台承担和实际/名义差额恒等式。
- grant 过期、逆转、终止、隔离；混合模型倍数、充值不补收 E、大小和缺字段边界。

所有身份、余额、门槛、模型与价格均为每次本地建库的合成 fixture，v2 不接入默认 Runtime。
结构指纹提交仍使用工程规范要求的 `run-db-baseline-replay.mjs --local-only --write-built`。
