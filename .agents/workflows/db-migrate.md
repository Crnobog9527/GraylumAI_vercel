---
description: 数据库 schema 修改与迁移
---

# 🗄️ 数据库修改与迁移 (DB Migrate)

当你需要为 GraylumAI 修改数据库表结构（添加表、添加字段等）时，请使用本工作流。

## 1. 修改 Schema
在 `packages/db/schema.ts` 中根据 Drizzle ORM 规范添加或修改表。
- 注意：必须为每一张新表添加 `id` 主键 (uuid) 并且定义好 timestamp，保留软删（`isDeleted: text`）逻辑。

## 2. 推送更新
由于这是一个开发环境工作流，推荐直接 Push 数据库表结构到 Supabase 开发实例，或生成迁移文件。
```bash
cd packages/db && npx drizzle-kit push
```
// turbo-all

## 3. 同步 tRPC 和 前端
数据库更改后，检查 `packages/api` 中是否有需要更新类型定义的地方。
