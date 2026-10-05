# BILL-PAYG profile 执行器交接（仅准备）

**采样计划和执行器完成，等待审查后执行。** 本轮 0 次付费请求、0 远端数据库访问、0 环境配置写入。
本页不是执行批准；必须先收到主窗口对本 PR 最终版本和 manifest 的审阅通过及执行通知。

## 入口

使用已批准测试余额的凭据，仅通过进程环境 `GRAYLUM_PAYG_TEST_OPENROUTER_KEY` 注入。
执行器不读项目 env 文件、不回退到生产凭据、不查询或充值余额、不改任何 OpenRouter 设置。
凭据选择必须由执行窗口核实属于 Owner 批准的测试余额；环境变量名本身不证明归属。
没有足够余额时报错停止，不改用另一凭据。

批准后，从本 PR 工作区执行（下列命令在第一步没有运行）：

```bash
node scripts/payg-profile-execute.mjs execute-approved \
  scripts/payg-profile/plan-prices.json \
  docs/launch/evidence/payg-profile-20261005.manifest.json \
  4289cffc98ac5fda57b46e93e8a7e3d083b30ab71223428a961d118593bad9c5 \
  owner-approved-test-balance-only
```

入口重新生成全部请求和清单，与已批准 manifest 整体深比较；任何请求、价格、上限或样本顺序变化均拒绝。
每条发送前重新 GET 精确模型 endpoint 目录，与冻结目录比较全部价格层和能力；漂移后须重新预演/审阅，不能继续。
本地费用计算复用 openRouterCallBound，发送和查账复用现有 openRouterAdapter/openRouterEvidence；
无 SDK 自动重试、无 fallback、固定 OpenRouter URL、禁止重定向。工具样本只带合成历史，不执行真实工具。

## 持久材料与停机

材料固定存入用户主目录的 `.local/state/graylum/payg-profile/<manifestHash>/`，目录 0700、文件 0600：

- `attempted.lock`：排他创建并同步，保证同一清单重复启动拒绝。**不要删除它来重跑。**
- `events.jsonl`：发送前同步记录 sampleId、requestHash、费用预留；每次查账前记录原 ID 和查账次数。
- `*.private.json`：真实 transport 回执和原始字节，仅本机保存，禁止整份上传 PR。
- `report.json`：返回时的结构化逐样本判定、费用和已知/未知总额；异常退出时以事件日志为准。

请求的费用预留只增加，不把便宜样本的余额转给后面的样本；每条预留为清单 upperUsd。
POST 最多一次；超时/断线无原 ID 时保留未知费用并停止，不能推断未收费。
有原 ID 但缺用量/费用/线路时最多 GET 三次，不重新发 POST、不更换 ID。
出现身份/费用/token 冲突、超费用/输出边界或不合格样本即停，未执行样本保留未执行，不补跑凑满。
进程重启、磁盘写失败和人工中止都不会自动续发。先审计已有事件及回执，再交主窗口处理。

查账和 response 的成本必须一致；P 用原生总 prompt token，缓存读写不从 P 扣除。
实际总额为已确认样本费用的精确十进制和；任一已尝试样本费用未知时 actualUsd=null，另报 knownUsd。
缓存字段缺失保持 null。输出压力需核对 finishReason、outputCapReached 和 reasoning 用量；
“未超界”不等于“已触及并证明 8192 的输出边界”。

## 公开报告与配置建议

只公开每条 sampleId、请求/回执 hash、B/P/rB/rT、实际费用、合格/失败/未知及总花费；
不要上传原始正文、思考正文、请求头、任何凭据、账号或邮箱；原 generation ID 留在本机材料里供查账。
对 manifest 中没尝试的条目明确标 NOT_RUN，对已尝试但缺证据的条目标 UNKNOWN，不能混作 0。
结果必须对照 [预演验收标准](BILL_PAYG_PROFILE_DRY_RUN.md)，不能扩大上界让样本通过。

第二步才根据完整合格格子提出 profile JSON 建议：只列被实测的 model/tag、reasoning wire、O 和消息容量；
填入真实 manifest/证据引用、缓存及多消息摘要、有效期。缺任何材料不生成可启用 profile。
本 PR 不访问 system_settings、不应用迁移、不打开开关；最终由主窗口在获准 staging 窗口处理。

## 兼容与恢复

0172 仅将 SQL 校验的全局消息硬限从 32 放到 128，仍取它与每个旧请求冻结 maxMessages 的较小值。
32 条旧执行不受放宽；无数据重写、新表、权限变化。开启新 profile 前必须先完成迁移，不能仅设置开关。
有活动 128 条执行时，恢复方式是关闭新准入并完成旧执行；不直接回退 SQL 上限造成在途执行拒绝。
