# 100 人复测：Owner 电脑放桩 + 免费隧道（Owner 照做版）

适用：总控已定时段、Owner 已批准"桩用 Owner 电脑加隧道"。**令牌、数据库连接串都只在 Owner 自己的终端和 Vercel 网页里输入，不发给任何 AI、不贴进聊天。**
所有命令都在**仓库根目录**的终端里运行（先 `cd` 到仓库根目录）。需要开两个终端：终端 A 跑桩和隧道（一直开着），终端 B 做其余操作。

## 用哪个隧道

首选 Cloudflare 免费"快速隧道"（`cloudflared`）：不用注册账号、不用令牌，每次启动给一个随机的 `https://….trycloudflare.com` 地址，关掉就失效。本机已装。
已知风险：Cloudflare 文档写明快速隧道**不保证支持流式响应**，而桩的回复是边出边发的。所以第 3 步的流式自检必须过；不通过就换 ngrok（文末），不要硬跑。

## 步骤

**1. 开机前**：Mac 接电源，整个复测约 1 小时 45 分钟，期间不要合盖。（脚本会自动防止休眠，不用另外设置。）

**2. 终端 A：启动桩和隧道**

```bash
scripts/loadtest/start-stub-tunnel.sh
```

终端 A 会打印三块内容：① 一整行 `LOADTEST_MODEL_STUB_URL=https://…/<随机串>`（要填进 Vercel 的值，随机串每次启动新生成，只显示在这个终端，不写文件）；② 一条已经填好地址的流式自检命令；③ 健康检查命令。

**3. 终端 B：流式自检**——把终端 A 打印的第 ② 块整条复制到终端 B 运行。通过：文字**一小块一小块陆续出现**，总共约 6 秒。不通过：静默约 6 秒后一下全出来（隧道在缓冲），停下来告诉总控，改用文末的 ngrok。

**4. Vercel 网页（Owner 自己做）**：graylumai-staging 项目 → Settings → Environment Variables，新增两个，环境选 Production（staging 就是用 Production 部署的），保存后**重新部署**，等部署完成：

| 名字 | 值 |
|---|---|
| `LOADTEST_MODEL_STUB_URL` | 终端 A 第 ① 块里 `=` 后面的整串（含随机串） |
| `LOADTEST_STUB_DB_HOST` | staging Supabase 的主机名（形如 `xxxx.supabase.co`，与 `NEXT_PUBLIC_SUPABASE_URL` 里的主机完全一致，总控会给） |

**5. 终端 B：准备私密环境文件**（连接串和账号文件路径只写在这里，不发给 AI）：

```bash
mkdir -p ~/graylum-loadtest
touch ~/graylum-loadtest/env.private && chmod 600 ~/graylum-loadtest/env.private
open -e ~/graylum-loadtest/env.private
```

在打开的文本里写下面五行，`<…>` 换成真实值后保存。**前三项由总控告知；只读连接串在 Supabase staging 项目的 Database 设置里按总控说明建**：

```text
export LOADTEST_BASE_URL='<graylumai-staging 的网址，总控给>'
export LOADTEST_ALLOWED_APP_HOST='<上面网址里的主机名>'
export LOADTEST_ACCOUNTS_FILE='<账号文件的完整路径，总控给>'
export LOADTEST_DATABASE_URL='<只读连接串>'
export LOADTEST_ALLOWED_DB_HOST='<连接串里的主机名>'
```

**6. 终端 B：1 个账号自检**（证明应用确实改道到了桩；不通过就不要开整套）：

```bash
source ~/graylum-loadtest/env.private
node scripts/loadtest/core-path-load.mjs --out ~/graylum-loadtest/selfcheck-$(date +%s) --calibrate --turns 1 --go
```

然后把终端 A 第 ③ 块里的命令整条复制到终端 B 运行（里面的地址已填好），看 `__stats` 那一段的结果：`calls` 要**大于 0**。等于 0 说明钩子没生效（变量没填对或没重新部署），停下，告诉总控。通过后告诉总控"隧道已起、两个变量已加、已重新部署、自检通过"。

**7. 终端 B：正式开跑**（总控确认时段后；约 1 小时 45 分钟，期间保持终端 A、B 都开着）：

```bash
source ~/graylum-loadtest/env.private
caffeinate -dis scripts/loadtest/run-all.sh
```

结束时终端 B 会打印连接汇总和"覆盖检查"结果（COVERED 表示采样覆盖了整个压测时间段），最后一行 `output …` 是本次输出目录，把这一行告诉总控即可（目录里没有密钥）。想先在不连任何东西的情况下看一眼流程，可先运行 `scripts/loadtest/run-all.sh --dry-run`（十几秒）。

**8. 跑完收尾（Owner 做，缺一不可）**：
1. 终端 A 按 Ctrl-C（桩和隧道停止，地址立即失效）。
2. Vercel 里**删掉那两个环境变量**，重新部署。
3. 删除 `~/graylum-loadtest/env.private`；在 Supabase 里删掉/作废只读连接。
4. 日限调回原值（总控告知）。

## 备选：ngrok（仅当第 3 步不通过）

1. 注册 ngrok 免费账号；令牌只在 Owner 自己的终端运行一次 `ngrok config add-authtoken <令牌>`（令牌不发给任何人）。免费额度（每月请求数、流量）我没有核实，用之前请总控或 Owner 在 ngrok 控制台确认够一次 100 人（约几千次模型调用）。
2. 终端 A 改用：

```bash
scripts/loadtest/start-stub-tunnel.sh --ngrok
```

输出的格式和上面完全一样（同样直接给出要填的那一行和自检命令），后面的步骤不变。
