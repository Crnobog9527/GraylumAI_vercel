---
description: 构建项目 & 检查错误
---

# 📦 构建与部署检查 (Build Validation)

本工作流用于本地执行生产环境级别的构建，以提前发现潜在的错误。

## 步骤 1: 运行构建
进入项目根目录执行 Turbo build。
```bash
npm run build
```
// turbo

## 步骤 2: 错误检查
如果构建失败，主要排查以下两点：
- **TS 类型错误**: tRPC 前后端接口不匹配，或者 Drizzle Schema 与查询要求不一致。
- **ESLint 错误**: 检查是否引入了未使用的变量，或是打破了 Hooks 的使用规则。

## 步骤 3: 修复并重试
分析日志并给出修复，直到 `npm run build` 可以在本地跑通。
