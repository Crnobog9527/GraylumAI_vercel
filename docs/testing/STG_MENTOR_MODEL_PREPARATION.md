# STG-MENTOR-MODEL 准备记录：缓存请求被冻结产品拒绝

2026-10-01；仅离线准备及授权的只读核验；真实生成调用 0 次。
本轮停在产品写入边界，未完成全部 112 次 dry-run，不能请求 Owner 批准实测。

## 冻结依据与最小阻塞证据

已核验 [#497 冻结声明](https://github.com/Crnobog9527/GraylumAI_vercel/pull/497#issuecomment-5934332975)，
精确 SHA `f9afd0db7805e80ccc6f5b7023a3e87b5014f5bd`。
声明要求复用该版本产品入口、请求冻结和 BILL2 adapter；旧 probe 的三字段工具/另建 Runner
不能算作五字段或端到端验证。本任务没有写入 #497 工作区或分支。

在该 SHA 的实际模块上做无网络边界验证：
- 普通文本块请求通过 `openRouterAdapter.prepareDispatch`，不执行它返回的发送函数。
- 同一个请求只在文本块加入 `cache_control:{type:'ephemeral'}`，报 `BILL2_PROVIDER_REQUEST_DENIED`。
- 顶层 `cache_control` 也被同样拒绝。两个拒绝均发生在凭据回调和 transport 之前。
- 传入凭据是本地合成常量，全局 fetch 和 transport 均设为拒绝；真实 transport 调用数 0。

代码位置：冻结版 [adapter 顶层白名单](https://github.com/Crnobog9527/GraylumAI_vercel/blob/f9afd0db7805e80ccc6f5b7023a3e87b5014f5bd/packages/api/src/services/bill2/openRouterAdapter.ts#L23)
及 [文本块只允许 type/text](https://github.com/Crnobog9527/GraylumAI_vercel/blob/f9afd0db7805e80ccc6f5b7023a3e87b5014f5bd/packages/api/src/services/bill2/openRouterAdapter.ts#L145)。
它不是配置缺项：标记若在冻结前加入，adapter 拒绝；若在 adapter 之后偷偷加入，
发送字节不再等于冻结 requestHash 对应字节，不能声称满足冻结产品路径和 #553 计量绑定要求。

独立的 probe-only 缓存实验可以是另一个待审边界，但不能自行把它等同于冻结 BILL2 请求；
当前要求全部 112 次按冻结产品字节准备，因此没有用独立发送器绕过这个拒绝。
如总控要求缓存也经过该产品边界，需要 #497 writer 另行修正、审阅并重发冻结声明；
本任务遵守“需要改产品文件即停下报总控”，未修改 Runtime、adapter、提示词、工具契约或数据库。
请总控明确采用产品支持还是单列 probe-only 对照边界，再恢复依赖它的准备。

## 当前官方参数（只读公开目录，不是模型调用）

| 模型 / 完整 tag | 普通输入 / 输出 USD 每百万 token | 供应商最大输出 | 本方案输出 |
| --- | --- | ---: | ---: |
| `google/gemini-3.8-flash` / `google-vertex/global` | 0.75 / 3.75 | 65536 | 8192 |
| `anthropic/claude-sonnet-5.5` / `anthropic` | 2 / 10 | 128000 | 8192 |
| `openai/gpt-6-luna` / `openai` | 0.10 / 0.50 | 128000 | 2048 |

Sonnet 5.5 最小可缓存前缀是 **512 token**，已核对其当前官方型号页，未套用旧型号的 1024。
Sonnet 5 分钟缓存写入 $2.50/M、读取 $0.20/M；Luna 缓存写入 $0.125/M。
Gemini 当前目录仍标记 50% 折扣；涨价仍拒绝，不改本方案 max_price。
供应商最大输出是能力信息，不证明测试 Runtime 已部署或其用途/窗口交集已放行 8192。

来源：
[Sonnet 官方型号页](https://platform.claude.com/docs/en/models/sonnet-5-5/overview)、
[Sonnet 官方迁移说明](https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide)、
[Gemini endpoints](https://openrouter.ai/api/v1/models/google/gemini-3.8-flash/endpoints)、
[Sonnet endpoints](https://openrouter.ai/api/v1/models/anthropic/claude-sonnet-5.5/endpoints)、
[Luna endpoints](https://openrouter.ai/api/v1/models/openai/gpt-6-luna/endpoints)。

## 账本与额度（只读）

- 本机原账本调用数仍为 736，与方案此前记录相同。
- 读取了原账本金额字段；本轮核验前后账本全文件 hash 相同，次数和金额均未因本轮改变。
  先前方案未保留完整金额快照，不能据此证明自上轮方案至今的金额始终未变。
- 指定探测密钥经只读 `GET /api/v1/key` 检查，相对当前建议总额 $19.46：**不够**。
  不公开密钥、额度或余额，不修改密钥/额度；未调用生成、计 token 或其他模型接口。

## Dry-run 与预算结论

- PASS：冻结声明/实际 SHA 核验、官方报价/输出/缓存最小长度核验、无网络缓存拒绝重现、账本只读核对。
- BLOCKED：缓存标记不能通过冻结产品 adapter；测试密钥额度不够。
- NOT_RUN：全 112 次产品请求组装及逐条 B/T 计量、单次/分模型/总预留实测、真实 provider 验证。
  没有把先前按字节限额估算的 $19.201096 当作此次实测 dry-run 总额。
- 方案建议仍为最多 112 次/$19.46，未调次数/金额硬上限；**不是本轮 dry-run 确认的最终预算**。
- 第 5.1 节的部署生效、完整准备和完整 dry-run 条件尚未由本任务证实完成。
  现阶段不提供可立即使用的预算批准原话；原方案文字仅是待条件完成后填实际数字的模板。

后续先由总控处理缓存路径边界；恢复后继续全部请求组装、沿用 callBoundUsd 和原账本的离线预留，
按实际数字更新批准原话。真实两轮中的后续请求依赖先前模型回复，离线合成数据必须标明来源，
不能冒称其字节就是未来真实请求；真实执行仍须逐次重新测量 B 和预留，不补样本、不自动扩容。
