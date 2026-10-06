# 定位清单与导师联动（后端）

2026-10-07 本任务 Owner 决定：导师每轮能看到右侧已填内容；右侧改完后显示“让导师接着聊”，由用户点击才触发；保存流程提速。前端由独立任务交付，本 PR 不修改 apps/web。决定在 Master Plan 的汇总由主窗口统一处理，避免与正在修改该文件的任务交叉写入。

## 前端接口

保存仍调用 `opc.information`，参数不变。成功返回 `{version, values}`，values 是此次成功写入的完整步骤字段对象；每项为 `{value, status, nature}`。旧 requestId 重试返回原先那次的版本和值，即使此后已发生别的保存也不返回新状态。前端可用返回值更新当前步骤缓存，但不得用较旧版本覆盖较新的缓存；整个步骤确认、派生结果有效性仍遵循原有读取规则。

点击“让导师接着聊”时，从 `@repo/api/src/shared/opcQuestions` 导入 `checklistUpdatedInput(fieldIds)`，把返回字符串作为普通 `opc.mentorTurnStream` 的 input，purpose 为 mentor；沿用当前 draftId/stepId 和普通发送的 requestId、organizeAfter 等参数。fieldIds 是当前步骤内已成功保存的字段 id（1–100 个、不能重复），不能传字段值。按钮每次明确点击生成新的 requestId；网络重试必须保留原 requestId 及原字段列表。不要传 answerSource，不使用 openingRequestId。后端不会因保存自动调用导师。

通知只说明用户点击后报告的变更列表，不伪造逐字段变更审计。服务端从冻结的步骤内容读取真实当前值，拒绝未知字段。导师确认收到后依据已填内容追问缺口，已确认内容不擅自改写。附带整理仍走普通准入与计费，但该事件没有用户原话：organizer 的 userInput 为空、hostEvent.kind 为 checklist_updated；数据库拒绝该事件的用户事实、user_statement 和通知标记补丁（记录 host_checklist_updated）；只允许向 Skill 明确声明的 agent_proposal 字段整理导师本轮具体建议，仍遵守原有保护字段/待采纳建议规则。

## 数据与容量边界

hostTurnContext 的每个字段携带 value、nature、basis、source、protected、hasPendingSuggestion。source=user 的手填内容标为 user_statement，仍保留 nature 中的不确定性。历史来源不明的字段标 unknown，不臆测来源。待采纳建议只提供布尔标记，不把建议作为用户已采纳的值。

数据全部来自 opc_step_material 后的冻结投影。新增元数据不进入稳定提示词前缀；旧执行重放仍使用原冻结内容。上限保持 16,000 UTF-8 字节：先省略 confirmed 字段值并标 valueOmitted，仍超限则在模型准入前拒绝。整理输入沿用现有压缩次序与限制；实际请求继续接受 Runtime/PAYG 的总输入字节检查，没有提高任何付费请求上限。

## 本机验证与迁移

0182 只替换已有函数，不添加表、RPC 家族、权限或配置。保存响应是向后兼容的附加字段；新增冻结元数据可被旧代码忽略。保留原有权限、项目锁和 requestId 比较。当前 staging 的下一迁移序号为 0182，仓库检查禁止跳号；与 #699 的另一个 0182 是并行 PR 的编号冲突，后合入者必须基于新 staging 重编号并重跑迁移检查，不能同时按原编号合入。built-fingerprint.json 是共享生成文件，本 PR 只包含本迁移对应函数条目，不能用本分支指纹覆盖其他迁移的条目。

所有数据库验证仅在一次性本机 Docker PostgreSQL 上执行。撤回时优先回退后端代码；额外响应字段与元数据无损兼容。若要撤回函数定义，应从应用前的数据库定义恢复这四个函数（opc_information、runtime_work_projection、opc_capture_apply、opc_historical_reach），保留已保存 values、版本、来源和请求记录；不执行早期 0159 整体回滚，也不删除业务数据。未执行任何远端迁移。

性能优化仅在历史遍历已达到全部字段时提前结束，不更改权限、字段顺序或返回值。不宣称定位了线上 1–3.4 秒的唯一原因：线上耗时还可能含认证、网络、数据库负载，当前任务禁止访问远端数据库。可复现实测结果见 Validation handoff。
