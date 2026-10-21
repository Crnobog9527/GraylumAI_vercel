# 自由对话定位检查的事务回归

运行：`node packages/db/tests/runtime-positioning-gate/run-local.mjs --local-only`。

测试建立并清理独立本地 PostgreSQL 17；只使用合成资料，不连接远程、不调用模型。
使用已有定位及 Runtime/BILL2 夹具，把已发布定位的证据连到真实 Runtime 执行，
实际走来源可读性与计费草稿 `FOR SHARE` 锁。根据函数 `provolatile` 模拟 PostgREST
在 POST RPC 上选择的事务模式，并切换到 `service_role` 执行。

必须证明：旧 STABLE 在只读事务报 25006；迁移后及重复应用均成功；函数体和 ACL
保持一致；他人、撤回 Runtime 来源、撤回定位均不能算作已确认定位。
匿名与已登录客户端仍无此 RPC 的直接执行权。

恢复：迁移不改表或数据，无数据恢复要求。原代码兼容新的 VOLATILE 声明。
如必须撤回该声明，可执行 `ALTER FUNCTION public.runtime_positioning_gate(uuid) STABLE;`，
但会恢复有报告来源的自由对话准入故障；不应将回退代码视为已经修复该故障。

迁移编号 0332 已由总控于 2026-10-22 分配；原暂用 0333 作废，PAY-FAILOVER 改用 0333。
上库与合并由总控执行；本任务未在 staging 应用。
