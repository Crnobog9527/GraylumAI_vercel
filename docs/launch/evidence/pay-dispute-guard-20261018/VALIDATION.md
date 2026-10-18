# PAY-DISPUTE-GUARD 验证边界

所有 Stripe 操作均指定 `Grayscale Luminary LLC 沙盒`，`livemode=false`。未读取密钥，未访问正式库或真钱。

## Stripe 实际沙盒对象

见 [stripe-sandbox.json](./stripe-sandbox.json)，只留白名单编号、金额、时间和状态。

- MP：本任务新建订阅 Checkout，网页输入 Stripe 官方拒付测试卡，实际付款 1 USD；读回 MP 开启、付款成功。
- 普通卡：浏览器后台读取超时后，复用官方 `tok_createDispute` 创建本任务新客户和非 MP 订阅，实际付款 1 USD。未操作其他测试订单。
- 两者都实际生成 created、updated、closed(won)、funds_withdrawn、funds_reinstated；拒付的 PaymentIntent 与各自 invoice_payments 相符。
- 结案使用 Stripe 官方 `winning_evidence` 测试模拟；应用实现不提交任何拒付答辩，不自动接受或反驳拒付。
- 两个本任务订阅均设置期末停止，随后独立读取确认 `cancel_at_period_end=true`。没有立即取消，没有恢复扣款。
- 这些合成 Stripe 订单没有 staging 用户映射，不能当作部署后应用全链通过。MP 积分包、钱包年期、站内数据库与 Stripe 效果同时成立的远程验收仍未运行。

Stripe 实际读回：判赢后 `charge.disputed=true`，拒付 `is_charge_refundable=true`。因此 API 退款资格新增本地全部撤回和 provider 完整身份/判赢/可退款验证；5 个相关测试文件 93 项通过，后续全量 API 7681 项通过、16 跳过。

## 本地数据库

```sh
node packages/db/tests/pay-dispute/run-local.mjs --local-only
node packages/db/tests/run-db-baseline-replay.mjs --local-only --write-built
node packages/db/tests/v3/run-workbench.mjs --bill2-core-only --without-app --schema-from-files
```

拒付专用测试验证真实 PostgreSQL 锁、冻结来源、在途恢复、结算、退款取代、管理员权限和会员事实；PAYG 补偿夹具为合成 run/call 记录。
新增回归：不同规范付款键竞争同一订单只成功一个（receive / late match 各测）；等待中的 stop_confirm 读取晚关联并同步内部订阅；站外结案管理员允许/拒绝、幂等审计、已知关联拒绝，后续实际交付或晚匹配对已交付积分包/会员重新冻结。
现有迁移文件重放 311/311、重复 242、2624 个结构组；收敛 unchanged，回滚 restored，cleanup PASS。
BILL2 修复历史 threshold 重放遗漏后 93/93，0 skipped；运行时 431 passed、5 skipped（不带 Next 应用的配置明确跳过浏览器/应用 HTTP 用例）；私有 canary 没有进入应用日志。
最终拒付 SQL 专用测试与指纹包含撤回后退款资格、规范映射、订阅身份推导和回填修复；BILL2/运行时全套在该最后修复前运行，最终候选以远端 CI 为准。详见 [local-results.json](./local-results.json)。

三年到期清理执行器按 Owner 既定决定上线后实施，本次只同步 DATA-ERASURE 白名单，不虚称到期删除测试通过。
PAY-EVIDENCE 当前尚未建表，专用测试按已确认文档构造最小表，验证根订单保全、清除待删标记和结案延长 90 天；未来证据清理器须使用相同根订单锁。

## 页面

本地浏览器夹具打包了实际 AdminPaymentDisputes、PaymentDisputeNotice 和 Button，只有 tRPC 返回值为合成数据，未连 staging。
已确认：冻结提示、判赢后仍冻结、二次确认、返回不提交、确认提交一次、成功显示恢复量且续费仍停止、失败保留冻结并给出可读错误。
分页：101 条合成记录，第一页 100 条已撤回记录，第二页旧冻结记录可打开二次确认；API 回归也验证第二页返回。
站外结案：实际组件二次确认，返回不提交、确认只一次，成功显示结案并去掉操作按钮；后端/服务回归 14 项、组件 5 项通过。
结案前列表与确认文案显示 Stripe 拒付编号、商户及测试/正式环境；缺身份不提供结案按钮。接口和组件新增身份回归各 6 项通过。
截图：[身份核实](./ui-external-identity.png)、[站外结案](./ui-external-resolved.png)、[分页](./ui-pagination.png)、[成功](./ui-withdraw-success.png)、[失败](./ui-withdraw-failed.png)。夹具没有正式页面的样式环境，不作为视觉还原或部署验收。

## 未完成项

- 迁移 0311 是 Owner 指定暂号；远端账本拒绝 0311 前尚未合并的编号空档，总控须按准备顺序最终确认，之后重新生成指纹、CI、审查。不得补空迁移或降低检查。
- 当前候选完整 CI、机器人当前版本结论、审查线程归零仍须读取 GitHub 实际结果。
- 迁移未上远程库；部署后的上述应用全链验收需要 Claude 总控安排迁移，再由 Codex 验证。当前不能宣称可合并。

钱包退款重送回归：微信/支付宝冻结转退款后，同一退款再次进入外部退款 SQL，duplicate=true，未再次扣取其他 40 积分。停续费并发回归：读到旧活动状态后另一任务先确认，当前任务不降级为 manual、不发失败告警；相关接口回归 26 项通过。
