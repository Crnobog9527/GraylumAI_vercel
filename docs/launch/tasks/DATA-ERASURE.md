# DATA-ERASURE：账号注销与数据删除 — 规则设计与实施验收

> **Owner 决定已写入；最终审查状态以 PR #474 为准。** Owner 2026-09-28 授权“同意把删除规则设计交给 Codex”。本轮只写本文，风险为 **high**（删除和保留数据的产品承诺），不改代码、迁移、配置，不连接远程数据库，不执行任何删除。
> 产品依据：[Master Plan v12](../MASTER_PLAN.md) §2.1(8–9)、§3、§5、§7.1–7.2、§9.3、D5/D7；[BILL2](V3-BILL-2-provider-authoritative-billing.md) §2–7。总控已审原设计；第 9 节记录 Owner 2026-09-29 决定及 E5 补充，本次修订后 ready / Codex 审查；最终合并还须 Owner 在本任务明确说“允许合并”。设计审查完成才满足 AC-2 建表前置，功能实现属于 N2。

## 现状与证据边界（2026-09-28）

现状只以基线 `0402f4d217ed809587b5dc70eb113d51277d75e0` 的 `packages/db/migrations/` 为证据；检查了全部 140 个 SQL 文件（0001–0139，含两个 0018）。**不代表远程数据库已应用或运行功能已验证。** 下文“应、必须、拟”都是设计要求。

- 成果历史、定位记录存在阻止修改/删除的触发器：[0066][m0066]、[0107][m0107]；扩展及其他阻断见第 4 节。
- BILL2、Runtime 多个 `actor_id` 是指向 `profiles` 的非空外键，未指定 `ON DELETE`，按 PostgreSQL 默认 NO ACTION；直接删资料会受阻。`bill2_runs.session_ref` 又指向 Runtime 会话，形成清理依赖：[0105][m0105]、[0106][m0106]。这不是可直接执行的注销方案。
- [0004][m0004] 的软删除及 [0078][m0078] 的会话删除拦截不等于正文擦除；[0001][m0001]、[0012][m0012]、[0045][m0045] 还有会随 profile 删除的财务 CASCADE，必须保护。
- 一些基线表只有迁移中的 RLS、查询或 ALTER，没有完整 CREATE/FK 定义；存储桶也没有建桶迁移。附录 A 逐项标为“定义缺失”，不能推断不存在、可级联或已可清除。迁移不能证明网页是否已有注销按钮，因此不沿用“代码没有任何注销功能”作为本次核实结论。
- 正式环境没有真实用户，是 **Owner 已确认事实**（Master Plan §2.1(8)、§9.3），不设计旧数据迁移。本设计仍须用完整测试结构验证新功能和账务安全；不能据此删除 staging 测试账务或修改既有迁移。
- 条款正文、法律适用判断不在范围。本文的提示描述只说明界面必须呈现的事实，最终措辞由 Owner 另行生成。第三方官方材料读取日期为 **2026-09-28—29**，见附录 C。

## 删除规则设计

### 1. 一页规则：给 Owner 看

**注销是清掉这个账号的全部私有内容；单条删除只清掉选中的内容和系统副本。账目不能跟着聊天一起消失。** 以下为 Owner 2026-09-29 已决定的产品规则（第 9 节有来源），功能尚未实现。

| 删除什么 | 我们怎么处理 | 保留多久、为什么 |
| --- | --- | --- |
| 整个账号 | 重新验证身份，展示删除影响并二次确认；确认后立即关闭登录和使用，开始清除资料、对话、定位、稿件、文档、文风、研究证据、反馈及系统副本 | 不设冷静期；正常在线内容 24 小时内清完。订阅及未决账务另行核对，异常显示未完成，不假报成功 |
| 一条回答、一个会话、一个成果 | 先显示影响；确认后立即不可读，清掉正文、历史副本、提取内容和使用它的执行快照；不提供回收站 | 24 小时内完成在线清除；默认保留其他独立保存的作品，并提示可另删。相关作品失去来源时提示需要复核 |
| 资料库文档 | 删除原文件、文字分段、目录、画像及执行快照 | 已经显示的回答、用户保存的成果仍保留，用户可另行删除；注销时一并清掉（D7 已定） |
| 已结清账目 | 只留金额、币种、订单/运行编号、时间、计费规则和必要核对证据；删提示词、回答、姓名、邮箱、文件内容 | 对应交易年度结束起保留 3 年；解释收费、退款和防止重复扣费，不用于恢复作品；具体单笔保全按 §3.3 |
| 还没查清的调用或退款 | 内容立即对用户和普通后台不可见；只隔离保留该笔核对确需的原请求/证据，其他内容照删 | 核对完成后 24 小时内清掉正文；定期人工复核，不因过期自动退款或重试 |
| 防止重复领开户积分 | 只留用来防止重复领新人积分的加密指纹（不存邮箱原文），同时覆盖邮箱和第三方登录 | 开户赠送规则存在期间保留；指纹仍可比对，不冒充完全匿名 |
| 日志、备份、第三方副本 | 清理我们可控制的副本；不可逐条删除的副本按已确认期限过期；已发给外部的数据走对方删除流程 | 日志最多 30 天、备份最多 30 天；实施时确认实际套餐，超出须再请 Owner 决定。外部可能另有保留要求，不能承诺所有地方立即删除 |
| 已同意用于改进的记录 | 撤回立即停止新使用；未使用的从案例中移除；已用过但仍可定位到个人的案例也删除 | 无法撤销人已经学到的通用经验；不保留原话、身份或可追溯案例。同意审计保留 1 年，不带正文 |

注销前须明确提示剩余积分作废；订阅和积分包付费成功后默认不退款，Owner 可以逐笔批准手动退款。二次确认后账号立即不能使用，余额原数字仅为对账保留、不能消费；先在原支付渠道确认停止续费，并处理完未决账务（包括已批准但未完成的手动退款），再完成注销。等待账务不阻止清除无关私有内容；结果不明先核对，不当成成功，也不重试。

### 2. 时间、状态和完成标准

第 9 节已批准：`T_online` = 24 小时；`T_fin` = 对应交易年度结束起 3 年；`T_log` = 最多 30 天；`T_backup` = 最多 30 天；`T_abuse` = 开户赠送规则存在期间。同意审计在撤回或注销触发撤回后保留 1 年。`T_review` 仅为内部人工复核周期，建议首次及之后每 30 天复核，不是 Owner 已批准的自动结清期限，不改变 BILL2。

- 账号流程：正常 → 重新验证身份并二次确认 → 清除中（立即封闭登录和使用，不可撤销）→ 在线内容已清除／账务待核对 → 本地清除完成。外部待处理、备份待过期单独显示，不能合成一个“全部删除”状态。确认前可放弃操作；确认后不提供恢复账号或撤销删除入口。
- `T_online`：单条删除从确认时起；注销从二次确认时起，不等待续费或账务核对。成功必须检查正文、衍生副本、对象存储和读路径；失败保留不含正文的清理进度并重试**清理**，不能重试收费调用。§3 最少隔离正文从核对完成起另计 24 小时，不得借此保留其他内容。预计完成时间变化须可见。
- 二次确认提交即撤销会话及服务端访问许可，停止生成、上传、新购买和 D5 使用。站内注销进度只通过经身份验证的受限查询能力展示阶段/时间/错误码，不恢复账号登录或内容访问；邮件通知不含正文。通知所需最少收件地址与正文隔离，仅用于此流程，发送完成即清；若账务久未解决，在 24 小时内发送阶段通知后清地址，后续凭受限进度入口查询，不无限保留邮箱。恢复邮件、旧令牌、重注册不能重开原账号。
- 删除确认即建立不可逆 `deleted_at` 标记并撤销读/重放/采用权限。物理删除异步完成不影响拒绝读取；客户端刷新、搜索、历史版本、下载、导出、后台和 SDK Session 都适用。仅 `hidden`、`revoked` 或 UI 隐藏不算清除。
- 复用既有领域记录、清理入口和服务端调度。最多为本次删除保留对象 ID、类型、请求 ID、阶段、时间、错误码与重试数；不新建通用队列、运行引擎或第二账本。恢复副本需用的最小删除清单保留至相关备份全部过期；清单不得带正文、邮箱或文件名。

### 3. 账务、在途和结果未知：不改变 BILL2 钱路

#### 3.1 财务字段白名单

保留既有 `profiles.credits`、`credit_transactions`、`billing_history`、订阅来源分配及 BILL2 关联，不新建余额权威。以下是允许保留的**字段种类**，实际列见 [0044][m0044]、[0053][m0053]、[0057][m0057]、[0061][m0061]、[0105][m0105]；任意 JSON 必须逐字段白名单，不能把整个 metadata/raw event/payload 当账务。

| 类别 | 最小保留 | 必须清掉 |
| --- | --- | --- |
| 钱与时间 | 金额原始十进制与精确数值、币种、积分、预留/实际扣费/实际恢复/被拦截差额、余额前后快照、原期与来源份额、创建/派发/结算/退款时间 | 自由文本备注、用户描述、IP/UA、联系方式（有具体争议保全需求须另批） |
| 身份与幂等 | 内部不可登录主体 ID、run/call/receipt/pre_deduct/transaction/order/refund/grant ID、request ID、顺序号、供应商及其账户命名空间、provider generation/payment/subscription/event ID | 密钥、token 凭证、完整支付工具信息、外部账号显示名；调用账户命名空间不是 API key |
| 定价与核对 | contract/adapter 版本、模型/工具/线路 ID、冻结兑换率/倍率/报价/上限、usage、覆盖组、最终性、冲突观测、结果/取消事实、查询尝试/来源/时间、收据验证及完整性摘要 | 提示词、原回答、工具参数/结果正文、URL 查询串、Skill 中混入的用户内容、SDK response 的 choices/message/reasoning |
| 来源保护 | 原始预扣关联、grant/周期、reversed/quarantine/termination 状态、退款和冲正关系、一次终态/一次消费标识 | 与解释本笔收费无关的其他用户数据 |

PAY-COMMON PR-1（暂定迁移 `0161_pay_common_contract.sql`）追加如下受限白名单：

- `payment_orders`：`payment_channel`、`merchant_namespace`、`payment_mode`、`purchase_request_id`、
  `purchase_payload_hash`、`purchase_snapshot`、`subscription_id`、`source_order_id`、`payment_amount_facts`。
- `user_subscriptions`：渠道/命名空间/模式与 `contract_snapshot`；`subscription_credit_grants`：
  `subscription_id`、`source_order_id`、`grant_snapshot`，保留原 grant、幂等身份和来源账务关系。
- 快照只含契约版本、商品类型/内部 ID/更新时间版本、周期、币种/单位、精确价格/折扣、税处理、积分/赠送；
  金额事实只含种类、精确十进制字符串或 unknown（JSON null）、币种/单位、无正文证据编号。
  禁止原始回调、联系信息、支付工具和自由正文。未知金额不能写 0，已有事实只能追加。
- `payment_provider_refs`：渠道、非敏感商户命名空间、模式、对象类型、外部对象编号、内部商品/订单/订阅关联、
  周期与创建时间；共享商品 price 映射不随单一主体注销删除，其余按原交易 `T_fin` 保留。

这三张原财务表的主体 FK 改为 RESTRICT，新映射和订单/订阅/grant 关联同为 RESTRICT；
不得先删主体或提前 SET NULL。封闭后允许服务端追加原订单核对事实，但不得恢复登录或使用权。
保留期仍为对应交易年度结束起 3 年；未决项先隔离核对。先清映射及 grant/退款对子订单、订阅的依赖，
再按原订单引用从子到父清订单/订阅，最后清无引用主体。此清单与次序交接 #611；
PR-1 不修改其注销控制器，也不授权执行到期清理或现金退款。

原始证据与财务投影须分开：保留官方金额字段的原始精确表示、来源、验证方式及必要签名证据；清正文前核验财务投影能复算且不破坏收据冲突检测。原完整证据的 hash 与脱敏财务投影的 hash 分开命名，不假称脱敏后仍是原文；hash 不是备份、更不能代替缺失官方证据。`payload_hash` 等幂等证据仍按受限财务数据处理，不能公开或称匿名。

#### 3.2 未决执行与晚到结果

1. 先标记来源/账号已删除并封闭新的派发许可，再按既有锁序逐 run 处理：run → call/receipt → profile → grant（BILL2 §5.2）；不持有 profile/grant 锁反向等待 run。Runtime/成果锁与此顺序的交互须在实现 PR 证明无死锁，不能套用全表一把锁。
2. 明确证明尚未派发的调用，撤销 token 后原身份退款一次；已派发而超时、断线、缺 provider ID 的保持 `unknown` 和原预留。**不重发、不换供应商、不二次预扣、不凭超时/TTL 自动退款或推断零成本。** 只允许已证实的按 ID 查询，查无结果仍未知。
3. 正常业务副本立即删；对这笔未决 run，隔离保留原 request ID/hash、固定版本/原请求必要片段、原派发事实、官方 ID/证据、冻结预算和定价、预扣/来源。只有核对确实依赖正文时才保留该笔最少正文及其原因，不保留整个账号文库。不能删完仅留 hash 却声称可恢复。禁止普通 API、团队案例或模型读取隔离正文。
4. 删除后已在网络中的响应，仅可信 adapter 读取成本、状态和供应商编号；不再存储正文、流给前端、追加 SDK history、写笔记/成果/文风或 D5 案例。原接收路径也检查删除版本，不能先把完整回包写收据再“以后清”。
5. 结算不依赖已删除业务正文：实现须为**原有 run**提供窄的只核对/结算服务路径，保留原 actor/预扣/授权上限验证，但不要求账号可登录或来源正文仍可读。它不能调用 prepare/dispatch，不能恢复被撤销的派发 token；原有 `bill2_actor` / scope 校验不能简单整体关掉（当前限制见 [0105][m0105]、[0106][m0106]）。
6. 结算/确认退款完成后 `T_online` 内清除隔离正文，财务白名单继续 `T_fin`。确认故障全退后即使供应商成本迟到，也只记平台成本，不重扣用户。收据冲突保留不可变的**财务观测**，不覆盖旧值，不翻转终态。
7. `T_review` 只是人工复核升级时间。长期无法核对不无限保留正文且无人处理：每次复核记录仍需哪些字段、下一次日期；可去掉不再必要的正文，财务 unknown/原预留继续。无法证明剩余正文可清除时，标明待处理并由 Owner 决定补偿/核销等受保护动作；本设计不授予此权限，也不承诺一个自动结清日。

Fusion 按整组一个 run 保留各子调用状态及未决份额；删除不引入另一次预扣或取整。Master Plan §4.4 对部分结算、§3.7/D14 对搜索用量/冻结标价/保底积分已有决定，待对应实现同步 BILL2；本文不把搜索“没有成本”误等同“请求结果未知”。仍未知的调用继续未知恢复规则。

#### 3.3 用户资料与财务关联

当前 actor 外键使保留账务时直接删 `profiles` 不可行（[0105][m0105]、[0106][m0106]）。拟复用原 `profiles.id` 为**不可登录、不可消费的最小财务占位**，保留原账务数字直至结清及 `T_fin`（对应交易年度结束起 3 年），清姓名/邮箱/头像/偏好等身份内容；它是可关联的假名化记录，不称匿名。E5 的剩余积分作废指使用权终止：保留原数字但不可使用，不能为了注销把余额强制归零、改旧流水或复制到新钱包。Owner 已批准的手动退款仍通过既有流水记账，不冻结合法退款调整。

Auth 账号在对象已删、关系已安全处理后通过受控 Auth 删除接口移除。因基线 profiles→auth.users 定义缺失，实施前必须在仓库的可重建基线补明此关系，并以新迁移解除会阻止 Auth 删除或级联抹账的联系；保留的财务占位不再 FK 依赖可删除 Auth 用户。**不得保留可登录 Auth 账号充当占位，也不得改指一个所有人共用的“匿名用户”。** 同邮箱重注册是新主体，不能读旧内容、继承旧钱路或借新账号完成旧 run。

`T_fin` 到期且无经单独确认的具体保全事项后，先删财务叶子再删占位。任何延长须记录适用记录、理由、批准人和下次复核日，不用“合规需要”无限保留全账号。

### 4. 改造禁止删除的触发器：只允许受控、单向清正文

这是未来新增迁移的设计，不修改已经应用的 SQL。保留版本身份、正常历史不可变和钱路不可篡改；**不使用 `DISABLE TRIGGER ALL`、session_replication_role 或可由客户端设置的开关绕过**。

| 当前阻断及证据 | 必须设计的受限变更 |
| --- | --- |
| [0066][m0066] `artifact_immutable`：evidence/confirmations/candidates/versions/requests；`artifact_round_identity`：定稿 round 全字段固定 | 将有内容的列与元数据分开；只允许授权删除函数把正文置 NULL/空容器并写 `deleted_at`，不允许替换为另一段文字。轮次 `steps` 和请求 `payload/response` 同样清除；普通编辑继续拒绝 |
| [0107][m0107]：opc_turns/plans/items/handoffs/result_links，`opc_draft_identity`；[0113][m0113]、[0114][m0114]、[0117][m0117]、[0126][m0126] 后续快照/采用/内容记录 | 允许同一受控擦除路径清 request/body/payload/result/brief 等，保存无正文 tombstone；下游 source_version_id 引用可指向已清正文的版本壳，所有来源读取须拒绝，不因此恢复正文 |
| [0105][m0105] `bill2_evidence_immutable` 对完整 receipts payload 禁改删；[0136][m0136] 会读取收据中的 SDK 正文 | 先形成可验证财务投影，再允许仅删除内容子树；金额、编号、时间、冲突和原始 hash 不改。后续收据写入先看删除状态，只持久化财务白名单；保留期到期才允许整行删除 |
| [0106][m0106] `runtime_binding_guard` 禁止已有 session_ref 清空 | 财务投影保留原 session 的不含内容来源编号后，仅授权清理可将 session_ref 从原值改 NULL；不能换绑其他会话，普通路径仍一次绑定。FK 同步设计为可空 SET NULL；不能只改 FK 而忘记 guard |
| [0078][m0078] `ordinary_chat_delete` 在非终态时吞掉 conversations DELETE；[0080][m0080]、[0082][m0082]、[0083][m0083] 的引用/执行保护 | 先关闭读取/派发并隔离核对必需字段，未决财务不抹掉。清理须检查影响行数，不能把返回 0 行当删成功；正文可清不等于强行终结请求 |
| [0108][m0108] actor_ids 至少 1 人；`runtime_test_budget_guard` 禁改 test_window_id | 共享窗口先移除该 actor；最后一人注销时停用窗口，并仅对停用窗口允许 actor_ids 空数组（同步 CHECK）。保留 run→window 预算关联，不能靠解绑减少其他人的累计支出；财务到期后 run 先删、窗口最后删 |
| [0062][m0062]、[0064][m0064] Skill revision/package 不可变 | 系统发布的共享 Skill 不是普通用户内容，保留；上传人归属要断开或假名化。若测试/私有包确有用户正文，也须走内容清除分支，不以“包不可变”豁免注销 |

受限清除函数要求：复用 service-role-only 入口、固定 search_path、内部校验 actor/对象所有权/删除请求身份；anon/authenticated 不可直写。删除执行角色无权限改金额/所有者/版本号/原期；检查 OLD→NEW 仅允许白名单列清空、`deleted_at` 空→有值，永不回填；重复执行幂等。数据库权限和触发器须共同保护，不能仅靠应用约定。正文为 NOT NULL 的旧列须在前向迁移中改为可空或约定无内容容器，并约束 deleted 行不能再有正文。

### 5. 单条删除（D7）及影响提示

| 用户选择 | 必须清除的范围 | 保留及提示 |
| --- | --- | --- |
| 一条对话回答 | 该 assistant 消息、流式暂存、批次/history 中的该条、备选/匹配结果、以它生成的系统摘要/笔记/画像副本、复制了它的执行快照与非财务收据正文；将已依赖它的执行标为不可重放 | 同轮用户提问及其他独立回答默认保留；不能借会话上下文重新拼出被删回答。独立保存成果保留，提示“该成果来源已删除，可另行删除” |
| 一个会话 | 所有消息/工具记录、附属整理和 Fusion 会话、全部历史批次、会话资料快照、自动笔记/排队任务、关联执行的正文和系统衍生数据 | 独立保存到资料库的成果默认保留（Owner 2026-09-29 决定，E8），提示受影响数量并提供另删入口；财务按第 3 节 |
| 一个已保存成果 | 所选成果及其手动/正式/历史版本正文、候选草稿、导出缓存、相关系统副本和冻结引用；来源引用失效 | 只删除用户选定的成果家族，不自动删独立成果。若 UI 只删一个版本，必须明确写“删除这个版本”，不把删一个版本误报为删整个成果 |
| 已确认定位版本 | 先列出依赖它的账号定位、选题/稿件、引用和正在执行项，说明来源将不可读、后续需重新选来源/复核，确认后清正文 | 下游已有独立正文默认保留；含源正文的系统快照清除；引用可留无正文版本壳。用户可取消；不能用“被引用”永久拒绝删除 |
| 文档/语料/研究证据 | 原文件、提取分段/目录/索引、画像及冻结内容的执行快照、未完成派生任务；研究查询、URL、结果、指标与缓存同样纳入 | 已显示回答/已保存成果保留是 D7 已定；证据刷新生成的新版本不能使旧删除内容复活 |

影响传播须同时查 SQL 外键和 JSON 中的来源链/版本号，包含 `source_content_id` 祖先链（[0123][m0123]、[0128][m0128]、[0132][m0132]）及没有外键的 scope/history 引用（[0105][m0105]、[0106][m0106]）。删除回答导致历史项缺失时保留无正文编号/删除标记，依赖执行不可重放，不能重新生成或把 revision 缺口填成原文。

并发以“删除确认提交”作为边界：封闭 dispatch 与结果 commit 都校验同一删除状态/版本。旧事务先完成的正文也在本次清除集合内；删除先完成则后到结果只能财务入账。多标签页、断线重连、后台整理、Fusion 汇总/采用、延迟 webhook 都不能绕开。没有交付是删除取消还是供应商确认故障，按 BILL2 已有事实区分，不能因为不展示就一律免费。

### 6. AC-2 及以后新表的建表约定

以下是具体技术契约，名称为字段语义；优先扩展现有领域表，不要求另建通用删除平台。AC-2 可据此设计表和外键，并遵守第 9 节已批准的期限及商业策略。附属会话是否采用仍按 [AGENT-CORE](AGENT-CORE.md) 的方案选型，本文件不替它选方案。

| 对象/约束 | 建表时必须做到 |
| --- | --- |
| 归属和时间 | 私有内容表有 `id`、`actor_id`、明确父对象 ID、`created_at`、适用的 `updated_at/version`；由服务端校验同一 actor，父子组合 FK/唯一约束防跨用户挂靠，不能只校验两个 ID 各自存在 |
| 正文与财务分离 | 正文列或一对一内容子表放消息、笔记、反馈原话、模型输出、文件段；金额/收据 ID 等只在现有 BILL2/账务表。不得在 metadata、request、trace、hash 旁再藏正文备份；文本搜索索引和缓存随正文删 |
| 内容外键 | 新建纯私有子内容 → 父内容明确 `ON DELETE CASCADE`；可独立保存的成果 → 来源版本用可空 `ON DELETE SET NULL`，或引用已有无正文版本壳并拒绝读取。不能级联删除用户未选择的独立成果 |
| 财务外键 | 财务子记录 → 财务父记录明确 `RESTRICT/NO ACTION`，按保留期叶子先清；财务 → 私有内容只允许可空 `SET NULL`，或存不带内容的来源 ID 且不作可读权限证明。禁止财务跟 Auth/会话/文件级联删除 |
| 账号外键 | 纯内容 → `profiles(id)` 可 CASCADE；财务 → 保留的 profiles 主体 RESTRICT。注销确认即封闭登录；清内容和依赖后才物理删除 Auth 身份，不能用 profile CASCADE 一键代替全流程。主体占位与 Auth 解除关系见 §3.3 |
| 删除标记 | 需防晚到写入/被财务引用的对象有 `deleted_at timestamptz NULL`、`deletion_request_id` 和单调 `version`（复用已有版本字段）；默认未删。deleted_at 一经写入不可恢复，子任务创建及提交均检查父对象和来源删除状态 |
| 内容约束 | `deleted_at IS NOT NULL` 时普通正文列必须 NULL/约定空值；未决最小证据只能放在受限核对载荷，不留在普通内容列。父 tombstone 保留到全部工作进程失效且依赖清完，随后可物理删除 |
| 写入与读取 | RLS + 服务端所有权；新建、读、搜索、导出、采用、重放、整理写回与结果提交同样检查删除。不存在的父对象和已删除对象均 fail closed，旧 request ID 返回“已删除”而非重建 |
| 注销封闭（PR-A 起） | 凡是给 `authenticated` 授权（表级或列级）的新 public 表，必须开 RLS，并在同一迁移里加限制性策略 `account_open_required`（`AS RESTRICTIVE FOR ALL TO authenticated USING/WITH CHECK (NOT (SELECT public.current_account_is_closed())))`）；以后才对已有表授权的迁移同样要加：凡是后续迁移才给 `authenticated` 授权的表，都必须在同一个迁移里补上 `account_open_required`。0148 第 8b 步就是一例：从文件建库时，有 8 张表的 `authenticated` 授权晚于 0147 才到位，0148 在授权之后按 0147 的同一规则补上。`packages/db/tests/account-open-policy-audit.sql` 是只读审计，应返回 0 行，本机随 `run-account-erasure-close.mjs` 运行，也可在 staging 只读执行；DB-BASELINE 的空库重放（`packages/db/tests/run-db-baseline-replay.mjs`）最后会运行它，结果不是 0 行就失败。`profiles` 例外，因为服务端要读出已注销状态 |
| 历史保护 | 不加整表永不允许 DELETE 的触发器。正常历史不可变可用列级保护，但保留窄擦除和到期清理通道；不能让 UPDATE 清正文仍被不可变 guard 阻挡 |
| 衍生引用 | 记录所用源对象/版本 ID，不只存副本/hash。多源笔记/画像任一来源删除，原系统副本停用并清除；以后重新整理须在新的有效来源上，不自动收费重建 |
| 同意用途 | AC-5 的 consent version、purpose、granted/revoked_at 与案例来源 ID 可审计，正文独立；默认 false；进入案例时、读取时、消费时服务端复核当前同意及未删除状态 |

具体落点：附属会话复用 Runtime 会话并登记父会话/来源，不另有豁免；整理笔记的草稿、确认版本、来源和手动覆盖均可擦除；反馈/“重写、放弃”事件清原文与关联身份，仅按已批准用途保留不含内容的计数；Fusion 清各列、评审意见、综合稿和采用前快照；LIB-DOCS 清上传占用、文件及分段；VOICE 清画像每个版本；RESEARCH-TOOLS 清查询/原始响应/取数证据及副本。每个实现 PR 必须把新表、列、桶和缓存补进本文附录并提供注销/单删测试。

### 7. 数据使用同意（D5）

已确认：默认不参与；明确勾选才允许团队查看去身份使用记录来**人工**改进；不训练模型、不自动改 Skill；新用途重新同意；个人文风和偏好只服务本人。来源为 Master Plan §6.3/D5 与 [AGENT-CORE AC-5](AGENT-CORE.md)，不是第三方训练授权。

- 撤回立即禁止新进入/读取/消费案例；已排队但尚未使用的记录移除。不能以生成案例时曾同意为由继续访问。导出到团队使用范围的可定位副本也必须登记并清理，不能只清一个案例视图。
- **已使用记录（Owner 2026-09-29 决定，E6）**：仍可回溯个人或含原话的案例、标注、截图、测试样本全部删除；真正不可回溯的汇总统计/通用改进可保留。不保证“让团队忘记已学到的经验”，也不把去掉姓名就叫不可回溯。
- 注销视为撤回，并清用户私有原记录及所有可定位案例；仅保留不带正文的同意/撤回时间、用途版本、删除完成证明至撤回或注销触发撤回后 1 年。数据进入案例之前必须去姓名、联系方式、账号、用户编号等身份信息，仍须保留受控来源映射以支持撤回；映射随案例清除。
- 若将来产生训练集或已训练模型，必须另立用途和删除能力决定、重新征求同意；不能把本轮“已参与改进”解释成已批准训练或自动学习。

### 8. 二次确认、防刷、订阅与备份

**二次确认**：Owner 2026-09-29 决定取消冷静期。先重新验证身份，再展示影响、剩余积分作废和退款默认规则，由用户二次确认；提交幂等，立即封闭账号及启动清除，不设待注销或撤销状态。限频和异常身份保护复用现有机制，不收集额外设备指纹。进度与无正文通知按 §2/E9。

**防刷**：原要求的“不可逆账号标识”不应实现为裸 SHA256(email)，可被猜测。采用独立密钥的 HMAC 对规范化邮箱及 `issuer + subject` 生成摘要（有哪类身份就记录哪类），记录用途、密钥版本、首次赠送事实和到期条件；只做相等匹配，不保存原文、不用于画像。邮箱标准化沿认证规则，不擅自合并点号/别名；OAuth 不用昵称作身份。E3 已批准两类标识在开户赠送规则存在期间保留，规则取消后清除；密钥部署属于以后另批配置。摘要仍可关联，密钥持有者可验证候选，**不能承诺绝对不可逆或完全匿名**。注册赠送在同一原子边界查摘要与发放，重注册并发也只能领一次；不改变其他合法购买/退款权利。

**订阅与未完成退款**：展示有效订阅、续费状态、在途支付/退款和未决预扣。**Owner 2026-09-30 决定（见 E4）：账号有自动续费订阅时不允许提交注销**，页面提示先在客户门户自行取消续费，服务端确认时再次检查；不新增服务端取消订阅的调用。已取消续费的订阅允许申请注销；二次确认后立即不能登录和使用，包括剩余已付权益。若订阅仍生效，先在原渠道停止续费并核实成功，再在未决账务处理完后完成注销；Waffo 订单不送 Stripe 重试（Master Plan D17）。停止续费结果不明时先核对远端状态，不能把本地标记当成功，也不能盲目重复请求。无关私有内容仍按二次确认起 24 小时清除。

> 2026-10-05：下面"订阅和积分包付费成功后默认不退款"的部分已由 MASTER_PLAN 第 2.1 节第 51 项的退款规则取代（#618 记录 Y：首购、积分包、Pro 升 Gold 在 7 天内且这次的积分没用过可以退，最多扣 6% 手续费；续费期、超过 7 天、积分已用过不退）。注销时积分作废等其余规则不变。

**积分作废与手动退款**：Owner 2026-09-29 决定及同日补充：订阅和积分包付费成功后默认不退款；注销前必须提示剩余积分作废。Owner 可逐笔人工判定并批准手动退款；本设计不新增自动退款、不代 Owner 判断例外。手动退款沿用既有退款、账务和原支付渠道，结果不明先核对、不重试；注销前已获批准且仍在处理的退款属于 E4 未决账务，完成后才完成注销。余额原数字作为不可消费的财务占位按 E2 留 3 年，实际退款照既有流水记录。购买退款的商业规则不取消 BILL2 对已证实故障/未派发调用的预扣恢复和对账义务，也不把注销或未知结果当故障退款理由。条款文字、法律适用及例外个案判断仍由 Owner 另行处理；本文不引用其他应用条款。

**备份**：活动库/对象清除不等于旧备份逐条清除。DB、PITR、对象存储备份、手动导出和日志转存分别列保留窗口，按 E7 固定过期；不能只写“Supabase 7 天”。Supabase 官方列不同套餐备份窗口，并明确数据库备份不含 Storage 对象，[S8] 不是本项目当前套餐证据。恢复只能先到隔离环境，在开读/写/派发之前重放删除清单并再次删除对象与正文；财务 unknown/防重键仍保留，不能因恢复旧备份重新派发或补发开户积分。若删除清单缺失或旧备份仍含正文，不开放服务。恢复演练用虚构账号，保留测试证据；不为本设计创建或下载生产备份。

### 9. Owner 决定记录（2026-09-29）

来源：[总控审查及两项补充要求](https://github.com/Crnobog9527/GraylumAI_vercel/pull/474#issuecomment-5873996861)、[Owner E1–E11 决定及解释](https://github.com/Crnobog9527/GraylumAI_vercel/pull/474#issuecomment-5874155025)、[Owner E5 最新补充](https://github.com/Crnobog9527/GraylumAI_vercel/pull/474#issuecomment-5874209947)。下表保留选项、提案推荐与取舍，**实际实现以最后一列为准**。全部 E1–E11 已决定；不把产品选择写成法律结论。条款由 Owner 另行生成，法律适用另行确认；超过已批准窗口等新增事实仍须报告。

| 编号 | 选项与提案推荐 | 理由与事实来源 | Owner 2026-09-29 决定 |
| --- | --- | --- | --- |
| E1 | 二次确认后立即注销 / 3、7、14 天冷静期；原提案推荐 7 天 | 原提案为防误删；Owner 改选二次确认，§2/§8 按最新决定执行 | 重新验证身份并二次确认后立即封闭登录和使用，进入清除流程；无冷静期、无撤销 |
| E2 | 3 年 / 原提案暂拟 7 年 / 专业意见指定其他期限 | BILL2 要求可对账；[S10] 列不同记录期限，不能套成 Graylum 法定义务；[S5/S6] 支付商期限也不等于我方期限 | `T_fin` 为对应交易年度结束起 3 年；具体单笔保全按 §3.3 记录并复核 |
| E3 | 邮箱摘要 / 推荐邮箱 + OAuth issuer/subject 摘要；1 年 / 推荐开户赠送存在期间 | 覆盖两类登录、防反复注销领赠送；摘要仍可关联；原防刷要求及 §8 技术边界 | 采用邮箱和第三方登录加密摘要，在开户赠送规则存在期间保留 |
| E4 | 完全阻止申请 / 推荐允许申请，停止续费并清未决账务后完成 / 立即终止订阅 | 避免继续扣费及丢失未决账务；原渠道按 Master Plan D17，外部保留见 [S5/S6] | 允许申请，确认后立即封闭账号；原渠道停止续费、处理完未决账务后完成注销，无关私文照删。**Owner 2026-09-30 决定：有自动续费时须先自行取消**——有自动续费订阅时不允许提交注销，影响预览提示并给出现有客户门户入口，服务端确认时再检查；不新增 Stripe 服务端调用。Waffo 接入时按同一规则 |
| E5 | 总控补列：推荐注销前提示积分作废、可退范围先申请 / 其他退费方案 | 注销后积分不可消费，须明确结果；[0044][m0044]、[0053][m0053]、[0057][m0057] 与 BILL2 保护原来源/一次终态；不作法律判断 | 注销前提示积分作废；付费订阅及积分包默认不退款，**同日补充：Owner 可逐笔批准手动退款**。原渠道处理，不新增自动退款；已批准未完成退款先处理。余额原数字不可使用，留至 E2 到期 |
| E6 | 只删未使用案例 / 推荐连可定位的已使用案例也删；审计 90 天 / 推荐 1 年 / 专业意见指定 | D5 默认不参与、人工改进；减少私有副本，审计仅时间/用途/状态，无正文 | 可定位到个人的已使用案例也删；同意审计在撤回或注销触发撤回后留 1 年；不可回溯的通用经验/汇总可留 |
| E7 | 日志 7 / 推荐 30 天；备份 7 / 推荐最多 30 天 | [S7/S8/S9] 平台窗口有差异；当前套餐、转存、SMTP 未核验，不能把公开说明当配置证据 | 日志最多 30 天、备份最多 30 天，实施时逐副本确认；超出再请 Owner 决定 |
| E8 | 连独立成果一起删 / 推荐保留独立成果并提示可另删 | D7 已定删文档保留回答/成果；扩展到回答/会话可避免误删已整理作品 | 删除回答/会话默认保留独立保存成果，展示影响和另删入口；账号注销仍全删 |
| E9 | 在线清除 24 小时 / 72 小时 / 7 天；推荐 24 小时 + 站内进度及无正文邮件 | 产品时限，非平台或法律保证；隔离未决正文、第三方另列；SMTP 需实施核验 [S9] | 24 小时内在线清除，站内进度 + 无正文邮件；失败如实显示，账号封闭后进度/通知按 §2 |
| E10 | 原提案优先 ZDR、非 ZDR 另行选择 / 一律 ZDR / 统一准入 | [S1] 不训练不等于不留存；和 RUNTIME-PROD 模型准入有重叠，具体政策仍按实际端点记录 | 非 ZDR 线路可以启用，不单独区分准入、不再逐条请求选择；如实说明外部可能保留，不改变既定不用于训练要求 |
| E11 | 推荐不提供回收站，确认后立即不可读 / 提供 N 天回收站 | 总控补列；推荐减少隐性正文副本，以删除前影响提示防误删；属产品取舍，非法律要求 | 不提供回收站；删除前展示影响，确认后立即不可读并按 `T_online` 清除 |

AC-2 实现须引用最终审查通过的本文版本；本设计不是运行注销、手动退款或变更供应商配置的执行授权。未决复核周期是 §2/§3 的内部运行建议，E5 决定不授权到期自动退款、补偿或核销。

## 对其他任务的要求

- AC-2/AC-5：按 §6 建表、补齐同意与来源关系；不得把本设计误作后台整理方案 A/B 的决定。
- BILL2 / Runtime：按 §3–4 分离正文与财务，补受限结算、单向擦除、原 session 解绑、迟到结果禁止落正文；保留结果未知不重试。
- FUSION、LIB-DOCS、VOICE、RESEARCH-TOOLS：按 §5–6 覆盖所有结果/来源/衍生/缓存，接入注销与单条删除；不得只删资料库索引。
- 本 PR **不修改其他文档**。后续应同步 AGENT-CORE、LIBRARY-VOICE、FUSION、RESEARCH-TOOLS 与 BILL2 的相关验收/受限恢复说明；Master Plan 由另一窗口维护，本 PR 只在 Handoff 告知引用关系和已批准决定；支付/退款相关任务同步 E5 默认规则及逐笔人工例外，RUNTIME-PROD 同步 E10 统一准入。

## 必测项清单（实现 PR 逐项验收；本轮均为 NOT_RUN）

| 编号 | 场景 | 必须看到的结果 |
| --- | --- | --- |
| T01 | 从实际完整迁移建隔离测试库 | 附录全部表/FK/触发器/桶都有对应证据；基线缺失必须补齐，不能用 mock DDL 代替；没有未知级联 |
| T02 | 上传 txt/md/docx → 文风画像 → 提问/整理/定位定稿 → 研究 → Fusion → 注销 | 逐表/字段/对象检查私有正文清空，包含 JSON、历史、候选、SDK 回包、导出和缓存；独立测试账号不受影响 |
| T03 | 注销前后账务对账 | 金额/精度/来源/预留/释放/消费守恒，退款 quarantine/跨期/termination 不失效，不多扣、多退或复活已退款积分；财务编号可回溯 |
| T04 | prepared、发出前崩溃、已发无 ID、ID 落库不明、cost_pending/unknown | 原 request/run/预扣身份不变，无新 dispatch/预扣；可靠查询才恢复，零成本有官方证据；隔离最少正文完成后按时清 |
| T05 | settle/refund/取消/删除/迟到回执并发 | 不同 DB 连接与同步屏障证明真并发；一次终态/消费；取消和删源不妨碍受限核对，后到正文不保存、不展示、不进 SDK/history |
| T06 | 分别删回答、会话、成果及历史版本、引用中的定位 | 影响提示准确；确认前可取消，确认后无回收站、立即不可读；全部系统副本和来源快照不可读或重放；独立成果默认保留并提示另删，无额外收费重建 |
| T07 | 删文档/语料时生成画像、后台整理、Fusion 汇总仍在运行 | 被删来源不能产生新结果或被采用，文风全部旧版本清除；D7 已完成回答/保存成果仍在，注销再全清 |
| T08 | 撤回 D5 / 注销与案例导入、读取、人工消费竞争 | 未同意和撤回后均不能进入/读案例；去身份在服务端；已使用可定位副本也删除，同意审计在撤回/注销触发撤回后 1 年到期清除，个人文风不被误当训练同意 |
| T09 | 二次确认、重复请求、冒用身份 | 二次确认前重验身份；确认后立即封闭登录/使用并开始 24 小时清除，无待注销或撤销入口；旧令牌、导出、重放均拒绝；进度能力只可查无正文状态；重复请求/清理幂等且越权拒绝 |
| T10 | 相同邮箱、相同 OAuth 主体重新注册及并发领赠送 | 新主体不能读旧数据，不重复赠送；规范化/密钥轮换/到期遵守 E3，不把不同用户错误合并 |
| T11 | 有效订阅、Owner 已批准手动退款在途、未知付款、剩余积分 | 删前提示积分作废及付费默认不退款/人工例外；确认即封闭账号，停止续费及已批准退款/未决账务完成后才结束注销；结果不明原渠道核对、不重试；不自动退款，不削弱 BILL2 故障恢复；余额原数字留 3 年不可消费，无关内容 24 小时内清除 |
| T12 | 0066/0107 等触发器和 session 解绑 | 普通篡改、跨主体、回填正文、换绑 run 均失败；仅白名单擦除成功；受影响行数准确；已清正文仍可结算；最后一个测试 actor 能清除且窗口停用，共享窗口其他 actor 累计预算不减少 |
| T13 | FK 清理、财务保留到期、仍有依赖/具体保全事项 | 按附录顺序，不误级联账务；仍有 run/退款时不删财务主体；按对应交易年度结束起 3 年核算到期，具体保全单独记录；到期清叶子后清父及测试窗口，失败明确记录不假报完成 |
| T14 | 对象删除超时、上传未完成、签名 URL 未到期、浏览器离线后重连 | 先删对象再释放占用；去重补清，不留下孤儿；旧链接/旧任务不可读写，必要时等最长期限并再扫；本地缓存清除 |
| T15 | 日志、计时、错误、SDK trace、邮件与第三方 | 无提示词/正文/密钥泄露；本方删除有回执；不支持逐条删的明确窗口与申请状态；不把平台文档当实际配置证据；日志最多 30 天，通知无正文且收件地址按 §2 清除，非 ZDR 无额外准入分支但显示真实外部留存边界 |
| T16 | 隔离备份恢复和删除清单恢复 | 对外开放前重做删除；旧内容、派发、余额赠送不复活；对象备份与数据库备份分别验证；备份最长 30 天且过期时间可核验；发现超过窗口须先报告 Owner，不能假称达标 |
| T17 | 新 AC-2 表/未来模块接入 | 每个私有列、归属、删除标记、FK、衍生来源、晚到写路径及同意规则均有测试，不能只测试一个主表 |
| T18 | 全部入口与访问者 | owner/跨用户/anon/后台普通角色/服务端清理角色分别测试；列表、详情、搜索、导出、历史、重放、采用、下载、财务恢复和新派发权限分开验证 |

实现 PR 记录 exact head、命令、测试环境和 PASS/FAIL/BLOCKED/NOT_RUN；文件检查/CI 不等于上表产品功能验收。正式供应商删除/对账、真实费用、生产执行须各自授权；本设计不借测试名义执行。最终需要相关验证、全部 required CI/Security、总控及最终 head Codex 审查，并完成第 9 节决定。

## 实施核对（2026-09-30，staging `cbc5ccdc`，迁移至 0145）

实现开始前按当前 staging 代码、迁移和总控 2026-09-30 只读核对的 staging 目录重新核对，以下更正优先于正文和附录 A 的旧描述：

- 0140–0145 只改授权/RLS，没有新表、外键或触发器；第 4 节列的保护触发器函数均未改动。`artifact_immutable` 现挂在 0066、0069、0070、0080、0082、0083、0107（3 处）、0113、0114、0117（4 处）、0126，实现须全部覆盖。
- 指向 `profiles` 的外键（staging 实际）：**CASCADE** = billing_history、conversations、invitations.created_by、subscription_credit_grants、token_stats、user_checkins、user_subscriptions；**SET NULL** = ai_usage_logs、announcements.created_by、application_logs、credit_transactions、invitation_records（两端）、invitations.used_by、modules.created_by、payment_orders、prompts.created_by、ticket_replies、tickets、user_activity_logs（两端）；其余均为 NO ACTION。**payment_orders 不会随 profile 级联删除**（0012 只有 user_subscriptions 级联）；credit_transactions、payment_orders 删 profile 会丢失账号关联，同样不可接受。
- `profiles` 没有指向 `auth.users` 的外键；`auth.users` 和 `profiles` 上都没有自定义触发器（无 handle_new_user）。资料由 API `ensureProfile` 创建并发放开户积分。
- 16 张核心表仍无迁移 CREATE，由 DB-BASELINE 补 `0000` 基线；在它完成前 **T01 为 BLOCKED**，外键改造按数据库目录动态查找约束，不按名称猜测。
- 服务端角色现无清除所需的表级权限（工单、邀请、行为日志、资料列等）；清除统一走只授予服务端执行的 SECURITY DEFINER 函数，不放宽表授权。
- 现有代码：无注销/擦除功能；`profiles` 已有 `status`、`is_deleted`、`deleted_at`；BILL2 prepare/dispatch 与 OPC/成果多数入口已要求 `status='active' AND is_deleted='false'`，而 record/close/cancel/finalize 不要求，注销后在途调用仍可结算。存储桶只有 `ticket-attachments`，头像无存储对象。支付代码无 Waffo；Stripe 取消续费只经客户门户，退款人工处理后由 webhook 对账。
- 旧 `/chat` 不再新做单条删除入口（总控 2026-09-30 同意），其数据由账号注销覆盖。
- Storage（2026-09-30 核对）：客户端代码没有任何 Storage 调用；上传只经服务端 `/api/upload`（PR-A 起拒绝非 active 账号），读取只经服务端生成的 30 分钟签名地址，而签名地址只在登录后接口里生成（已注销账号被拒）。`storage.objects`/`storage.buckets` 开了 RLS 且策略数为 0（总控 2026-09-29 只读核查，#506），客户端用 JWT 直接调 Storage API 会被默认拒绝，所以 PR-A 不在 `storage.objects` 上加策略；该表属于 `supabase_storage_admin`，迁移角色也不该改它。注销前已签发的地址最长 30 分钟后失效，附件对象由 PR-C 删除。以后如果给 Storage 加客户端策略（LIB-DOCS），必须同时加注销限制条件。

### 实现拆分与后续事项

PR-A 封闭账号 → B1 内容擦除通道 → B2 账务擦除通道与受限结算 → C 清除执行与外键改造 → D 单条删除；E 防刷在 A 之后并行。

PR-E（0151）开户赠送防刷：
- `opening_grant_identity_digests` 只保存 E3 用途、身份类型、密钥版本、HMAC、首次开户赠送决定月份（UTC 月初）和“开户赠送规则取消”到期条件；无身份原文或账号外键。只允许 service_role 读取，经服务端专用 RPC 写入，接入 `account_open_required`。财务余额和流水仍以原 profiles / credit_transactions 为权威。
- 注册的 `opening_grant_claim` 锁 profile，再按固定顺序锁摘要，在同一事务中匹配身份和调用原账务 RPC；匹配旧事实则不赠送，在原账本记金额 0 的拒绝决定，避免零余额恢复路径在改邮箱后补发。封闭账号直接拒绝，购买和退款继续走原路径。
- API 从已验证的 Auth 身份生成摘要；`account_erasure_confirm_with_digests` 先保存开户赠送决定的身份摘要（含精确幂等键下的 0 元拒赠），再在同一事务调用 0147 确认；摘要失败则整体回滚，不封闭账号。旧确认入口的 service_role 直接执行权限撤销，注销请求仍是唯一封闭审计依据。
- 与 0150 兼容：确认事务提交后，C 才能在新事务调用正文擦除；同事务调用会按 0150 的屏障返回重试。0151 不改屏障、父对象 guard、`erased_at` 规则或 `ordinary_chat_claim` 撤权，不在持有 profile/摘要锁时调用擦除。正文擦除及删除 Auth 身份后，E3 事实仍保留用于相等匹配。
- 服务端变量 `OPENING_GRANT_HMAC_KEYS` 使用多版本独立密钥，envValidator 能识别缺失或错误配置，但 `validateEnvOnStartup` 没有生产调用方，不会阻止应用启动；实际建档赠送和注销确认路径会拒绝操作。旧版本及对应密钥须保留；数据库拒绝漏掉已有版本，同版本错误替换密钥不能从摘要自动发现。真实 staging 值由 Owner 亲自配置，不在公开记录中展示；规则取消后才清除此用途事实，备份恢复开放服务前须恢复防刷事实。
- 部署前总控执行 PR-E 的聚合 SELECT；[Owner 已接受历史 staging 账号缺口](https://github.com/Crnobog9527/GraylumAI_vercel/pull/538#issuecomment-5916532310)，本次不回填。0151 前已赠账号不用于验收；迁移后尽快部署配套 API，空档不做防刷测试。正式库由迁移全新建立、不迁移已有用户数据；若此前提改变，接受失效，回到回填方案。历史封闭补存仅作参考；验证和回退入口见 `packages/db/tests/erasure-e-README.md`，有摘要事实时回退拒绝。

PR-B1a（0149，artifact / agent / research / opc 表）的擦除通道：
- **只用于已注销账号**：`account_erasure_scrub_content(p_profile_id)` 要求账号已经在 `account_erasure_requests` 里，否则拒绝执行（`ACCOUNT_ERASURE_NOT_CLOSED`）。正文清成 NULL 之后，有十几处重放和冲突检查用 `<>` 比较，结果会被 NULL 跳过；runtime 的"只在已有值时拒绝"会被重新写入；还有若干读取路径会"返回空内容"而不是"拒绝读取"。这些只有在账号还能使用时才会被触发。**单条删除（D7）上线前，PR-D 必须先把这些改成对 `erased_at` 显式拒绝。**
- 做法：26 张表加 `erased_at`；按目录动态找出引用可擦除列的 CHECK，改写成"已擦除或满足原规则"；NOT NULL 的正文列改成可空，加"未擦除必须有值""已擦除必须为空"两条约束。`artifact_immutable` 和另外三个保护函数通过触发器参数拿到每张表的白名单，只放行"未擦除 → 已擦除、白名单列清空（或改成规定的占位值）、其他列一字不变"这一种 UPDATE；已擦除的行不能再改，DELETE 仍然一律拒绝。可变表加 `erased_row_guard`。`packages/db/tests/erasure-constraint-audit.sql` 是只读审计，应返回 0 行。
- 壳里保留：id、时间、归属主体、状态、版本号、平台 Skill 的 package / workflow / template hash（这些不是用户内容）。账务键保留：成果生成 result 里的 credits / inputTokens / outputTokens / costUsd，研究调用 result 里的 cost；`provider_observations` 由 PR-B2 按账务白名单处理。账号类唯一值（opc_accounts.account_key、artifact_projects.account）改为 `erased:<id>`，不会互相冲突。
- **由正文算出来的 hash 一并清除**：content_hash、report_hash、source_hash、input_hash、agent_preference_requests.payload_hash（整行删除）。短文本的 hash 可以用猜测去比对原文，按附录 A 属于"可关联内容指纹"，不能保留。唯一保留的是 `research_operations.identity_hash`：它是研究调用计费的幂等键，按 §3.1 属于受限财务证据，客户端不能读取，保留到 T_fin 到期；它不是用来恢复内容的，也不公开。
- 在途的行不清：成果生成不是 succeeded/refunded 的、研究调用不是 succeeded/failed/cancelled 的，以及还有未清调用的研究计划，都先跳过并计数。**这些行要等 PR-B2**：现有的结算函数（artifact_generation、artifact_reject_generation、artifact_observe_generation、research_transition、research_user_charge、research_cancel）一开头就检查 `status='active' AND is_deleted='false'`，所以已注销账号的在途生成和研究调用现在无法结算，也无法退款，要靠 PR-B2 的受限结算路径才能走到终态。PR-C 的重试任务在这之后才清得掉这些行，**所以 PR-C 必须排在 PR-B2 之后**。
- 界面状态类、偏好、账号绑定这 6 张没有被任何外键引用的表，直接删行（opc_work_ui / opc_account_ui / opc_publication_ui / agent_confirmed_preferences / agent_preference_requests / artifact_accounts）。其余表只留下没有正文的壳，物理删除由 PR-C 做。
- runtime_* 和旧对话表在 PR-B1b。

PR-B1b（0150，runtime / 旧对话表）的擦除通道：
- 复用 0149 的 `erased_row_guard` 和目录约束改写，覆盖 7 张 runtime 表以及 conversations、messages、conversation_context_snapshots、ordinary_chat_requests；服务端调用 `account_erasure_scrub_runtime(p_profile_id)`，同样要求 `account_erasure_requests` 已有记录。依赖边没有正文，用显式 `marker-only` 规则只写 `erased_at`；空白名单仍拒绝，其他列及已擦除行不可改。
- runtime 的 payload、结果、历史、工具参数和结果、scope/material 全清，`runtime_scope_material.content_hash` 一并清掉。complete / checkpoint / tool complete 会尝试回填 NULL，守卫拒绝这种写入。`bill2_runs` 全部列（包含 `session_ref`）不动；解绑归 PR-B2。只有 completed/cancelled 且对应 run 已 closed、settled/refunded（或没有 run）的执行可清；依赖边等两端，会话和 material 等该会话全部执行，锁忙的父行也跳过并计数。
- 旧对话的标题、摘要、消息正文及上下文快照清空；`is_deleted` / `deleted_at` 软删除事实不变。skill 模式消息的已有 guard 仅给合法单向擦除放行；conversations 的客户端 UPDATE 写入 `erased_at` 时要求账号已注销，INSERT 一律不能直接创建已擦除行。ordinary 请求只清 succeeded/failed，正文和 `writer_token` 派发凭证一并清空，未擦除请求仍须保留凭证；reservation / billing_result 仅保留迁移列明的财务键；共享会话内容等普通请求及成果生成都到终态。
- 不做物理删除，不放宽表授权。两个 conversation DELETE guard 返回 NULL 时，必须检查行仍存在，不能把影响 0 行当成功。回退含总控给出的 staging 函数原文；已有擦除行就拒绝执行。PR-C 仍排在 PR-B2 之后；PR-D 仍须先补读取和重放对 `erased_at` 的显式拒绝，不能把账号注销通道直接用于单条删除。
- **旧对话准入关闭**：按总控在 #537 的 P1 决定，0150 撤销 `service_role` 对 `ordinary_chat_claim(uuid,uuid,jsonb,uuid)` 的执行权限，回退恢复；不改函数体，不影响已有请求的 `ordinary_chat_transition`。应用层继续保持旧聊天关闭；REVOKE 不终止已进入函数的事务，擦除前由下述事务屏障确认旧事务排空，不能把一次正文扫描当成阻止晚到写入。
- **事务屏障（总控 #537 决定）**：0150 同时给 `account_erasure_scrub_runtime` 和已合并的 `account_erasure_scrub_content` 加前置只读屏障，不改 0149 文件、不改准入或财务函数。在确认已注销后，以调用屏障时的 `clock_timestamp()` 为 cutoff，仅允许 READ COMMITTED；自检统计权限、清统计快照，仅从 datid 为当前库或 NULL 的 activity 行检查其他事务并提取候选 pid，再按原顺序检查虚拟事务锁及本库 prepared transactions。其他数据库的长事务不能阻塞本库清除，datid NULL 的 worker 保留保守判断。client 仍只放行有统计权限且明确 `idle + xact_start NULL` 的事务外连接（开始于 cutoff 之后的已知状态事务沿用原规则）。对具名非 client 且 state NULL 的后台进程，六参数纯函数只在 xact_start/xid/xmin 全空时列为候选；取得候选 pid 后再查 `pg_locks`，仍持有 granted virtualxid ExclusiveLock 就拒绝，不能仅凭两个空标识认定事务结束。其他未知、disabled 或不可见均拒绝。排除纯维护进程和 pg_cron launcher，保留 pg_net、cron job、parallel、逻辑复制工作进程及未知类型。未通过返回 `{"retry":true,"reason":"transactions_pending"}`，不改内容也不返回 skipped 计数；PR-C 必须稍后新事务重试，不能将其视为成功。另保守拒绝 confirmed_at 不早于调用事务起点的请求，保证同事务（含子事务）注销不能立即擦除；比并发确认更早开始的调用也须重开事务重试。该时间比较不是提交证明，不能替代 activity/prepared 屏障。长事务/后台 worker 可能延迟清除，不能取消它们来假造完成。
- **无 active 检查的晚到 INSERT**：0150 的父对象 guard 对 messages/context snapshots 的新 INSERT 取 conversation SHARE 锁，与擦除的 UPDATE 锁互斥；父会话已擦除则拒绝。既有擦除行仍禁止回填；snapshots ACL 不变，权限拒绝和 guard 拒绝分别测试。在途 ordinary 请求仍保留 token、共享内容计 skipped，完成后再清除。
- **PR-B2/C 必测：旧结算与内容擦除顺序**：直接 `atomic_finalize_ai_success/abort` 不强制关联 ordinary request，不能宣称现有 skipped 规则已覆盖。向已擦除会话插消息会被父 guard 拒绝，整个原子结算回滚，预扣保留 pending。B2/C 必须验证先完成/核对适用的旧账务再擦除会话，并验证拒绝时没有部分扣费或退款；不能吞掉 INSERT 后继续结算。本 PR 不改财务函数，不实现受限结算。旧 HTTP 聊天和 claim 新准入均已关闭，不应再产生新 legacy 请求；failure 不写 messages，仍按 B2 财务/日志路径处理。
- **PR-C/PR-D 删除顺序**：`conversation_context_snapshots.source_message_start_id/end_id` 的 ON DELETE SET NULL 会内部执行 UPDATE，被已擦除快照的 guard 拒绝。须先删快照再单独删消息，或者只按整个会话删除；两条路径都要验证实际删除结果。0149 注释的“DELETE stays possible”仅指 guard 本身不拦 DELETE，并不保证外键引发的 UPDATE 能通过；历史迁移保持原文，此处及 0150 注释予以澄清。
- **PR-B2/C 终态推进**：即使对应 run 已 settled/refunded 且 closed，仍停在 interrupted/cost_pending 的执行及其会话也会一直被跳过。B2 的受限恢复须把执行推进 completed/cancelled，C 随后重试清除；不能仅凭 run 已结算就报告内容清除完成。

PR-A 留给后续 PR 的必做事项：
- **在途预扣（PR-B2 必须处理）**：注销时仍在途的 BILL2 run 可以照常结算（record/close/cancel/finalize 不检查账号状态），但 0137 的 `bill2_revoke_unstarted_dispatch` 会先调用 `bill2_actor`，已注销账号会被拒。所以"已授权派发但从未发出"的预扣，要等 PR-B2 的受限结算路径才能释放；在此之前只是占着，不会丢失。
- **SECURITY DEFINER 函数（PR-A 起逐个分拣）**：这类函数以属主身份执行，绕过 RLS，`account_open_required` 拦不住已注销账号未过期的 JWT。`packages/db/tests/account-open-definer-audit.sql` 列出客户端可执行的这类函数：会写用户数据或改积分的，要在函数里加"已注销则拒绝"；只读或本身已检查 `status='active'` 的，要写明理由。以后新增的这类函数，同样要遵守这条。2026-09-30 在 staging 只读执行的结果：客户端能执行的共 4 个，属主都是 postgres。`claim_daily_checkin(uuid)`（加积分）和 `soft_delete_conversation(uuid,uuid)`（改会话）已在 0147 加检查，函数体以 staging 原文为准，只加了检查；`validate_invitation_code(text)` 只读，且已检查 `status='active'`，豁免；`rls_auto_enable()` 是平台的事件触发器函数，不能直接调用，豁免。延后另立：A.1 第 8 步财务到期清理、T16 备份恢复演练、附录 B/C 的日志/备份保留期核对与第三方删除申请、Waffo 接入后的"先取消续费"规则。

## 附录 A：逐表清单与外键删除顺序

初版盘点覆盖迁移中 **75 个不同 CREATE TABLE 对象**，后续 PR-A/PR-E 新表在下表追加，另列只被迁移引用的基线表；包括平台配置是为了交代发布者等用户引用，不能把共享配置误删。表名对应当前基线的迁移名称，链接直达文件。未列当前列的完整定义，不等于准许保留未列字段：未知/自由文本默认按私有正文查明并清除。

处理代码：**D = 删除正文及用户行**（有存活引用则留无正文 tombstone）；**M = 清正文/身份，保留 §3 财务白名单**；**P = 保留共享配置，清用户归属和私文**。D 在 `T_online` 内处理；M 在核对结束后清最少隔离正文、财务留 `T_fin`；P 无用户内容的共享定义持续服务期间保留。每行的“前/后”均指物理删行的相对次序；正文和读权限先清，不等财务父表到期。M 行原 FK 有 CASCADE 的，须先按 §3.3 改造，不能照旧 FK 删除。

| 表及迁移来源 | 处理及理由 | FK 顺序／特别事项 |
|---|---|---|
|profiles ([0002][m0002],[0004][m0004],[0027][m0027],[0051][m0051])|D 身份邮箱昵称头像，必要时最小不可登录账务墓碑待核对|最后；基线 FK 未证实；不得先触发账务 CASCADE|
|conversations ([0002][m0002],[0004][m0004],[0069][m0069],[0091][m0091])|D 标题/摘要/summary_metadata|其 messages/snapshots/chat/slice/ordinary 请求处理后；[0078][m0078] 拦截|
|messages ([0002][m0002],[0004][m0004],[0014][m0014])|D 正文/部分回答及 metadata|先清 snapshots 派生、token_stats.message_id 断链；原始 FK 未证实|
|credit_transactions ([0002][m0002],[0018][m0018a],[0024][m0024],[0044][m0044],[0053][m0053],[0105][m0105])|M description 可含被邀请者邮箱([0025][m0025]/[0028][m0028])；留 amount、余额前后、ledger/source/reason code、订单/退款/周期/幂等编号和时间|不随 profile 删；billing_history/subscription grants 对其 FK SET NULL，但账务证据期内保持必要关联|
|tickets ([0002][m0002],[0004][m0004],[0010][m0010])|D 工单描述、附件；若金钱争议仅摘取最少 M 字段|ticket_replies 后；基线 FK 未证实|
|ticket_replies ([0002][m0002],[0004][m0004],[0010][m0010])|D content/attachments、回复人标识|先清存储对象再删 replies；同一工单他人/管理员回复不能保留用户正文副本|
|invitations ([0002][m0002],[0019][m0019],[0025][m0025],[0028][m0028])|D code、created_by/used_by 关系；必要防刷另用 Owner 批准最小标识|invitation_records/返佣关联先结算脱敏，原始 FK 未证实|
|invitation_records ([0002][m0002],[0020][m0020],[0025][m0025],[0026][m0026],[0028][m0028])|M 奖励证据；删 inviter_email/invitee_email/IP/UA/block_reason 自由文本，移除两端账户身份|涉及未注销邀请人时保留其合法账项但删被注销者身份；编号/奖励金额留最少；基线 FK 未证实|
|user_activity_logs ([0002][m0002])|D 用户行为细节|profile 前；列和 FK 不完整，不能保留整个 JSON|
|token_stats ([0001][m0001],[0014][m0014],[0068][m0068],[0105][m0105])|M 模型/token/cost/credits/time，清 metadata 正文和内容 FK|与 bill2_run 保持财务关系；用户/会话 CASCADE 必须改，message SET NULL|
|billing_history ([0001][m0001],[0014][m0014],[0053][m0053],[0057][m0057]、[0058][m0058]、[0059][m0059]、[0060][m0060]、[0061][m0061])|M 预扣/结算/退回金额、preDeductId/requestId、分配/周期绑定、恢复/拦截及幂等证据；清 reason 私文|bill2_runs.pre_deduct_id 引用，不能先删；profile CASCADE 需改|
|ai_usage_logs ([0001][m0001],[0068][m0068],[0105][m0105])|M 最少成本/去重结果码；D IP/UA/error_message/自由 metadata|user/conversation SET NULL 不会擦正文；generation/run FK 默认 NO ACTION，须 detach 或保留 tombstone|
|diagnostic_results ([0005][m0005],[0048][m0048])|D message/details/run_by；仅留不可反推的聚合时延|run_by 默认 NO ACTION，profile 前断链|
|application_logs ([0006][m0006],[0048][m0048])|D message/context/user/request 关联；可留无正文统计|user SET NULL 不等于脱敏；account 删除显式扫 request/execution 关联|
|payment_orders ([0012][m0012],[0041][m0041],[0043][m0043]、PAY-COMMON 暂定 0161)|M 原财务列及 §3.1 渠道、命名空间、模式、请求身份/摘要、冻结快照、精确金额事实、订阅/原订单关联；清 metadata 私文|主体及新增关联 RESTRICT；先映射/grant/退款依赖，再子订单→父订单/订阅，最后主体；不提前 SET NULL|
|payment_provider_refs（PAY-COMMON 暂定 0161）|M §3.1 外部身份与订单/订阅关联；共享商品映射为 P，无私文|无主体 CASCADE；各目标 FK RESTRICT；财务映射在原交易保留期及核对结束后先于订单/订阅清，共享商品映射不随账号清|
|user_subscriptions ([0012][m0012],[0037][m0037],[0042][m0042],[0053][m0053]、PAY-COMMON 暂定 0161)|M 原订阅事实及 §3.1 渠道/命名空间/模式/合同快照；删私文|主体 FK RESTRICT；先处理映射、grant 和订单依赖；有效订阅按已定 E4/E5 处理|
|user_checkins ([0013][m0013],[0048][m0048])|D 签到记录；奖励 ledger 留 M|profile 前，现有 CASCADE；防刷不默认保留签到历史|
|conversation_context_snapshots ([0014][m0014])|D content/metadata，滚动摘要/搜索摘要均删|message source SET NULL 不会清摘要；conversation 前|
|scheduled_job_runs ([0017][m0017]、[0018][m0018b])|D summary/error 中用户 ID/正文；保留不含用户的任务计数和时间|无用户 FK 也必须按关联扫描|
|subscription_credit_grants ([0045][m0045],[0052][m0052],[0053][m0053],[0060][m0060]、PAY-COMMON 暂定 0161)|M 原周期/来源事实及内部订阅/原订单关联、grant_snapshot|主体和新增财务关联 FK RESTRICT；核对和保留期结束后，先清依赖再清 grant，最后父订单/订阅；未对账前不能删|
|skills ([0062][m0062],[0064][m0064])|P 平台 Skill，清操作者身份/审计私文|created/updated/published/archived_by 默认 NO ACTION 且状态 CHECK 要求 actor；须将非账务操作者改可空 SET NULL，并同步状态 CHECK；保留发布事实，不长期保留身份占位|
|skill_revisions ([0062][m0062])|P 发布物内容；操作者脱敏|published_by NOT NULL 默认 NO ACTION，immutable；受限擦除改可空归属，同步 guard，不删发布物|
|skill_packages ([0064][m0064])|P manifest 与资源完整性|actor_id NOT NULL 默认 NO ACTION、immutable；受限断开上传人引用，如含用户私有上传则那份 D|
|skill_package_files ([0064][m0064],[0072][m0072])|P 平台字节；用户私有文件 D|package 子表 immutable，hash/bytes CHECK 对擦除有影响|
|skill_revision_revocations ([0064][m0064])|P 撤销事实与时间，revoked_by 去身份|revision 子表 immutable|
|research_plans ([0065][m0065])|M 最小预算/操作计数/取消，D operations 查询与参数|research_operations 后；actor 默认 NO ACTION|
|research_operations ([0065][m0065],[0071][m0071])|M 调用身份/报价预扣收费/时间状态，D result|artifact_evidence.operation_id 先处理；未知不重试|
|artifact_projects ([0066][m0066],[0080][m0080],[0107][m0107])|D account/work_title；必要下游依赖留 tombstone|所有 rounds/versions/evidence/OPC/其他 source_project_id 后，source_project 自引用倒序|
|artifact_rounds ([0066][m0066])|D workflow 中混入的私文/steps 全部正文|confirmations/candidates/versions/requests/OPC/link/chat 后；固定轮 guard 要改|
|artifact_evidence ([0066][m0066])|D payload、content_hash 等可关联内容指纹|restrictions/links/result_links/子 supersedes 后；operation FK 需先断/删|
|artifact_evidence_restrictions ([0066][m0066])|D 或保留最少 deleted 墓碑与时间|evidence 前；已 deleted 不代表 payload 已清除|
|artifact_confirmations ([0066][m0066])|D body/evidence_ids 私密引用|round 前 immutable；定位正文复制均清|
|artifact_candidates ([0066][m0066])|D body/evidence_ids|generation.candidate_id / opc_result_links.candidate_id 先断/删|
|artifact_versions ([0066][m0066])|D report/report_hash/evidence_ids；下游需要 ID 时 tombstone|OPC accounts/items/plans/business/strategy、work refs、slice links 的 source_version_id 先处理|
|artifact_requests ([0066][m0066])|D payload/response；去重保留最少 ID|agent_slice_executions 复合 FK 子表先处理；immutable|
|artifact_workflows ([0067][m0067])|P 平台 schema/workflow|不因注销用户删；无用户 FK|
|artifact_accounts ([0067][m0067])|D account 与账户绑定|actor 前；三元平台模块 Skill 配置本身保留|
|artifact_generations ([0068][m0068],[0077][m0077],[0104][m0104])|M quote/pre_deduct/dispatch/state/charged/time，D input/basis/result/provider_observations 正文|token_stats/ai_usage_logs 先脱链；candidate 引用先处理；未知继续对账|
|artifact_chats ([0069][m0069])|D 绑定|turn/summaries 后；conversation CASCADE 但 project/round 默认 NO ACTION|
|artifact_chat_turns ([0069][m0069],[0070][m0070])|D body/evidence/context_turn_ids|summaries 后；conversation→artifact_chats CASCADE|
|artifact_chat_summaries ([0070][m0070])|D 派生身份，实际摘要副本沿 generation/result 清除|turn 前 CASCADE|
|ordinary_chat_requests ([0078][m0078])|M 预扣/状态/最少请求编号，D input/response_params/partial_content/reservation/billing_result 里的私文|conversation CASCADE 但未知删除 guard；不能通过删状态去重屏障制造重试|
|artifact_reference_configs ([0080][m0080])|P 平台引用规则|无用户 FK；work references 后才可平台删除，本任务不删配置|
|artifact_work_references ([0080][m0080])|D creation_payload/section_ids/source_hash 与用户链|先于 versions/evidence/round/project，immutable|
|agent_confirmed_preferences ([0081][m0081])|D scope/name/value，停用于个性化|actor 前；注销清全部；撤回 D5 只清案例副本，个人偏好仍服务本人|
|agent_preference_requests ([0081][m0081])|D payload_hash；最多留不含正文的幂等 tombstone|actor 前|
|agent_slice_pairs ([0082][m0082])|P 平台配对规则|无用户 FK|
|agent_slice_links ([0082][m0082])|D source_hash/section 引用|versions/evidence/round 前，immutable|
|agent_slice_executions ([0083][m0083],[0085][m0085],[0094][m0094])|M 最少运行 ID/model/budget/time，D basis/preferences/discussion/evidence/input_hash|calls 后，conversation/project/round/artifact_requests 前，immutable|
|agent_slice_calls ([0084][m0084],[0085][m0085],[0096][m0096],[0099][m0099])|M quote/pre_deduct/state/time/成本证据，D evidence 正文|execution 前；未知不重发|
|bill2_drafts ([0105][m0105])|D 或最少 revoked 墓碑|opc_drafts 后、actor 前|
|bill2_runs ([0105][m0105],[0106][m0106],[0108][m0108])|M reserved/budget/rate/multiplier/max_calls/deadline/state/outcome/charged/restore/cost/version/request/pre_deduct/time；D payload/result/scope 私文|receipt/provider IDs/calls 与 ledger 账务关联需完整；actor NO ACTION；session_ref guard 要受限断链|
|bill2_calls ([0105][m0105],[0137][m0137])|M provider/account namespace/model/provider ID/upper/selected cost/dispatch/recovery/state/time；D payload|receipts/provider_ids 后才到期删，run 前；派发令牌撤销；保留版本/已派发事实防重，不能保留可用 capability|
|bill2_provider_ids ([0105][m0105])|M provider+namespace+provider ID→call 唯一映射|call 前；防串账/重复收据不是用户正文|
|bill2_receipts ([0105][m0105],[0136][m0136])|M 费用证据白名单/冲突/hash/source/time，D sdkResponse content/tool args 等|call 前；immutable 改为内容可擦、金额证据不可改；原文 hash 不冒充脱敏 hash|
|runtime_sessions ([0106][m0106],[0130][m0130])|D start_payload/scope 用户内容|batches/history/tool/deps/executions/material 和所有 OPC session 引用后；bill2 session_ref 断链|
|runtime_executions ([0106][m0106])|M 极少 run/execution linkage 如必须，D payload/result/primary_result/match_result/history refs|dependencies 双向、history/batches/tool、opc result/content references 后|
|runtime_history_dependencies ([0106][m0106])|D 双端执行引用或保留不可读失效标记|先于其任一 execution；清源后下游读取失效|
|runtime_session_batches ([0106][m0106])|D items 内容副本|session/execution 前|
|runtime_session_history ([0106][m0106])|D item 内容副本|session/execution 前，含 internal_control 也不能漏|
|runtime_tool_calls ([0106][m0106])|D arguments/result|execution 前；取数正文与索引均清|
|runtime_scope_material ([0106][m0106])|D request/content/content_hash，revoked=true 不是擦除|opc_turns/opc_video_material_bindings 后，再 session|
|opc_drafts ([0107][m0107])|D binding，必要无正文墓碑|turns/plans/handoffs/topic/draft_business/strategy 后；bill2_drafts/runtime_session/project/round 前|
|opc_turns ([0107][m0107])|D input_hash/请求上下文绑定|draft/session/round/material 前，immutable|
|opc_plans ([0107][m0107])|D request/body|items 后、draft/source version 前，immutable|
|opc_accounts ([0107][m0107],[0117][m0117])|D platform/account_key；用户业务关联|items/UI/strategy drafts 后、project/source version/business 前|
|opc_items ([0107][m0107])|D brief/item/private schedule|content versions/video bindings/item edits/UI 后、plans/accounts/project/source version 前，immutable|
|opc_handoffs ([0107][m0107])|D payload/result|draft/actor 前，immutable|
|opc_result_links ([0107][m0107])|D evidence/execution/candidate 关联|evidence/round/candidate/execution 前，immutable|
|runtime_test_windows ([0108][m0108])|D actor_ids 中该 actor；保留纯预算配置/不可识别合计|数组非 FK 但 CHECK 至少 1 人；最后 actor 删除须停用及受限空数组设计；保留 run→window 关联与累计预算，财务到期后先 run 后窗口|
|opc_topic_workspaces ([0113][m0113])|D source_hash/用户 source 与 session 绑定|opening 后、draft/source version/session 前；immutable|
|opc_topic_openings ([0114][m0114])|D input|topic_workspace 前，immutable|
|opc_businesses ([0117][m0117])|D name/current_source_version|draft_businesses/opc_accounts 后、source version/profile 前|
|opc_draft_businesses ([0117][m0117])|D 业务绑定|draft/business 前|
|opc_item_edits ([0117][m0117],[0122][m0122])|D title/brief/day|item 前|
|opc_topic_draft_versions ([0117][m0117])|D request/body|draft/source version/profile 前，immutable|
|opc_library_requests ([0117][m0117])|D payload/result|strategy_request_bases 后、profile 前，immutable|
|opc_content_versions ([0117][m0117],[0123][m0123])|D body/title，source_content 依赖如仍需存活留 tombstone|video binding/子 source_content 后，item/execution/profile 前；immutable；非空 CHECK 要改|
|opc_video_material_bindings ([0117][m0117],[0119][m0119])|D 用户脚本/材料绑定|content version/item/material/profile 前，immutable|
|opc_work_ui ([0124][m0124])|D display_name/pin/archive/delete 状态|item/profile 前；deleted=true 仅 UI 状态，不等于删内容|
|opc_account_ui ([0124][m0124])|D display_name|account/profile 前|
|opc_publication_ui ([0124][m0124])|D 发布日期/版本私有信息|item/profile 前；不代表删除第三方已发布内容|
|opc_account_strategy_drafts ([0125][m0125])|D source/account 绑定|draft/account/source versions/profile 前|
|opc_account_strategy_request_bases ([0126][m0126])|D step_versions|复合 FK opc_library_requests 前，immutable|
|modules ([0002][m0002],[0008][m0008],[0036][m0036],[0062][m0062],[0073][m0073])|P 平台定义；created_by SET NULL，不删模块|Skill/module 自引用 RESTRICT 不属于用户数据删除；清 audit 私文|
|prompts ([0002][m0002],[0004][m0004])|P 平台提示词；若有用户私有内容则 D|无 baseline CREATE/FK；必须补证作者/所有权|
|announcements ([0002][m0002],[0004][m0004])|P 平台公告；审计身份脱敏|基线 FK 未证实，不臆测 authors|
| ai_models ([0002][m0002]、[0014][m0014]) | P 模型共享配置；清误存私文 | 无完整基线定义；若有操作者引用，profile 清理前断开 |
| system_settings ([0002][m0002]) | P 共享系统配置；不保留用户内容 | 基线定义缺失，须补证；审计引用脱敏后保留配置 |
| credit_packages ([0002][m0002]、[0012][m0012]) | P 套餐定价；不是私人内容 | payment_orders 套餐引用保留；不因注销删除共享套餐 |
| membership_plans ([0002][m0002]、[0009][m0009]、[0012][m0012]) | P 会员共享配置 | 订阅引用保留；不因注销删除共享权益，基线仍须补证 |
| account_erasure_requests（PR-A 新增） | M 注销进度：请求 ID、阶段、时间、错误码、重试次数；不含正文、邮箱、文件名 | 引用 profiles（RESTRICT）；随财务占位到期、在 profiles 之前删除；存在时 profiles 的 status/is_deleted/deleted_at 不可回退 |
| opening_grant_identity_digests（[0151](../../../packages/db/migrations/0151_opening_grant_identity_digests.sql)，PR-E 新增） | E3 防刷：仅用途、类型、密钥版本、HMAC、首次开户赠送决定月份（UTC 月初）、到期条件；无原文，不用于画像 | 无账号 FK；独立于正文、Auth 身份和财务占位删除顺序，开户赠送规则取消后清除；仅 service_role 读取/经专用 RPC 写入，恢复服务前须保留防重事实 |


### A.1 可以据此实施的分阶段顺序

1. **封闭使用**：标记删除、停止新派发/上传/案例使用，列出全部关系与 JSON 来源，隔离未决最小证据；保留主体和财务链。所有后续操作可幂等续做，不能只记“已删除”而无失败进度。
2. **存储与叶子**：先保存临时对象清单并删对象，再清 UI、item_edits、strategy_request_bases、video_material_bindings、result_links、opc_turns、topic_openings、topic_workspaces、topic_draft_versions、handoffs、draft_businesses、strategy_drafts、work_references、slice_links、evidence_restrictions、history_dependencies；它们引用的父表尚在。
3. **内容关系**：opc_content_versions 的 source_content_id 后代先于祖先；然后 opc_items → opc_plans/opc_accounts → opc_businesses/opc_drafts。library_requests 等复合键父表在其子记录之后。单条删除保留独立下游时，改指无正文 tombstone/断开可空来源，不能删除整条独立作品链。
4. **Runtime**：history/batches/tool_calls → executions；先处理引用 execution 的 opc_result_links/content_versions。opc_turns/video bindings 后清 scope_material；所有 OPC session 引用处理并受限清空 bill2_runs.session_ref 后，才能删 sessions。active_execution 虽无声明 FK 也清空。
5. **旧对话/执行**：slice_calls 的财务证据先隔离并保留原调用身份，正文清后处理 slice_executions；chat_summaries → chat_turns → artifact_chats；conversation_context_snapshots 在 messages/conversations 前处理。ordinary_chat_requests 的未决原身份保留无正文壳，终态后才能最终脱离/删除 conversation。先消除 token_stats 的会话 CASCADE 风险，不能顺手抹掉消费。
6. **成果/研究**：token_stats/ai_usage_logs 对 generation 的引用受控脱链或保留财务壳；generations 清正文保留账务。其 candidate 关联处理后才能清 candidates；confirmations/requests/versions（所有 source_version 关系先处理）→ rounds；evidence 的 supersedes 后代先于祖先，引用解除后 → projects（source_project 自引用后代先）。research_operations 被 evidence 引用，先处理 evidence 后才能到期清 operations → plans。仍有未决财务时保留无正文父壳，不靠删父解决未决。
7. **账号**：清测试窗口中的本 actor（最后一人按 §4 停用），保留窗口预算链；清工单（对象 → replies → tickets）、行为/应用日志、签到、邀请码（records/奖励脱敏 → invitations）、共享配置操作者引用。profiles 财务占位保留，Auth 关系按 §3.3 解除后用 Auth API 删登录。包含他人邀请奖励/共享配置时只清本人的身份，不误删他人账项。
8. **财务到期（另一时间点）**：完成核对并到 `T_fin` 后，先处理 runtime/legacy 留存壳和 usage/ledger 对 run 的引用；receipts/provider_ids → calls → runs → billing_history。PAY-COMMON 映射及 grant/退款对订单、订阅的依赖先清；子订单先于原始父订单，订单先于关联订阅。subscription_credit_grants、billing_history 对 credit_transactions 的引用先清/脱链再删流水；依赖 payment_orders/subscription 的行先处理；最后才删不再被引用的 profiles。未满足保留期的行继续留，无正文且不可消费；不能先删 profile 触发 [0001][m0001]/[0012][m0012]/[0045][m0045] 的财务 CASCADE。

这是约束依赖顺序，不是可直接复制执行的 SQL。基线缺失部分须 T01 补证再生成完整拓扑；循环/不能断开的关系用无正文壳而非关约束。当前 no-action FK、immutable guard、NOT NULL/CHECK 需同一实现方案处理，测试实际行数与拒绝读取。

## 附录 B：存储桶、日志与数据库外副本

迁移范围没有 `storage.buckets` / `storage.objects` 建表或建桶记录，也没有 SMTP、外部日志平台、备份套餐的部署事实。以下是**须覆盖的对象及拟定处理**，不把文档提到的名字说成已由迁移证实。实施 PR 在允许范围内补完整仓库定义/非生产证据；不能让 Owner 搬运技术清单。

| 项目／仓库证据 | 处理与理由 | 顺序／期限 |
| --- | --- | --- |
| 工单附件桶：Master Plan §5.1 提及 `ticket-attachments`；迁移只见 [0010][m0010] 的附件列，桶定义缺失 | 删除用户工单涉及的对象、缩略图和复制件；不只删附件 JSON | 冻结新签名/上传 → 保留临时对象清单 → Storage API 删对象并核验 → 清 replies/tickets 的附件指针；`T_online` |
| 头像对象：迁移中无桶定义，profiles 基线定义缺失 | 删除头像及派生缓存；不假定桶叫 avatars | 清对象后清 profile 路径；已签名地址按实际最长有效期控制，删除后不能重新上传同一路径 |
| 资料库、语料、未来生成媒体：LIBRARY-VOICE 规划对象，当前迁移无新文件表/桶 | 删除原文件、提取文字、目录/分段、索引/向量（以后若有）、临时上传和全部画像；共享桶本身保留 | 先撤销读写/任务，再对象及其衍生副本，确认后释放存储占用，最后删登记；过期上传即使用户不再登录也须补清 |
| Skill 包存储：[0064][m0064]、[0072][m0072] 实际定义 DB 文件 bytes，不证明有独立桶 | 系统 Skill 字节保留；私有用户上传内容若进入包则清该内容和副本 | 按附录 A 的 package/file/revision 约束处理，不误删平台共享包 |
| `application_logs`、`user_activity_logs`：[0006][m0006]、[0002][m0002]；diagnostic_results：[0005][m0005]；job summary：[0017][m0017] | 删除用户 message/context/details/error/行为数据；去 user_id 不够，仍要扫 request/run 关联与正文 | 在删除财务关联索引前定位所有副本；`T_online` 清可定位内容，普通无正文排障字段最多 `T_log`。0006 的 30 天清理函数和 0004 软删清理默认 30 天不是批准依据，也不证明实际运行；本轮期限来自 E7 |
| 计时记录：diagnostic_results.latency_ms [0005][m0005]；ai_usage_logs.latency_ms [0001][m0001]；dispatch/created 时点 [0105][m0105] | 首字、SDK、工具耗时若带 request/actor，删除关联或按短期日志处理；仅对账所需派发/完成时点入财务白名单；不可反推个人的汇总统计可保留 | 不把全量请求 trace 当账单留 3 年；外部计时 sink 未由迁移定义，须查明后归入同一清单 |
| Vercel stdout、错误追踪、SDK trace、日志转存：迁移无投递定义；ENGINEERING 列 pino/Sentry/Vercel Analytics | 写入前不带私有正文、姓名、邮箱、完整 URL/请求头；已有可定位事件在可控端删除；外部不能逐条删时提出删除请求并记录窗口 | 与应用内容同时停写；实际 sink/保留期待核验，[S7/S11] 仅证明供应商通用说明，不能推定已启用 |
| Redis/缓存、浏览器本地存储、下载/导出缓存：迁移无定义 | 删除本方可控的会话/内容缓存与关联键；多标签页失效，离线重连先验证删除状态；删除操作不能清别人的键 | 先拦读取/写回再清缓存；用户已经下载到自己设备或发到外部的副本不在我方可删除范围，界面不能声称撤回所有副本 |
| DB/PITR/对象备份、手动导出：迁移无套餐/保留配置 | 按 §8 到期清除，不因备份恢复重新开放已删内容 | 删除清单晚于最后一份含内容备份过期；[S8]。不删除整个项目来满足单用户注销 |
| Auth 系统表（含身份、会话/token）：本仓库迁移没有 Auth 系统表及 profiles→auth.users 的完整定义 | 用平台管理接口删除登录身份；不直接 SQL 猜测删除平台内部表。授权与现存 JWT 均需应用实时阻断 | 对象所有权、业务和财务依赖处理后删除 Auth；[S8] 说明删用户不能假定旧 JWT 立刻无效 |

## 附录 C：第三方逐项处理、官方事实与限制

本轮只读取下列**公开官方页面**，未登录或调用第三方业务 API。数据流为本任务必须覆盖的设计范围，不宣称已核实供应商账号设置。第三方没有本库外键，顺序统一是：**阻止新发送 → 保留必要对账编号 → 清本方副本 → 在可用的官方渠道申请/执行删除 → 记录已确认、未确认、保留例外及期限**；不是删 Graylum 记录就等于删了对方数据。删除单个最终用户不删除 Graylum 的商户/供应商总账号。

| 对象 | 官方说明（2026-09-28—29 读取） | 我们的处理、理由和不能承诺的部分 |
| --- | --- | --- |
| OpenRouter | 默认不启用私有输入/输出日志；仍有用量/延迟等元数据。路由端点各自有数据政策；不训练与 ZDR 是不同限制，[S1] | 删本方提示词/回答与缓存，财务只留调用 ID/成本；停止新发送。若启用可存储功能须纳入单独删除清单。不把本项目配置说成已验证 ZDR，不能保证删掉供应商留存 |
| 经 OpenRouter 的模型托管供应商 | OpenRouter 按具体 endpoint 记录政策，供应商通用政策可能与端点协议不同；无法确认时其按保留/训练保守标记，[S1] | 每次调用保存不含正文的 provider/endpoint/政策版本索引；RUNTIME-PROD 为每个启用端点补其官方政策 URL、读取日期、期限和删除联系渠道。按 E10 统一准入，不因非 ZDR 另设产品分支或再次审批；不按模型名字套同一保留期，也不能删除已在外部合法保留的日志 |
| TikHub | 其隐私政策列 API usage logs 12 个月、账号终止后资料 90 天、支付记录 7 年，删除存在保留例外，[S2] | 本方查询/URL/返回证据全删，费用/调用编号最小保留。按官方联系渠道申请相关日志删除；这些期限针对 TikHub 的客户数据，不能推成“Graylum 用户注销后 TikHub 90 天必清”，也不能删除原社媒平台上的公开内容 |
| Parallel | Search 产品页标示 ZDR/no training；隐私政策对账号、联系/IP 等数据另按业务必要性保留，未给统一固定天数，[S3] | 清本方 query/objective、来源 URL、结果片段和副本，账务 usage 单列；核实所用 Search 线路的适用范围。不能把 Search 的 ZDR 扩展为账号/支持/计费数据也不留 |
| Firecrawl | 隐私政策称 PII 一般保留至书面删除请求，未公布循环清理期限；企业页面另说明 Zero Day Retention，[S4] | 清本方抓取 URL、结果、截图/导出、缓存；必要时申请删除。企业能力不等于本项目已享有 ZDR，不推定普通接口自动清除或远程请求必成功 |
| Waffo | 按用途、适用期限及争议保留；相关期限后额外两个月，活动系统删除后部分备份最多 90 天；可申请提前删除但有例外，[S5] | 原渠道处理订阅/退款后删非必要客户字段并申请删除；本方仅留交易/收据/退款最少字段。MoR 方保留不能由我方直接删除；无统一可承诺年限 |
| Stripe | 官方允许提出个人数据删除请求，同时说明支付监管等原因可能继续保留部分记录，[S6] | 按原交易渠道核对、取消/退款及删除可删除客户字段，交易最小证据按 `T_fin`；不为注销直接删除商户账号。不能承诺抹掉其支付记录或持卡人邮箱副本 |
| 邮件服务（实际 SMTP 商未由迁移定义） | Supabase 支持任意兼容 SMTP 服务，公开说明不能证明本项目选了谁，[S9] | 清本方收件人、投递队列/模板变量/日志正文；最后必要通知只含进度事实，发送后清地址。已送到用户邮箱的邮件我方不能撤回；启用前补实际商官方删除和留存说明，期限未证实不能算完成 |
| Vercel | Runtime 日志公开窗口因套餐不同：Hobby 1 小时、Pro 1 天、Enterprise 3 天，Observability Plus 30 天；不是本项目配置证据，[S7] | 停正文日志/URL 泄露，清可控缓存/导出；托管日志或转存逐项申请删除/等待确认窗口。网站内容删除不等于旧部署日志清除 |
| Supabase | DB 备份与 Storage 对象独立；Storage SQL 元数据删除不会删除底层文件，须 Storage API；删 Auth 用户后已有 JWT 可仍有效到过期，[S8] | 按附录 A/B 处理 DB/Auth/对象，再等待备份过期；应用实时拒绝旧身份。不能直接 SQL 删 storage.objects 充当清文件，不假设删 Auth 会清全部业务表 |
| 条件项：Sentry、Analytics、Redis/Upstash、SDK tracing、Log Drains | 工程规范列监控/限流工具，但迁移不定义其实际投递；Vercel Analytics 默认聚合及 session hash 24 小时，不等于自定义字段都匿名；Sentry 官方列部分备份可到 90 天，[S11] | 若有实际投递，逐接收方补官方期限/删除方法；本方可控键/事件删，必要审计字段短期留。超过 E7 目标窗口须明示并由 Owner 决定；不凭工具存在断言已经发送用户内容 |

所有对外删除操作都要有不含正文的关联编号、申请时间、对方回复/期限与结果；未收到确认写“待第三方处理”，不能写 PASS。无公开逐用户删除 API 不等于“法律上无需删除”，只记录能力未知并走官方联系渠道。本文不授权发送邮件、改供应商保留设置或关闭账号。

### 官方来源索引

以下来源于 **2026-09-28—29 读取**。只转述官方事实，不判断哪些法律适用于 Graylum。

- **[S1]** OpenRouter：[Data Collection](https://openrouter.ai/docs/guides/privacy/data-collection)、[Provider Logging](https://openrouter.ai/docs/guides/privacy/provider-logging)、[ZDR](https://openrouter.ai/docs/guides/features/zdr)、[ZDR 的边界说明](https://openrouter.ai/blog/insights/zero-data-retention/)。端点政策可能不同，不能用不训练替代不留存。
- **[S2]** TikHub：[Privacy Policy §6、§8](https://docs.tikhub.io/5508543m0)。公开分类保留期及删除申请例外；不是 Graylum 自身期限。
- **[S3]** Parallel：[Search](https://parallel.ai/products/search)、[Privacy Policy / Data Retention](https://parallel.ai/privacy-policy)。区分搜索内容与账号、IP、支持资料。
- **[S4]** Firecrawl：[Privacy Policy §6、§8](https://www.firecrawl.dev/privacy-policy)、[Enterprise](https://www.firecrawl.dev/enterprise)。通用 PII 请求删除与企业 ZDR 不可混同。
- **[S5]** Waffo：[Privacy Policy §7、§10](https://www.waffo.ai/privacy)。用途/争议期限、备份和提前删除限制；不据此替 Owner 决定期限。
- **[S6]** Stripe：[删除个人资料说明](https://support.stripe.com/questions/i-would-like-to-delete-the-information-stripe-has-collected-from-me?locale=en-GB)、[Privacy Portal](https://privacy.stripe.com/privacy/home)。数据删除申请不保证所有交易记录立即删除。
- **[S7]** Vercel：[Runtime Logs / Limits](https://vercel.com/docs/logs/runtime)。实际套餐、Log Drains 和其他遥测须另证，日志可见窗口不证明所有内部副本同期销毁。
- **[S8]** Supabase：[Backups](https://supabase.com/docs/guides/platform/backups)（每日 Pro/Team/Enterprise 可访问窗口 7/14/30 天，PITR 另有 7/14/28 天选择）、[Storage Schema](https://supabase.com/docs/guides/storage/schema/design)、[Managing User Data](https://supabase.com/docs/guides/auth/managing-user-data)、[日志访问窗口](https://supabase.com/docs/guides/troubleshooting/check-usage-for-monthly-active-users-mau-MwZaBs)（Free/Pro/Team/Enterprise 为 1/7/28/90 天）。访问窗口不等于平台所有副本的销毁保证。
- **[S9]** Supabase：[Custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp)。只能确认平台支持的方式，不能确认本项目邮件商/实际保留期限。
- **[S10]** IRS：[How long should I keep records?](https://www.irs.gov/businesses/small-businesses-self-employed/how-long-should-i-keep-records)。期限随记录和情形变化，不能由本文作本项目法律适用判断。
- **[S11]** Vercel：[Analytics Privacy](https://vercel.com/docs/analytics/privacy-policy)；Sentry：[备份与保留说明](https://www.sentry.help/en/articles/13965019-how-frequently-is-data-backed-up)；Upstash：[Privacy Policy](https://upstash.com/trust/privacy.pdf)。仅为条件使用项的公开依据，不证明本项目启用；上线前须补实际配置证据。

### 迁移文件索引

[m0001]: ../../../packages/db/migrations/0001_ai_billing_tables.sql
[m0002]: ../../../packages/db/migrations/0002_enable_rls_all_tables.sql
[m0004]: ../../../packages/db/migrations/0004_recursive_summary_and_soft_delete.sql
[m0005]: ../../../packages/db/migrations/0005_diagnostics.sql
[m0006]: ../../../packages/db/migrations/0006_application_logs.sql
[m0008]: ../../../packages/db/migrations/0008_modules_schema_update.sql
[m0009]: ../../../packages/db/migrations/0009_context_length_limit.sql
[m0010]: ../../../packages/db/migrations/0010_ticket_auto_close_supabase_cron.sql
[m0012]: ../../../packages/db/migrations/0012_stripe_payments.sql
[m0013]: ../../../packages/db/migrations/0013_checkin_rewards.sql
[m0014]: ../../../packages/db/migrations/0014_ai_runtime_closure.sql
[m0017]: ../../../packages/db/migrations/0017_scheduled_job_runs.sql
[m0018a]: ../../../packages/db/migrations/0018_payment_fulfillment_atomicity.sql
[m0018b]: ../../../packages/db/migrations/0018_rls_text_flags_and_job_runs.sql
[m0019]: ../../../packages/db/migrations/0019_public_route_rls_hardening.sql
[m0020]: ../../../packages/db/migrations/0020_admin_query_indexes.sql
[m0024]: ../../../packages/db/migrations/0024_atomic_apply_credit_ledger_entry.sql
[m0025]: ../../../packages/db/migrations/0025_atomic_claim_invitation_code.sql
[m0026]: ../../../packages/db/migrations/0026_atomic_apply_invitation_rebate.sql
[m0027]: ../../../packages/db/migrations/0027_balance_write_surface_lockdown.sql
[m0028]: ../../../packages/db/migrations/0028_restore_staging_helper_functions.sql
[m0036]: ../../../packages/db/migrations/0036_public_module_display_fields.sql
[m0037]: ../../../packages/db/migrations/0037_preserve_subscription_status_on_invoice_fulfillment.sql
[m0041]: ../../../packages/db/migrations/0041_stripe_refund_reconciliation.sql
[m0042]: ../../../packages/db/migrations/0042_canceled_subscription_profile_downgrade.sql
[m0043]: ../../../packages/db/migrations/0043_payment_order_status_machine.sql
[m0044]: ../../../packages/db/migrations/0044_credit_transactions_v2_semantics.sql
[m0045]: ../../../packages/db/migrations/0045_subscription_credit_grants.sql
[m0048]: ../../../packages/db/migrations/0048_restore_staging_baseline_objects.sql
[m0051]: ../../../packages/db/migrations/0051_auth_opening_grant_profile_defaults.sql
[m0052]: ../../../packages/db/migrations/0052_year1_annual_calendar_period_keys.sql
[m0053]: ../../../packages/db/migrations/0053_refund_1b_consumed_amount_termination.sql
[m0057]: ../../../packages/db/migrations/0057_refund_1b_actual_refund_accounting_repair.sql
[m0058]: ../../../packages/db/migrations/0058_refund_1b_canonical_metadata_merge_repair.sql
[m0059]: ../../../packages/db/migrations/0059_refund_1b_failure_period_metadata_repair.sql
[m0060]: ../../../packages/db/migrations/0060_refund_1b_post_merge_forward_repair.sql
[m0061]: ../../../packages/db/migrations/0061_refund_1b_expired_quarantine_repair.sql
[m0062]: ../../../packages/db/migrations/0062_skill_1a_db_publish_contract.sql
[m0064]: ../../../packages/db/migrations/0064_v3_private_skill_packages.sql
[m0065]: ../../../packages/db/migrations/0065_v3_research_operations.sql
[m0066]: ../../../packages/db/migrations/0066_v3_artifact_transactions.sql
[m0067]: ../../../packages/db/migrations/0067_v3_workbench_queries.sql
[m0068]: ../../../packages/db/migrations/0068_v3_workbench_generation.sql
[m0069]: ../../../packages/db/migrations/0069_v3_chat_skill.sql
[m0070]: ../../../packages/db/migrations/0070_v3_separate_summary.sql
[m0071]: ../../../packages/db/migrations/0071_v3_research_billing.sql
[m0072]: ../../../packages/db/migrations/0072_v3_admin_skill_modules.sql
[m0073]: ../../../packages/db/migrations/0073_admin_management_write_grants.sql
[m0077]: ../../../packages/db/migrations/0077_workbench_provider_rejection.sql
[m0078]: ../../../packages/db/migrations/0078_ordinary_chat_requests.sql
[m0080]: ../../../packages/db/migrations/0080_account_artifact_reuse.sql
[m0081]: ../../../packages/db/migrations/0081_agent_slice_preferences.sql
[m0082]: ../../../packages/db/migrations/0082_agent_slice_artifact_links.sql
[m0083]: ../../../packages/db/migrations/0083_agent_slice_execution_identity.sql
[m0084]: ../../../packages/db/migrations/0084_agent_slice_call_accounting.sql
[m0085]: ../../../packages/db/migrations/0085_agent_slice_summary_identity.sql
[m0091]: ../../../packages/db/migrations/0091_agent_slice_entry.sql
[m0094]: ../../../packages/db/migrations/0094_agent_slice_discussion_context.sql
[m0096]: ../../../packages/db/migrations/0096_agent_slice_bounded_unavailable.sql
[m0099]: ../../../packages/db/migrations/0099_agent_slice_rejected_result_usage.sql
[m0104]: ../../../packages/db/migrations/0104_workbench_provider_observations.sql
[m0105]: ../../../packages/db/migrations/0105_v3_bill2_authoritative_runs.sql
[m0106]: ../../../packages/db/migrations/0106_runtime_sessions.sql
[m0107]: ../../../packages/db/migrations/0107_opc_workbench.sql
[m0108]: ../../../packages/db/migrations/0108_runtime_staging_window.sql
[m0113]: ../../../packages/db/migrations/0113_opc_topic_workspace.sql
[m0114]: ../../../packages/db/migrations/0114_opc_topic_consent.sql
[m0117]: ../../../packages/db/migrations/0117_opc_core_experience.sql
[m0119]: ../../../packages/db/migrations/0119_opc_video_admission.sql
[m0122]: ../../../packages/db/migrations/0122_opc_content_type.sql
[m0123]: ../../../packages/db/migrations/0123_opc_manual_content.sql
[m0124]: ../../../packages/db/migrations/0124_opc_workspace_ui.sql
[m0125]: ../../../packages/db/migrations/0125_opc_account_strategy.sql
[m0126]: ../../../packages/db/migrations/0126_opc_account_strategy_schema.sql
[m0128]: ../../../packages/db/migrations/0128_opc_script_ancestry.sql
[m0130]: ../../../packages/db/migrations/0130_runtime_conversations.sql
[m0132]: ../../../packages/db/migrations/0132_opc_video_execution_ancestry.sql
[m0136]: ../../../packages/db/migrations/0136_runtime_truncation_diagnostic.sql
[m0137]: ../../../packages/db/migrations/0137_bill2_unstarted_dispatch.sql
