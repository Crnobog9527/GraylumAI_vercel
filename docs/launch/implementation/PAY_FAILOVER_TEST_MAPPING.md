<!-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. -->
# PAY-FAILOVER 测试商品映射执行说明

`PAY_FAILOVER_TEST_MAPPING.sql` 是交总控审阅的 staging 数据脚本，不是自动迁移。本任务只准备与本地验证，**没有写入远程数据库、切换渠道或完成付款验收**。

## 应用前置

1. 先完成 #1237（0331）与 #1238（0332）前置同步，再按总控最终分配应用 `0333_pay_failover.sql`。本脚本检查两个 PAY-FAILOVER RPC 存在；执行者仍须核对实际迁移记录及对应版本。
2. 执行连接必须为 staging Supabase 项目 `gvcpmcunmfrbxuwimxfa`。普通 PostgreSQL 连接内无法可靠推断项目编号，须在执行端核对，不能把 SQL 内的 namespace 检查当作项目识别。
3. 商品依据为 [12 个测试商品回读 manifest](../evidence/pay-failover-products-20261022/products.json)。Owner 已授权建立这 12 个测试一次性 USD 商品，主窗口已完成创建及逐个回读核对；本脚本不读取供应商密钥。

## 写入范围与拒绝条件

只新增 12 条 `waffo / test / price / is_current=true` 映射：会员六条 `one_time / legacy`，积分包六条 `package / pro|gold`。固定关联本站公开 Pro、Gold 和三档积分包 ID。创始首购及后续 $496 续买共用同一个 founder 商品，既有资格规则保持不变。

2026-10-22 只读核对发现：原六条 Waffo 测试订阅映射均 current，namespace 唯一为 `waffo_test`；尚无本次一次性与会员价积分包映射。脚本从这原六条真实映射推导 namespace，并核对它仍为已验证的值，不读取供应商密钥。

整个脚本只有一个事务，持有现有路由锁并锁定相关目录行与映射表，先查完整批次冲突再插入。原六条订阅、Stripe、live、路由设置、订单及用户记录均不更新或删除。相同 current 映射重跑为无改动；不同 current、相同商品 ID 绑定其他目标/namespace、已有 inactive 映射、与 live/旧订阅商品复用，或目录价格/权益发生变化，都会使整批拒绝并回滚。

积分包价格按现有 admission 的实际公式计算：Pro 95%、Gold 90%，向下取整至 $0.10。实际 admission 不读取 `membership_plans.package_discount`；脚本复用其公式，而非假定该字段控制付款金额。供应商产品金额由公开 manifest 与支付服务建单时的商品回读验证；映射表本身没有金额列。

## 执行与验收

总控核对目标及前置后，用现有受控数据库执行方式运行整个 SQL；使用psql时必须设置 `-v ON_ERROR_STOP=1`，遇到任何错误停止；不得只执行中间的 INSERT。成功结果应恰好 12 行，每行包含 SKU、预期 USD 最小单位金额、映射 ID 和供应商商品 ID，可与 manifest 逐项核对。

该脚本不会开启应急渠道。应用映射后仍须独立完成 Waffo 测试银行卡一次性购买会员/积分包、履约、退款、切回 Stripe 和旧 Waffo 单处理的 staging 浏览器验收。测试模式不显示支付宝；上线后支付宝最小金额真实付款并退款须 Owner 另行批准。

失败时事务整体回滚。成功后若需撤回映射，不删除已可能被订单引用的付款事实；交总控核对是否被引用，再做单独的受控前向处理。

## 本地验证

Owner再次改号为0333；#1238（真实0332）已合并并同步，以下已按最终0333文件顺序重验，不再使用旧0332结果代替。

独立测试命令：`node packages/db/tests/pay-failover-mapping/run-local.mjs --local-only`。只使用临时本地 PostgreSQL，不加载远程密钥，不调用供应商 API，不刷新迁移指纹。

2026-10-22本地真实数据库验证11项PASS，证据见[验证结果](../evidence/pay-failover-products-20261022/mapping-validation.json)。验证包括 12 条完整维度关联、同 ID 幂等、冲突整批回滚、inactive 不自动启用、namespace/live/旧订阅冲突拒绝、基础目录价格变化拒绝，以及原六条订阅、Stripe/live 哨兵记录与路由设置不变。此测试按当前真实文件构建 schema；不代替前置同步后的最终完整 replay/指纹验收。

2026-10-22 本地结果：**PASS，11 项**；已同步 #1237/#1238 后的最终 schema 构建 336/336，未重复迁移、未刷新指纹。执行日志保留于 `/tmp/pay-failover-0333-final-mapping.log`。脚本语法检查与仓库代码长度检查通过。远程应用及 staging 浏览器付款验收均 **NOT_RUN**。
