# DATA-ERASURE B2b 公共账表投影

只验证 `0188_erasure_ledger_content.sql`；依赖 0187 和之前完整迁移。

```bash
node packages/db/tests/erasure-ledger/run-local.mjs --local-only
```

仅使用本机 Docker Unix socket、已有 PostgreSQL 镜像和一次性合成数据库。
不读取连接串或密钥、不访问远端。`--local-only --development` 仅用于修改中的快速验证，
省略历史迁移指纹重复；不能替代最终完整验证。

清理范围是四张公共财务表的正文及固定元数据投影；保持金额、分类、关联、时间不变。
按单表、稳定 UUID 游标、每批最多 100 条处理，锁忙行跳过，`remaining` 包含跳过和异常行。
游标用尽后应从头重扫；`manualReview` 或 `remaining` 非零不能宣称该表清理完成。
这里没有协调器、自动调用、付款执行或远端启用。

覆盖：允许和拒绝权限、关闭事实、重复执行、四表金融字段、固定嵌套用量与计价事实、
正文 canary 清除、原始 null/数字/数字字符串、跨主体隔离、晚到服务端写入、
真实 BILL2 退款/PAYG 结算与补偿、异常证据人工复核、游标和真实独立连接行锁竞争。
本机平台缺失的 service table ACL 仅由测试临时补齐并恢复，不写入迁移。

迁移新建函数和触发器，不替换金额算法。重复执行必须保持完整结构指纹。
`rollback.sql` 仅允许尚无任何投影事实的结构回滚；发生清理后拒绝回滚，须向前修复，
不能恢复已擦除正文。账户关闭与永久删除协调、支付快照、异常私有回执仍属后续切片。
