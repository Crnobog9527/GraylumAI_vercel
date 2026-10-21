# PAY-FAILOVER：Waffo 一次性测试商品与 staging 验收前提

2026-10-22：经Owner授权，以下12个一次性商品已在原Waffo测试店铺创建并逐个回读核对。原六个订阅商品税类均为saas；官方查询不提供taxIncluded，原创建请求也省略，Owner本聊天明确确认本次照原请求省略该字段。结账priceSnapshot仍按既定规则taxIncluded=true锁定含税实付金额，两者不混为同一事实。所有币种USD，不启用试用、不使用订阅商品、不产生自动续费。映射尚未写入staging数据库，交总控审阅[独立数据脚本](./PAY_FAILOVER_TEST_MAPPING.sql)及[执行说明](./PAY_FAILOVER_TEST_MAPPING.md)，在0332之后应用。本地11项验证已通过。会员商品名称可保留“月付/年付”，但供应商商品类型必须是一次性，本站按期限履约。

|本站商品|USD|Waffo 一次性商品编号|billing_cycle|offer_kind|price_usage|package_tier|
|---|---:|---|---|---|---|---|
|Pro 月付|29.00|`PROD_6FNYvZF8hqtUQ2eI2dYWn4`|monthly|standard|one_time|legacy|
|Pro 年付|279.00|`PROD_5H6xw582MO5LMlXDMdBaYV`|yearly|standard|one_time|legacy|
|Gold 月付|69.00|`PROD_28RcU7crNX1yWcNG6cUung`|monthly|standard|one_time|legacy|
|Gold 年付|621.00|`PROD_7jIVpWKLO8UPJCP1AYhvBf`|yearly|standard|one_time|legacy|
|Gold 首购首月|49.00|`PROD_4eXN4ZE5tGcYrPijNWi1NN`|monthly|gold_first30|one_time|legacy|
|创始会员首次/续买|496.00|`PROD_2j3AkXSpKPucJveBZmnqB1`|yearly|founder|one_time|legacy|
|990 积分包 Pro 价|9.40|`PROD_3XO2qfUvb0XOroaT4aBAKV`|one_time|standard|package|pro|
|990 积分包 Gold 价|8.90|`PROD_5YIBXJgdZU0f6k30auvzXc`|one_time|standard|package|gold|
|2990 积分包 Pro 价|28.40|`PROD_1752aMIkaA3xBtS9k6nx3Y`|one_time|standard|package|pro|
|2990 积分包 Gold 价|26.90|`PROD_4v5lv0dtor8i8yx5rPvfLq`|one_time|standard|package|gold|
|10990 积分包 Pro 价|94.90|`PROD_1qYZ4XFhJdY9Dy8sBap3fJ`|one_time|standard|package|pro|
|10990 积分包 Gold 价|89.90|`PROD_5LB9TxN6Khruy6YyuPEFu6`|one_time|standard|package|gold|

总计 12 个一次性商品；创始续买复用同一 founder 商品。映射使用现有 `payment_provider_refs`，channel=waffo，mode=test，准确的测试 merchant_namespace / membership_plan_id / credit_package_id / 外部 PROD 商品 ID；每个维度只能有一个 is_current=true 的价格映射。不能把原订阅 PROD ID 填进一次性映射，也不能复制 test ID 到 live。正式商品与映射须 Owner 后续单独准备。

最低 staging 验收先准备 Pro 月付和 990 积分包 Pro 价；全部商品可用声明仍需完整映射与逐项检查。测试模式 Waffo 不显示支付宝、微信，不能因此改开关或伪造实测 PASS。支付宝只用模拟付款事实覆盖；上线后最小金额真实支付宝付款及退款必须再获 Owner 单独批准。

验证次序：总控确认0330/0331/0332依赖与迁移、包含本改动的 staging 已通过正常合并部署 → 准备一次性商品和映射 → 占用经批准的测试账号 → 后台版本锁切 Waffo → 测试卡会员/积分包现金与权益分别核对 → 原渠道退款完成/积分权益收口 → 切回 Stripe → Stripe 新购正常且 Waffo 原单和退款继续回收。未知付款先核对，不换渠道重扣。

创建证据见[公开脱敏清单](../evidence/pay-failover-products-20261022/products.json)和[只读原商品核对](../evidence/pay-failover-products-20261022/preflight.json)。初查一次性商品为0；每次创建前查同名、创建后查回，最终12个均active、无正式版本，未遇结果不明或重试。

本任务不部署任何分支。代码尚未进入 staging 时，其 staging 验收状态必须为 NOT_RUN；商品未准备时为 BLOCKED，不能拿原订阅商品或本地 fixture 浏览器替代。
