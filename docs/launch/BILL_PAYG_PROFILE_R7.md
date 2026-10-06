# BILL-PAYG r7：AI Studio线路离线预演

**r7 准备完成，等待复核。真实模型请求 NOT_RUN。**

依据：[Owner线路决定](https://github.com/Crnobog9527/GraylumAI_vercel/pull/665#issuecomment-6001418763)。风险high；本轮只准备，不访问远端数据库、不改环境配置、不合并。

- 批次 `payg-profile-20261006-r7`，manifestHash `72e0b6a4a347d816b06de0752f823a4a3cf9318ef1b5e3732c0bc49fd9b012b2`。
- [完整清单](evidence/payg-profile-20261006-r7.manifest.json)。r6本机状态目录不存在，确认未执行；旧批次锁和材料保留。
- 96条：Gemini AI Studio 76（60矩阵+12多消息+none/low各2输出）、Luna整理16、Sonnet输出4。
- 本批上界 **$5.396385750000**；已入账 **$4.991984715000**；累计上界 **$10.388370465000 < $25**。
- Gemini $4.966305750000；Luna $0.225280000000；Sonnet $0.204800000000。单条批准上限不变。

## 公开目录核实

[OpenRouter精确endpoint目录](https://openrouter.ai/api/v1/models/google/gemini-3.8-flash/endpoints)与[模型目录](https://openrouter.ai/api/v1/models)，
快照见 `scripts/payg-profile/catalog-2026-10-06-r7.json`；Gemini检索时间见快照retrievedAt，其他两路保留2026-10-05冻结报价。
完整tag为`google-ai-studio`，provider_name为`Google AI Studio`，status=0，context=1048576 ≥212992，max_completion_tokens=65536。支持隐式缓存、工具及reasoning_effort。
模型目录reasoning mandatory=true、default_enabled=true、默认medium，supported_efforts=high/medium/low。不传参数不等于关闭思考；两种实际wire为不传reasoning参数、reasoning_effort=low，均require_parameters=true。

| 项目 | 原始USD/token或request | 计划USD/百万token或request |
| --- | ---: | ---: |
| 输入 | 0.00000075 | 0.750000000000 |
| 输出（含内部reasoning） | 0.00000375 | 3.750000000000 |
| 缓存读 | 0.000000075 | 0.075000000000 |
| 缓存写 | 0.0000000416666666666667 | 0.041666666667（向上取整） |
| 请求费 | 目录未列，按0 | 0 |

完整其他价格字段保留快照（图像/音频、搜索等），本批纯文本、不调用服务端搜索/媒体或缓存存储API。discount字段不再次折算，直接采用pricing原值。
provider.only仅含google-ai-studio，allow_fallbacks=false，无service_tier。依据[官方路由文档](https://openrouter.ai/docs/guides/routing/provider-selection#targeting-specific-provider-endpoints)，裸tag不会选入需要显式opt-in的flex/priority；新增非服务档位后缀会被目录预检拒绝。
输出上限含reasoning的契约来源沿用[Gemini文档](https://ai.google.dev/gemini-api/docs/generate-content/thinking#token-limits-and-max_output_tokens)；本线路仍须实测，不能用目录能力代替实测通过。

## 请求、证据与账务

Gemini全部重新生成，ID新增r7后缀。60矩阵和12多消息仍覆盖64/96/128；4输出压力O=512，length且0.9O≤completion（含reasoning）≤O才合格，超过O仍立即停批。
OUTPUT_CAP_NOT_REACHED记录失败与费用后继续，不能算合格证据；未知费用、拒绝、线路/目录不可用、身份/hash失败与越界仍停，不补跑。
Luna整理16、Sonnet输出4的完整请求正文、ID、requestHash、逐条上界均与r6完全一致；构建器拒绝这两路价格/能力变化。Sonnet O=2048，Luna适配O=1024，不能冒充输出压力。
原155条Sonnet/Luna合格证据保留。Vertex首条508/512放在excludedRouteEvidence，仅用于历史审计，不计入AI Studio的输出/矩阵/多消息证据；Gemini AI Studio目前全部证据为0。
五批已入账合计$4.991984715，含r5b $0.002676750000。r1首条/r2第49条/r4第77条仅按已有固定身份的Owner核实$0处理，原UNKNOWN不改写；r5b已知费用不改。
新入口拒绝所有旧manifest。原r5或r6若出现未纳入账务的attempted.lock，在任何新请求之前停止为SUPERSEDED_BATCH_ATTEMPTED，不删除锁。
未来profile新准入固定绑定同步为AI Studio；只有模型、精确tag、实际报价与完整证据相符才可使用。拒绝Vertex、flex、priority和跨线路组合；旧冻结执行继续使用旧报价。没有改变实际staging路由或设置。

## 每条费用上界（实际执行均 NOT_RUN）

| # | sampleId | requestHash | O | 上界USD |
| ---: | --- | --- | ---: | ---: |
| 1 | `google/gemini-3.8-flash:output:chinese:output-stress:0:r5:r7` | `973ea8967e527e88237c4a0eb2575b94081c6d7daa4a0acd8f75751ce16b6293` | 512 | 0.011136000000 |
| 2 | `google/gemini-3.8-flash:output:code:output-stress:1:r5:r7` | `977b96096be7c7ddf8bfe5bdbe1413cdf8fd0c1347c24fad9900673ce0f8e6a7` | 512 | 0.011136000000 |
| 3 | `google/gemini-3.8-flash:output:chinese:output-stress:2:r5:r7` | `8777e4295be576caf95d323bd94589700df868182843bf7549be5fa8187a8bf3` | 512 | 0.011136000000 |
| 4 | `google/gemini-3.8-flash:output:code:output-stress:3:r5:r7` | `0cc734cf3bfa82c44ece25ee9de8a8520baeb0409ab398a29b540d56f0f85242` | 512 | 0.011136000000 |
| 5 | `google/gemini-3.8-flash:matrix:chinese:small:0:r7` | `274b6b0b23e7a3505f03d6e75958f7cf6f567091502e5bfc4c7ff742fa89fcae` | 1024 | 0.010310250000 |
| 6 | `google/gemini-3.8-flash:matrix:chinese:small:1:r7` | `26cad16a50f8504fdfd906534ba865b10f86b8e4f8dff2f8e55fad6a4f35f1e6` | 1024 | 0.012855750000 |
| 7 | `google/gemini-3.8-flash:matrix:chinese:small:2:r7` | `8a2d9de8f8113f7dbba472ba48b7035bb505236d94b68d518840e736c8d162d0` | 1024 | 0.012933000000 |
| 8 | `google/gemini-3.8-flash:matrix:chinese:small:3:r7` | `94add4b6bee8b6a44ca3b88d727dd4a983ad4f0d2c901d283fc6ac3be53f1d49` | 1024 | 0.013056000000 |
| 9 | `google/gemini-3.8-flash:matrix:chinese:medium:0:r7` | `bb23e85ae946e646576bd7eaaa35d04460154d595e01cdb4cc7e24904315dcc3` | 1024 | 0.032347500000 |
| 10 | `google/gemini-3.8-flash:matrix:chinese:medium:1:r7` | `248ab305d280ff69ee4f9da863d00bff6a7787702302d90c87496708d6ae01f4` | 1024 | 0.032962500000 |
| 11 | `google/gemini-3.8-flash:matrix:chinese:medium:2:r7` | `3b3dc024c535eb1f27f33707a56a3d5aeb283c07cb1c6098591ebc04f90cfad5` | 1024 | 0.033576750000 |
| 12 | `google/gemini-3.8-flash:matrix:chinese:medium:3:r7` | `facd1e7f614e65c5c62257ce88b1b635fec9f84335de3ad57d6bff8f3fc35916` | 1024 | 0.034560000000 |
| 13 | `google/gemini-3.8-flash:matrix:chinese:large:0:r7` | `1627c6ff4a815774c13d02abe8c5341333d13c7ecb0e3a285fcee28e035b64b1` | 1024 | 0.144168750000 |
| 14 | `google/gemini-3.8-flash:matrix:chinese:large:1:r7` | `5fddba8523915e46ca0cfefacfc3b0a1cdd66ab63e9ce632348792f3eb4dacba` | 1024 | 0.147855000000 |
| 15 | `google/gemini-3.8-flash:matrix:chinese:large:2:r7` | `1560f93e6bba764bc3670c0dea7491e27cb83324b871a092870e953ba671e92c` | 1024 | 0.151541250000 |
| 16 | `google/gemini-3.8-flash:matrix:chinese:large:3:r7` | `c27316f7152f73e2dd541d9b07b834e1f3e2381360c32f9e05cf1b9a90c9eedd` | 1024 | 0.157440000000 |
| 17 | `google/gemini-3.8-flash:matrix:english:small:0:r7` | `f13e159f11e2d356506073e7e4ed022fea63168ad6f505f20be216ac05a214b1` | 1024 | 0.010310250000 |
| 18 | `google/gemini-3.8-flash:matrix:english:small:1:r7` | `a5d26ca1221857fec467406e565db1c81dc517751e34410e407e4f12168f6d9d` | 1024 | 0.012855750000 |
| 19 | `google/gemini-3.8-flash:matrix:english:small:2:r7` | `5cd225ff309028eb23aec1774779dcf9680705ac941f2e2452ae012180dd24bd` | 1024 | 0.012933000000 |
| 20 | `google/gemini-3.8-flash:matrix:english:small:3:r7` | `7a19c182a9753abbb52f980f2adeb28c8497a01694a5801d48eeaf393cf50565` | 1024 | 0.013056000000 |
| 21 | `google/gemini-3.8-flash:matrix:english:medium:0:r7` | `a28b509b9be662f25dc8890ea11e515f6b77e88c1e55f184b721e57522abac47` | 1024 | 0.032347500000 |
| 22 | `google/gemini-3.8-flash:matrix:english:medium:1:r7` | `7842f34bff5047e65a9a9d3b8e9d6aa482233b369a2bce340f3228acf6ce9d4c` | 1024 | 0.032962500000 |
| 23 | `google/gemini-3.8-flash:matrix:english:medium:2:r7` | `f4c428114e42be08bd98cfa66fbc37584ec3ca89df68b87097556b587fee52dc` | 1024 | 0.033576750000 |
| 24 | `google/gemini-3.8-flash:matrix:english:medium:3:r7` | `c5c4e4565ab5870cffaf918e367d1b2eff71c8875b29378d6593b80a6e4b0ae8` | 1024 | 0.034560000000 |
| 25 | `google/gemini-3.8-flash:matrix:english:large:0:r7` | `6eb1c50fe0b1ff16c49315c9cdb1e7a203a8178da2b7aefdf2a7a2cdb4661b76` | 1024 | 0.144168750000 |
| 26 | `google/gemini-3.8-flash:matrix:english:large:1:r7` | `29475f8d502d61a88ad0c3452b2709278a26bed3b4774da93484ac9187ebb9ce` | 1024 | 0.147855000000 |
| 27 | `google/gemini-3.8-flash:matrix:english:large:2:r7` | `ea8e5448bf7a8cdad79dffa8df005763f92f4704511cadf0807c441006e21eae` | 1024 | 0.151541250000 |
| 28 | `google/gemini-3.8-flash:matrix:english:large:3:r7` | `56cbfc11514476adf2cd72750658d2f4cb33bb9a9ff58b0cc5993b5b674d18ce` | 1024 | 0.157440000000 |
| 29 | `google/gemini-3.8-flash:matrix:code:small:0:r7` | `903866f9b666694184c3e1e71d15eec0c725bf3594891833395d262b2fdb0c20` | 1024 | 0.010308000000 |
| 30 | `google/gemini-3.8-flash:matrix:code:small:1:r7` | `20715db77c797e2d1bc62e314d83fd70a957da6f002772e9f1ba04e6439d11d5` | 1024 | 0.012855750000 |
| 31 | `google/gemini-3.8-flash:matrix:code:small:2:r7` | `66110f00d987f518e186e425a22bce3642514cef522a9c7b9ab12dfbf96f4c0e` | 1024 | 0.012933000000 |
| 32 | `google/gemini-3.8-flash:matrix:code:small:3:r7` | `9161b00adb85614b2e43bee058515e9d855fea23253255206f5ccd14e2481a18` | 1024 | 0.013056000000 |
| 33 | `google/gemini-3.8-flash:matrix:code:medium:0:r7` | `a3dbc4f67ed63c9daa5a2cecb6a5a9eae905c34f4703d04db458a5363d92e4a2` | 1024 | 0.032347500000 |
| 34 | `google/gemini-3.8-flash:matrix:code:medium:1:r7` | `bcf4ec5eaff1ec1e7caf4651df06d449820ddb5f814030aa611ef9b40c4c23f7` | 1024 | 0.032962500000 |
| 35 | `google/gemini-3.8-flash:matrix:code:medium:2:r7` | `16a33b0a5d4046dad2ca5cb12f300c8a313ddf9fb9cf041b3df409b9faa3837f` | 1024 | 0.033576750000 |
| 36 | `google/gemini-3.8-flash:matrix:code:medium:3:r7` | `ed305e7ed1cc90a96c2b1b2c8360c5b7581f021033b14f736f02233c7152585f` | 1024 | 0.034560000000 |
| 37 | `google/gemini-3.8-flash:matrix:code:large:0:r7` | `50afa23dca34b9720571357da8555b6d1d113aac3ffb30d8ea2909908ce8c86b` | 1024 | 0.144168750000 |
| 38 | `google/gemini-3.8-flash:matrix:code:large:1:r7` | `2c2a954f919330d33b2d34d57f07f4ab226303ec0ae17177c95833d30dabdb63` | 1024 | 0.147855000000 |
| 39 | `google/gemini-3.8-flash:matrix:code:large:2:r7` | `57e702b16cc6b8dab9ced3260a23935ad5d8eafed5699aecfd7dfcb600f3132c` | 1024 | 0.151541250000 |
| 40 | `google/gemini-3.8-flash:matrix:code:large:3:r7` | `1f164b8f379181ff376f30d566c90d42a57202af39feae91a9fe3ca16d151d2a` | 1024 | 0.157440000000 |
| 41 | `google/gemini-3.8-flash:matrix:json:small:0:r7` | `1562bce6bb5a83faa3e076c694103299e0f7b225dfa3a5bfffbdd85930787c62` | 1024 | 0.010308000000 |
| 42 | `google/gemini-3.8-flash:matrix:json:small:1:r7` | `7b7dbfa8fe5cdaed9979444cdb8913794dc81f44b813008574c74577cc89decb` | 1024 | 0.012855750000 |
| 43 | `google/gemini-3.8-flash:matrix:json:small:2:r7` | `8556d081e812b95e9d5fe82704be0c9c920061889154088f9d96ad0511e5d443` | 1024 | 0.012933000000 |
| 44 | `google/gemini-3.8-flash:matrix:json:small:3:r7` | `148e124db66079a19d5f80a326460c272d6b35c060943ee0749cb4ada6ab0252` | 1024 | 0.013056000000 |
| 45 | `google/gemini-3.8-flash:matrix:json:medium:0:r7` | `2c2c46dbfd558abec83d7972eaf1b806ca4d1528308b0bbdc063e5a65d53f3ad` | 1024 | 0.032347500000 |
| 46 | `google/gemini-3.8-flash:matrix:json:medium:1:r7` | `c7b024db6e45651ecc9127cea1c5bb1a34202875803cedea0c161ac2722bf3c7` | 1024 | 0.032962500000 |
| 47 | `google/gemini-3.8-flash:matrix:json:medium:2:r7` | `b8dee2b3587944c6daaa9d1c590aaa22f88ccbcd59a7e7f4206405ff51d1c20f` | 1024 | 0.033576750000 |
| 48 | `google/gemini-3.8-flash:matrix:json:medium:3:r7` | `55646e185ed5f33765c54c4162f66baa804f058a1ed74af1434118da1a29585a` | 1024 | 0.034560000000 |
| 49 | `google/gemini-3.8-flash:matrix:json:large:0:r3:r7` | `9f84f2a1122806c0f8043104a6a3ed711b92a991c87f8804911cd18854286338` | 1024 | 0.144168750000 |
| 50 | `google/gemini-3.8-flash:matrix:json:large:1:r3:r7` | `d2beb9f3db9197faf5f9e68997fd127786782ecadb6166f91e1bab351261f2cf` | 1024 | 0.147855000000 |
| 51 | `google/gemini-3.8-flash:matrix:json:large:2:r3:r7` | `b6ceaebb389f84b034832141797d65379037d1675044b3387f00be3000677cb9` | 1024 | 0.151541250000 |
| 52 | `google/gemini-3.8-flash:matrix:json:large:3:r3:r7` | `c2d23b50e9b4a7155d33ee49830c169e31b0f60220b47eddf73e2501f148d718` | 1024 | 0.157440000000 |
| 53 | `google/gemini-3.8-flash:matrix:tools:small:0:r7` | `96d1fa9ce17c4886b69cbc90c49402f10d8ea3c6ab1a18ed3084eefb422106cd` | 1024 | 0.010506750000 |
| 54 | `google/gemini-3.8-flash:matrix:tools:small:1:r7` | `58519a170f19cc3bac681d80178cc59ce5d536b579a47eb6cfe9df27165b95bf` | 1024 | 0.012855750000 |
| 55 | `google/gemini-3.8-flash:matrix:tools:small:2:r7` | `9e201aa527335dec886c784789606acd9ecb41c82cf9dff14b563d91cefb5524` | 1024 | 0.012933000000 |
| 56 | `google/gemini-3.8-flash:matrix:tools:small:3:r7` | `476dec6e5457e86c9de5c6ad44fc9884b4b96481f28e7a482c9915f82d5096b4` | 1024 | 0.013056000000 |
| 57 | `google/gemini-3.8-flash:matrix:tools:medium:0:r7` | `489e99b84554e827b2ea738a43911c06aa2cde6d8970d84a66deee173383dda9` | 1024 | 0.032347500000 |
| 58 | `google/gemini-3.8-flash:matrix:tools:medium:1:r7` | `a828ace06206ba3399f41dadcfa892048aae001798eb7d3b7cf7316df865f38d` | 1024 | 0.032962500000 |
| 59 | `google/gemini-3.8-flash:matrix:tools:medium:2:r7` | `78fefa23e45b1703008ed5e0fc2c0efd80acd8b7444711d3650ba555829cdd71` | 1024 | 0.033576750000 |
| 60 | `google/gemini-3.8-flash:matrix:tools:medium:3:r7` | `bb0f75300c85dd82c8d801b5e6f4746ad82b2fdf94852b4505ea3473c18cb1fd` | 1024 | 0.034560000000 |
| 61 | `google/gemini-3.8-flash:matrix:tools:large:0:r7` | `6ffa78c706c1802ef06bb94910bb917adf5c682e23cae1254737b1ecf2cf4232` | 1024 | 0.144168750000 |
| 62 | `google/gemini-3.8-flash:matrix:tools:large:1:r7` | `e6814a799c7cdc1a146806e27ab1b4f25849b0a4eb76323aea7b34d63128145d` | 1024 | 0.147855000000 |
| 63 | `google/gemini-3.8-flash:matrix:tools:large:2:r7` | `f624f3fd8e94553c6c6bf7b8e4966445673d8fd8fd028102b0df2cff2ef338f2` | 1024 | 0.151541250000 |
| 64 | `google/gemini-3.8-flash:matrix:tools:large:3:r7` | `65602e7d0b6fc66da6a89657850f74949c7e65f88faccb81096f19f6e89b6f35` | 1024 | 0.157440000000 |
| 65 | `google/gemini-3.8-flash:messages:english:short-64:0:r7` | `2a0aeebce0a9c191be76008bf7e03ff59c110ef26281ca6b92883e2006143a32` | 1024 | 0.022272000000 |
| 66 | `google/gemini-3.8-flash:messages:english:short-64:1:r7` | `e15cec1c4f54552f411ea26de609b5df33c8c07c12e7b0dad68afbce9823b3de` | 1024 | 0.022272000000 |
| 67 | `google/gemini-3.8-flash:messages:english:long-64:0:r7` | `888b04910d0e0dbd7037b9972d2e8510f82f14f8656c6719018bc09f9320f77c` | 1024 | 0.144984000000 |
| 68 | `google/gemini-3.8-flash:messages:english:long-64:1:r7` | `31315ad090c00114702d62cafc05807714abb8f66648c7ec054ba556097633a5` | 1024 | 0.144984000000 |
| 69 | `google/gemini-3.8-flash:messages:english:short-96:0:r7` | `261bd38df701c7b8dc4a6fd1e707473f4563ec2bca3bf32a31049081686dea20` | 1024 | 0.022272000000 |
| 70 | `google/gemini-3.8-flash:messages:english:short-96:1:r7` | `e92ebcd4bd5b0ae70040583e26d1f846a56c0c96454ddedcd5c994b82054ce75` | 1024 | 0.022272000000 |
| 71 | `google/gemini-3.8-flash:messages:english:long-96:0:r7` | `572af2658312445de3b5d3dbf436aa8724f32ad7401830621de778ec5d771150` | 1024 | 0.144984000000 |
| 72 | `google/gemini-3.8-flash:messages:english:long-96:1:r7` | `36b5362b92868261f0a23b2937f1df9094fcf4cb6bad4fbd57880bc460fec2e1` | 1024 | 0.144984000000 |
| 73 | `google/gemini-3.8-flash:messages:english:short-128:0:r7` | `f16cd26b3c741108e1db1d6cd318e42654858d8da978ae23f3710c4c0633453f` | 1024 | 0.022272000000 |
| 74 | `google/gemini-3.8-flash:messages:english:short-128:1:r7` | `442f5591b146bfe0243db256a6bcd86ca542ab629f017a3feb0db8b90c7dac50` | 1024 | 0.022272000000 |
| 75 | `google/gemini-3.8-flash:messages:english:long-128:0:r7` | `17efcaf6a5fb90417037709de9742c1177d2f32fe27422e4895cc569ed2561dc` | 1024 | 0.144984000000 |
| 76 | `google/gemini-3.8-flash:messages:english:long-128:1:r7` | `9a134ed28dd4ab6a64404f8ba2d03a51652fdfc2439e6b26f3c0e7b22e8a0577` | 1024 | 0.144984000000 |
| 77 | `openai/gpt-6-luna:route:organizer:serial-tools-v6-reasoning:0:4096:r5b` | `fb40f3f2542c4dd34fccfc9f16903e63c44d0aa0bf95473cab4d8e72e6f07095` | 1024 | 0.002048000000 |
| 78 | `openai/gpt-6-luna:route:organizer:serial-tools-v6-reasoning:0:196608:r5b` | `64df032b24b32c7c6d626dfec12937606927987a99d7c89e138d14c64517ad34` | 1024 | 0.026112000000 |
| 79 | `openai/gpt-6-luna:route:organizer:serial-tools-v6-reasoning:1:4096:r5b` | `93e5b6f157d495e40a837111e91f085784b3c4bfd1854b562410beee4fe00b58` | 1024 | 0.002048000000 |
| 80 | `openai/gpt-6-luna:route:organizer:serial-tools-v6-reasoning:1:196608:r5b` | `7ab5ab0026ac99cc3aa5e56b55822844394045cdf2b143bcaa0b32c77e3aaa3b` | 1024 | 0.026112000000 |
| 81 | `openai/gpt-6-luna:route:attached_organizer:serial-tools-v6-reasoning:0:4096:r5b` | `7282d208b89a5c6a6c90f04548c69931509e6dc91d83dfbf308f7c866f0b46c1` | 1024 | 0.002048000000 |
| 82 | `openai/gpt-6-luna:route:attached_organizer:serial-tools-v6-reasoning:0:196608:r5b` | `c8dc64569064d999a165acd5efac82d3c79655f3f310e50904ecfc6b26c8eba9` | 1024 | 0.026112000000 |
| 83 | `openai/gpt-6-luna:route:attached_organizer:serial-tools-v6-reasoning:1:4096:r5b` | `97c694b37144e392b29bee33844b14cfb3a43ebf6e75595f9a972547948ba14f` | 1024 | 0.002048000000 |
| 84 | `openai/gpt-6-luna:route:attached_organizer:serial-tools-v6-reasoning:1:196608:r5b` | `285b6563a42b5518e59e345549e1bbea210fccb1cfeac005d31541adf015fe9b` | 1024 | 0.026112000000 |
| 85 | `openai/gpt-6-luna:route:attached_organizer:serial-tools-v4-stream:0:4096:r5b` | `03425cc4d81de3faa1767dbcd181550c238c8068a058cbad480bcc68a4f8b111` | 1024 | 0.002048000000 |
| 86 | `openai/gpt-6-luna:route:attached_organizer:serial-tools-v4-stream:0:196608:r5b` | `623f1e60c96aa23f62e99bfc5fdb9e1682ce30df31993709840fe52f067d7937` | 1024 | 0.026112000000 |
| 87 | `openai/gpt-6-luna:route:attached_organizer:serial-tools-v4-stream:1:4096:r5b` | `876037795b20b7aa61daf32b5fc9e1d5c95ef080658b66d23398a84d7fd20981` | 1024 | 0.002048000000 |
| 88 | `openai/gpt-6-luna:route:attached_organizer:serial-tools-v4-stream:1:196608:r5b` | `d5b6e7c603820ba16741269b41ac84247cf80ce1775eb5cb7478969416396f3b` | 1024 | 0.026112000000 |
| 89 | `openai/gpt-6-luna:route:attached_organizer:agent-turn-v5-stream:0:4096:r5b` | `2c8523e8703384a86b126375583099e6978b5426025611289346bfebd7b7e7f9` | 1024 | 0.002048000000 |
| 90 | `openai/gpt-6-luna:route:attached_organizer:agent-turn-v5-stream:0:196608:r5b` | `b6d160c41255b49c98dc5130000fb1b78c2486db5d74b038aacc5148554fa446` | 1024 | 0.026112000000 |
| 91 | `openai/gpt-6-luna:route:attached_organizer:agent-turn-v5-stream:1:4096:r5b` | `0003c91cd674293b17829ecae57327d4d711fcef5b4d773e64f5084a492913f7` | 1024 | 0.002048000000 |
| 92 | `openai/gpt-6-luna:route:attached_organizer:agent-turn-v5-stream:1:196608:r5b` | `c5f8ed8962f203cfec2770d23a0eb2f60b544373cc177c9111b08894d68943e3` | 1024 | 0.026112000000 |
| 93 | `anthropic/claude-sonnet-5.5:output:chinese:output-stress:0:r5b` | `5c83223a957cdb02b6883096ab6883d45c04bbda8590e9535265f7d452ae186a` | 2048 | 0.051200000000 |
| 94 | `anthropic/claude-sonnet-5.5:output:code:output-stress:1:r5b` | `2cfebe218fec1cfd809ca64709085b0fcbe0bbca83f2e4559a1650c54c3bf618` | 2048 | 0.051200000000 |
| 95 | `anthropic/claude-sonnet-5.5:output:chinese:output-stress:2:r5b` | `93905de61f4c8c4cedf4500fa469c869047846a54f46b09d02c6e889c9eebfce` | 2048 | 0.051200000000 |
| 96 | `anthropic/claude-sonnet-5.5:output:code:output-stress:3:r5b` | `0edfe965dac22d503ed961979d631b2bb9f535bfcbbcbf841ef821f4ff335974` | 2048 | 0.051200000000 |

离线复现：

```bash
node scripts/payg-profile.mjs plan scripts/payg-profile/plan-prices.json /tmp/payg-r7-manifest.json r7
```

价格没有变化，但tag长度改变了5条自动尺寸小样本的请求字节数，本批总上界比旧r5b少$0.000015；并非降低安全系数。
执行见[执行器文档](BILL_PAYG_PROFILE_EXECUTOR.md)，本轮未运行。迁移最终0176后续由主窗口安排；本轮不改迁移编号。
