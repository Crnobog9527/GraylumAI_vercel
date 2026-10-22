# PAY-FAILOVER 本地验证证据（最终数据库重验：2026-10-22）

Owner当前排号：PAY-FAILOVER迁移为0335，已同步#1240/0333注销清理优化、#1239/0334恢复及#1236退款显示改动。下列数据库机器结果已按真实前置完整重验；此前0331/0332/0333版本的旧计数不代替本轮0335结果。

在注销相关函数中，0335只扩展付款请求擦除封装，不覆盖0333的owned Runtime选择谓词；新增的注销套件对清理与财务保留作实际验证。0334除新增恢复RPC，还补丁修改`runtime_admit`、`opc_step_material`的organizer门禁；0335未覆盖它们。完整本地库只读查询确认这些定义与0332定位门禁的`VOLATILE`模式均保留（`/tmp/pay-failover-0335-final-scope.log`）。本轮无需SQL或测试兼容修复。

本证据均使用本机隔离的 PostgreSQL、明确模拟的供应商事实或本地 fixture 浏览器，不包含远程数据库操作、商户后台设置、真实付款或分支部署。

- `baseline.json`：最终空库338/338；269个历史迁移在各自位置重复无结构变化；2700个结构分组，account-open审计无缺漏；收敛重复不变，回撤演练恢复、清理通过。已执行`--write-built`，最终指纹与合并后的文件一致，无额外差异。
- `database.json`：最终0335的50项集成用例通过，包含双向渠道/权限审计、并发幂等、未知与迟到现金、未来接续、50创始名额、原渠道退款、真实部分和未知拒付、注销归属。另覆盖退款后拒付不重复回收，以及旧建单接口无法绕过渠道锁；此前税契约断言先红后绿：Waffo inclusive，Stripe exclusive。
- `upgrade-compatibility.json`：最终91项升级、钱包、测试时钟与恢复用例通过，含新增大陆卡测试时钟12项；旧Stripe自动续费、钱包接续与恢复保留。该runner顺序启动独立PAY-FAILOVER测试库，以上50项无需重复单跑。
- `waffo-compatibility.json`：最终105项旧Waffo兼容用例通过；在已有旧付款与订阅数据上应用后续迁移，并逐个验证重复执行结构不变。
- `erasure-compatibility.json`：默认完整模式的28组检查通过，建库338/338、269个历史迁移重复、清理成功。包含真实processor/service-role组合、业务正文清理、未知财务阻止删除、资金/账务身份保留，以及64个大正文跨账户canary的owned Runtime清理、绑定保留与幂等。旧Waffo订阅的live形状继续拒绝；新Waffo一次性test/live封装另由上述50项覆盖。
- 商品映射最终11项通过，含12条完整关联/金额、幂等、冲突整批回滚、test限定及旧订阅/live/Stripe/settings不变，机器证据见[商品映射验证](../pay-failover-products-20261022/mapping-validation.json)。该验证仅在隔离本地库执行，未向staging写入映射。
- 历史API全量回归：548文件通过、3文件跳过；8424用例通过、19用例跳过。之后商品目录在Stripe离线时仍可显示的增量测试单独回归；这些旧API数字不作为本轮最终全量结果，CI须覆盖最终提交。
- Waffo provider定向：136用例通过；一次性退款adapter 29用例通过；本地UI及fixture浏览器另有独立定向回归。不同套件存在重叠，不累加成商户实测。
- 独立人工/Agent审查：商品错价、未查款本地超时释放、部分拒付记成全额、退款claim后派发前读取中断等具体P1均已修正并复核。最终机器人仍需覆盖实际提交。

此前0332验证曾暴露一个夹具顺序错误：全库小批次到期清理按随机用户ID排序，管理员覆盖尚未建立的用户可能已被正确降为Free，随后测试却要求保持Gold。修复仅把既有覆盖夹具移到清理前，增加Gold起始前置断言，保留全部原断言；同一105项重跑通过。失败日志`/tmp/pay-failover-0332-final-waffo-compat-red.log`保留，不涉及业务SQL修改。此前0333及本轮0335均无需进一步修改，105项再次通过。最终命令日志为`/tmp/pay-failover-0335-final-{baseline,upgrade,waffo-compat,mapping,erasure,scope}.log`。注销日志首部的`synthetic timeout`为套件注入的Auth不确定场景，最终退出码0、`failed=null`。

此前退款成功后的每日对账不再误报，退款强匹配/差额/未知与退款后拒付共20项通过，cron14项通过。失败退款恢复积分仅是数据库模拟收口；供应商失败是否永不迟到成功并无足够证据，实际失败/未知退款保持人工核对，不自动恢复或重发。

staging银行卡付款/会员及积分开通/退款/切回Stripe：NOT_RUN。支付宝真实付款：NOT_RUN，且须上线后Owner另行批准。12个测试商品已由主窗口独立创建并回读，见商品证据；数据库映射应用与部署仍由总控按实施文档处理，不能用本证据代替。

机器人审查后的修订：Waffo会员入口按一次性商品映射判断，旧全局渠道不再影响新会员购买；内部会员事实区分一次性与旧订阅，避免误要求恢复续费。相关API 3套157项通过；Waffo旧订阅兼容105项通过；PostgREST带时区的付款时间及退款后拒付定向20项通过。API/Web类型与本轮修改文件lint通过。50项新数据库回归已接入必需计费集成CI，使用独立测试库顺序运行；最终CI/机器人结论见PR最新交接。

此前UI P2由主窗口独立验证：先红2项，修复后34项通过；API/Web类型检查及本轮UI文件lint退出码均为0。这些结果与上述最终数据库回放分别记录，不合并计算成付款或浏览器验收。

本轮合并兼容由主窗口独立验证：`SubscriptionCard.test.tsx`与`paywall/methodCheckout.test.ts`共64项通过，包含本地Chromium fixture（`/tmp/pay-failover-0335-ui-compat.log`）。provider执行窗口独立只读复核合并API未发现新增P0/P1/P2，`methodMembership.test.ts`及`methodMembership.testClock.test.ts`共30项通过。主窗口API/Web类型检查及冲突测试文件lint均退出0（`/tmp/pay-failover-0335-{api-types,web-types,ui-lint}.log`）。以上不代表staging商户付款验收。
