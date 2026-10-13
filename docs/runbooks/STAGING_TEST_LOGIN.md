# 测试站一键登录（staging-login）

给做浏览器验收的 AI（Codex，或 Codex 没额度时代做的 Claude）用：不需要 Owner 手动登录或切换账号，
也不输入密码、不过 hCaptcha。Owner 2026-10-13 批准："用现有 staging 管理密钥为名单内测试账号生成登录状态，只限测试站"。

这只是本机工具，网站代码里没有任何免登录入口或测试接口。

## 硬限制（脚本内置，不能用参数改）

- 只连测试站 Supabase 项目 `gvcpmcunmfrbxuwimxfa`，只为 `https://auth-staging.graylum.com` 生成登录状态。
  正式项目 `fhmshnqjjnnlvplojktv` 或其他任何项目的地址、密钥一律拒绝退出。
- 只为本机名单里的邮箱生成；名单外的角色直接拒绝。
- 只登录测试站里**已存在且邮箱已验证**的账号。账号不存在、未验证或被封禁就拒绝，不创建账号、不改密码、
  不替账号做邮箱验证。登录本身会让 Supabase 记一次"最近登录时间"，这是正常登录的一部分。
- 日志只写角色名、密钥来源（`supabase-cli` / `env-file`）、访问令牌过期时间和输出文件路径；
  不打印邮箱、密钥和令牌。

## 用法（Codex）

```bash
node scripts/staging-login user
```

角色名就是名单里的键（例如 `user`、`free`、`admin`）。成功后生成
`~/.graylum/staging-sessions/<角色>.json`（Playwright storageState，权限 600），用它打开浏览器：

```js
const context = await browser.newContext({ storageState: `${os.homedir()}/.graylum/staging-sessions/user.json` });
const page = await context.newPage();
await page.goto('https://auth-staging.graylum.com/profile');
```

Playwright CLI 可以用 `--load-storage=<文件>`。

- 访问令牌约 1 小时过期，网站会用刷新令牌自动续期；浏览器里续期后的新令牌不会写回文件。
  打开后被跳到登录页，就重跑一次脚本。
- 同一个账号可以同时有多个会话；但同一个测试账号不要同时跑两个浏览器验收任务，会互相串输入。
- 不读取、不记录、不截图 storageState 文件内容，也不把它贴进 PR、评论或日志。它等同于这个测试账号的登录凭证。
- 退出码：0 成功；1 没给角色名；2 被拒绝或出错（终端会写中文原因）。

## Owner 一次性准备

1. **账号名单**：复制示例，填上测试站的测试账号邮箱（只要邮箱，不要密码；不要放个人邮箱）。

   ```bash
   cp scripts/staging-login/accounts.example.json ~/.graylum/secrets/staging-test-accounts.json
   ```

   ```bash
   chmod 600 ~/.graylum/secrets/staging-test-accounts.json
   ```

   打开这个文件，把 `user`、`free`、`admin` 后面的示例邮箱换成真实测试邮箱；用不到的角色可以删掉，
   也可以加新角色（小写字母、数字、连字符）。`_note` 这一行可留可删。这些账号要先在测试站正常注册并完成邮箱验证。

2. **管理密钥**：默认不用准备。脚本运行时用本机已登录的 Supabase CLI 读取测试站的 service role 密钥，
   只放在内存里，不写盘。只有 CLI 没登录或没有权限时，才需要 Owner 新建
   `~/.graylum/secrets/supabase-staging.env`（权限 600），内容两行：

   ```text
   SUPABASE_URL=https://gvcpmcunmfrbxuwimxfa.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<测试站 service role 密钥>
   ```

   文件里写的地址如果不是测试站，脚本会拒绝。

## 出问题时

| 终端提示 | 处理 |
| --- | --- |
| 找不到账号名单 | 按上面第 1 步填写名单 |
| 账号名单里没有角色 X | 名单里加这个角色，或换一个已有角色 |
| 测试站里没有这个名单邮箱对应的账号 / 邮箱还没验证 | Owner 先在测试站注册或完成验证；脚本不会代办 |
| 读不到测试站管理密钥 | `supabase login` 后重试，或按第 2 步存密钥文件 |
| 测试站登录接口返回 401/403 | 密钥失效或被换过，重新登录 CLI 或更新密钥文件 |

代码在 `scripts/staging-login/`，单元测试 `scripts/tests/staging-login.test.mjs`（随 `pnpm test:ci:safeguards` 在 CI 运行）。
