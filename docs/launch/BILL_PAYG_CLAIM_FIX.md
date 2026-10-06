# BILL-PAYG 首轮领取拒绝：配置缺失与诊断修复

风险：high（计费领取异常处理）。基于 staging `57b34f42`，对应
[#658 的失败证据](https://github.com/Crnobog9527/GraylumAI_vercel/pull/658#issuecomment-6011908907)。

## 根因与边界

2026-10-06 对 staging 两项系统设置作只读查询：`runtime_payg_staging` 已启用、含 3 个 profile，
但 `billing_payg_start_thresholds` 整项不存在。现有 SQL 在创建调用行、冻结积分之前返回
`BILL2_START_THRESHOLD_UNCONFIGURED`。服务层原先将此明确拒绝覆盖为
`BILL2_DATABASE_UNAVAILABLE`，宿主随后按派发前失败取消，未提供具体原因。

本机一次性数据库使用交付的 `payg-profile-final.json`（仅更新本地有效期）、
Sonnet 5.5 / anthropic / low、输出 8192、输入预算 90000、历史 100，附带
Luna / none、输出 2048、输入预算 64000。测试使用合成身份、价格和余额，不导入远端用户数据。
真实路由、合同、PostgREST 和 PostgreSQL 链路复现上述拒绝：无调用行、余额不变。
仅在本地夹具补齐合成门槛后，同一合同领取成功，重复领取返回同一个调用。
夹具中的 1 积分门槛不是 staging 推荐值，也不是已批准的门槛。

恢复 staging 调用需要主窗口核对既有门槛决定，并申请设置补齐批准；本任务不写远端设置。
本问题无需放宽 SQL 校验，也未提出数据库迁移。未修改正式环境、staging 配置或数据，未合并。

## 已保存的实现

- 保留白名单内的精确领取拒绝码；未知数据库错误继续隐藏原始内容。
- 日志只记录固定事件名和拒绝码，不记录身份、输入、数据库 detail 或 hint。
- 单测覆盖拒绝码保留、脱敏和拒绝后不发放派发能力。
- 数据库回归覆盖最终 profile 的缺门槛拒绝、零扣费和本地补齐后的领取幂等。

## Handoff

范围按 [主窗口评论](https://github.com/Crnobog9527/GraylumAI_vercel/pull/684#issuecomment-6012457118)
收窄为精确领取拒绝码、脱敏日志、单测、数据库回归和文档。`execute.ts` 不在本 PR 改动范围。
宿主可读错误提示已移出本 PR，待 #675 合并后作为后续小任务实施，不是本 PR 的未完成项。

- 已完成：复现、保留精确拒绝码、脱敏日志和数据库回归；未改变 SQL 计费校验。
- CI 修复：把一次生成两个离线采样批次的测试拆成逐批次测试，保持原时限和全部验证条件；
  每个批次仍完整重建并与已提交 manifest 比较，不访问模型。
- 验证：此前 26 条相关单测、API 类型检查、相关 ESLint、代码尺寸检查、差异格式检查通过；
  一次性数据库复现通过。最终完整 CI/Security 和独立审查仍待完成。
- 发现的问题：Secret Scan 扫描整个 PR 提交范围，较早提交的固定日志常量仍有误报；
  后续已改成可读文字，但仅增量扫描通过不足以证明全历史扫描通过。不得增加扫描豁免。
- 下一步：完成当前范围的 CI 修复、全套检查后转为 ready 并完成独立审查；不合并。
- 外部交接：staging 门槛设置由主窗口在 Owner 批准后处理；本次续办不访问远端数据库、不改配置。
  门槛补齐后的 [#658 验收](https://github.com/Crnobog9527/GraylumAI_vercel/pull/658#issuecomment-5990469067)
  由主窗口安排，不依赖本 PR 合并；本 PR 不宣称真实验收通过。
