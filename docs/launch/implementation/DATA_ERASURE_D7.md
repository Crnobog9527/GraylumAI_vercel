# DATA-ERASURE D7 后端交接

风险 **high**：永久删除、本人权限、数据库和财务正文投影。依据
[DATA-ERASURE §5](../tasks/DATA-ERASURE.md) 及 MASTER_PLAN D7 / E1–E11。
本 PR 只改后端；不改前端，不使用浏览器，不访问远端数据库，不合并。
迁移改用 **0201**（2026-10-10 最新总控分配）；0200 由先合并的 #774 使用。
当前基线已包含 #768 的 0199 及 #774 的 0200；本次按完整迁移链重新生成指纹。

## 实施拆分

| 选择 | 清除 | 保留 |
| --- | --- | --- |
| 回答 `answer` | 原 execution 的回答、匹配结果、复制正文的 history/batch/tool、依赖执行快照、系统 capture 副本、非财务收据正文 | 用户提问、独立回答、独立保存成果 |
| 会话 `session` | 全部执行及提问、历史、工具、批次、scope/material、系统衍生副本 | 独立保存成果，来源不可再使用 |
| 成果 `artifact` | artifact project 家族的全部发布版本、round/candidate/confirmation、引用和请求缓存；其成果内容版本、绑定的引导聊天及快照、关联调研结果正文、本人项目显示名称和发布设置 | 其他独立成果和下游已保存正文 |
| 成果内容 `content` | 指定 opc_content_versions 所属 work_item + kind 家族的全部手动/正式/历史版本和系统快照 | 其他 kind 的独立正文；来源链失效 |

旧 `/chat` 按任务文档明确决定不新增单条删除入口，继续由注销覆盖。成果家族绑定的引导式 Skill 聊天则随该成果一并清除。若未来物理删除消息，
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

预览与确认复用同一范围计算，全部编号数组排序去重后计算 hash。确认锁定所属 profile/session/project 和原执行账务，
重新核对范围 hash；忙时整笔回滚。来源链、Runtime dependency、结构化 JSON 引用及视频素材专用绑定均参与清理。
视频素材采用独立请求编号，通过既有脚本绑定找到原执行和素材消费者；清理前在现有依赖表保留编号，保证重复范围稳定。
V3 无来源编号的整理输入按同会话、字段身份和完整建议值识别副本；将依赖编号保存到现有 Runtime 依赖表，保证重复清理范围稳定。
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

## Handoff / 交接

已完成：0201 SQL、本人单条删除薄 API、错误码和前端影响说明；正常合并包含 #774/0200 的最新 staging，未变基或强推。0201 在新函数版本上增量补丁，保留 0199 的 V3 撤回与 0200 的临时表 TRUNCATE/未决账务复核逻辑；唯一指纹冲突由完整迁移链重生成解决。

审查修复：成果绑定引导聊天及快照清理、关联调研结果 cost 投影/计划锁、项目列表隐藏已删除成果、成果库隐藏删除空壳；本人项目私有设置清除及晚到写入拒绝、预览范围排序稳定。独立保存但来源被删除的成果仍保留。没有新删除系统或前端改动。

验证：完整空库迁移链、重复执行、目录稳定和回滚恢复已通过；本机单条删除/注销并发/财务/V3 组合、safeupdate 注销执行器、API 与最终 CI/独立复审结果待本轮完成后记录在 PR。

剩余边界：永久正文无法通过迁移回退恢复；前端入口、影响确认、缓存和多标签页失效由前端窗口完成；此前已发到客户端的内容不能撤回。未知账务仍保留原身份和复核状态。远端迁移与产品验收未由本任务执行。

下一步：完成当前版本验证与独立复审，修复阻断问题，将确切版本和结果记录在 PR 后停下等主窗口审计。本任务不合并、不操作远端数据库、不使用浏览器。

删除内容或成果家族时，沿选中内容版本的 `execution_id` 清除原生成执行及其历史副本；
不依赖执行 payload 反向引用稍后才创建的内容编号。独立保存成果仍保留，来源失效。
