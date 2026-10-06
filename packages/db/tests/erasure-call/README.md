# DATA-ERASURE B2b：原调用正文清除（0184）

本片在 B2 财务擦除阶段，先于 PR-C 注销编排。仅清除已封闭主体、已关闭调用集合的
原 BILL2 call payload 正文；财务核对、原请求幂等标识、冻结报价与原结算路径保持不变。
复用 0183 的递归字段验证和原 run → call → receipt → profile 锁序，不新增调度或账本。

风险 high：不可逆正文清除、服务权限和财务保留。新增迁移只在本机一次性数据库验证。
验收覆盖 v1/v2、权限拒绝、递归白名单、重复执行、迟到收据/结算、防回填和回退。
未决调用保持 unknown 及原预留；不重新派发、不凭超时退款、不删除供应商核对编号。

异常收据最少证据之外正文、其他公共财务字段/支付快照、会话解绑，PR-C 的编排、
Storage、资料和 Auth 删除仍未完成。本片不代表 B2b 或完整账号删除完成。

## 验证入口与恢复

```sh
node packages/db/tests/erasure-call/run-local.mjs --local-only
node packages/db/tests/run-db-baseline-replay.mjs --local-only --write-built
```

新函数 `account_erasure_scrub_calls(profile,run)` 仅授予 service_role；无自动调用方。
每次处理原 run 的调用集合（创建契约最多 32 个），开放集合返回 call_set_open，不能视为完成。
其锁序为 run → 原 PAYG 模型锁 → calls → receipts → profile，沿用已有财务路径。
只增加调用行的单向 content_erased_at；清除后 payload 不可回填，原核对/结算状态可继续推进。
requestHash 是方案 §3.2 的原请求核对/幂等证据，保持原值；不新增完整 payload 摘要，sourceHash 清除。
冻结报价及 nominalPricing 逐层白名单保留精确表示，额外嵌套正文丢弃，非法财务类型整笔拒绝。

载荷改变时，原计量异常复核失效机制会清除 metering_review_audit_id，后续需按既有流程重新复核。
审计历史、异常事实、金额及账本不改，不保留过期审批绕过模型异常准入限制。
此结果不是新的财务事实，也不代表异常收据正文已经清除。

rollback.sql 只允许在尚无清除事实时恢复原结构。已清除后只能前向修复，不能恢复正文或反转结算。
专项同时验证 v1/v2、迟到收据与 close 的双连接竞争；已接入既有 BILL2 集成。
远端数据库、staging 迁移应用、真实账号删除、配置修改及合并均不在本窗口执行范围。
