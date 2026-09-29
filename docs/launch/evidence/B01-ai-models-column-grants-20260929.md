# B01：模型密钥列权限修复

风险：**高**。修改数据库 SELECT 授权和凭据读取边界；仅限 ai_models。
依据 PR #498 的 S1 B-01、ACL-02；开工基线为 staging `44f54bde981bf67bb634f2e8e37c8dc456bc4148`。
未查询远端业务值。无结构、数据、RLS、service_role 权限、其他表、依赖或 CI 改动。

## 代码路径复核

- `services/modelRouter.ts`：用户模型路由/成本估算改用 `services/models/publicColumns.ts` 的显式列；不再取 api_key，返回的 apiKey 为 null。真正执行请求的流式路由另行用 service role 读取密钥。
- `routers/model.ts`：创建、更新、旧配置更新的返回结果剔除 api_key；已有列表和连接状态投影继续使用安全元数据/布尔值。
- `routers/diagnostics.ts`：仅密钥检查查询改用 supabaseAdmin，其余用户查询保留原身份。
- `services/diagnostics.ts`：模型状态检查用 supabaseAdmin，结果仅包含状态，不返回密钥。
- `routers/settings.ts` 的整理模型选择/保存检查、`routers/modelReasoning.ts` 的试用均为 adminProcedure；`trpc.ts` 将其 ctx.supabase 切换为 service_role。保留 RUNTIME_MODEL_COLUMNS。
- `app/api/ai/stream/route.ts` 的 getRuntimeModelConfig 调用传入 supabaseAdmin，保留密钥读取。
- 其余 ai_models 查询：用户模型列表、定价、诊断 ID 查询已有明确安全列；管理员财务查询映射为固定统计字段；agentSlice/artifacts 和受保护 runtime/skills 服务使用 service role。
- 全仓查询检索涵盖直接 from、关联选择、RPC/SQL 引用。按静态列用途未发现另一独立凭据列；api_endpoint 是地址、config 是模型设置，保留读取。未检查远端 JSON/地址的实际内容，不能据此证明其中从未写入秘密。

## 迁移和恢复

`0142_ai_models_column_grants.sql` 先撤销 PUBLIC/anon/authenticated 表级及全部已有列级 SELECT，再用 pg_attribute 授予 authenticated 除 api_key 外的现有列。忽略系统列/已删除列，可重复执行。未来新增列需显式迁移授权，不自动获得权限。

回退仅恢复 S1 所述 staging SELECT 状态，会重新开放 B01 风险。另行批准后可执行
`packages/db/tests/ai-models-column-grants-rollback.sql`：清除三角色表级/列级 SELECT 后，执行
`GRANT SELECT ON TABLE public.ai_models TO authenticated;`。其他权限和 RLS 保持原状。

## 验证

- PASS：相关 9 个单测文件、170 个测试。
- PASS：本机最小 PostgreSQL 17 + PostgREST 数据库；按 S1 ACL-02 复现迁移前 authenticated 可读合成密钥、anon 不可读；迁移后 SQL 和 REST 的密钥/星号读取为 42501，安全列可读，停用行仍不可见，service_role 可读两行。
- PASS：重复迁移、PUBLIC/anon/authenticated 残留列授权清理、精确 ACL/列授权回退；RLS、数据和 service_role ACL 未变；临时容器已清理。
- 本地命令：`node packages/db/tests/run-ai-models-column-grants.mjs --local-only`。这是有来源的最小权限夹具，不是全历史迁移重放或远端 staging 验证。
- PASS：完整 API 单测 130 文件，2851 通过、3 个既有跳过；网站类型检查、代码大小检查、指定当前 staging base 的迁移账本检查。
- PASS：`node packages/db/tests/run-ai-models-preview.mjs --local-only`，2 项定向集成测试通过；其余 284 项按范围过滤，未运行。实际浏览器登录并选择模型；真实 HTTP 模型列表、成本估算、整理模型列表、后台模型列表/更新正常且无密钥字段或片段；REST 直接读密钥仍为 42501，service role 可读取。导师准入覆盖并发、重放与越权拒绝。只用本地合成 transport，未调用真实模型。
- 预览适配器只归档已提交 HEAD，在临时副本里复用 run-workbench，追加 B01 迁移和独立测试文件；不修改共享 runner、已有 workbench 测试或受保护服务目录。测试后清理本轮容器/应用，保留本地截图和日志。新测试脚本无产品基础设施或新数据权威。
- 扩展验证 FAIL/未归因：较宽的既有 `ADMIN: model edits and unused-module deletion` 在 20 秒超时；`OPC: browser manual positioning` 在后段读取“定位摘要”时超时。未将其算作通过，也未据此宣称既有基线必然失败。该轮应用日志未发现 42501；未扩大 B01 范围修改这些测试/页面。B01 自有浏览器夹具的首次选择器超时，已通过补齐用户资料与显示开关修正并重跑通过。
- 远端必需 CI/Security：以 PR 当前 head 的 Checks 和 Handoff 为准；独立语义审查按 Owner 流程等待总控审查后再触发。远端迁移、生产和真实 provider 验证均未运行。

## 合并后应用 staging

1. 总控审查通过后才能 ready 和请求独立审查；候选检查通过且本会话收到 Owner 双确认后才可合并。
2. 先确认兼容代码已在 staging 可用；合并本身不代表迁移已应用。
3. Owner 另行批准后，有写入通道的执行者核对目标和当前迁移编号/授权，执行该单独迁移。
4. 只用权限函数及非生产身份验证 42501、安全列读取和服务端功能，不输出密钥值/片段。记录是否真正应用；生产不在授权范围。
5. 若需恢复，优先修复兼容代码；只有另行批准后才执行上述回退。
