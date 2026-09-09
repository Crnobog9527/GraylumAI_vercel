# 后台设置与模块删除运维

核对基线：2026-09-10，staging 已合入 PR #398、#399、#400。本文描述操作契约和该阶段证据；后续维护仍需读取实时分支、部署与 [AGENTS.md](../../AGENTS.md)。

## 管理员怎么用

- **设置保存**：打开 `/admin/settings`，从下拉列表选择主力、辅助和步骤成果整理模型，再点击“保存所有设置”。模型显示名称可包含 `openai/gpt-5.6-luna`，实际保存的是模型记录 UUID。保存后刷新并核对值。
- **批量删除**：打开 `/admin/prompts`，勾选需要删除的模块，点击“删除选中”并确认。服务器确认后，已删除行立即从当前列表移除，列表刷新在后台继续。
- **引用冲突**：被功能卡片、对话或项目引用的模块不能删除。一个批次中有引用冲突时整批保留；取消选择该模块，或使用下架。
- **下架与删除**：下架保留记录和既有引用；删除不可恢复。性能验证使用专用测试记录，不借用用户已有模块。

## API 与数据契约

以下为 tRPC 调用形态，需经过正常认证上下文；不要将服务端凭据放进浏览器示例。

| 接口 | 输入/输出 | 行为 |
| --- | --- | --- |
| `admin.getSettingsDashboard` | 设置页聚合数据 | 设置页主读取入口 |
| `settings.getRoutingModels` | 返回 `id/name/model_id` 列表 | 仅管理员、仅启用模型；不返回密钥 |
| `settings.getSummaryModels` | 整理模型可用性选项 | 服务端检查资格，凭据不离开服务端 |
| `settings.updateSystemSettingsBulk` | `[{key, value}, ...]` | 管理员复核、模型校验后批量 upsert |
| `admin.getPromptsDashboard` | 模块列表、统计与分页数据 | 模块页读取入口 |
| `admin.removePrompts` | `{ids: UUID[]}` → `{success: true, deletedIds: UUID[]}` | 1–100 个输入 ID，去重，一条原子 DELETE；返回实际删除的 ID |
| `admin.removePrompt` | `{id: UUID}` | 保留的单条删除兼容接口 |
| `admin.deletePrompt` / `admin.batchDeletePrompts` | 单条/批量 ID | 历史命名，实际执行下架 |

空的主力/辅助模型值 `''` 表示清除该覆盖配置；非空值必须为启用的 `ai_models.id`。`ai_models.model_id` 是供应商标识，不可替代数据库 ID。整理模型还需满足独立可用性校验；未配置或运行时不可用时保留原成果，不改用主力模型。整理输出上限为 128–4096 tokens。

批量删除重放时已不存在的 ID 不会再次删除，`deletedIds` 可以为空。数据库外键在同一 DELETE 中保护引用，包括并发新增引用。前端只在服务器成功后更新缓存，不等待后续刷新；刷新失败保留已确认结果并提示重试。

## 故障排查

| 现象 | 核查方向 | 已有处理 |
| --- | --- | --- |
| 设置保存提示暂时无法验证权限 | 服务端 `settings_writer_profile_read_failed`；检查 `profiles` 所需列的 SELECT grant | #398 补齐 `service_role` 对 `is_deleted` 的窄授权；读取失败返回安全 503，权限不符返回 403 |
| 模型配置无效或已变化 | 主力/辅助值是否为存在且启用的记录 UUID；整理模型资格；并发模型删除 | #399 在写入前校验；不合法输入/引用冲突返回安全 400，不部分保存 |
| 删除返回 409 | 是否存在功能卡片、对话或项目外键引用 | 保留整个批次，提示改为下架或调整选择 |
| 删除等待较长 | 分别记录 mutation、列表 refresh、数据库语句耗时 | #400 合并批次请求，并将 refresh 移到确认反馈之后；单次网络和服务端延迟仍可能存在 |
| 未登录/普通用户调用写接口 | 认证和管理员资格 | 拒绝路径应保持 401/403，不通过扩大客户端权限修复 |

`service_role` 绕过 RLS 不代表拥有所有 SQL 权限。按 [数据库依赖](../DATABASE.md#admin-write-dependencies-and-access) 核对已合入迁移；不要直接放开整表权限、删除引用约束或关闭检查来解决保存失败。数据库恢复/配置变更仍遵循 AGENTS.md 的对应授权要求。

## 验证与恢复

依赖安装完成且 Docker 可用时，从仓库根运行：

```bash
node packages/db/tests/v3/run-workbench.mjs --admin-only
```

该选择运行隔离 PostgreSQL、Auth、PostgREST 和浏览器的管理员场景，其余工作台用例会跳过。使用一次性测试环境并由 runner 清理。生成的证据目录可能含本地测试凭据，不整体上传；仅保留脱敏结果与必要截图。更多破坏性场景见 [验证清单](../ADMIN_DESTRUCTIVE_VALIDATION_CHECKLIST.md)。

staging 页面检查可确认入口、确认弹窗和取消；真实保存/删除须在对应授权范围内执行并重新读取结果。部署回滚不能恢复已删除数据，也不会撤销数据库授权。迁移恢复参考各迁移文件的 recovery 注释，经影响评估和授权后执行；撤销 0076 会重新导致受限环境中的设置保存拒绝。

## 本阶段交接证据

| 变更 | 已确认 | 限制 |
| --- | --- | --- |
| [PR #398](https://github.com/Crnobog9527/GraylumAI_vercel/pull/398) | staging 合并；0076 最小列读取授权已按 Owner 批准应用 | 不授予其他环境修改权限 |
| [PR #399](https://github.com/Crnobog9527/GraylumAI_vercel/pull/399) | staging 合并；55 项相关单测；真实本地 53 字段保存/刷新/数据库一致，非法批次与拒绝路径验证 | 保存成功不等于每项下游 provider 效果都重新验收 |
| [PR #400](https://github.com/Crnobog9527/GraylumAI_vercel/pull/400) | staging 合并；62 项 API 单测；隔离管理员套件 8 passed / 101 skipped；精确候选必需检查及独立审查通过 | 101 项未运行；不能宣称全工作台回归完成 |

#400 合并提交为 `7af10101b2300c34fe506805269590098b37dea6`。当次 staging 部署 `dpl_Ef9V3kRYPRPgXpfH2JntYoke9iqv` 为 Ready，`graylumai-staging.vercel.app` 上的新批量删除入口、弹窗及取消已检查；没有通过删除 staging 记录做部署后速度基准。

优化前的一次 staging 样本：删除请求 6,394 ms，随后列表刷新 2,942 ms；同类数据库 DELETE 的 4 次统计均值 15.42 ms、最大 38.11 ms。最终本地隔离样本：批次请求 144 ms，确认后界面更新 69 ms，刷新刻意阻塞时也能显示结果。环境与测量条件不同，不能据此计算线上提速倍数；下一次已授权真实删除才能补充 staging 提速实测。
