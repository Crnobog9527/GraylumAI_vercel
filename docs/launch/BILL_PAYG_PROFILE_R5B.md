# BILL-PAYG r5b 离线预演（2026-10-06）

**r5b 准备完成，等待复核。没有发送真实请求。** 原r5清单作废，执行入口拒绝旧hash。
依据：[r4主窗口审计](https://github.com/Crnobog9527/GraylumAI_vercel/pull/665#issuecomment-6000090284)、
[Owner费用确认](https://github.com/Crnobog9527/GraylumAI_vercel/pull/665#issuecomment-6000132517)。

## 新批次与上界

manifestHash：`4f8002e7989930cbf5cddd6ea2cae04e46548a196a885ac607a9b5f579b2990d`。批次ID：`payg-profile-20261006-r5b`。

| 组成 | 条数 | 上界USD |
| --- | ---: | ---: |
| Gemini原线路全部剩余样本（60矩阵、12多消息、4输出压力） | 76 | 4.966320750000 |
| Luna整理路径补测（4组合×2思考参数×短/长） | 16 | 0.225280000000 |
| Sonnet新ID输出压力 | 4 | 0.204800000000 |
| r5b | 96 | **5.396400750000** |
| 前四批已入账 | — | **4.989307965000** |
| 累计上界 | — | **10.385708715000 < 25** |

价格、完整线路tag和单条批准上限保持原冻结快照。Gemini输出O=512、Sonnet O=2048，各none/low两条。
Gemini未完成的76条请求hash和单条费用不变，仅输出样本ID改为r5b；Sonnet四条全部换新ID。
保留155条合格旧证据，旧矩阵/消息不重发；Sonnet旧失败请求不是合格证据。顺序为Gemini76、Luna16、Sonnet4。
Gemini status=0来自主窗口本次公开目录核实，本轮没有发送目录或出口查询；获准执行仍逐次核对精确目录，不换线路。
单条超限、拒绝、未知、未触顶或目录漂移即停止，不补跑、不重跑、不调大上界、不充值。

## 前四批对账

| 批次hash | 已入账USD | 原始未知与Owner确认 |
| --- | ---: | --- |
| `4289cffc98ac5fda57b46e93e8a7e3d083b30ab71223428a961d118593bad9c5` | 0.000000000000 | [确认依据](https://github.com/Crnobog9527/GraylumAI_vercel/pull/665#issuecomment-5996661703)；1条原始UNKNOWN按$0入账 |
| `596c57a3839de657e46058d16d8a558af2c84d3ea4b79b74e80a9b96e4a10ef7` | 2.596497700000 | [确认依据](https://github.com/Crnobog9527/GraylumAI_vercel/pull/665#issuecomment-5998488867)；1条原始UNKNOWN按$0入账 |
| `3cbeb87e1e9895527cf8e56c611337c897ef28bb7df637412724c05949be5e74` | 2.213641800000 | [确认依据](https://github.com/Crnobog9527/GraylumAI_vercel/pull/665#issuecomment-5999267254)；0条原始UNKNOWN按$0入账 |
| `04e92dfa3a33a49090c853da83cf088b5d83555ac447b92760a5b3461725f1db` | 0.179168465000 | [确认依据](https://github.com/Crnobog9527/GraylumAI_vercel/pull/665#issuecomment-6000132517)；1条原始UNKNOWN按$0入账 |

r2第49条、r4第77条均经Owner核实未收费；r1首条采用原主窗口接受的$0处理。新manifest记录会计确认，
不改写本机UNKNOWN回执，也不把原失败条目标成WITHIN。r5b不再把r4作为未结清兄弟批次：它是已独立确认的prior accounting。
旧锁存在时本地报告必须逐项与这些固定确认吻合，额外未知/不同hash/金额差异仍拒绝。作废r5出现锁则在任何网络前停止。

## Luna用途核对与缺口

证据边界：Owner确认Luna承担整理模型；本次核对staging固定源码`430f9aba7f777e129502af85150d1bd93f8fd03c`，
没有读取远端数据库或部署中的设置，不能声称已独立核实当前模型绑定、推理档位或部署生效状态。
本工作分支与该staging版本的admission/execute/providerRequest/runner对应文件相同。

| 用途 | requestFormat | 最终整理请求 |
| --- | --- | --- |
| organizer（独立整理） | serial-tools-v6-reasoning | 非流式，无工具 |
| attached_organizer（普通调用附带整理） | serial-tools-v6-reasoning | 非流式，无工具 |
| attached_organizer（OPC step） | serial-tools-v4-stream | 非流式，无工具 |
| attached_organizer（OPC mentor） | agent-turn-v5-stream | 非流式，无工具，历史0 |

源码：[模型与reasoning选择](https://github.com/Crnobog9527/GraylumAI_vercel/blob/430f9aba7f777e129502af85150d1bd93f8fd03c/packages/api/src/services/runtime/admission.ts#L174)、
[格式与profile用途](https://github.com/Crnobog9527/GraylumAI_vercel/blob/430f9aba7f777e129502af85150d1bd93f8fd03c/packages/api/src/services/runtime/admission.ts#L253)、
[附带整理实际调用](https://github.com/Crnobog9527/GraylumAI_vercel/blob/430f9aba7f777e129502af85150d1bd93f8fd03c/packages/api/src/services/runtime/execute.ts#L403)、
[独立reasoning与非流式转换](https://github.com/Crnobog9527/GraylumAI_vercel/blob/430f9aba7f777e129502af85150d1bd93f8fd03c/packages/api/src/services/runtime/providerRequest.ts#L59)。

r4固定phase=skill、v6、primaryDialogue=true，尚未采样上述整理分支。**旧Luna skill profile建议不能直接用于整理，暂不提供可启用的整理profile。**
补测使用相同openRouterRequestBody、正确phase/primaryDialogue/attachedOrganizer.reasoning，四组合各覆盖none/low，
B=4096与196608各一条，O=1024，共16条；无工具、两条消息。SDK本地fake exchange逐条生成后比对最终JSON，禁止任何网络。
短/长探针验证适配分支，不能冒称新增60格矩阵、12条多消息或输出硬限证据；这些复用r4已合格证据及hash。

补测全部合格后，才可建议purposes=[organizer,attached_organizer]、formats=[v6,v4,v5]（完整名称见表）、
reasoning仅none/low，testedOutputLimit=512、outputLimit=8192，maxMessages=128仍来自r4矩阵范围。
用途和格式数组是现有schema的准入允许集合，实际组合须遵守上表，不能声称所有笛卡尔组合都经过采样。
不列ordinary/skill/skill_matching/report；其他reasoning档位或路由未覆盖，启用前主窗口须核对实际冻结配置。
旧artifacts summary与旧agentSlice不走本host profile，不据此扩展。配置建议只写PR，不改实际设置。

## 逐条费用上界

每条严格绑定requestHash；原单条批准上限不变。未执行样本全部为NOT_RUN。

| # | 样本ID | B | T | O | 批准限额USD | 预留上界USD | requestHash |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | google/gemini-3.8-flash:output:chinese:output-stress:0:r5b | 4096 | 12288 | 512 | 0.25 | 0.011136000000 | `667b0ed2d0985766035f6f4d2ce6820003b719c3c773180e71ddc745dcb18521` |
| 2 | google/gemini-3.8-flash:output:code:output-stress:1:r5b | 4096 | 12288 | 512 | 0.25 | 0.011136000000 | `98b63a092ce9ecdc27d6e35a8169729ddd3edf12a36542dd68e7d925f3d596e3` |
| 3 | google/gemini-3.8-flash:output:chinese:output-stress:2:r5b | 4096 | 12288 | 512 | 0.25 | 0.011136000000 | `0da15d873aefe81676e853d6779e204d611b2f546c693f65ca632e63a81f7cbb` |
| 4 | google/gemini-3.8-flash:output:code:output-stress:3:r5b | 4096 | 12288 | 512 | 0.25 | 0.011136000000 | `6127ee14cec05f3af5ea412885cf8035d59d2a8c17e92e993096482a62a4caba` |
| 5 | google/gemini-3.8-flash:matrix:chinese:small:0 | 439 | 8631 | 1024 | 0.25 | 0.010313250000 | `5871302ba3ec68048b2746bb87e10a9a233492e1f8fcbc609b736934172897b6` |
| 6 | google/gemini-3.8-flash:matrix:chinese:small:1 | 3829 | 12021 | 1024 | 0.25 | 0.012855750000 | `942b2ba01fe388d14fdf1008708160dd5dfe81145c3f7407aeaa8b91c0a16716` |
| 7 | google/gemini-3.8-flash:matrix:chinese:small:2 | 3932 | 12124 | 1024 | 0.25 | 0.012933000000 | `f8cc08ead704fe31b0b5a8aadf1924b7f52d770053234c05e6731f056c8b6b63` |
| 8 | google/gemini-3.8-flash:matrix:chinese:small:3 | 4096 | 12288 | 1024 | 0.25 | 0.013056000000 | `35ec0fd9d0ec664effbe6f3a70a250a72021bcf62c337443c18585c2cd4b0e5f` |
| 9 | google/gemini-3.8-flash:matrix:chinese:medium:0 | 29818 | 38010 | 1024 | 0.25 | 0.032347500000 | `bb691d5719336847998d60ce999cda2c02f6b96d59ae89cf70c0f0afd7c5da91` |
| 10 | google/gemini-3.8-flash:matrix:chinese:medium:1 | 30638 | 38830 | 1024 | 0.25 | 0.032962500000 | `971b873448abf9d5c0bb0dc5fc1ef5f19ac820d9f3865bafca783303b2938e75` |
| 11 | google/gemini-3.8-flash:matrix:chinese:medium:2 | 31457 | 39649 | 1024 | 0.25 | 0.033576750000 | `918a91dbd9fac336f106731e65c05d050201bfdecffc5665e8f084f04f382198` |
| 12 | google/gemini-3.8-flash:matrix:chinese:medium:3 | 32768 | 40960 | 1024 | 0.25 | 0.034560000000 | `6add7cecb28b5ca5a982c49cd70fbcc484704714bd8fd252174901a3453cdba1` |
| 13 | google/gemini-3.8-flash:matrix:chinese:large:0 | 178913 | 187105 | 1024 | 0.25 | 0.144168750000 | `e4943d2a5af251f02b2910cf2a9f7abc9809513d7ae6c4d088f8f81cfc4b1f29` |
| 14 | google/gemini-3.8-flash:matrix:chinese:large:1 | 183828 | 192020 | 1024 | 0.25 | 0.147855000000 | `658efa1b3d3b9708c9687c0842b1621d8ced0e3560840f3a3d0eb1a234eaa4e0` |
| 15 | google/gemini-3.8-flash:matrix:chinese:large:2 | 188743 | 196935 | 1024 | 0.25 | 0.151541250000 | `7d5b992af20a956627dac44704fb5864d6da249f71c9af1d6ac69ac85bbd62df` |
| 16 | google/gemini-3.8-flash:matrix:chinese:large:3 | 196608 | 204800 | 1024 | 0.25 | 0.157440000000 | `210b9debf0f4a6a09141b666a13d6aa061470aeb0d71f375857b2ae578880112` |
| 17 | google/gemini-3.8-flash:matrix:english:small:0 | 439 | 8631 | 1024 | 0.25 | 0.010313250000 | `3d877870c8fcc8e7115cb86298ef34709f993cdef2a05523c7ad1e22857cdb05` |
| 18 | google/gemini-3.8-flash:matrix:english:small:1 | 3829 | 12021 | 1024 | 0.25 | 0.012855750000 | `7e0d4d504600e72dfc85184f8171671dfe51de26afb2d481fdd4bb48d9a4de56` |
| 19 | google/gemini-3.8-flash:matrix:english:small:2 | 3932 | 12124 | 1024 | 0.25 | 0.012933000000 | `772d40d39108e98e173055d4ba71db2f4fc16c0e697b295239720c2b15c1c6f2` |
| 20 | google/gemini-3.8-flash:matrix:english:small:3 | 4096 | 12288 | 1024 | 0.25 | 0.013056000000 | `25622dd3e5d37f81add6468ee93239c765ddb0fa947db6bcdb998f6750de8de7` |
| 21 | google/gemini-3.8-flash:matrix:english:medium:0 | 29818 | 38010 | 1024 | 0.25 | 0.032347500000 | `a335a5c8142a1d6a6e7f8dba5b923f79a4c54e9c8c7f0389c7479a1ff0cfefc5` |
| 22 | google/gemini-3.8-flash:matrix:english:medium:1 | 30638 | 38830 | 1024 | 0.25 | 0.032962500000 | `0fbb40830daaed7927cfc786aa03c4437c2b0464527ab8d3c9170376d0e5ceb6` |
| 23 | google/gemini-3.8-flash:matrix:english:medium:2 | 31457 | 39649 | 1024 | 0.25 | 0.033576750000 | `0283d1ab6d38bfbc0722ee6fb1e2c6436dbfae522d46a453d3ad56fc3d46d18f` |
| 24 | google/gemini-3.8-flash:matrix:english:medium:3 | 32768 | 40960 | 1024 | 0.25 | 0.034560000000 | `fe23e1e0f597ce38d09c2b50cc40feaceb3bff9153417ad6ea55c9ff0e655ab0` |
| 25 | google/gemini-3.8-flash:matrix:english:large:0 | 178913 | 187105 | 1024 | 0.25 | 0.144168750000 | `aeaea7528f91b91cb916520fc42bf56cf7d0804763d5cc8a469bdc615a053789` |
| 26 | google/gemini-3.8-flash:matrix:english:large:1 | 183828 | 192020 | 1024 | 0.25 | 0.147855000000 | `2435528a521114cee0d351a495d581c7c4dabddf13a6fe5d17620c5c75b21f62` |
| 27 | google/gemini-3.8-flash:matrix:english:large:2 | 188743 | 196935 | 1024 | 0.25 | 0.151541250000 | `0613f574f63150343963b039dd9e31e2fab0efcc800238e7e6fbe94e4e8b0d34` |
| 28 | google/gemini-3.8-flash:matrix:english:large:3 | 196608 | 204800 | 1024 | 0.25 | 0.157440000000 | `5e7b0a3f65f1a9f5137726d4b13345141fcd23f5d45b39cc4b0265140e096fc0` |
| 29 | google/gemini-3.8-flash:matrix:code:small:0 | 436 | 8628 | 1024 | 0.25 | 0.010311000000 | `6cf3bd2ece80eeeb9e178bd455d5530b0b52cb21ebbd02c1f08f84f599fa5c85` |
| 30 | google/gemini-3.8-flash:matrix:code:small:1 | 3829 | 12021 | 1024 | 0.25 | 0.012855750000 | `86f26650d84a10e0aa5fd16f3e1d0700fe1986cae94cd1253753157e2783a7fc` |
| 31 | google/gemini-3.8-flash:matrix:code:small:2 | 3932 | 12124 | 1024 | 0.25 | 0.012933000000 | `138ca554831299998d04f8e1f88f64f23433248144cd95890653b64c6ea8fa38` |
| 32 | google/gemini-3.8-flash:matrix:code:small:3 | 4096 | 12288 | 1024 | 0.25 | 0.013056000000 | `513d81a7964330d74306938aa199fbce291fce9cfa9359db7e3bd891d6bdc65d` |
| 33 | google/gemini-3.8-flash:matrix:code:medium:0 | 29818 | 38010 | 1024 | 0.25 | 0.032347500000 | `90456346e6b2a7b0ca2c3374ecb208733015b90a00f8f32a40b059519bb1b0b7` |
| 34 | google/gemini-3.8-flash:matrix:code:medium:1 | 30638 | 38830 | 1024 | 0.25 | 0.032962500000 | `a0b69924bfe5461bf8ec4407f892f2ec2ec188259f255930babeee802ea1ae73` |
| 35 | google/gemini-3.8-flash:matrix:code:medium:2 | 31457 | 39649 | 1024 | 0.25 | 0.033576750000 | `2212d03293ebb8dbafb1c3da74baec9bbfc8b6051b24026ffc99aa58a32a6bc7` |
| 36 | google/gemini-3.8-flash:matrix:code:medium:3 | 32768 | 40960 | 1024 | 0.25 | 0.034560000000 | `cd2f1f70a691edb3f4db4ff90a5cbc8829c1793b9787f71071915943722a8dc9` |
| 37 | google/gemini-3.8-flash:matrix:code:large:0 | 178913 | 187105 | 1024 | 0.25 | 0.144168750000 | `511043eace94736678747314adea2bcde681ca82c1f7cf905748b013b3f9da60` |
| 38 | google/gemini-3.8-flash:matrix:code:large:1 | 183828 | 192020 | 1024 | 0.25 | 0.147855000000 | `5bad434d35c819254299a54928cfbe8f5f0e415feffe049dda83507ba22f085c` |
| 39 | google/gemini-3.8-flash:matrix:code:large:2 | 188743 | 196935 | 1024 | 0.25 | 0.151541250000 | `6da8f4e8b53c2de153a00918dde0350c564b4eff5d3c52c4cfe0b006e89efcfb` |
| 40 | google/gemini-3.8-flash:matrix:code:large:3 | 196608 | 204800 | 1024 | 0.25 | 0.157440000000 | `9db98c8ea50a4e3336a65b00f522865a9fb41bd7d8e89d5b5e189ed80c4a4b41` |
| 41 | google/gemini-3.8-flash:matrix:json:small:0 | 436 | 8628 | 1024 | 0.25 | 0.010311000000 | `486998ab678c47b3d12f209b260ef476edd428e99260abb1702a02344af496e1` |
| 42 | google/gemini-3.8-flash:matrix:json:small:1 | 3829 | 12021 | 1024 | 0.25 | 0.012855750000 | `e1ac6bfc93d84ad7a1dd6f5ab362d1ebf1b97cd0904c682ef5b1c319fc712bd5` |
| 43 | google/gemini-3.8-flash:matrix:json:small:2 | 3932 | 12124 | 1024 | 0.25 | 0.012933000000 | `ac255721fe291a02b45dff212afcd616c6a614843a69a23548491b925a3a3a06` |
| 44 | google/gemini-3.8-flash:matrix:json:small:3 | 4096 | 12288 | 1024 | 0.25 | 0.013056000000 | `314676fd87cbe588cc5552cc06fab88b128d1db9c9adb568c088f30b09da34fb` |
| 45 | google/gemini-3.8-flash:matrix:json:medium:0 | 29818 | 38010 | 1024 | 0.25 | 0.032347500000 | `c0447f6caba1e433e8be8c4d47656e99b1e497db5881dde9988d2822496e53f2` |
| 46 | google/gemini-3.8-flash:matrix:json:medium:1 | 30638 | 38830 | 1024 | 0.25 | 0.032962500000 | `c304b9fa063c6711c242d89f10f760c28f804214715d22c32c137aa972ff0ad0` |
| 47 | google/gemini-3.8-flash:matrix:json:medium:2 | 31457 | 39649 | 1024 | 0.25 | 0.033576750000 | `7f17a991520a4751728a66408fa0c1cad02b8180299f3e42911c0bd3f19f78ec` |
| 48 | google/gemini-3.8-flash:matrix:json:medium:3 | 32768 | 40960 | 1024 | 0.25 | 0.034560000000 | `58674c564f4fdceadb79d92b1f1abb827b6daa41b349add278d7dd6e335adf42` |
| 49 | google/gemini-3.8-flash:matrix:json:large:0:r3 | 178913 | 187105 | 1024 | 0.25 | 0.144168750000 | `5cdf867cee3fd155cfbd0c1882323846fb03e24389914c379bfcd3c16be8c3c6` |
| 50 | google/gemini-3.8-flash:matrix:json:large:1:r3 | 183828 | 192020 | 1024 | 0.25 | 0.147855000000 | `f306218d6c8c751a515fcb776b9c9e2f494afb89ba09a1129e24358e20127d4d` |
| 51 | google/gemini-3.8-flash:matrix:json:large:2:r3 | 188743 | 196935 | 1024 | 0.25 | 0.151541250000 | `10df53623fbac9377b1cf9b49c9e2817f06c39b0013f01cd28ff14a7ba96d578` |
| 52 | google/gemini-3.8-flash:matrix:json:large:3:r3 | 196608 | 204800 | 1024 | 0.25 | 0.157440000000 | `1f7af59b694762931ec94832950be8144a6f5acceb38f8ca47f3fc4be7bc7134` |
| 53 | google/gemini-3.8-flash:matrix:tools:small:0 | 701 | 8893 | 1024 | 0.25 | 0.010509750000 | `0cac18843931682224fd36f4d7fe2af94587abaf8e4bf1df1d648c09ed366617` |
| 54 | google/gemini-3.8-flash:matrix:tools:small:1 | 3829 | 12021 | 1024 | 0.25 | 0.012855750000 | `47422b77b8731f0a1b2bb926a641aa7424e2adac1de8bd0a19e60413e880b955` |
| 55 | google/gemini-3.8-flash:matrix:tools:small:2 | 3932 | 12124 | 1024 | 0.25 | 0.012933000000 | `af4e54b4ccfc6eade8c369e30b3a10313ce59a61dee4f025ddca60e29283e1c2` |
| 56 | google/gemini-3.8-flash:matrix:tools:small:3 | 4096 | 12288 | 1024 | 0.25 | 0.013056000000 | `9648120ddc1da2d03cea9327918ff5b4a70a2d4cc5e1152cc2bee1d47aadf5ca` |
| 57 | google/gemini-3.8-flash:matrix:tools:medium:0 | 29818 | 38010 | 1024 | 0.25 | 0.032347500000 | `cd73fa357e08c13c675a3f9ae28196197c72265c723028adece42d6530bcb19e` |
| 58 | google/gemini-3.8-flash:matrix:tools:medium:1 | 30638 | 38830 | 1024 | 0.25 | 0.032962500000 | `c357c3961f1220a708e72f7f4f919eca01295393ce9d16ac5b8de4a45f038584` |
| 59 | google/gemini-3.8-flash:matrix:tools:medium:2 | 31457 | 39649 | 1024 | 0.25 | 0.033576750000 | `38b2bf1dcb05dbc1e14a2496a48c1b15e3352ba01252fc401f72568ba723f07e` |
| 60 | google/gemini-3.8-flash:matrix:tools:medium:3 | 32768 | 40960 | 1024 | 0.25 | 0.034560000000 | `a8027487d890b81af0dc022feae3f0f5de249fc3d665596eb70c263b50706933` |
| 61 | google/gemini-3.8-flash:matrix:tools:large:0 | 178913 | 187105 | 1024 | 0.25 | 0.144168750000 | `8f6bff31c2f2d5effc56699754f1bec9c38537522ec328edcd23648015f34eb7` |
| 62 | google/gemini-3.8-flash:matrix:tools:large:1 | 183828 | 192020 | 1024 | 0.25 | 0.147855000000 | `95f1c4968d603d5a2e9c51251534f40a797909a593e147c4a978fab489ce74ec` |
| 63 | google/gemini-3.8-flash:matrix:tools:large:2 | 188743 | 196935 | 1024 | 0.25 | 0.151541250000 | `29975dbd3277d9378e5f93d7a183eba94093091063494661285db5e05926ca64` |
| 64 | google/gemini-3.8-flash:matrix:tools:large:3 | 196608 | 204800 | 1024 | 0.25 | 0.157440000000 | `b1300ca08729de7c15f9e73fe296b6e766a2d2d4b36d69158e794f201668548c` |
| 65 | google/gemini-3.8-flash:messages:english:short-64:0 | 16384 | 24576 | 1024 | 0.25 | 0.022272000000 | `c3258fb88dd88bc4707ff31cf496f7374db8597db0f8e7d6951f0cf81c2758f7` |
| 66 | google/gemini-3.8-flash:messages:english:short-64:1 | 16384 | 24576 | 1024 | 0.25 | 0.022272000000 | `5c2a1b2ec13c65539a27eaa903ed0cf2bf94b167fd7346f81ae3ee75880466d7` |
| 67 | google/gemini-3.8-flash:messages:english:long-64:0 | 180000 | 188192 | 1024 | 0.25 | 0.144984000000 | `5643c266257e05bfc8a35dbef6ff6d7c34f3b12c5a5b4e015c3aa6a577ac9d1a` |
| 68 | google/gemini-3.8-flash:messages:english:long-64:1 | 180000 | 188192 | 1024 | 0.25 | 0.144984000000 | `e6e0fbea30a7821f8917a926df6eb881f60a2f61eb10eab7fb99fc10b997f3a2` |
| 69 | google/gemini-3.8-flash:messages:english:short-96:0 | 16384 | 24576 | 1024 | 0.25 | 0.022272000000 | `1ba3c09c44b23647201c7661fa0c4b568555419b4bf4f79bd53e2d2b82e5dc41` |
| 70 | google/gemini-3.8-flash:messages:english:short-96:1 | 16384 | 24576 | 1024 | 0.25 | 0.022272000000 | `1c269ce07b44933b5385f3b55cd7414d874d7aee871c8c58cbf2e564d6abb6a5` |
| 71 | google/gemini-3.8-flash:messages:english:long-96:0 | 180000 | 188192 | 1024 | 0.25 | 0.144984000000 | `cf5847b21a7b9bdf3266fa38f635085822bf27a9f5e03a75d1738936864f7406` |
| 72 | google/gemini-3.8-flash:messages:english:long-96:1 | 180000 | 188192 | 1024 | 0.25 | 0.144984000000 | `504bd416692e2232b956b8052a949c0d69028ea79f5b659bdd8abcca409581a2` |
| 73 | google/gemini-3.8-flash:messages:english:short-128:0 | 16384 | 24576 | 1024 | 0.25 | 0.022272000000 | `8738378fa5c92e8e87ce6c0a1844ab1282b51d8df2e66ea4d1e43e1e63479560` |
| 74 | google/gemini-3.8-flash:messages:english:short-128:1 | 16384 | 24576 | 1024 | 0.25 | 0.022272000000 | `fd41e61a14586b57fb29e90c88dc3f86b5475a8332a0e3a336cc26a261cda73b` |
| 75 | google/gemini-3.8-flash:messages:english:long-128:0 | 180000 | 188192 | 1024 | 0.25 | 0.144984000000 | `3d91e3c96e538ecf5860397bb947e4fd0bc77b9432a466e051c8fee4ff0d3eea` |
| 76 | google/gemini-3.8-flash:messages:english:long-128:1 | 180000 | 188192 | 1024 | 0.25 | 0.144984000000 | `3f443668ffde5c581e28bd8534d897e2ce9774f23dddbc370a8a317f0b8efcb2` |
| 77 | openai/gpt-6-luna:route:organizer:serial-tools-v6-reasoning:0:4096:r5b | 4096 | 12288 | 1024 | 0.05 | 0.002048000000 | `fb40f3f2542c4dd34fccfc9f16903e63c44d0aa0bf95473cab4d8e72e6f07095` |
| 78 | openai/gpt-6-luna:route:organizer:serial-tools-v6-reasoning:0:196608:r5b | 196608 | 204800 | 1024 | 0.05 | 0.026112000000 | `64df032b24b32c7c6d626dfec12937606927987a99d7c89e138d14c64517ad34` |
| 79 | openai/gpt-6-luna:route:organizer:serial-tools-v6-reasoning:1:4096:r5b | 4096 | 12288 | 1024 | 0.05 | 0.002048000000 | `93e5b6f157d495e40a837111e91f085784b3c4bfd1854b562410beee4fe00b58` |
| 80 | openai/gpt-6-luna:route:organizer:serial-tools-v6-reasoning:1:196608:r5b | 196608 | 204800 | 1024 | 0.05 | 0.026112000000 | `7ab5ab0026ac99cc3aa5e56b55822844394045cdf2b143bcaa0b32c77e3aaa3b` |
| 81 | openai/gpt-6-luna:route:attached_organizer:serial-tools-v6-reasoning:0:4096:r5b | 4096 | 12288 | 1024 | 0.05 | 0.002048000000 | `7282d208b89a5c6a6c90f04548c69931509e6dc91d83dfbf308f7c866f0b46c1` |
| 82 | openai/gpt-6-luna:route:attached_organizer:serial-tools-v6-reasoning:0:196608:r5b | 196608 | 204800 | 1024 | 0.05 | 0.026112000000 | `c8dc64569064d999a165acd5efac82d3c79655f3f310e50904ecfc6b26c8eba9` |
| 83 | openai/gpt-6-luna:route:attached_organizer:serial-tools-v6-reasoning:1:4096:r5b | 4096 | 12288 | 1024 | 0.05 | 0.002048000000 | `97c694b37144e392b29bee33844b14cfb3a43ebf6e75595f9a972547948ba14f` |
| 84 | openai/gpt-6-luna:route:attached_organizer:serial-tools-v6-reasoning:1:196608:r5b | 196608 | 204800 | 1024 | 0.05 | 0.026112000000 | `285b6563a42b5518e59e345549e1bbea210fccb1cfeac005d31541adf015fe9b` |
| 85 | openai/gpt-6-luna:route:attached_organizer:serial-tools-v4-stream:0:4096:r5b | 4096 | 12288 | 1024 | 0.05 | 0.002048000000 | `03425cc4d81de3faa1767dbcd181550c238c8068a058cbad480bcc68a4f8b111` |
| 86 | openai/gpt-6-luna:route:attached_organizer:serial-tools-v4-stream:0:196608:r5b | 196608 | 204800 | 1024 | 0.05 | 0.026112000000 | `623f1e60c96aa23f62e99bfc5fdb9e1682ce30df31993709840fe52f067d7937` |
| 87 | openai/gpt-6-luna:route:attached_organizer:serial-tools-v4-stream:1:4096:r5b | 4096 | 12288 | 1024 | 0.05 | 0.002048000000 | `876037795b20b7aa61daf32b5fc9e1d5c95ef080658b66d23398a84d7fd20981` |
| 88 | openai/gpt-6-luna:route:attached_organizer:serial-tools-v4-stream:1:196608:r5b | 196608 | 204800 | 1024 | 0.05 | 0.026112000000 | `d5b6e7c603820ba16741269b41ac84247cf80ce1775eb5cb7478969416396f3b` |
| 89 | openai/gpt-6-luna:route:attached_organizer:agent-turn-v5-stream:0:4096:r5b | 4096 | 12288 | 1024 | 0.05 | 0.002048000000 | `2c8523e8703384a86b126375583099e6978b5426025611289346bfebd7b7e7f9` |
| 90 | openai/gpt-6-luna:route:attached_organizer:agent-turn-v5-stream:0:196608:r5b | 196608 | 204800 | 1024 | 0.05 | 0.026112000000 | `b6d160c41255b49c98dc5130000fb1b78c2486db5d74b038aacc5148554fa446` |
| 91 | openai/gpt-6-luna:route:attached_organizer:agent-turn-v5-stream:1:4096:r5b | 4096 | 12288 | 1024 | 0.05 | 0.002048000000 | `0003c91cd674293b17829ecae57327d4d711fcef5b4d773e64f5084a492913f7` |
| 92 | openai/gpt-6-luna:route:attached_organizer:agent-turn-v5-stream:1:196608:r5b | 196608 | 204800 | 1024 | 0.05 | 0.026112000000 | `c5f8ed8962f203cfec2770d23a0eb2f60b544373cc177c9111b08894d68943e3` |
| 93 | anthropic/claude-sonnet-5.5:output:chinese:output-stress:0:r5b | 4096 | 12288 | 2048 | 0.50 | 0.051200000000 | `5c83223a957cdb02b6883096ab6883d45c04bbda8590e9535265f7d452ae186a` |
| 94 | anthropic/claude-sonnet-5.5:output:code:output-stress:1:r5b | 4096 | 12288 | 2048 | 0.50 | 0.051200000000 | `2cfebe218fec1cfd809ca64709085b0fcbe0bbca83f2e4559a1650c54c3bf618` |
| 95 | anthropic/claude-sonnet-5.5:output:chinese:output-stress:2:r5b | 4096 | 12288 | 2048 | 0.50 | 0.051200000000 | `93905de61f4c8c4cedf4500fa469c869047846a54f46b09d02c6e889c9eebfce` |
| 96 | anthropic/claude-sonnet-5.5:output:code:output-stress:3:r5b | 4096 | 12288 | 2048 | 0.50 | 0.051200000000 | `0edfe965dac22d503ed961979d631b2bb9f535bfcbbcbf841ef821f4ff335974` |

## 离线复现与边界

```bash
node scripts/payg-profile.mjs plan scripts/payg-profile/plan-prices.json /tmp/payg-r5b.json r5b
cmp docs/launch/evidence/payg-profile-20261006-r5b.manifest.json /tmp/payg-r5b.json
```

运行命令见[执行器文档](BILL_PAYG_PROFILE_EXECUTOR.md)，但当前没有执行授权。本轮不加载凭据，不运行该入口。
原四批锁、日志、原始回执完整保留；原r5清单保留作历史证据，不能执行。
当前0172迁移重号保留，最终按主窗口安排改0176并重建指纹；本轮不改号、不访问远端数据库、不改配置、不合并。
