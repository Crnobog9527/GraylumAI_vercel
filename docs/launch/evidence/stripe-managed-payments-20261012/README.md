# Stripe Managed Payments 测试模式验证（2026-10-12）

任务：PAY-WAFFO（收款渠道调整的前置验证）。只在 Owner 的 Stripe 沙盒（测试模式）里做，没有碰正式模式。

- 脚本：[`mp-probe.mjs`](mp-probe.mjs)。密钥只从 `~/.graylum/secrets/stripe-test.env` 读取，必须是 `sk_test_` 开头。每条命令在第一次写入前都会核对账户编号：运行前必须用 `MP_EXPECT_ACCOUNT` 指定沙盒账户编号，没指定就直接停下。脚本不会打印密钥。
- 证据：`01-setup.json`（建会话和参数兼容性）、`02a`（付款后）、`02b`（第一次续费后）、`02c`（续费失败和第二期后）的订阅、发票、手续费、事件，`03-ops-upgrade-cancel-refund.json`（升级、取消、退款）、`04-trial-wording-probes.json`（试用措辞能否修改）。这些文件已经脱敏：账户号、邮箱、姓名、地址、链接、卡尾号都去掉了。
- 浏览器付款由 Codex 完成，过程和截图说明见 [PR #847 的验收记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/847#issuecomment-6120815623)。

## 给 Owner 的结论（大白话）

**总体判断：MP 可以作为银行卡订阅的主力渠道，但中国大陆买家用不了。** 这次要验证的订阅、续费、失败、升级、取消、退款，在测试模式下都跑通了。和微信/支付宝单笔共用一个 Stripe 账户也没问题。

| # | 验证项 | 结论 |
|---|---|---|
| 1 | MP 订阅和微信/支付宝单笔共用一个账户 | **PASS** |
| 2 | Gold 首 30 天 49 美元、之后每月 69 | **PASS（有条件）**：能精确做到 30 天，但结账页和邮件会写"试用 / 30 天免费" |
| 3 | 测试时钟续费 | **PASS**：续费成功、续费失败、失败后自动取消都看到了 |
| 4 | 创始 496/年、升级、到期不续、退款 | **PASS**；另有 3 处行为要注意（见下文） |
| 5 | 审核/资格 | **只能部分验证**：测试模式里 MP 已经是"即用型"，正式环境要等 Stripe 审核 |
| 6 | 美国走普通 Stripe、其他走 MP | **可行，代码改动很小**；但把非美国买家错分到普通 Stripe 的税务后果重，建议先全部走 MP |

### 需要 Owner 决定的事

1. **首 30 天的说法（第 2 项）**。能精确做到"首 30 天 49 美元"的做法是：30 天试用，同时一次性收 49 美元。代价是 Stripe 结账页写的是「试用」「30 天免费」，按钮是「支付并开始试用」，Stripe 还会自动发"试用开始 / 试用即将结束"的邮件，我们改不了这些措辞。另一种做法是一次性优惠券，结账页写「1 个月优惠 US$20」，没有"试用"字样，但第一期是一个自然月（这次实测 31 天），不是 30 天。
   - 推荐 A：**改回"首月 49 美元"，用优惠券**。措辞干净，用户不会误以为是免费试用，也不容易因为"说是免费却扣了 49"而引发拒付。
   - B：保留"首 30 天"，接受结账页和邮件里的"试用"字样。
   - 可以直接复制的话：`同意银行卡 Gold 首期改为"首月 49 美元"（自然月），用一次性优惠券实现。`
2. **中国大陆银行卡用户怎么办**。实测在 MP 结账页把国家选成中国后，提交时报 "China is not currently supported."，付不了款。这和官方资格页一致：中国在 MP 的受限买家国家名单里。
   - 推荐 A：**大陆用户只用微信/支付宝单笔**（现在已经有）。不自动续费，到期再买。
   - B：大陆用户的银行卡订阅走普通 Stripe，由 Graylum 当卖家。中国对境外数字服务怎么征税需要税务顾问确认，风险不清楚。
   - C：大陆用户的银行卡订阅继续保留 Waffo（Waffo 代码已经停用但保留着）。
   - 可以直接复制的话：`同意中国大陆用户不走银行卡订阅，只用微信/支付宝单笔。`
3. **标价含不含税**。Codex 从台湾网络打开结账页时，看到的是新台币价格再加 5% 营业税（Stripe 会按买家所在地换算成当地货币，并在价格之外另加当地税）。现在的设置是"税另外加"：欧盟用户会在 69 美元之外再付约 20% 增值税。如果改成"含税"，用户付的总价不变，税从 Graylum 的收入里扣。这是定价决定，需要 Owner 定。
   - 推荐：**税另外加**（Stripe 默认做法，Graylum 每笔收入一样）。可以直接复制的话：`同意 MP 价格不含税，税在结账时另外加。`
4. **全部走 MP，还是"美国走普通 Stripe + 其他走 MP"**（第 6 项）。**推荐先全部走 MP（中国大陆按第 2 条处理）**，理由：
   - 把非美国买家错分到普通 Stripe 时，Graylum 就成了卖家。欧盟、英国对境外卖数字服务的商家没有起征门槛，第一笔就要登记和交增值税，这个风险远大于省下的手续费。把美国买家错分到 MP 只是多付 3.5%，没有税务风险。
   - 能省的钱有限：每个美国用户每月大约省 2.4 美元（69 × 3.5%）。
   - 两种方式只差创建结账时的一个开关，以后美国收入多了再拆分，改动很小，不用现在就做。

### 风险和没验证到的地方

- **MP 的 3.5% 附加费在测试模式里看不到。** 测试订单的手续费只有普通 Stripe 那部分（例如 69 美元一笔扣 2.30），没有单独一笔 MP 费用。正式环境里这笔费用怎么扣、在哪里显示，要上线后看第一笔真实交易才能确认。
- **正式审核结果在测试模式里验证不了**（见第 5 项）。
- **Stripe 可以绕过我们直接退款。** MP 下 Link 客服可以在 60 天内给用户退款；如果 Stripe 找我们、48 小时内没回复，它可以不经我们同意直接退。用户也能在 Link 网站自己取消订阅。我们的系统必须照样处理这些从外部发生的退款和取消（扣回积分、结束会员）。Owner 在后台已经把"退款请求"设成先发邮件给 Owner 批准，但这个 48 小时规则仍然有效。
- **用户的信用卡账单上显示 `LINK.COM* GRAYSCALE LU`。** 用户可能认不出这是 Graylum，容易发起拒付。建议在 Stripe 后台把账单描述改成能认出 Graylum 的写法。
- **续费失败后的宽限期**：沙盒当前的设置是扣款失败后重试 2 次，大约 25 天内订阅就被自动取消了。创始会员有 7 天宽限期、我们有 24 小时宽限逻辑，迁移时要确认 Stripe 的重试设置不会比我们的宽限期更早取消订阅。
- **用户要求删除数据时**：Stripe 会删掉他在 MP 下的数据并取消订阅，我们要能接住这种"订阅突然被取消"的情况。
- **没验证的**：订阅期中途升级（这次是在订阅刚开始时升级的）、拒付流程、Link 邮件的实际内容（测试用的是假邮箱，沙盒也不会自动发邮件）、通过 API 修改订阅默认付款方式（这次探针写错了测试卡写法，结果无效；按官方文档，MP 订阅不能通过 API 改默认付款方式，只能由用户在客户门户里改）。

## 各项技术细节

### 1. 同一账户并存（PASS）

- 同一个沙盒（账户编号核对过，就是 Owner 开 MP 的那个）里：MP 订阅会话的 `managed_payments.enabled=true`，可用支付方式由 Stripe 自动决定（这次是 `card`、`cashapp`）；微信/支付宝单笔会话按现有代码的写法建（`payment_method_types:['wechat_pay'|'alipay']`），`managed_payments.enabled=false`。Codex 实测这几种都付款成功。
- 页面区别：MP 页面底部有 Link 销售说明和 Link 扣款条款；微信/支付宝页面写的是 "Powered by Stripe"，没有 Link。
- 回调事件（证据：`02d-inspect-correlated-events.json`。完整翻页读取了验证开始后的 248 个事件，只保留属于本次验证对象的 223 个；`02a`–`02c` 里的事件统计只读了第一页，也没有按对象过滤，以 `02d` 为准）：两边都是标准事件。MP 侧有 `checkout.session.completed`、`customer.subscription.created / updated / deleted / trial_will_end`、`invoice.created / finalized / paid / payment_succeeded / payment_failed / upcoming`、`invoice_payment.paid`、`payment_intent.*`、`charge.*`；退款有 `charge.refunded`、`refund.created / updated`、`charge.refund.updated`。非 MP（微信/支付宝）侧有 `checkout.session.completed`、`payment_intent.created / requires_action / succeeded`。`checkout.session`、`payment_intent`、`subscription`、`setup_intent` 对象上都有 `managed_payments.enabled`，可以用它区分是不是 MP；`charge` 和 `invoice` 对象上没有这个字段。
- 结算字段（balance transaction）：
  - MP：`fee_details` 有两行，`stripe_fee`（69 美元一笔是 230 美分）和 `withheld_tax`（这次是美国怀俄明州地址，税务判定 `product_exempt`，金额 0）；`type=charge`；账单描述 `LINK.COM* GRAYSCALE LU`。
  - 微信/支付宝：`fee_details` 只有 `stripe_fee`（230 美分），`type=payment`，没有 `withheld_tax`。
  - 退款：MP 部分退款 10 美元，结算记录是 `amount=-1000, fee=0`，`fee_details` 里有一行 `withheld_tax_refund=0`；原来那笔手续费不退。

### 2. 首 30 天 49 美元（PASS，有条件）

| 做法 | Stripe 是否接受 | 实际效果 |
|---|---|---|
| 一次性优惠券（69 减 20，只抵首期） | 接受 | 今天收 49；第一期 31 天（10/12→11/12，按自然月）；第二、三期各收 69 ✔ |
| 30 天试用 + 一次性 49 | 接受 | 今天收 49；第 30 天整（2592000 秒）开始收 69 ✔；页面写「试用」「30 天免费」 |
| 精确的 `trial_end`（正好 30 天） | 接受（只建了会话，没付款） | 效果应该和上一种一样 |
| 30 天账单锚点 + `proration_behavior=none` + 一次性 49 | **拒绝**："You cannot set `proration_behavior` to `none` in a Checkout Session with one-time prices." | — |
| 促销码（`allow_promotion_codes`） | 接受 | 没付款测试 |

**用户看到的效果对比（Codex 截取的页面原文）：**
- 优惠券做法（s2）：「1 个月优惠 US$20.00」「然后从下个月开始每月 US$69.00」，今日 49 美元。没有"试用""免费"字样，用户看得懂是"首月便宜 20"。
- 试用加 49 做法（s3）：「试用 MP probe Gold」「30 天免费」「US$69.00 / 月以后」，另外单列一行「MP probe Gold first 30 days US$49.00」，按钮是「支付并开始试用」。页面一边写"30 天免费"、一边今天收 49，容易让人觉得被骗，也给拒付留了理由。

**能不能把 s3 的"免费"字样改掉**（证据：`04-trial-wording-probes.json`）：
- `custom_text`（提交按钮旁说明、条款说明）：**MP 下不允许**，实测报 "You cannot use custom_text with Managed Payments."
- `subscription_data.description`：可以建会话，但它是订阅和发票上的描述，不是结账页上"30 天免费"那一行，改不掉那几个字（结账页显示没有用浏览器复核）。
- 改产品名：只能把"试用 MP probe Gold"里的产品名部分改掉，"试用""30 天免费""开始试用"是 Stripe 自动生成的文字。
- 结论：**在 MP 下改不掉"免费 / 试用"字样**。Stripe 还会照常发"试用开始 / 试用即将结束"的邮件。所以推荐优惠券做法，口径改为"首月 49 美元"。

另外：官方文档说 MP 不支持 `automatic_tax`，但实测带上这个参数也能建会话。以官方文档为准，迁移时不要传。

### 3. 测试时钟续费（PASS）

- 每个场景各用一个测试时钟和一个客户。测试时钟可以用在 MP 订阅上。
- 续费成功：月付在第 31 天收 69（`billing_reason=subscription_cycle`，第一次就扣成功）；年付在第 365 天收 496；试用场景在第 30 天收 69。
- 续费失败（测试卡 `4000…0341`）：试用结束后第一次扣款失败 → 订阅变为 `past_due`，发 `invoice.payment_failed`，`next_payment_attempt` 大约在 15.5 小时后；再推进 25 天后，一共尝试了 2 次，订阅变为 `canceled`，发 `customer.subscription.deleted`，那张发票仍然是 `open`。重试次数和多久后取消由 Stripe 后台的"收入恢复 / 重试"设置决定，不是 MP 特有的。
- 和我们的逻辑对接：发放会员和积分继续以 `invoice.paid` 为准；收到 `invoice.payment_failed` 时开始我们的 24 小时宽限（创始会员 7 天）；收到 `customer.subscription.deleted` 时结束会员。要把 Stripe 的重试时间设得比我们的宽限期长，不然 Stripe 会先把订阅取消掉。

### 4. 固定价续费、升级、取消、退款（PASS）

- 创始 496/年：第二年按同一个价格续费 496（价格对象没变，所以价格锁住了）。
- Pro→Gold 升级：用 API 改订阅项目的价格，并设 `proration_behavior=always_invoice`，马上生成一张 `subscription_update` 发票：退 Pro 未用部分 −29、收 Gold 剩余部分 +69，实收 40，扣款成功。下一期按 69 续费。这次是在订阅刚开始时升级，所以是整期差价；期中升级会按天数折算（没测）。
- 到期不续：设 `cancel_at_period_end=true` 后订阅保持 `active`，到期自动变成 `canceled`。
- 退款：用 API 可以部分退款（10 美元成功）。MP 规则：退款时用户付的税全部退还；但在部分地区 Stripe 仍要替我们交原来那笔税，这部分会从 Graylum 的余额里扣（来源：how-it-works 页）。

### 5. 审核和资格（只能部分验证）

- 测试模式能验证的：Owner 已在沙盒开启 MP（状态"即用型"、"默认启用"保持关闭、每个结账会话单独开），MP 会话能建能付。产品必须设置合格的税务编码，否则直接报错（实测 `the product tax code is missing`）。
- 测试模式验证不了的：正式账户能不能通过资格审查。官方说"根据业务类型和所在地做资格审查"。Graylum 是美国怀俄明州 LLC，在支持的地区里。
- **正式启用时 Owner 要做的**（只列步骤，我没有代做）：
  1. 切换到正式模式，打开 Dashboard → 设置 → Managed Payments（`dashboard.stripe.com/settings/managed-payments`），按提示提交资格信息，接受 Managed Payments 服务条款。
  2. "默认启用"保持关闭，由代码在每个结账会话里单独开。
  3. 在 Dashboard → 设置 → 业务信息里，确认客服邮箱是对的（Stripe 升级处理客户问题时会联系这个邮箱，48 小时内要回复）。
  4. 在结账设置里填好服务条款和隐私政策链接，并设置能认出 Graylum 的账单描述。
- **产品描述怎么写才算"全自动数字产品"**：写成"由 AI 自动完成的社交媒体定位和内容策略工具（软件即服务），用户在网页上自助使用"。不要写成有真人顾问一对一辅导或代运营（这类"专业服务"MP 不支持）。客服回复问题不算真人交付服务。税务编码建议用 `txcd_10105001`（AI 即服务，云端，个人使用），这次测试用的就是它；如果主要卖给企业，改用 `txcd_10105002`。

### 6. "美国走普通 Stripe + 其他走 MP"（可行，暂不推荐）

- **怎么分流**：创建结账会话之前就要决定开不开 MP。可以参考的信号：
  - 用户访问时的 IP 国家（Vercel 请求头里有）；
  - 用户自己选的国家；
  - 付款后才能拿到的 `customer_details.address.country` 和卡的发卡国家。

  稳妥的做法是：只有 IP 和用户自选国家都是美国时才走普通 Stripe，其他情况一律走 MP；付款后再核对账单国家，对不上的进人工处理。
- **分错的后果**：
  - 美国买家走了 MP：只是多付 3.5%，没有税务问题（MP 也代缴美国销售税）。
  - 非美国买家走了普通 Stripe：Graylum 就是卖家。欧盟、英国等对境外卖数字服务的商家第一笔就要登记、交增值税，而且算不清楚。这个方向的风险不受 5 美元损失线保护，要避免。
- **已有订阅不能迁入 MP**：官方写明只有新的 MP 结账才能开 MP。所以已经在普通 Stripe 上的美国订阅，以后想改走 MP，只能让用户重新订阅一次。
- **工作量**：代码改动很小，两边的回调事件一样，只差创建结账时的一个开关，加上分流判断和付款后核对国家，大约 1 个小 PR。另外的工作在运营上：美国部分要自己处理拒付、风控，还要盯各州的销售税门槛（可以用 Stripe Tax 免费监控门槛）。

### 迁移时代码要改的地方（以后写方案时用）

- MP 会话不能传 `payment_method_types`（实测报 `Unsupported parameter`），而现有 `packages/api/src/services/payments/stripeCheckoutIntent.ts` 会传。不能传的参数还有 `automatic_tax`、`tax_id_collection`、`customer_update`、`invoice_creation`、`subscription_data.invoice_settings` 等（见官方 update-checkout 页）。
- 所有 MP 产品都要设置税务编码。
- 价格默认"税另外加"（`tax_behavior=exclusive`）；如果改成含税，要在价格上设置 `inclusive`。
- 现有代码遇到订阅打折会报 `PAY_COMMON_SUBSCRIPTION_DISCOUNT_UNSUPPORTED`；首期优惠要改成用 `discounts` 传优惠券，或者用试用加一次性项目。

## 测试数据

沙盒里留下了带 `mp_probe=20261012` 标记的测试产品、价格、优惠券、测试时钟和客户，都在测试模式里，不影响正式数据。需要清理时，删掉这些测试时钟即可（相关客户和订阅会一起删除）。
