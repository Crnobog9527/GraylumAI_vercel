# BILL-PAYG 最终配置与交接

采样完成，累计费用 **$7.399349965**，没有超过批准的 $25。
[主窗口审计与收尾授权](https://github.com/Crnobog9527/GraylumAI_vercel/pull/665#issuecomment-6010557192)；
[r9逐条费用、路由证据与最终建议](https://github.com/Crnobog9527/GraylumAI_vercel/pull/665#issuecomment-6010270829)。

## 配置文件

[payg-profile-final.json](evidence/payg-profile-final.json) 是 `runtime_payg_staging` 的完整 value 对象：
version、enabled、windowId、profiles。三个profile与已审r9结果建议一致。
`windowId` 的全零 UUID **只是占位符**；由主窗口替换为目标 staging 窗口 ID 后再写入。
本PR只交付文件，不写任何设置、不应用迁移、不再次采样。

离线校验（不联网、不读凭据、不连接数据库）：

```bash
node scripts/payg-profile-validate-final.mjs
# 填入真实窗口ID后的本机副本也使用同一schema：
node scripts/payg-profile-validate-final.mjs /path/to/filled-profile.json
```

验证实际使用 `paygHostSettings`（运行时完整设置schema），不会以 `{enabled:false}` 的简化关闭分支代替验证。
全零占位满足UUID结构，schema通过不代表已经绑定窗口、未过期或得到启用授权。
运行时仍要求windowId与目标窗口一致、证据未过期且purpose/format/reasoning都匹配。
有效期固定为2026-10-13T00:00:00Z，不自动延期。

Gemini用low、Sonnet用low（保留none作为同线路语义来源）、Luna不传reasoning参数。
三者最大128条、196608字节，outputLimit=8192；testedOutputLimit分别512、2048、512。
Sonnet low的直接触顶样本数0，标记same-route-none，不冒称low自己触顶。
用途和格式推广遵循主窗口决定；历史64/96/128证据保留，r9实际路由短长12条全部合格。
mentor无历史、step无工具，report仅证明预期wire；报告执行链绑定问题仍非本PR的端到端验收。

## 迁移与恢复

同步staging后，本PR使用 `0177_payg_profile_messages.sql`；选择时staging最新0176，#679尚未合并。
只把 `bill2_payg_validate_quote` 的全局消息上限32提高至128；仍取它与每个冻结quote.maxMessages的较小值。
旧32条冻结执行不受影响，无数据更新、新表或权限变更。源函数md5防漂移校验不变；重复执行保持相同结构。

恢复时先关闭新PAYG准入（独立获准后由主窗口操作），让已有冻结执行完成。
不要在128条执行仍活跃时把SQL硬限退回32；撤回应用代码也不能抹掉已冻结执行和费用记录。
如需恢复SQL旧上限，必须先确认无依赖128条的在途执行，再另行新增受审迁移；不删除已应用迁移。

完整本地空库回放与指纹重建：

```bash
node packages/db/tests/run-db-baseline-replay.mjs --local-only --write-built
```

仅用本机Docker，按历史位置重复执行迁移并核对幂等性。远端数据库未访问。
合并前若staging新增迁移占号，需要再次merge、改到下一个连续空号、重建指纹并重跑受影响检查。
