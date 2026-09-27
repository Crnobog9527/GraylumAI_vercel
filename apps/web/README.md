# apps/web

Graylum 的网站前端（Next.js App Router）。它是 pnpm monorepo 的一部分，不要单独在这个目录里用 npm/yarn 安装。

- 仓库入口与规则：[根目录 README](../../README.md)、[AGENTS.md](../../AGENTS.md)
- 技术栈、目录约定、代码大小限制和测试命令：[docs/ENGINEERING.md](../../docs/ENGINEERING.md)
- 当前产品规划：[docs/launch/MASTER_PLAN.md](../../docs/launch/MASTER_PLAN.md)

常用命令（在仓库根目录执行）：

```bash
pnpm install --frozen-lockfile
```

```bash
pnpm --filter web dev
```

```bash
pnpm --filter web typecheck
```
