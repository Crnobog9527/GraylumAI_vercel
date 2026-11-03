# 100 人复测：Owner 电脑放桩 + 免费隧道（Owner 照做版）

适用：总控已定时段、Owner 已批准"桩用 Owner 电脑加隧道"。**令牌、数据库连接串都只在 Owner 自己的终端和 Vercel 网页里输入，不发给任何 AI、不贴进聊天。**

## 用哪个隧道

Cloudflare 免费"快速隧道"（`cloudflared`）：不用注册账号、不用令牌，每次启动给一个随机的 `https://….trycloudflare.com` 地址，关掉就失效。本机已装 `cloudflared`。

已知风险：Cloudflare 文档写明快速隧道**不保证支持流式响应**，而桩的回复是边出边发的。所以第 3 步有一道必须过的流式自检；不通过就换备选（文末），不要硬跑。

## 步骤

**1. 开机前**：Mac 接电源、关闭休眠（系统设置 → 锁定屏幕/电池；或终端运行 `caffeinate -d` 并保持开着）。整个复测约 1 小时 45 分钟，期间不要合盖。

**2. 启动桩和隧道**（在仓库根目录；开一个专用终端并一直开着）：

```bash
scripts/loadtest/start-stub-tunnel.sh
```

终端会打印一行 `LOADTEST_MODEL_STUB_URL = https://….trycloudflare.com/<随机串>`。随机串每次启动都新生成，只显示在这个终端里，不写入任何文件。

**3. 流式自检**（另开终端，把上一步打印的地址代入；预期：数据**分很多次、隔一阵一块**陆续出现，总共约 6 秒；如果静默 6 秒后一下全出来，说明隧道在缓冲，停下来告诉总控）：

```bash
curl -N -s -w '\n总耗时 %{time_total}s\n' -H 'content-type: application/json' \
  -d '{"model":"x","stream":true,"messages":[{"role":"user","content":"hi"}]}' \
  "<上一步地址>/api/v1/chat/completions"
```

**4. 把地址交给 Vercel（Owner 自己在网页上做）**：graylumai-staging 项目 → Settings → Environment Variables，新增两个，目标环境选 Production（staging 就是用 Production 部署的），然后重新部署：

| 名字 | 值 |
|---|---|
| `LOADTEST_MODEL_STUB_URL` | 第 2 步打印的整行地址（含随机串） |
| `LOADTEST_STUB_DB_HOST` | staging Supabase 的主机名（形如 `xxxx.supabase.co`，与 `NEXT_PUBLIC_SUPABASE_URL` 里的主机完全一致） |

**5. 只读连接串（采样连接数用）**：在 Supabase staging 项目的 Database 设置里按总控说明建/取只读连接。把它放进 Owner 自己的私密文件，**不要发给 AI**：

```bash
mkdir -p ~/graylum-loadtest && umask 077
# 用文本编辑器打开这个文件，两行里的 <…> 换成真实值，保存：
#   export LOADTEST_DATABASE_URL='<只读连接串>'
#   export LOADTEST_ALLOWED_DB_HOST='<连接串里的主机名>'
open -e ~/graylum-loadtest/env.private
```

跑采样的终端先 `source ~/graylum-loadtest/env.private`，再运行 `vercel-run-plan.md` 第 2 步的命令。AI 窗口只会拿到采样产出的汇总数字，拿不到连接串。

**6. 通知总控**：说"隧道已起、两个变量已加、已重新部署"。总控按运行计划第 2 步先做 1 账号自检（看桩的 `__stats` 里 calls > 0，证明钩子生效），通过后才开整套。

**7. 跑完收尾（Owner 做，缺一不可）**：
1. 在启动桩的终端按 Ctrl-C（隧道地址立即失效）。
2. Vercel 里**删掉那两个环境变量**，重新部署。
3. 删除 `~/graylum-loadtest/env.private`，并在 Supabase 里删掉/作废只读连接。
4. 日限调回原值（总控告知）。

## 备选（仅当第 3 步不通过）

ngrok 免费版：要注册 ngrok 账号。令牌只在 Owner 自己终端运行 `ngrok config add-authtoken <令牌>`（令牌不发给任何人）。启动用 `ngrok http 127.0.0.1:8787`；因为 `start-stub-tunnel.sh` 只管 Cloudflare，需手工起桩：`LOAD_STUB_HOST=127.0.0.1 LOAD_STUB_PORT=8787 LOAD_STUB_PREFIX=$(openssl rand -hex 16) node scripts/loadtest/openrouter-stub.mjs`，地址是 ngrok 打印的 `https://…ngrok-free.app` 后接同一个随机串。免费额度（每月请求数、流量）我没有核实，用之前请总控或 Owner 在 ngrok 控制台确认够一次 100 人（约几千次模型调用）。
