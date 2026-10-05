# BILL-PAYG r6 离线预演

> 已作废且未执行：Owner要求Gemini改AI Studio，后续只准备 [r7](BILL_PAYG_PROFILE_R7.md)。本页为历史离线记录，不得执行；历史复现须使用 plan-prices-vertex-2026-10-05.json。

**r6 准备完成，等待复核。真实请求 NOT_RUN。**

依据：[主窗口审计与判定决定](https://github.com/Crnobog9527/GraylumAI_vercel/pull/665#issuecomment-6000858032)。风险 high；本轮只准备，不访问远端数据库、不改配置、不合并。

- 批次：`payg-profile-20261006-r6`；manifestHash：`abf06bcc4c8db71f2f121fcd58de75e6996dd54f8666dc3c60fb6455945f55a2`。
- 清单：[完整 manifest](evidence/payg-profile-20261006-r6.manifest.json)。输出判定、未达标继续策略、前批账务和保留证据均参与 hash。
- 本批95条：Gemini75（3输出、60矩阵、12多消息）、Luna整理适配16、Sonnet输出4。
- requestHash、请求正文、单价、每条上界与 r5b 剩余95条逐一相同；ID保留旧批次后缀用于追溯，不能据后缀重跑旧批次。
- 本批上界 **$5.385264750000**；已入账 **$4.991984715000**；累计上界 **$10.377249465000 < $25**。
- Gemini $4.955184750000；Luna $0.225280000000；Sonnet $0.204800000000。单条批准上限不变。

## 判定与保留证据

输出压力合格条件为 finish_reason=length 且 0.9O ≤ 原生completion（含reasoning）≤ O。整数实现使用10×completion ≥ 9×O，512下最低461，2048下最低1844。
费用和输入/缓存等所有既有边界先校验；只允许 OUTPUT_CAP_NOT_REACHED 记录费用与失败后继续，不能计入合格样本。O+1、未知费用、拒绝、线路/目录不可用、身份/hash失败仍停止；不得补跑。

r5b首条 requestHash `667b0ed2d0985766035f6f4d2ce6820003b719c3c773180e71ddc745dcb18521`：Gemini不传reasoning参数，P=1029，B=4096，O=512，completion=508（含reasoning489），length，费用$0.00267675；新标准合格。
保留原始 OUTPUT_CAP_NOT_REACHED、原 outputCapReached=false；r6 retainedEvidence单独记录新判定、规则和决定引用，不改写旧本机材料。原回执hash `987ec0948072fb59d478fccf9ba88a64341cd61f93e74388ba87399a7b55306c`。
已合格证据共156条；该首条不在r6发送清单。旧manifest无新判定字段时仍按历史严格相等解释，便于复核当时停批。

## 前批账务

| manifestHash | 已入账USD | 原始未知费用的审计处理 |
| --- | ---: | --- |
| `4289cffc98ac5fda57b46e93e8a7e3d083b30ab71223428a961d118593bad9c5` | 0.000000000000 | 固定身份的Owner确认$0；原UNKNOWN不改写 |
| `596c57a3839de657e46058d16d8a558af2c84d3ea4b79b74e80a9b96e4a10ef7` | 2.596497700000 | 固定身份的Owner确认$0；原UNKNOWN不改写 |
| `3cbeb87e1e9895527cf8e56c611337c897ef28bb7df637412724c05949be5e74` | 2.213641800000 | 费用已确认 |
| `04e92dfa3a33a49090c853da83cf088b5d83555ac447b92760a5b3461725f1db` | 0.179168465000 | 固定身份的Owner确认$0；原UNKNOWN不改写 |
| `4f8002e7989930cbf5cddd6ea2cae04e46548a196a885ac607a9b5f579b2990d` | 0.002676750000 | 费用已确认 |

有旧锁时对账金额、未知数量和固定例外身份必须完全匹配。r5b已知费用和历史未合格状态能正常对账，不把它改写为零。原r5从未执行且作废。

## 尚需实测的覆盖

Gemini保留none档第1条，新批再含none第2条、low两条，O=512；Sonnet none/low各两条，O=2048。Luna复用r4 none/low各两条512证据，16条整理适配为O=1024，不冒充输出压力。
Gemini的64/96/128多消息仍须本批完成后判定。Sonnet/Luna已有60矩阵和12多消息合格；Sonnet输出语义、Luna整理用途仍待本批证据。保留已有Sonnet一条8192精确触顶观测。
全部所需格子合格后，testedOutputLimit如实填写512或2048，profile.outputLimit可按已批准语义使用8192；未覆盖用途/格式不列入。只在PR提出建议，不应用配置。

## 每条上界（实际费用均 NOT_RUN）

| # | sampleId | requestHash | O | 上界USD |
| ---: | --- | --- | ---: | ---: |
| 1 | `google/gemini-3.8-flash:output:code:output-stress:1:r5b` | `98b63a092ce9ecdc27d6e35a8169729ddd3edf12a36542dd68e7d925f3d596e3` | 512 | 0.011136000000 |
| 2 | `google/gemini-3.8-flash:output:chinese:output-stress:2:r5b` | `0da15d873aefe81676e853d6779e204d611b2f546c693f65ca632e63a81f7cbb` | 512 | 0.011136000000 |
| 3 | `google/gemini-3.8-flash:output:code:output-stress:3:r5b` | `6127ee14cec05f3af5ea412885cf8035d59d2a8c17e92e993096482a62a4caba` | 512 | 0.011136000000 |
| 4 | `google/gemini-3.8-flash:matrix:chinese:small:0` | `5871302ba3ec68048b2746bb87e10a9a233492e1f8fcbc609b736934172897b6` | 1024 | 0.010313250000 |
| 5 | `google/gemini-3.8-flash:matrix:chinese:small:1` | `942b2ba01fe388d14fdf1008708160dd5dfe81145c3f7407aeaa8b91c0a16716` | 1024 | 0.012855750000 |
| 6 | `google/gemini-3.8-flash:matrix:chinese:small:2` | `f8cc08ead704fe31b0b5a8aadf1924b7f52d770053234c05e6731f056c8b6b63` | 1024 | 0.012933000000 |
| 7 | `google/gemini-3.8-flash:matrix:chinese:small:3` | `35ec0fd9d0ec664effbe6f3a70a250a72021bcf62c337443c18585c2cd4b0e5f` | 1024 | 0.013056000000 |
| 8 | `google/gemini-3.8-flash:matrix:chinese:medium:0` | `bb691d5719336847998d60ce999cda2c02f6b96d59ae89cf70c0f0afd7c5da91` | 1024 | 0.032347500000 |
| 9 | `google/gemini-3.8-flash:matrix:chinese:medium:1` | `971b873448abf9d5c0bb0dc5fc1ef5f19ac820d9f3865bafca783303b2938e75` | 1024 | 0.032962500000 |
| 10 | `google/gemini-3.8-flash:matrix:chinese:medium:2` | `918a91dbd9fac336f106731e65c05d050201bfdecffc5665e8f084f04f382198` | 1024 | 0.033576750000 |
| 11 | `google/gemini-3.8-flash:matrix:chinese:medium:3` | `6add7cecb28b5ca5a982c49cd70fbcc484704714bd8fd252174901a3453cdba1` | 1024 | 0.034560000000 |
| 12 | `google/gemini-3.8-flash:matrix:chinese:large:0` | `e4943d2a5af251f02b2910cf2a9f7abc9809513d7ae6c4d088f8f81cfc4b1f29` | 1024 | 0.144168750000 |
| 13 | `google/gemini-3.8-flash:matrix:chinese:large:1` | `658efa1b3d3b9708c9687c0842b1621d8ced0e3560840f3a3d0eb1a234eaa4e0` | 1024 | 0.147855000000 |
| 14 | `google/gemini-3.8-flash:matrix:chinese:large:2` | `7d5b992af20a956627dac44704fb5864d6da249f71c9af1d6ac69ac85bbd62df` | 1024 | 0.151541250000 |
| 15 | `google/gemini-3.8-flash:matrix:chinese:large:3` | `210b9debf0f4a6a09141b666a13d6aa061470aeb0d71f375857b2ae578880112` | 1024 | 0.157440000000 |
| 16 | `google/gemini-3.8-flash:matrix:english:small:0` | `3d877870c8fcc8e7115cb86298ef34709f993cdef2a05523c7ad1e22857cdb05` | 1024 | 0.010313250000 |
| 17 | `google/gemini-3.8-flash:matrix:english:small:1` | `7e0d4d504600e72dfc85184f8171671dfe51de26afb2d481fdd4bb48d9a4de56` | 1024 | 0.012855750000 |
| 18 | `google/gemini-3.8-flash:matrix:english:small:2` | `772d40d39108e98e173055d4ba71db2f4fc16c0e697b295239720c2b15c1c6f2` | 1024 | 0.012933000000 |
| 19 | `google/gemini-3.8-flash:matrix:english:small:3` | `25622dd3e5d37f81add6468ee93239c765ddb0fa947db6bcdb998f6750de8de7` | 1024 | 0.013056000000 |
| 20 | `google/gemini-3.8-flash:matrix:english:medium:0` | `a335a5c8142a1d6a6e7f8dba5b923f79a4c54e9c8c7f0389c7479a1ff0cfefc5` | 1024 | 0.032347500000 |
| 21 | `google/gemini-3.8-flash:matrix:english:medium:1` | `0fbb40830daaed7927cfc786aa03c4437c2b0464527ab8d3c9170376d0e5ceb6` | 1024 | 0.032962500000 |
| 22 | `google/gemini-3.8-flash:matrix:english:medium:2` | `0283d1ab6d38bfbc0722ee6fb1e2c6436dbfae522d46a453d3ad56fc3d46d18f` | 1024 | 0.033576750000 |
| 23 | `google/gemini-3.8-flash:matrix:english:medium:3` | `fe23e1e0f597ce38d09c2b50cc40feaceb3bff9153417ad6ea55c9ff0e655ab0` | 1024 | 0.034560000000 |
| 24 | `google/gemini-3.8-flash:matrix:english:large:0` | `aeaea7528f91b91cb916520fc42bf56cf7d0804763d5cc8a469bdc615a053789` | 1024 | 0.144168750000 |
| 25 | `google/gemini-3.8-flash:matrix:english:large:1` | `2435528a521114cee0d351a495d581c7c4dabddf13a6fe5d17620c5c75b21f62` | 1024 | 0.147855000000 |
| 26 | `google/gemini-3.8-flash:matrix:english:large:2` | `0613f574f63150343963b039dd9e31e2fab0efcc800238e7e6fbe94e4e8b0d34` | 1024 | 0.151541250000 |
| 27 | `google/gemini-3.8-flash:matrix:english:large:3` | `5e7b0a3f65f1a9f5137726d4b13345141fcd23f5d45b39cc4b0265140e096fc0` | 1024 | 0.157440000000 |
| 28 | `google/gemini-3.8-flash:matrix:code:small:0` | `6cf3bd2ece80eeeb9e178bd455d5530b0b52cb21ebbd02c1f08f84f599fa5c85` | 1024 | 0.010311000000 |
| 29 | `google/gemini-3.8-flash:matrix:code:small:1` | `86f26650d84a10e0aa5fd16f3e1d0700fe1986cae94cd1253753157e2783a7fc` | 1024 | 0.012855750000 |
| 30 | `google/gemini-3.8-flash:matrix:code:small:2` | `138ca554831299998d04f8e1f88f64f23433248144cd95890653b64c6ea8fa38` | 1024 | 0.012933000000 |
| 31 | `google/gemini-3.8-flash:matrix:code:small:3` | `513d81a7964330d74306938aa199fbce291fce9cfa9359db7e3bd891d6bdc65d` | 1024 | 0.013056000000 |
| 32 | `google/gemini-3.8-flash:matrix:code:medium:0` | `90456346e6b2a7b0ca2c3374ecb208733015b90a00f8f32a40b059519bb1b0b7` | 1024 | 0.032347500000 |
| 33 | `google/gemini-3.8-flash:matrix:code:medium:1` | `a0b69924bfe5461bf8ec4407f892f2ec2ec188259f255930babeee802ea1ae73` | 1024 | 0.032962500000 |
| 34 | `google/gemini-3.8-flash:matrix:code:medium:2` | `2212d03293ebb8dbafb1c3da74baec9bbfc8b6051b24026ffc99aa58a32a6bc7` | 1024 | 0.033576750000 |
| 35 | `google/gemini-3.8-flash:matrix:code:medium:3` | `cd2f1f70a691edb3f4db4ff90a5cbc8829c1793b9787f71071915943722a8dc9` | 1024 | 0.034560000000 |
| 36 | `google/gemini-3.8-flash:matrix:code:large:0` | `511043eace94736678747314adea2bcde681ca82c1f7cf905748b013b3f9da60` | 1024 | 0.144168750000 |
| 37 | `google/gemini-3.8-flash:matrix:code:large:1` | `5bad434d35c819254299a54928cfbe8f5f0e415feffe049dda83507ba22f085c` | 1024 | 0.147855000000 |
| 38 | `google/gemini-3.8-flash:matrix:code:large:2` | `6da8f4e8b53c2de153a00918dde0350c564b4eff5d3c52c4cfe0b006e89efcfb` | 1024 | 0.151541250000 |
| 39 | `google/gemini-3.8-flash:matrix:code:large:3` | `9db98c8ea50a4e3336a65b00f522865a9fb41bd7d8e89d5b5e189ed80c4a4b41` | 1024 | 0.157440000000 |
| 40 | `google/gemini-3.8-flash:matrix:json:small:0` | `486998ab678c47b3d12f209b260ef476edd428e99260abb1702a02344af496e1` | 1024 | 0.010311000000 |
| 41 | `google/gemini-3.8-flash:matrix:json:small:1` | `e1ac6bfc93d84ad7a1dd6f5ab362d1ebf1b97cd0904c682ef5b1c319fc712bd5` | 1024 | 0.012855750000 |
| 42 | `google/gemini-3.8-flash:matrix:json:small:2` | `ac255721fe291a02b45dff212afcd616c6a614843a69a23548491b925a3a3a06` | 1024 | 0.012933000000 |
| 43 | `google/gemini-3.8-flash:matrix:json:small:3` | `314676fd87cbe588cc5552cc06fab88b128d1db9c9adb568c088f30b09da34fb` | 1024 | 0.013056000000 |
| 44 | `google/gemini-3.8-flash:matrix:json:medium:0` | `c0447f6caba1e433e8be8c4d47656e99b1e497db5881dde9988d2822496e53f2` | 1024 | 0.032347500000 |
| 45 | `google/gemini-3.8-flash:matrix:json:medium:1` | `c304b9fa063c6711c242d89f10f760c28f804214715d22c32c137aa972ff0ad0` | 1024 | 0.032962500000 |
| 46 | `google/gemini-3.8-flash:matrix:json:medium:2` | `7f17a991520a4751728a66408fa0c1cad02b8180299f3e42911c0bd3f19f78ec` | 1024 | 0.033576750000 |
| 47 | `google/gemini-3.8-flash:matrix:json:medium:3` | `58674c564f4fdceadb79d92b1f1abb827b6daa41b349add278d7dd6e335adf42` | 1024 | 0.034560000000 |
| 48 | `google/gemini-3.8-flash:matrix:json:large:0:r3` | `5cdf867cee3fd155cfbd0c1882323846fb03e24389914c379bfcd3c16be8c3c6` | 1024 | 0.144168750000 |
| 49 | `google/gemini-3.8-flash:matrix:json:large:1:r3` | `f306218d6c8c751a515fcb776b9c9e2f494afb89ba09a1129e24358e20127d4d` | 1024 | 0.147855000000 |
| 50 | `google/gemini-3.8-flash:matrix:json:large:2:r3` | `10df53623fbac9377b1cf9b49c9e2817f06c39b0013f01cd28ff14a7ba96d578` | 1024 | 0.151541250000 |
| 51 | `google/gemini-3.8-flash:matrix:json:large:3:r3` | `1f7af59b694762931ec94832950be8144a6f5acceb38f8ca47f3fc4be7bc7134` | 1024 | 0.157440000000 |
| 52 | `google/gemini-3.8-flash:matrix:tools:small:0` | `0cac18843931682224fd36f4d7fe2af94587abaf8e4bf1df1d648c09ed366617` | 1024 | 0.010509750000 |
| 53 | `google/gemini-3.8-flash:matrix:tools:small:1` | `47422b77b8731f0a1b2bb926a641aa7424e2adac1de8bd0a19e60413e880b955` | 1024 | 0.012855750000 |
| 54 | `google/gemini-3.8-flash:matrix:tools:small:2` | `af4e54b4ccfc6eade8c369e30b3a10313ce59a61dee4f025ddca60e29283e1c2` | 1024 | 0.012933000000 |
| 55 | `google/gemini-3.8-flash:matrix:tools:small:3` | `9648120ddc1da2d03cea9327918ff5b4a70a2d4cc5e1152cc2bee1d47aadf5ca` | 1024 | 0.013056000000 |
| 56 | `google/gemini-3.8-flash:matrix:tools:medium:0` | `cd73fa357e08c13c675a3f9ae28196197c72265c723028adece42d6530bcb19e` | 1024 | 0.032347500000 |
| 57 | `google/gemini-3.8-flash:matrix:tools:medium:1` | `c357c3961f1220a708e72f7f4f919eca01295393ce9d16ac5b8de4a45f038584` | 1024 | 0.032962500000 |
| 58 | `google/gemini-3.8-flash:matrix:tools:medium:2` | `38b2bf1dcb05dbc1e14a2496a48c1b15e3352ba01252fc401f72568ba723f07e` | 1024 | 0.033576750000 |
| 59 | `google/gemini-3.8-flash:matrix:tools:medium:3` | `a8027487d890b81af0dc022feae3f0f5de249fc3d665596eb70c263b50706933` | 1024 | 0.034560000000 |
| 60 | `google/gemini-3.8-flash:matrix:tools:large:0` | `8f6bff31c2f2d5effc56699754f1bec9c38537522ec328edcd23648015f34eb7` | 1024 | 0.144168750000 |
| 61 | `google/gemini-3.8-flash:matrix:tools:large:1` | `95f1c4968d603d5a2e9c51251534f40a797909a593e147c4a978fab489ce74ec` | 1024 | 0.147855000000 |
| 62 | `google/gemini-3.8-flash:matrix:tools:large:2` | `29975dbd3277d9378e5f93d7a183eba94093091063494661285db5e05926ca64` | 1024 | 0.151541250000 |
| 63 | `google/gemini-3.8-flash:matrix:tools:large:3` | `b1300ca08729de7c15f9e73fe296b6e766a2d2d4b36d69158e794f201668548c` | 1024 | 0.157440000000 |
| 64 | `google/gemini-3.8-flash:messages:english:short-64:0` | `c3258fb88dd88bc4707ff31cf496f7374db8597db0f8e7d6951f0cf81c2758f7` | 1024 | 0.022272000000 |
| 65 | `google/gemini-3.8-flash:messages:english:short-64:1` | `5c2a1b2ec13c65539a27eaa903ed0cf2bf94b167fd7346f81ae3ee75880466d7` | 1024 | 0.022272000000 |
| 66 | `google/gemini-3.8-flash:messages:english:long-64:0` | `5643c266257e05bfc8a35dbef6ff6d7c34f3b12c5a5b4e015c3aa6a577ac9d1a` | 1024 | 0.144984000000 |
| 67 | `google/gemini-3.8-flash:messages:english:long-64:1` | `e6e0fbea30a7821f8917a926df6eb881f60a2f61eb10eab7fb99fc10b997f3a2` | 1024 | 0.144984000000 |
| 68 | `google/gemini-3.8-flash:messages:english:short-96:0` | `1ba3c09c44b23647201c7661fa0c4b568555419b4bf4f79bd53e2d2b82e5dc41` | 1024 | 0.022272000000 |
| 69 | `google/gemini-3.8-flash:messages:english:short-96:1` | `1c269ce07b44933b5385f3b55cd7414d874d7aee871c8c58cbf2e564d6abb6a5` | 1024 | 0.022272000000 |
| 70 | `google/gemini-3.8-flash:messages:english:long-96:0` | `cf5847b21a7b9bdf3266fa38f635085822bf27a9f5e03a75d1738936864f7406` | 1024 | 0.144984000000 |
| 71 | `google/gemini-3.8-flash:messages:english:long-96:1` | `504bd416692e2232b956b8052a949c0d69028ea79f5b659bdd8abcca409581a2` | 1024 | 0.144984000000 |
| 72 | `google/gemini-3.8-flash:messages:english:short-128:0` | `8738378fa5c92e8e87ce6c0a1844ab1282b51d8df2e66ea4d1e43e1e63479560` | 1024 | 0.022272000000 |
| 73 | `google/gemini-3.8-flash:messages:english:short-128:1` | `fd41e61a14586b57fb29e90c88dc3f86b5475a8332a0e3a336cc26a261cda73b` | 1024 | 0.022272000000 |
| 74 | `google/gemini-3.8-flash:messages:english:long-128:0` | `3d91e3c96e538ecf5860397bb947e4fd0bc77b9432a466e051c8fee4ff0d3eea` | 1024 | 0.144984000000 |
| 75 | `google/gemini-3.8-flash:messages:english:long-128:1` | `3f443668ffde5c581e28bd8534d897e2ce9774f23dddbc370a8a317f0b8efcb2` | 1024 | 0.144984000000 |
| 76 | `openai/gpt-6-luna:route:organizer:serial-tools-v6-reasoning:0:4096:r5b` | `fb40f3f2542c4dd34fccfc9f16903e63c44d0aa0bf95473cab4d8e72e6f07095` | 1024 | 0.002048000000 |
| 77 | `openai/gpt-6-luna:route:organizer:serial-tools-v6-reasoning:0:196608:r5b` | `64df032b24b32c7c6d626dfec12937606927987a99d7c89e138d14c64517ad34` | 1024 | 0.026112000000 |
| 78 | `openai/gpt-6-luna:route:organizer:serial-tools-v6-reasoning:1:4096:r5b` | `93e5b6f157d495e40a837111e91f085784b3c4bfd1854b562410beee4fe00b58` | 1024 | 0.002048000000 |
| 79 | `openai/gpt-6-luna:route:organizer:serial-tools-v6-reasoning:1:196608:r5b` | `7ab5ab0026ac99cc3aa5e56b55822844394045cdf2b143bcaa0b32c77e3aaa3b` | 1024 | 0.026112000000 |
| 80 | `openai/gpt-6-luna:route:attached_organizer:serial-tools-v6-reasoning:0:4096:r5b` | `7282d208b89a5c6a6c90f04548c69931509e6dc91d83dfbf308f7c866f0b46c1` | 1024 | 0.002048000000 |
| 81 | `openai/gpt-6-luna:route:attached_organizer:serial-tools-v6-reasoning:0:196608:r5b` | `c8dc64569064d999a165acd5efac82d3c79655f3f310e50904ecfc6b26c8eba9` | 1024 | 0.026112000000 |
| 82 | `openai/gpt-6-luna:route:attached_organizer:serial-tools-v6-reasoning:1:4096:r5b` | `97c694b37144e392b29bee33844b14cfb3a43ebf6e75595f9a972547948ba14f` | 1024 | 0.002048000000 |
| 83 | `openai/gpt-6-luna:route:attached_organizer:serial-tools-v6-reasoning:1:196608:r5b` | `285b6563a42b5518e59e345549e1bbea210fccb1cfeac005d31541adf015fe9b` | 1024 | 0.026112000000 |
| 84 | `openai/gpt-6-luna:route:attached_organizer:serial-tools-v4-stream:0:4096:r5b` | `03425cc4d81de3faa1767dbcd181550c238c8068a058cbad480bcc68a4f8b111` | 1024 | 0.002048000000 |
| 85 | `openai/gpt-6-luna:route:attached_organizer:serial-tools-v4-stream:0:196608:r5b` | `623f1e60c96aa23f62e99bfc5fdb9e1682ce30df31993709840fe52f067d7937` | 1024 | 0.026112000000 |
| 86 | `openai/gpt-6-luna:route:attached_organizer:serial-tools-v4-stream:1:4096:r5b` | `876037795b20b7aa61daf32b5fc9e1d5c95ef080658b66d23398a84d7fd20981` | 1024 | 0.002048000000 |
| 87 | `openai/gpt-6-luna:route:attached_organizer:serial-tools-v4-stream:1:196608:r5b` | `d5b6e7c603820ba16741269b41ac84247cf80ce1775eb5cb7478969416396f3b` | 1024 | 0.026112000000 |
| 88 | `openai/gpt-6-luna:route:attached_organizer:agent-turn-v5-stream:0:4096:r5b` | `2c8523e8703384a86b126375583099e6978b5426025611289346bfebd7b7e7f9` | 1024 | 0.002048000000 |
| 89 | `openai/gpt-6-luna:route:attached_organizer:agent-turn-v5-stream:0:196608:r5b` | `b6d160c41255b49c98dc5130000fb1b78c2486db5d74b038aacc5148554fa446` | 1024 | 0.026112000000 |
| 90 | `openai/gpt-6-luna:route:attached_organizer:agent-turn-v5-stream:1:4096:r5b` | `0003c91cd674293b17829ecae57327d4d711fcef5b4d773e64f5084a492913f7` | 1024 | 0.002048000000 |
| 91 | `openai/gpt-6-luna:route:attached_organizer:agent-turn-v5-stream:1:196608:r5b` | `c5f8ed8962f203cfec2770d23a0eb2f60b544373cc177c9111b08894d68943e3` | 1024 | 0.026112000000 |
| 92 | `anthropic/claude-sonnet-5.5:output:chinese:output-stress:0:r5b` | `5c83223a957cdb02b6883096ab6883d45c04bbda8590e9535265f7d452ae186a` | 2048 | 0.051200000000 |
| 93 | `anthropic/claude-sonnet-5.5:output:code:output-stress:1:r5b` | `2cfebe218fec1cfd809ca64709085b0fcbe0bbca83f2e4559a1650c54c3bf618` | 2048 | 0.051200000000 |
| 94 | `anthropic/claude-sonnet-5.5:output:chinese:output-stress:2:r5b` | `93905de61f4c8c4cedf4500fa469c869047846a54f46b09d02c6e889c9eebfce` | 2048 | 0.051200000000 |
| 95 | `anthropic/claude-sonnet-5.5:output:code:output-stress:3:r5b` | `0edfe965dac22d503ed961979d631b2bb9f535bfcbbcbf841ef821f4ff335974` | 2048 | 0.051200000000 |

离线复现：

```bash
node scripts/payg-profile.mjs plan scripts/payg-profile/plan-prices-vertex-2026-10-05.json /tmp/payg-r6-manifest.json r6
```

执行入口见[执行器文档](BILL_PAYG_PROFILE_EXECUTOR.md)，本轮没有运行。旧批次锁和记录保持原样，最终迁移0176另由主窗口安排。
