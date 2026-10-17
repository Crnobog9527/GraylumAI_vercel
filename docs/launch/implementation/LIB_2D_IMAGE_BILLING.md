# LIB-2d：BILL2 单图调用的计费前提（迁移 0286）

风险 high（计费）。对应 [LIB_DOCS_PLAN.md](../LIB_DOCS_PLAN.md) 第 4.4 节「AI 识别的计费」第 2–4 点。
只补 BILL2 核心：没有调用方、没有用户入口、没有后台设置；照用 BILL2 / 边用边扣，不新增收费口径。

## 做了什么

1. **能发图片，但只能是一张**：PAYG 调用里最多一个 `image_url` 内容段，必须是内嵌的
   `data:image/jpeg;base64,…`，不收外部地址、PNG、`detail` 等额外字段；只能放在 user 消息里；
   只有 `IMAGE_PURPOSES`（目前只有 `library_ocr`）能用；路线的稳定报价里必须声明 `imageInput`
   （`maxDataUrlBytes ≤ 819,223`、`maxEdge ≤ 2048`）。服务端只读 JPEG 文件头里的宽高，不解码像素。
   形状要求：短边 ≥ 64 像素、长边 ≤ 4 × 短边。
2. **冻结上限含图片费**：
   - 输入上限 T = 文字字节 + 图片 token 上限 + 模板 + 余量。文字字节 = 整个请求字节 − data URL 字节，仍不超过 196,608；
     base64 本身不按 token 计。
   - 图片 token 上限 = `2 × ⌈宽/14⌉ × ⌈高/14⌉ + 2048`。在允许的形状内，它比常见视觉模型公开的算法都大
     （每 750 像素一个 token、512/768 切块、28/32 像素切片、336 切块加缩略图；最紧的是 336 切块，约到 92%），
     单元测试逐格核对。1600×1131 的一页是 20,678 个 token。
   - 上限金额 U 在原公式上再加 `图片单价 × 图片 token 上限`：OpenRouter 的 `image` 价不论按张还是按 token 计，这都是上限。
   - 发给 OpenRouter 的 `provider.max_price` 在路线声明了图片单价时多带 `image`。
   - 实际结算不变：按官方用量和名义价格，不超过冻结上限；实际 token 超过 T 时照旧标 `budget_conflict` 并停这条线路。
3. **新的计费范围 `library_document`**：`{kind:'library_document', documentId}`，只认本人的、
   `kind=document`、格式 PDF 或 Word、状态 processing / ready、没有删除的文档；文档进入删除后，同一运行单的新调用被拒。
4. **注销保留的计费字段**：图片的字节数、宽高、token 上限和图片单价随调用记录保留，图片内容从不进入计费记录。

TS 和 SQL 两边各算一遍，规则一致：`packages/api/src/services/bill2/imageInput.ts`（常量和 JPEG 头解析）、
`paygPolicy.ts`、`openRouterPolicy.ts`、`openRouterAdapter.ts`（发送前再量一遍，和冻结的报价逐项相等）、
`runtime/paygRuntime.ts`（报价）；SQL `bill2_payg_image`、`bill2_payg_validate_quote`（0286 补丁）、`bill2_scope_allowed`。

## 给下游的接口约定（PUBLISH-MONITOR PR-3c 截图导入）

PR-3c 复用这套单图计费，按下面做，不另建计费：

1. **加用途**：在 `imageInput.ts` 的 `IMAGE_PURPOSES` 和 SQL `bill2_payg_image` 的用途列表里同时加自己的用途名
   （例如 `publish_screenshot`），需要一个新迁移按 0286 的方式替换函数体（用 `-- 0286 image` 之后的标记判断是否已打过补丁）。
2. **加计费范围**：截图属于发布记录而不是资料库文档，按 0286 的写法给 `bill2_scope_allowed` 再包一层自己的范围，
   不要借用 `library_document`。
3. **报价**：路线的稳定报价带 `imageInput` 和 `providerLimits.imageUsd`（快照里没有 `image` 价时写 `"0"`），
   用 `runtimePaygCall(request, purpose, policy, rules, epoch)` 生成调用报价，它会自动识别那一张图并算 T 和 U；
   请求必须是一个 user 消息里「文字段 + 一个 image_url 段」。
4. **截图形状**：长截图超过 4:1 要先在浏览器里切成几张、分几次调用；长边先缩到 ≤ 路线的 `maxEdge`，JPEG ≤ 600 KB 左右
   （data URL ≤ 819,223 字节）。
5. **不存图**：图片只在这一次请求里经过服务端，不写库、不进日志；`requestHash` 绑定整段请求。

## 还没做（LIB-2d 后续 PR）

- 识别调用方：单页识别接口、`library_recognition_units` 状态推进、余额不足暂停、系统原因退回、清理 cron 里的识别对账。
  这类运行单不在 Runtime 和 Fusion 的恢复批次里，调用方 PR 要带自己的恢复批次。
- 后台「资料库文字识别」模型设置，以及这条路线的 PAYG 主机报价（`paygHostPolicy` 的用途、请求格式和实测证据）。
  快照里图片单价不为 0 的路线（目前只有 Gemini）在付费实测核实计价方式之前不放进可选范围。
- staging 付费实测（预算另批）：用真实页面图片核对实际图片 token 和 T 的余量、`max_price.image` 能否被 OpenRouter 接受。

## 验证

- 单元测试：`imageInput.test.ts`（文件头解析、各家算法都在上限内、拒绝外部地址/PNG/两张图/超尺寸/伪装 SVG）、
  `paygPolicy.test.ts`、`paygRuntime.test.ts`、`openRouterAdapter.test.ts`。
- SQL：`packages/db/tests/payg/image.mjs`（`run-local.mjs` 一并运行）：接受、各种拒绝且不冻结、纯文字调用不变、
  范围允许/拒绝、删除后新调用被拒、注销投影。去掉 0286 时同一组用例失败（先红后绿）。
- 0286 在历史位置连续执行两次结构不变；`built-fingerprint.json` 已更新。

## 回退

0286 只给已有函数加检查分支、加一个新函数，不写数据。没有调用方，回退代码不影响现有对话计费。
需要撤回时，用 `pg_get_functiondef` 取 0267 之后的函数原文重建 `bill2_payg_validate_quote`、
把 `bill2_scope_allowed_before_library` 改回原名，并恢复两个注销投影函数。
