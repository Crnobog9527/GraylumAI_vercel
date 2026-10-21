# PAY-FAILOVER 测试商品创建证据（2026-10-22）

Owner授权见[#1234](https://github.com/Crnobog9527/GraylumAI_vercel/issues/1234#issuecomment-6320537843)，以及本聊天对taxIncluded原样省略的明确确认。

- `preflight.json`：使用运行时读取的staging绑定核对原商户/店铺与现有测试配置相符，供应商确认test、prodEnabled=false。原六订阅均active、无正式版本、税类saas；查询schema不提供taxIncluded，原创建请求亦省略。一次性商品初查为空。
- `products.json`：12个创建后的商品编号及映射维度。每次创建前检查同名、创建后查回，最终再次逐个核对金额、币种、税类、状态和店铺；12个全新且无正式版本，无未知结果或重试。时间为API操作的UTC时间，对应Owner时区2026-10-22。
- 官方创建端点：[POST /v1/actions/onetime-product/create-product](https://docs.waffo.ai/api-reference/endpoints/onetime-products/create-product)。只用了该写端点和GraphQL只读接口，未发布、创建结账页或付款。
- 私钥由现有测试配置仅在进程内加载；Vercel将staging私钥标为sensitive，不可回读，使用前先将原配置的商户/店铺与当前staging绑定在内存严格比较，再由已签名的供应商test查询确认。没有输出或新增/修改任何密钥，证据不含签名、凭据、店铺认证编号或个人数据。
- `mapping-validation.json`：独立数据SQL本地11项PASS，含12关联、幂等、冲突整批回滚、原订阅/Stripe/live/settings不变。最终计数以机器结果为准；数据脚本验证不代替0333完整回放/指纹；现有机器结果是旧0332历史证据，待#1238合并同步后刷新。
- staging映射尚未写入；采用独立数据SQL供总控核对并在0333之后应用，避免把测试店铺数据混进结构迁移或正式环境。原六订阅映射保留，新映射每维度唯一current；遇不同current整批拒绝，不静默覆盖。

商品创建通过不等于支付验收。staging银行卡全链路仍NOT_RUN，#1237已合并并同步；等待#1238合并同步后完成0333最终检查、总控上库合并和正常staging部署后执行。
