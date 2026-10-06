# PAY-COMMON：9-22 遗留待付订单清理

风险：high（支付订单终态）。依据：[#679 主窗口审计](https://github.com/Crnobog9527/GraylumAI_vercel/pull/679#issuecomment-6011373921)。

本任务交付默认只读的盘点工具、逐单受控关闭入口、一次性本地 PostgreSQL 与模拟 Stripe 验证。
只有 Stripe 权威读取证明结账已过期、未付款且无订阅、发票或其他付款凭证时，才能复用现有关单 RPC。
证据不全保持未决；不删除订单，不新增表，不将旧订单伪装成 PAY-COMMON 新订单。

远端数据库、真实 Stripe 验证和实际关单由主窗口取得 Owner 批准后另行执行。
本 PR 不访问远端数据库、不改配置、不合并；正式环境只读盘点也必须先获 Owner 批准。

实现与操作步骤待本 PR 补齐；当前不能据此执行远端操作。
