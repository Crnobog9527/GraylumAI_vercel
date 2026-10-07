# DATA-ERASURE B2b 支付元数据

```bash
node packages/db/tests/erasure-payment/run-local.mjs --local-only
```

仅用本机Docker Unix socket和固定PostgreSQL镜像构建一次性合成库，不读取远端连接串、
密钥或实际付款信息。开发中的 `--local-only --development` 不代替完整历史回放验证。

0189只投影payment_orders、user_subscriptions和subscription_credit_grants的metadata。
原退款批准（包括原hash和feeEvidence）、冻结支付请求、固定合同/购买/发放快照、
金额事实以及全部非metadata金融字段原样保留；这些未处理字段是后续依赖。
它不是整行或账户已删除的标记。

异常金融子对象保持原值，其他无关正文仍清掉；返回manualReview与remaining明确反映残留。
metadata_scrubbed_at只代表发生过至少一次投影，包括部分清除，不代表完整成功。
剩余计数动态检查异常子对象，因此不能仅凭标记判定完成。标记不可回退，
有任何部分清理事实后也拒绝空结构回滚，只能向前修复。

单表每批最多100条，稳定UUID游标，跳过被锁行。游标用尽但remaining不为零时需从头重扫；
不能把锁忙或人工复核当成功。没有新表、队列、调度或真实退款入口。
既有paymentConflicts追加保护保持不变；正常固定对象完整保留，异常对象进入复核。

本机用例覆盖实际三表全行金融字段与批准hash保真、已知升级报价/会员覆盖形状、
异常子对象部分清除、权限、跨主体、late写入、原身份退款结果恢复与重放、
未知金额拒绝以及独立连接锁竞争。必要平台ACL仅在合成fixture临时补齐。
