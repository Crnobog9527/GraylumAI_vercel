# REPORT-MODEL 后端接口与交付边界

模块已有 `model_id` 是对话模型权威。0198 只增加 `modules.report_model_id`（可空外键）；
新报告取 `report_model_id ?? model_id`，其他对话与 Skill 路径仍用 `model_id`。
不新增配置表、计价器、模型回退或报告财务状态机。模型设置不改变 Skill 发布包与报告格式。

## 管理员接口（tRPC）

- `reportModel.get({ moduleId })`：返回 `moduleId, dialogueModelId, reportModelId, effectiveModelId`。
- `reportModel.options()`：返回 `{ models: [{ id, name, model }] }`，只列当前环境测试窗口中已启用、
  报价有效、报告 PAYG profile/输出/思考组合、计费倍数、报告启动门槛均有效的模型。
  列表和保存复用现有准入检查，不发模型请求，不刷新目录、不修改报价。
- `reportModel.update({ moduleId, reportModelId, expectedReportModelId })`：保存后返回 get 的结构。
  两个模型字段都允许 `null`。`expectedReportModelId` 是此前读取值，防止旧页面覆盖新设置；
  清空不依赖当前报价/窗口可用。非空值保存时重新验证。

全部使用现有 `adminProcedure`；普通用户 `FORBIDDEN`、未登录 `UNAUTHORIZED`。
模块列不向 anon/authenticated 开放。`report_model_window` 仅 service_role 可调用，函数内部
另核对管理员身份；它仅供配置验证，不授予管理员测试调用权限，也不修改测试窗口。
当前 Runtime 仅开放隔离 staging 测试窗口，所以候选列表按当前宿主已有准入范围提供；
本功能不提前开启生产 Runtime，也不增加环境绑定。

## 稳定错误码

| 错误码 | 含义 |
| --- | --- |
| `REPORT_MODEL_UNAVAILABLE` | 模型不存在、停用或能力无效 |
| `REPORT_MODEL_PRICING_UNAVAILABLE` | 报价缺失、过期、字段未知或现价超过窗口报价 |
| `REPORT_MODEL_ADMISSION_REQUIRED` | 窗口未准入该模型，或报告 profile、思考配置、PAYG、倍数、门槛不完整 |
| `REPORT_MODEL_CONFIG_UNAVAILABLE` | 后台配置读取/保存失败或当前环境不支持配置验证 |
| `REPORT_MODULE_NOT_FOUND` | 模块不存在 |
| `REPORT_MODEL_CONFLICT` | 并发修改冲突，需重读后再提交 |

报告入口将模型相关拒绝映射为上述前三项；其他报告既有错误码不变。
实际派发仍执行现有窗口、会员、来源、预算和 PAYG 校验，失败不会换模型。
管理员候选校验不保证之后配置不会变化，新执行必须重新准入。

## 冻结与兼容

选定模型进入现有 context/modelId、精确报价、PAYG profile、倍数、report 用途和计费快照。
数据库在新准入的模块共享锁下核对报告模型，避免选择与冻结之间配置漂移。
重放先查原请求。已冻结报告后续读/执行使用与持久运行单完全一致的原模型；更改报告或对话
模型绑定不影响它，模块停用、模型停用、Skill/来源撤权等原有检查继续生效。
报告不会覆盖“最近导师对话模型”的会话投影。旧报告无须补字段；不重算原金额、不重复派发或收费。

## 0198 指纹与恢复

来源为 staging `b9bf443b6e5620dbf205a0fb2e534d0c4977cbfb` 的文件建库结果，非远程数据库快照。
迁移对三处函数做精确源指纹检查；重复执行也检查目标逆替换后的指纹，不接受未知定义。

| 函数 | 之前 MD5 | 之后 MD5 |
| --- | --- | --- |
| `runtime_admit(uuid,uuid,uuid,jsonb,jsonb)` | `11ff43aed8b67e76fab03f2ba7107696` | `ff7a5653ed4b68e347cff7f6734472b4` |
| `runtime_direct_billing_allowed_before_opc(uuid,jsonb,uuid)` | `f7587da7257cee711f64c7a0e82d8311` | `441cca9928bfcd6235b909efc44ece5f` |
| `runtime_session_context(uuid,uuid)` | `67b8e8ca0a4f07c95e5758676a1a803c` | `c18f5d7dac5a5e4fa159526e1b8086ca` |

逐对象结构变化在 `packages/db/tests/baseline/built-fingerprint.json`：一个可空列、外键、
一个管理员窗口只读函数及执行权限、三处函数定义；没有模型设置数据写入。
本机全链回放：201/201，132 项历史位置重复执行验证，0198 连续执行两次结构不变。

恢复优先保留 0198 和已冻结记录：通过管理员接口把本任务配置的报告模型清空，保存清空前
的模块/模型映射以供恢复，再撤回应用代码。旧代码忽略新增列，空值新准入仍沿用对话模型。
不删除列、报告、运行单或账务；保留新的冻结校验，保证原独立模型报告仍可恢复。
任何远程迁移/设置变更由后续获授权窗口执行，本任务未操作 staging 数据库或配置。
若要彻底撤销数据库变化，必须先确认没有独立模型的在途/历史报告依赖，再单独设计前向迁移，
不能直接恢复旧函数令已付费报告不可读。

## 验证边界

使用本机 PostgreSQL、真实 Runtime/PAYG/SQL 与模拟供应商；无浏览器、真实供应商或付费调用。
单元测试覆盖管理员允许/拒绝、候选过滤、空值恢复、旧页面冲突及错误码；集成测试覆盖
默认选模、不同模型/价格、冻结和结算、模型失效、报价缺失、配置变更后重放/续跑及重复请求。
这证明后端行为，不证明新模型的报告质量、真实费用或延迟；后台界面后续接入。
