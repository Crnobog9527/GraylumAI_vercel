# UI 像素级复刻任务

## 任务目标
将新项目的 UI 完全还原为旧项目的视觉效果，确保像素级一致。

## 旧项目信息
- **仓库地址**: https://github.com/Crnobog9527/graylumAi-backup
- **架构**: React 18 + Vite + Tailwind CSS + Shadcn/ui
- **组件数**: 105 个
- **关键文件**:
  - `src/theme.css` (376行) - CSS 变量定义
  - `src/components.css` (1224行) - 组件样式
  - `tailwind.config.js` - Tailwind 配置
  - `src/components/` - 所有组件

## 执行原则
1. **只改视觉，不改逻辑** - 不修改组件的 props、状态管理、事件处理
2. **100% 复制样式** - className、CSS 变量、Tailwind 配置完全照搬
3. **保持结构一致** - HTML 嵌套层级必须相同
4. **优先级**: 核心页面 > 次要页面 > 边缘功能

---

## Step 1: CSS 基础设施迁移

### 任务
从旧项目复制所有 CSS 基础设施到新项目。

### 执行清单
```bash
# 1. 复制 CSS 变量（必须完整复制）
旧: src/theme.css (376行)
新: apps/web/src/app/globals.css (@layer base 部分)

# 2. 复制组件样式（必须完整复制）
旧: src/components.css (1224行)  
新: apps/web/src/app/globals.css (@layer components 部分)

# 3. 复制 Tailwind 配置
旧: tailwind.config.js
新: apps/web/tailwind.config.ts (保持 extend 部分一致)

# 4. 复制全局样式
旧: src/index.css, src/App.css
新: apps/web/src/app/globals.css
```

### 验证
在浏览器开发者工具中检查：
- [ ] CSS 变量 `--color-primary`, `--bg-primary` 等已生效
- [ ] 背景色是 `#0A0A0A` (深黑色)
- [ ] 主色调是 `#FFD700` (金色)
- [ ] 无 CSS 编译错误

---

## Step 2: 页面级 UI 复刻

用户会提供旧项目的页面截图，请按以下流程复刻每个页面。

### 复刻流程（标准模板）

#### 输入
- 用户提供：旧项目页面截图
- 对应的旧项目文件路径（如 `src/pages/Chat.jsx`）

#### 输出
- 新项目对应文件的 UI 完全匹配截图

#### 执行步骤

**1. 分析旧项目代码**
```bash
# 打开旧项目文件
浏览旧项目的 GitHub 仓库: https://github.com/Crnobog9527/graylumAi-backup

# 需要分析的内容：
- 页面文件: src/pages/[PageName].jsx
- 使用的组件: src/components/[category]/[ComponentName].jsx
- 每个元素的 className
- HTML 结构（div 嵌套层级）
- 使用的自定义 CSS 类
```

**2. 复制 HTML 结构**
```tsx
// 保持完全相同的 DOM 结构
// 旧项目
<div className="flex h-screen">
  <aside className="w-64 bg-card">...</aside>
  <main className="flex-1">...</main>
</div>

// 新项目（保持一致）
<div className="flex h-screen">
  <aside className="w-64 bg-card">...</aside>
  <main className="flex-1">...</main>
</div>
```

**3. 复制所有 className**
```tsx
// 逐个元素复制 className，顺序也要一致
// 旧: className="flex items-center gap-4 p-4 bg-card rounded-lg shadow-sm"
// 新: className="flex items-center gap-4 p-4 bg-card rounded-lg shadow-sm"
```

**4. 处理自定义 CSS 类**
如果旧项目使用了 components.css 中定义的类（如 `.message-bubble-user`），确保：
- 该类已经在 Step 1 中复制到 `globals.css`
- 在新组件中使用相同的类名

**5. 调整组件库样式**
如果使用了 Shadcn/ui 组件，需要覆盖默认样式：
```tsx
// 在组件上添加与旧项目一致的 className
<Button className="h-12 px-6 bg-primary hover:bg-primary/90">
  发送
</Button>
```

**6. 验证**
- 在浏览器中并排对比新旧项目
- 使用开发者工具测量间距、颜色
- 检查响应式断点（320px, 768px, 1024px, 1920px）
- 检查 hover/focus 状态

---

## Step 3: 组件级 UI 复刻

### 核心组件优先级列表

**P0 - 聊天系统（最重要）**
```
src/components/chat/
├── ChatSidebar.jsx          → apps/web/src/components/chat/ChatSidebar.tsx
├── ChatHeader.jsx           → apps/web/src/components/chat/ChatHeader.tsx
├── MessageBubble.jsx        → apps/web/src/components/chat/MessageBubble.tsx
├── ChatMessages.jsx         → apps/web/src/components/chat/ChatMessages.tsx
├── ChatInput.jsx            → apps/web/src/components/chat/ChatInput.tsx
├── ChatInputArea.jsx        → apps/web/src/components/chat/ChatInputArea.tsx
├── ModelSelector.jsx        → apps/web/src/components/chat/ModelSelector.tsx
└── [其他聊天组件]
```

**P1 - 布局组件**
```
src/components/layout/
├── AppHeader.jsx            → apps/web/src/components/layout/AppHeader.tsx
└── GlobalBanner.jsx         → apps/web/src/components/layout/GlobalBanner.tsx
```

**P1 - 用户资料**
```
src/components/profile/
├── ProfileComponents.jsx    → apps/web/src/components/profile/ProfileComponents.tsx
├── PersonalInfoCard.jsx     → apps/web/src/components/profile/PersonalInfoCard.tsx
└── [其他资料组件]
```

**P2 - 其他业务组件**
根据用户需求逐步复刻。

### 组件复刻模板

对于每个组件：

```tsx
/**
 * 组件: [ComponentName]
 * 复刻自: [旧项目文件路径]
 * 复刻日期: [YYYY-MM-DD]
 * 状态: ✅ 已完成 / 🚧 进行中 / ⏳ 待处理
 */

// 1. 保持相同的导入
import { Button } from '@/components/ui/button';
import { Send } from 'lucide-react';

// 2. 保持相同的接口（props 类型不变）
interface ChatInputProps {
  onSend: (content: string) => void;
  isLoading?: boolean;
}

// 3. 复制完整的 JSX 结构和 className
export function ChatInput({ onSend, isLoading }: ChatInputProps) {
  // 业务逻辑保持不变
  const [content, setContent] = useState('');
  
  // JSX 结构和样式完全复制
  return (
    <div className="border-t p-4 bg-card">
      <div className="max-w-3xl mx-auto flex gap-2">
        <Textarea
          className="min-h-[60px] max-h-[200px] w-full rounded-md border border-input bg-background px-3 py-2"
          placeholder="输入消息... (Shift+Enter 换行)"
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
        <Button className="h-[60px] w-[60px]" size="icon" onClick={() => onSend(content)}>
          <Send className="h-5 w-5" />
        </Button>
      </div>
    </div>
  );
}
```

---

## Step 4: 细节打磨

### 需要检查的细节

**颜色一致性**
```css
/* 核心颜色必须完全匹配 */
--background: #0A0A0A;        /* 深黑背景 */
--card: #1A1A1A;              /* 卡片背景 */
--primary: #FFD700;           /* 金色主色 */
--secondary: #FFA500;         /* 橙金辅助 */
```

**间距一致性**
- 页面内边距: `p-4`, `p-6`, `p-8`
- 组件间距: `gap-2`, `gap-4`, `space-y-4`
- 容器最大宽度: `max-w-3xl`, `max-w-7xl`

**字体一致性**
- 标题: `text-2xl font-bold`, `text-xl font-semibold`
- 正文: `text-base`, `text-sm`
- 次要文字: `text-sm text-muted-foreground`

**圆角和阴影**
- 圆角: `rounded-md`, `rounded-lg`
- 阴影: `shadow-sm`, `shadow-md`

**响应式断点**
- 移动端: `sm:` (640px)
- 平板: `md:` (768px)  
- 桌面: `lg:` (1024px)
- 大屏: `xl:` (1280px)

---

## 关键注意事项

### ❌ 禁止修改
- 组件的 TypeScript 接口（props 类型）
- 状态管理逻辑（useState, useEffect）
- 事件处理函数内部逻辑
- tRPC 调用和数据获取
- 路由配置

### ✅ 只修改
- `className` 属性
- HTML 元素嵌套结构（仅限为了匹配样式）
- CSS 文件内容
- Tailwind 配置
- 内联 `style` 属性（如果必要）

### 🎯 质量标准
- 并排对比新旧项目，肉眼无法分辨差异
- 使用浏览器测量工具，间距误差 < 2px
- 颜色值完全匹配（使用开发者工具取色）
- 字体大小和粗细完全一致
- 响应式断点行为一致

---

## 工作流程示例

### 用户输入
```
我要复刻聊天页面，这是旧项目的截图：[上传截图]
旧项目文件: src/pages/Chat.jsx
```

### Claude Code 执行
```
1. 访问 GitHub 查看 src/pages/Chat.jsx 源码
2. 分析页面结构:
   - 左侧: ChatSidebar（对话列表）
   - 中间: ChatMessages（消息区域）
   - 底部: ChatInput（输入框）
   - 顶部: ChatHeader（工具栏）

3. 逐个组件复刻:
   a) 复制 ChatSidebar.jsx 的所有 className 到 ChatSidebar.tsx
   b) 复制 ChatMessages.jsx 的所有 className 到 ChatMessages.tsx
   c) 复制 ChatInput.jsx 的所有 className 到 ChatInput.tsx
   d) 复制 ChatHeader.jsx 的所有 className 到 ChatHeader.tsx

4. 处理页面布局:
   - 复制 Chat.jsx 的 className
   - 保持相同的 flex/grid 布局
   - 确保侧边栏宽度、高度计算一致

5. 验证:
   - 在浏览器中打开新项目
   - 与截图对比
   - 调整任何不匹配的地方
   
6. 完成并报告:
   ✅ ChatSidebar - 已完成
   ✅ ChatMessages - 已完成
   ✅ ChatInput - 已完成
   ✅ ChatHeader - 已完成
   ✅ Chat 页面布局 - 已完成
```

---

## 输出要求

每完成一个页面/组件，请输出：

```markdown
## ✅ [页面/组件名称] 复刻完成

**复刻文件**:
- 旧: src/pages/Chat.jsx
- 新: apps/web/src/app/(app)/chat/page.tsx

**涉及组件**:
- [x] ChatSidebar
- [x] ChatMessages  
- [x] ChatInput
- [x] ChatHeader

**关键修改**:
- 复制了 1224 行 components.css 到 globals.css
- 添加了 `.message-bubble-user` 和 `.message-bubble-assistant` 类
- 调整了 ChatInput 的高度从 h-16 到 h-[60px]
- 统一了圆角为 rounded-lg

**验证结果**:
- [x] 视觉效果与截图一致
- [x] 响应式布局正常
- [x] Hover/Focus 状态正确
- [x] 无 TypeScript 错误
- [x] 无 ESLint 警告

**截图**: [如果可能，提供完成后的截图]
```

---

## 开始执行

**当前状态**: 等待用户提供第一个页面的截图

**下一步**:
1. 用户上传页面截图
2. 用户指定对应的旧项目文件路径
3. Claude Code 执行复刻流程
4. 输出完成报告

**准备好了吗？请上传第一个需要复刻的页面截图！** 🚀
