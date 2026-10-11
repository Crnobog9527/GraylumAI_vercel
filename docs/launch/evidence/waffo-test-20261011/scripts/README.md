# 独立实测脚本

本目录不带 package.json/lockfile，不属于 pnpm workspace，不被应用导入。
**不要在仓库中安装依赖。** 本次实际执行目录是本机私有 `~/.graylum/waffo-test-20261011`。

复核时先复制到独立目录，再用 npm 精确安装 `@waffo/pancake-ts@0.26.0`；
签名合成测试还需要 `zod@4.3.6`（仅用于加载 #791 现有函数）。Node 24 可直接执行 TS。
`run.mjs` 的 products/sessions/refund/cancel 会产生真实的 **Waffo 测试模式对象**，不是离线测试。
本次已执行完成，后续默认只做 probe 查询，不重复创建；若操作超时/结果未知，先查远端实际状态，
不要盲目重跑，更不能在 24 小时幂等缓存过期后用相同键重建。state.json 留在原私有目录，不提交。

- `run.mjs products`：六个固定规格测试产品；名称/金额写死，逐笔保存状态，显式幂等键。
- `run.mjs sessions`：三个付款会话和一个 60 秒未付会话。
- `run.mjs refund`：查回本次 49 美元成功付款及店铺/test 归属后发起一次全额测试退款。
  SDK 缺公开商户退款方法，临时调用 SDK 的内部 http.post；不要复制到产品运行时代码。
- `run.mjs cancel`：查回本次 69 美元 active 订阅后停止续费。
- `run.mjs replay-expired`：完全同体、同键重放本次过期会话创建，比较 ID 和到期时间，不改变其期限。
- `probe.mjs <query.graphql> <output.json>`：仅允许 SDK GraphQL 只读请求；自动注入指定文件中的店铺号，
  结果先脱敏再输出和保存。GraphQL errors 要人工检查，HTTP 成功不代表查询成功。
- `signing-test.mjs`：**完全离线**，临时生成密钥只留内存，不读取 Waffo 密钥或发网络请求。
  它需要同目录的 `pr791-client.ts`、`pr791-webhook.ts`；从 GitHub 读取下述精确版本原文件，
  不使用当前分支或更新后的代码替代。本 PR 不重复提交这两份实现。

比较文件版本：`d931f0302647dde634facec7bea77b1d6f91176d`：
`packages/api/src/services/payments/waffoTestOperationsClient.ts` 和 `waffoWebhook.ts`。
执行结果 `signing-test.json` 只包含布尔结论；密钥与签名不写入文件或日志。

每次真正写接口前验证指定店铺 isLive=false、prodEnabled=false、回调数为 0；
固定 api.waffo.ai 和端点白名单，不含 publish/store-update/webhook 配置入口。
凭据唯一来源 `~/.graylum/secrets/waffo-test.env`，只接受 WAFFO_ENV=test；不从进程环境回退读取。
请求头不记录。保存的是脱敏响应，不是原始敏感响应；checkoutUrl 在公开脚本日志中也遮盖。
仓库样例只遮盖字段，没有改写金额/状态；schema 文件是 introspection 选取的相关字段摘录。
