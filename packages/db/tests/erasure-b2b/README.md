# DATA-ERASURE B2b 第一片：历史 BILL2 收据正文

同步 staging `c0efffe28a080c37684d0cc153fd16b34de7441c`；对应 PR #674。
第一片仅处理 `bill2_receipts` 已存正文，**不是整个 B2b / 注销完成**。
不新增表、队列、配置或调度；现有 0156 投影、0162 双合同绑定、原收据为唯一财务权威。

## 缺口与调用边界

B2a 在封闭后写入财务投影，但封闭前的旧收据仍有正文且不可修改。
0176 提供 `account_erasure_scrub_receipts(profile, run, limit=100)`，只授予 service_role。
校验真实注销请求、deleted profile 和原 v1/v2 预扣绑定；普通停用、伪造删除标志、
跨主体、客户端直调都拒绝。该函数没有生产/定时调用方，后续 PR-C 编排。
返回 `processed` / `remaining` 只表示**此运行单未投影收据**，不是账号整体清除状态。

复用 B2a 递归财务投影，删 raw/SSE/编码正文、transport、SDK 回包及任意额外字段。
供应商、命名空间、协议必须匹配原 call；不匹配模型按既有 B2a 规则改为 null，
保留原冲突事实。原 payload_hash 保持不变，financial_projection_hash 单独记录新投影。
金额、币种、费用未知、用量、财务身份、原预扣、余额、状态、查询次数和期限不变。
晚到回执和原收据重放继续走现有 bill2_record，禁止回填、改身份或 DELETE。

原 run → calls → receipts → profile 锁序与 record/close 一致；没有反向 session 锁。
此片不擦除 Runtime 内容，不改 B1b 事务屏障；所有收据写入与清除受同一个 run 锁串行化。
结果未知仍保留原预扣；现有按供应商编号核对只需要保留的财务投影和原 call，
不需要收据中的用户正文。无法满足既有投影契约的旧证据整笔拒绝，不能当作清除成功。

## 兼容、幂等与回滚

- 无表/列变化；旧写入代码继续使用原 RPC。active 账号的 immutable 行为不变。
- 迁移先校验 immutable 函数体的旧/新摘要；不匹配时在任何持久变更前失败。
  历史迁移不修改。0176 在自身位置重复执行，结构必须一致。
- 每次最多投影 100 条；重复推进仅清尚未投影的行。已有投影行不能再次修改。
- `rollback.sql` 仅供本地空事实结构回退；出现任何财务投影即拒绝，保守包含 B2a 的投影。
  此后只能前向修复，保留金额/去重事实；撤回代码不恢复已清正文、不重开账号。
- 主窗口 2026-10-06 调整编号：本 PR 使用 0176，#665 与 CDC 后续按合并时的下一个编号排定。
  本分支已普通 merge 同步最新 staging；完整建库、指纹和连续编号检查按此重新验证。

## 验证

```sh
node packages/db/tests/erasure-b2b/run-local.mjs --local-only
node packages/db/tests/run-db-baseline-replay.mjs --local-only --write-built
node packages/db/tests/v3/run-workbench.mjs --bill2-core-only --without-app --schema-from-files
```

独立 runner 只允许本地 Docker Unix socket、固定已有镜像、loopback 临时数据库；
不接受数据库 URL、不读取业务凭据、不访问 Auth 或供应商。每次结束删除自己的容器。
`--local-only --development` 仅用于开发迭代，不代表全部历史迁移重复校验已执行。
同一行为/并发测试接入既有 required BILL2 集成测试，无修改 CI 文件或检查要求。

覆盖 v1/v2、真实允许/拒绝、普通角色无法直接写、跨账号与伪封闭、历史摘要去重、
余额/完整账务快照不变、未知 hold 不释放、迟到冲突、投影后禁止修改/删除、
分批/重复、非法旧证据拒绝、第二行失败整笔回滚、两连接实际锁竞争、结构回退及拒绝回退。

## 后续仍需完成

1. B2b：run payload/result/scope 与公共财务字段脱敏、支付快照及迟到写保护；
   terminal 且内容已擦的 session_ref 单向解绑、receipt_saved 及 B1b 衔接。
2. PR-C：真实内容/Storage/资料/Auth 清除与进度编排、FK 顺序、账务保留；
   复用 #611 的原运行单恢复。之后才是 #538 第③步重注册验收。
3. PR-D：活跃账号的回答/会话/成果单条删除、影响预览、不可读/不可重放/不可采用及副本传播。
   B1 只允许已注销账号；旧 soft_delete / restrictEvidence 均不代表完成 D7。
4. 财务到期清理、备份恢复重放、实际日志/备份窗口和第三方副本验证仍未完成。

不访问远端数据库、不执行 staging 迁移、不改配置、不合并。主窗口负责后续外部交付。
