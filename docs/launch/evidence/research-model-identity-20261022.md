# RESEARCH-TOOLS / MODEL-IDENTITY-GUARD 排查与验证

任务：修复 #716 第 2 步对标“可以照着学”标签矛盾；查明自由对话身份问题无回答原因，
复测“你是 Claude 吗？”与“你用的是什么模型？”。本次真实模型预算上限 1 美元。
仅 founder 浏览器；指定 staging-login 的不透明 storageState；未读取或记录凭证；不部署分支。

## 对标标签

founder 原定位 `/app/positioning/e6707493-2620-4551-a8bf-3520f034aead` 现场复现：
3 个账号均显示“可以照着学”，播放和互动率均为“这次没查到”。
粉丝、更新时间和作品数量有证据，但模型收到的是汇总指标，没有作品内容。
`qualified` 的产品规则核验数据门槛，不能证明内容主题适合用户学习。

修复为“数据条件达标”，并明确“内容主题是否适合你，仍需结合具体作品判断”。
报告门槛和不足卡同步使用同一表述；不改变 qualified、阈值、缺失值或计费。

本地真实 Chrome 375px / 1440px：6 项研究界面回归 PASS，包含缺失指标仍不得承诺
“可以照着学”、主题判断说明、计数和原确认/刷新行为。
修改后 staging 浏览器：BLOCKED，当前部署尚未包含本 PR。

## 身份问题没有回答

在 staging 部署 `dpl_8eALBqki7k1f9fLzMyWPXYHVaBMf`（代码 26371ee7）上，
founder 第一次发送“你是 Claude 吗？”：

- `runtime.start` 200，session `a8af0d3a-26aa-48eb-895a-c40a8de24d89`。
- request `47f76304-bf42-45ce-a00c-9856d7f4c936` 的 `runtime.prepare` 500。
- 诊断编号 `f084563e-c633-467d-9eef-ea93adaeae18`。
- Vercel 请求 `t6r2z-1792600013559-73dad0eac387`：数据库错误 `25006`。
- `runtime.view` 200：`executions:[]`、`activeExecution:null`；刷新原任务仍为空。
- 无 executeStream、无模型执行，积分 6727 不变。没有重发原请求；第二问 NOT_RUN。

staging 只读 SQL 重现得到完整错误链：
`runtime_positioning_gate → opc_has_confirmed_positioning → opc_source_allowed → artifact_evidence_allowed
→ runtime_history_available → runtime_billing_allowed → runtime_direct_billing_allowed_before_opc`。
最后一步执行 `SELECT id FROM bill2_drafts ... FOR SHARE`，被只读事务拒绝。

`runtime_positioning_gate` 声明 STABLE，PostgREST 因此为它启动只读事务；
只有定位来源链接到 Runtime 执行时才进入这个锁路径。
这解释了为何无定位/没有 Runtime 来源的旧测试可通过，而已完成定位的身份问答失败。
历史两次原始失败未保留完整准入响应，因此不能把本次诊断编号归给旧请求；
已核对旧成功提问有保存的品牌回答，旧未答精确提问无对应执行记录。

最小修复：只将 `runtime_positioning_gate(uuid)` 的事务声明改成 VOLATILE。
函数体、ACL、来源与计费保护保持原样。不拦截输入，不伪造品牌回答，不关闭定位保护。

## 验证与未完成项

- 身份保护及定位准入相关：182 项单测 PASS。
- 两条精确提问：执行器模拟供应商身份泄露，仍实际进入 Runtime 模型路径；
  最终/保存回答均为已批准品牌话术，进度事件不暴露模型名，PASS（合成测试）。
- 独立本地数据库：旧只读事务复现 25006、修复与重复执行、他人/撤回来源拒绝、ACL：PASS。
- 空库全链回放与重复迁移指纹：PASS；335 个建库步骤、266 个迁移在各自位置连续重复应用，重建 2688 个对象组，收敛重放不变，清理 PASS。
- founder 两条真实品牌答复：NOT_RUN，须先由总控将最小迁移应用到 staging，不能以模拟代替。
- 最终版本 CI 17/17、机器人无 P0/P1、未解决意见 0：尚未全部满足，不交为可合并。

迁移暂为 0333；0332 已分配给 PAY-FAILOVER，需总控按现行规则最终排号，不能跳过缺号检查。
验证材料保存在本机 `~/.graylum/evidence/pr1238/`；不提交登录状态、私人附件或其他账号资料。
