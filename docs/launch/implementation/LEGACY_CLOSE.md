# LEGACY-CLOSE 删除与功能对照

状态：实施中；不合并。基线 staging `c91c526d3c43fb5e0b28c2a0a1942b457590fa3a`。
授权：#771 总控 2026-10-11 并行派发及本任务 Owner 指令。

## 删除前发现的保留边界

- `components/chat/MessageMarkdown`、`ChatInlineNotice`、`chat-scroll` 仍被 Runtime/定位页面使用，保留及其测试/样式。
- `services/artifacts/workbench.ts` 仍被 `opc/service.ts` 使用；定位页调用 `workbench.execute`。不能整包删除。
- `/workbench` 页面仍调用旧成果生成、报告与项目接口；先记录，不把现有可达功能当作死代码删除。
- `modelRouter.ts` 被定时/管理诊断与 `routers/ai.ts` 使用；后者含计费估算和停止结算，本任务禁止改计费相关文件，暂保留，待总控排定。
- `aiOutputFilter.ts`、`contentModerator.ts` 被上述可达的旧成果生成引用，暂保留，不能通过移除过滤静默改变在用生成行为。
- `/api/ai/requests` 与 ordinary-chat 恢复/访问校验保留，避免改变旧请求结算；不删除数据库旧对话或迁移。
- `scripts/code-size-baseline.json` 为 #784 在途文件；如删除后必须缩减条目，先请求总控排顺序。

## Handoff

- 已完成：核对任务定义、#507/#522、总控授权、在途 PR、分支保护与自动 CI；建立独立 worktree。
- 下一步：完成无共享引用的页面、流式旧实现及测试清理；逐项补充功能对照与验证结果。
- 阻塞：上述活跃引用不能硬删；共享大小基线需总控安排。
- 验证：尚未运行；禁止浏览器；不宣称 LEGACY-CLOSE 全部完成。
