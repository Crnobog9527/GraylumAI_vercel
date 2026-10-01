# RATE-LIMIT：配置准备（保护未接线）

风险 high。Owner 已确认初值：新对话 10/min、200/24h，模型调用 30/min、600/24h，
及暂停开关。当前分支只完成独立配置准备，**没有启用 Runtime/OPC 限流或暂停**。
完整原方案与总控记录见 [PR #562](https://github.com/Crnobog9527/GraylumAI_vercel/pull/562)。

## 已实现

- 私有 `runtime_rate_limits`，专用管理员 get/update、严格范围/类型校验、保存后回读。
  通用单项/批量接口禁写；未加入用户公开设置投影。不存在时使用 Owner 初值，
  读取失败或无效内容返回 503，不伪造默认成功，不做跨请求配置缓存。
- `/admin/settings` 的 AI使用额度卡片可编辑并单独保存配额；显示“保护尚未接线”。
  一键暂停按钮禁用；接口可以保存 stopNewCalls，但不宣称它已控制 Runtime。
- API Redis 客户端兼容两套完整变量名，原 500ms 超时及失败关闭不变。
- checkRuntimeRateLimit 支持准入/调用双窗口参数、显式环境前缀、稳定 Redis key；
  调值替换实例，不清计数，最多六组缓存；关闭 analytics 和本地拒绝缓存。
  日窗口先检查，失败不检查分钟；分钟失败可能已占日次数，保守不扣回。
  该 helper 尚无运行时消费者，stopNewCalls 的安全执行由后续宿主接线完成。
  不改 Web 旧链路的独立客户端，不改变其配置要求。

## 按总控决定暂不接线

[边界报告](https://github.com/Crnobog9527/GraylumAI_vercel/pull/562#issuecomment-5926530309)：
OPC 的原请求转换/重放识别在 opc/service.ts 内；execute 的发送与恢复分流在
execute.ts 内。路由前置拒绝会挡住恢复和原失败收尾；路由预查再执行存在竞争窗口，
不能证明暂停后不发送、也不能保证拒绝后预留释放。复制 service 规则不是最小方案。

本次未修改 admission.ts、execute.ts、bill2/service.ts、opc/service.ts，
也未在 routers/runtime.ts 或 routers/opc.ts 放入不完整检查。
[总控已确认分步范围](https://github.com/Crnobog9527/GraylumAI_vercel/pull/562#issuecomment-5926589161)：
本轮交付配置、后台、Redis 参数化和测试，宿主接线等 #497/#550 后一次完成。
封闭内测前必须完成接线并验证保护生效。
当前是独立准备切片，不能以绿 CI 代替保护实际生效。

## 环境变量：只核对名字

| 用途 | URL 名字 | 可写 token 名字 |
| --- | --- | --- |
| 首选 | UPSTASH_REDIS_REST_URL | UPSTASH_REDIS_REST_TOKEN |
| Vercel 集成兼容 | KV_REST_API_URL | KV_REST_API_TOKEN |

首选任一非空就要求首选成对完整；只有首选两个都不存在/为空时才读取集成完整对。
不混用两套，不接受 KV_REST_API_READ_ONLY_TOKEN，不遍历自定义前缀。
不输出值、长度、哈希或凭证来源内容；本任务没有查询远程环境变量或加载本地真实凭证。
自定义前缀由 Owner 在 Vercel 增加同数据库的完整别名对，或另行确认具体名字兼容。

Owner 已确认 staging 安装了 Vercel Upstash Free 集成；这不是本任务的连通性验证。
部署前由总控请 Owner 核对变量名字及目标环境可见性；正式环境尚未配置，
上线前须配置完整对并确认额度充分/付费方案。缺失或额度耗尽会失败关闭。
参考：[Upstash Vercel 集成示例](https://upstash.com/docs/redis/tutorials/nextjs_with_redis)。

## Redis 用量估算（代码已参数化但尚未接线，非用量实测）

核对仓库锁定的 @upstash/ratelimit 2.0.8 源码与
[官方命令成本](https://upstash.com/docs/redis/sdks/ratelimit-ts/costs)：
单区域 slidingWindow，每个窗口允许请求常态 4 条命令、首次建桶 5 条；
冷脚本 NOSCRIPT 回退 EVAL 可额外 1 条。analytics 开启每次再加 1 条。
两个窗口一次准入常态 8–10 条（新桶已关闭 analytics，保留应用错误日志）；
首次脚本回退保守按 12 条。模型调用桶同口径。不是 2 条 HTTP 请求等于 2 条计费命令。
超限也可能消耗命令，其他 API/auth 限流共用数据库还要另计。

按 30 天、单用户每天用足推荐值、新桶不启用 analytics 估算：

| 场景 | 常态命令/月 | 含初次/冷脚本的保守预算 |
| --- | --- | --- |
| 第一步 200 次准入/天 | 48,000–60,000 | 72,000 |
| 第二步另加 600 次模型调用/天 | 144,000–180,000 | 216,000 |
| 两步合计 | 192,000–240,000 | 288,000 |

分钟峰值分别为约 80–100、240–300 条/分钟；不是全站上限。
5 个此类准入用户约 240k–300k/月，10 个约 480k–600k/月；
两步后仅 2 个满额用户已约 384k–480k/月，尚未包含重试、超限请求和其他限流。
这些是成功尝试的场景估算；失败尝试数量不受日成功配额约束，不能当总费用硬上限。
若沿用 analytics=true，每次双窗口增加约 2 条，即满额准入另 12k/月、模型调用另 36k/月。
多区域数据库复制开销另算，不假定 Owner 安装项的地域或实际流量。

[官方当前 Free 说明](https://upstash.com/pricing/redis)为 500k 命令/月。
实际安装计划/仪表盘优先，不能沿用旧文档 10k/天作为本次额度结论。
不为查看用量另加定时任务、每请求 PING、Redis 监控计数或额外 analytics 写入。

另一个准确性修正：SDK slidingWindow 是相邻固定桶加权的近似滑动窗口，
并非逐请求时间戳的精确滚动 24h；reset 只是下个固定窗口起点。
[官方算法说明](https://upstash.com/docs/redis/sdks/ratelimit-ts/algorithms)。
按获批的“复用现有滑动窗口”实施时需明确这一边界，不能声称任何精确连续 24h 都严格不超 200。
若需要该硬保证，应由总控修订算法范围；本次没有默换算法。

## 运维可见性

- Redis 请求失败：旧桶 ERROR 事件 `rate_limit_backend_unavailable_denying_request`；
  新参数化桶为 `runtime_rate_limit_backend_unavailable_denying_request`。
  非法 helper 参数单独记 `runtime_rate_limit_invalid_configuration_denying_request`。
  与用户普通超限分开，不输出原异常/URL/token。该事件证明后端保护不可用，
  不能仅凭它判定“Free 耗尽”，需 Owner 在 Upstash 仪表盘核对。
- 配置故障：`runtime_rate_limit_config_unavailable`，reason 为
  read_failed / invalid / write_failed，不包含设置内容。
- 卡片明确解释 Redis 故障拒绝及日志入口；不显示未经探测的“Redis 健康”。
- 上线前待办：完成宿主安全接线、真实隔离 Redis 并发/超时验证、部署 commit 核对、
  staging 原值保存与恢复、正式环境完整变量对和足够命令额度。
  本轮没有远程 Redis、数据库或模型调用，不把本地配置测试记为 staging 验收。
