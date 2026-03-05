---
description: 新增 UI 组件
---

# 🧩 新增可复用前端 UI 组件 (Add Component)

新增 React 组件的标准化流程。

## 1. 确定组件类型
- **通用/基础 UI 组件**: 如果是从 shadcn 引入，需要放到 `apps/web/src/components/ui/` 下，比如按钮、弹窗等基础无状态组件。
- **业务组件**: 根据业务域放在 `apps/web/src/components/[domain]/`，例如 `chat/`、`admin/`、`profile/`。

## 2. 组件命名与规范
- 使用大驼峰（PascalCase）如 `ChatInput.tsx`。
- 支持 `className` 透传。使用 `cn()`（`clsx` + `tailwind-merge`）合成样式类。

## 3. 状态管理
- 组件内部的浅层状态用 `useState`。
- 与全局联动的深层状态（例如侧边栏收起展开或者当前聊天记录）用 `Zustand` (`apps/web/src/stores/`)。
