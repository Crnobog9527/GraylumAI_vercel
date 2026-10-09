# DATA-ERASURE D7 后端交接

实施中，风险 **high**：永久删除、本人权限、数据库和财务正文投影。依据
[DATA-ERASURE §5](../tasks/DATA-ERASURE.md) 及 MASTER_PLAN D7 / E1–E11。
本 PR 只改后端；不改前端，不使用浏览器，不访问远端数据库，不合并。
迁移改用 **0200**（#766 总控最新分配）；最终基线须包含先合并的 #768。

## 实施拆分

| 选择 | 清除 | 保留 |
| --- | --- | --- |
| 回答 `answer` | 原 execution 的回答、匹配结果、复制正文的 history/batch/tool、依赖执行快照、系统 capture 副本、非财务收据正文 | 用户提问、独立回答、独立保存成果 |
| 会话 `session` | 全部执行及提问、历史、工具、批次、scope/material、系统衍生副本 | 独立保存成果，来源不可再使用 |
| 成果 `artifact` | artifact project 家族的全部发布版本、round/candidate/confirmation、引用和请求缓存；其成果内容版本 | 其他独立成果和下游已保存正文 |
| 成果内容 `content` | 指定 opc_content_versions 所属 work_item + kind 家族的全部手动/正式/历史版本和系统快照 | 其他 kind 的独立正文；来源链失效 |

旧 `/chat` 按任务文档明确决定不新增单条删除入口，继续由注销覆盖。若未来物理删除消息，
仍须先删 context snapshots；本次保留无正文的不可恢复编号壳，不触发 FK SET NULL。

账务沿用现有 run/call/receipt 和 ledger 的财务白名单，保留金额、币种、用量、原调用/
交易编号、报价、幂等及结算事实；不退款、不重扣、不把未知结果改成免费或供应商故障。
必要账务保留期沿用既定规则。无法投影的财务证据返回 `review_required`，不能显示全部清理完成。

## 复用及安全边界

复用现有单向 `erased_at` 清理、BILL2 财务投影和 `runtime_financial_recovery`。
`bill2_erasure_closed` 保持原判定；仅原 run 的 `content_deleted_at` 授予受限清理权限。
内部返回 `contentDeleted`，不会把仍开放的账号错误标为 `accountClosed`。
四个现有根表增加删除时间；没有新队列、任务系统或账本。回答保留提问，所以其删除标记
不能直接等同于要求全部正文为空的旧 `erased_at`；整账号注销仍可继续清除提问。

预览与确认复用同一范围计算。确认锁定所属 profile/session/project 和原执行账务，
重新核对范围 hash；忙时整笔回滚。来源链、Runtime dependency、结构化 JSON 引用均参与清理。
读取/重放/派发拒绝已删除对象，父对象触发器阻止晚到子记录；流式返回前重新查删除状态，
但原调用继续完成财务收尾。不能撤回此前已发到客户端的字节，前端必须同步清缓存。

永久清除没有正文恢复回滚：缺陷采用前向修复，不能通过回退迁移恢复已删除内容。
在远端执行迁移前需要另行批准；发布必须先具备数据库接口再启用相应应用版本。

## 前端接口

均为已登录本人调用，身份由服务器取得，输入禁止 `actorId` 等额外字段。

- `account.contentErasurePreview` query：`{ kind, id }`。
- `account.contentErasureConfirm` mutation：`{ kind, id, previewHash, acknowledged: true }`。
- `kind` 为上表四个值，`id` 为相应 execution/session/project/content UUID。
- preview：`{ kind, id, alreadyDeleted, affectedExecutions, preservedSavedVersions,
  affectedSources: [{kind: account|work_item|reference|content, id}], previewHash }`。
  影响列表只含本人对象编号，前端结合已有项目名称展示；不是私有正文导出接口。
- confirm：`{ kind, id, status: deleted|review_required, alreadyDeleted,
  preservedSavedVersions, financialReviewCount }`。
- 重复确认返回 `alreadyDeleted: true`；不会生成新付费执行。

| message | tRPC code | 展示/动作 |
| --- | --- | --- |
| CONTENT_NOT_FOUND | NOT_FOUND | 不存在或无权操作，不区分他人的对象 |
| CONTENT_ERASED | PRECONDITION_FAILED | 已永久删除，禁止读取和重放 |
| CONTENT_ERASURE_PREVIEW_CHANGED | CONFLICT | 影响范围变化，重新预览并确认 |
| CONTENT_ERASURE_BUSY | CONFLICT | 原操作占用中，刷新后重试；本次未部分删除 |
| CONTENT_ERASURE_UNAVAILABLE | SERVICE_UNAVAILABLE | 状态未确认，不显示成功 |

删除前推荐文案：

- 回答：“永久删除这条回答及系统副本，无法恢复。你的提问和独立保存成果会保留；相关执行不能重放。”
- 会话：“永久删除此会话及全部消息，无法恢复。独立保存成果会保留，但来源将不可读，可另行删除。”
- 成果：“永久删除这份成果及全部历史版本、候选草稿和系统副本，无法恢复。其他独立成果会保留。”
- 通用：“删除内容不会退还已产生的费用；必要账务记录按规则保留。”

定位成果先列依赖账号、稿件和引用，说明后续须重新选择来源或复核，允许取消。
保留成果显示“该成果来源已删除，可另行删除”；`sourceAvailable: false` 不能误作正文丢失。
收到确认后清除本对象及相关列表/结果缓存、多标签页广播失效、停止显示旧流式缓冲；重连刷新。
`review_required` 显示“内容已不可读，部分财务证据仍待核对”，不得显示在线清除全部完成。

## Handoff

已完成：0200 SQL、薄 API、前端接口说明；本机 D7 11 组及原注销财务/解绑 9 组验证通过。
同步 staging `4c66637a` 后完整空库重放 202/202、133 次重复执行及 D7 集成测试通过。
API 全量重跑 5807 通过、12 跳过（首跑 7 个测试桩缺失已修复）；新增错误码测试 17/17 通过。
类型、lint、大小检查通过；额外缓存来源修正已在开发库验证，最终链/指纹需随 #768 再生成。
最终 CI 和独立结论尚未完成。

下一步：补齐其他读取入口/财务合同回归；#768 合并后同步 staging、在其 `opc_query` /
`opc_content_allowed` 版本上补丁，生成完整指纹，再推送最终候选并转为可审查。
阻塞最终基线：#768 当前尚未合并；不阻塞独立实现和本机验证。
完成后读取当前 head 的独立结论并修复 P0/P1，停下等主窗口审计；不执行合并或远端迁移。
