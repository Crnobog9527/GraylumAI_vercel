---
description: 构建代码提交并 Push 到远程分支
---

# 💾 Git 提交流程 (Git Commit)

完成某一项任务后，执行代码提交规范操作。

## 1. 检查状态
首先查看哪些文件被修改。
```bash
git status
```
// turbo

## 2. 暂存代码
如果是确定的改动，全部加入暂存区。如果是单文件，可由你自行按需添加。
```bash
git add .
```
// turbo

## 3. 生成 Commit 信息
为本次改动生成一条清晰友好的 Commit 信息。信息包含前缀：
- `feat:` 新功能
- `fix:` 修复 Bug
- `refactor:` 代码重构
- `style:` 代码格式/样式调整
- `docs:` 文档变更

请向用户确认提交信息，确认无误后执行：
```bash
git commit -m "feat/fix: descriptive message"
```
// 这一步由 Agent 根据确认的信息手动执行

## 4. (可选) Push 到远程
如果用户要求，推送到 GitHub。
```bash
git push
```
