---
description: 启动本地开发环境
---

# 🚀 启动 GraylumAI 本地开发环境

本工作流用于启动 GraylumAI 的前端和全栈所需的环境。

## 步骤 1: 检查环境依赖
- 确保 Node.js 版本符合要求
- 确保 PostgreSQL 和 Redis 处于可用状态（如果使用本地实例）
- 检查 `apps/web/.env.local` 和顶级 `.env` 是否已配置

## 步骤 2: 安装依赖
进入项目根目录，运行 pnpm install 确保所有依赖是最新的。
```bash
pnpm install
```
// turbo

## 步骤 3: 启动开发服务器
使用 turbo 启动所有应用包开发模式。
```bash
npm run dev
```

## 注意事项
- 你可以通过 `http://localhost:3000` 访问 app。
- API 服务通过 `http://localhost:3000/api/trpc` 暴露。
