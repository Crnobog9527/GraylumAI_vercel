# PAY-FAILOVER：Waffo 一次性测试商品与 staging 验收前提

本清单交总控准备；尚未创建、修改商品或映射。需要 Owner 自行操作 Waffo 后台，或明确授权在测试店铺创建以下一次性商品。所有币种 USD，商品税类 saas，结账覆盖金额必须 taxIncluded=true，不启用试用，不使用订阅商品，不产生自动续费。会员商品名称可保留“月付/年付”，但供应商商品类型必须是一次性，本站按期限履约。

|本站商品|美元金额|映射 billing_cycle|offer_kind|price_usage|package_tier|
|---|---:|---|---|---|---|
|Pro 月付|29.00|monthly|standard|one_time|legacy|
|Pro 年付|279.00|yearly|standard|one_time|legacy|
|Gold 月付|69.00|monthly|standard|one_time|legacy|
|Gold 年付|621.00|yearly|standard|one_time|legacy|
|Gold 首购首月|49.00|monthly|gold_first30|one_time|legacy|
|创始会员首次/续买|496.00|yearly|founder|one_time|legacy|
|990 积分包 Pro 会员价|9.40|one_time|standard|package|pro|
|990 积分包 Gold 会员价|8.90|one_time|standard|package|gold|
|2990 积分包 Pro 会员价|28.40|one_time|standard|package|pro|
|2990 积分包 Gold 会员价|26.90|one_time|standard|package|gold|
|10990 积分包 Pro 会员价（9990+1000 赠送）|94.90|one_time|standard|package|pro|
|10990 积分包 Gold 会员价（9990+1000 赠送）|89.90|one_time|standard|package|gold|

总计 12 个一次性商品；创始续买复用同一 founder 商品。映射使用现有 `payment_provider_refs`，channel=waffo，mode=test，准确的测试 merchant_namespace / membership_plan_id / credit_package_id / 外部 PROD 商品 ID；每个维度只能有一个 is_current=true 的价格映射。不能把原订阅 PROD ID 填进一次性映射，也不能复制 test ID 到 live。正式商品与映射须 Owner 后续单独准备。

最低 staging 验收先准备 Pro 月付和 990 积分包 Pro 价；全部商品可用声明仍需完整映射与逐项检查。测试模式 Waffo 不显示支付宝、微信，不能因此改开关或伪造实测 PASS。支付宝只用模拟付款事实覆盖；上线后最小金额真实支付宝付款及退款必须再获 Owner 单独批准。

验证次序：总控确认0330/0331依赖与迁移、包含本改动的 staging 已通过正常合并部署 → 准备一次性商品和映射 → 占用经批准的测试账号 → 后台版本锁切 Waffo → 测试卡会员/积分包现金与权益分别核对 → 原渠道退款完成/积分权益收口 → 切回 Stripe → Stripe 新购正常且 Waffo 原单和退款继续回收。未知付款先核对，不换渠道重扣。

本任务不部署任何分支。代码尚未进入 staging 时，其 staging 验收状态必须为 NOT_RUN；商品未准备时为 BLOCKED，不能拿原订阅商品或本地 fixture 浏览器替代。
