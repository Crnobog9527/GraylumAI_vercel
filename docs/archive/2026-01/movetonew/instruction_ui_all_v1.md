UI 还原任务：从旧项目到新架构的视觉一致性迁移
任务目标
将新架构项目的 UI 完全还原为旧项目（graylumAi-backup）的视觉样式，确保用户体验的连续性，同时保持新架构的代码质量和技术优势。

执行前置条件
1. 理解项目架构差异
必读文档：
* 旧项目架构文档：https://github.com/Crnobog9527/graylumAi-backup/blob/main/.claude/ARCHITECTURE_ANALYSIS.md
* 旧项目仓库地址：https://github.com/Crnobog9527/graylumAi-backup

2. 旧项目视觉系统分析范围
扫描并分析以下旧项目文件以提取完整的视觉规范：
核心样式文件（必扫描）
graylumAi-backup/src/
├── theme.css                    # 主题系统变量 (376行)
├── components.css               # 组件样式库 (1224行)
├── index.css                    # 全局样式
├── App.css                      # 应用级样式
└── tailwind.config.js           # Tailwind 配置
关键组件文件（按优先级）
P0 - 核心布局组件：
├── components/layout/AppHeader.jsx
├── components/layout/GlobalBanner.jsx
└── components/common/

P0 - 聊天系统组件（15个）：
├── components/chat/ChatInput.jsx
├── components/chat/ChatMessages.jsx
├── components/chat/ChatSidebar.jsx
├── components/chat/MessageBubble.jsx
├── components/chat/ChatHeader.jsx
└── [其余聊天组件...]

P1 - 用户资料组件（5个）：
├── components/profile/ProfileComponents.jsx (1,348行)
├── components/profile/PersonalInfoCard.jsx
└── [其余资料组件...]

P1 - 管理后台组件（11个）：
├── components/admin/AdminSidebar.jsx
├── components/admin/StatsCard.jsx
└── [其余管理组件...]

P2 - 其他业务组件：
├── components/credits/
├── components/tickets/
├── components/invite/
└── components/modules/

任务执行步骤
Step 1: 视觉系统分析与提取（必须完成）
目标：建立完整的视觉设计规范文档
执行指令：
请扫描旧项目的以下文件，提取并整理完整的视觉规范：

1. 扫描 `src/theme.css` 和 `src/components.css`
2. 扫描 `tailwind.config.js` 中的自定义配置
3. 扫描所有 P0 级别的组件文件

提取以下设计元素：
- 🎨 颜色系统（所有 CSS 变量）
- 📏 间距系统（padding, margin, gap 的使用规律）
- 🔤 字体系统（font-family, font-size, font-weight, line-height）
- 🌑 阴影系统（box-shadow 的所有变体）
- 📐 圆角系统（border-radius 的使用规律）
- 🔲 边框系统（border-width, border-color）
- 🎭 动画系统（transition, animation）
- 📱 响应式断点（媒体查询规则）

输出格式：
创建 `VISUAL_DESIGN_SYSTEM.md` 文件，包含：
- 完整的 CSS 变量列表（分类整理）
- Tailwind 自定义类的映射表
- 组件级样式模式（如卡片样式、按钮样式、输入框样式）
- 布局模式（Flexbox/Grid 的使用规律）
- 深色主题的具体实现细节
输出文件：VISUAL_DESIGN_SYSTEM.md

Step 2: 新项目全局样式配置（基础设施）
目标：在新项目中建立与旧项目完全一致的样式基础
执行指令：
基于 Step 1 提取的视觉规范，配置新项目的全局样式系统：

1. 更新 `apps/web/src/app/globals.css`：
   - 复制旧项目的所有 CSS Variables
   - 保持变量命名与旧项目完全一致
   - 添加旧项目中的所有 @layer 定义
   - 复制所有全局样式规则

2. 更新 `apps/web/tailwind.config.ts`：
   - 复制旧项目的 theme.extend 配置
   - 确保颜色、间距、字体等配置完全匹配
   - 添加旧项目的自定义 Tailwind 类

3. 如果旧项目使用了无法通过 Tailwind 实现的样式：
   - 在 `globals.css` 中定义自定义 CSS 类
   - 使用 @layer components 或 @layer utilities
   - 保持类名与旧项目一致

4. 验证配置：
   - 确保所有 CSS 变量在开发者工具中可见
   - 确保深色主题正确应用
   - 确保没有编译错误
修改文件：
* apps/web/src/app/globals.css
* apps/web/tailwind.config.ts
验证清单：
* [ ] CSS 变量数量与旧项目一致
* [ ] 深色主题颜色值完全匹配
* [ ] Tailwind 配置无遗漏
* [ ] 无 CSS 编译错误

Step 3: UI 组件逐个还原（核心工作）
目标：使每个组件的视觉呈现与旧项目完全一致
执行原则：
🎯 核心原则：
1. 视觉一致性优先级 > 代码优雅性
2. 保持新架构的组件逻辑和 Props 接口
3. 只修改视觉相关代码（className, style, CSS）
4. 不修改组件的业务逻辑和数据流
5. 使用旧项目的 className 组合作为参考

📋 还原清单：
对于每个组件，确保以下元素完全一致：
- 背景颜色（background-color）
- 文本颜色和大小（color, font-size, font-weight）
- 内外边距（padding, margin）
- 边框和圆角（border, border-radius）
- 阴影效果（box-shadow）
- Hover/Focus/Active 状态样式
- 动画和过渡效果（transition, animation）
- 响应式断点行为（媒体查询）
- 图标大小和颜色
- 布局方式（flex, grid）
3.1 组件还原优先级和顺序
Phase A: 核心布局组件（P0）
请按以下顺序还原核心布局组件：

1. AppHeader（应用头部导航）
   旧文件：src/components/layout/AppHeader.jsx
   新文件：apps/web/src/components/layout/AppHeader.tsx
   
   关键点：
   - Logo 位置和大小
   - 导航菜单项的间距和字体
   - 用户头像的位置和样式
   - 下拉菜单的样式
   - 响应式汉堡菜单（如有）

2. GlobalBanner（全局横幅）
   旧文件：src/components/layout/GlobalBanner.jsx
   新文件：apps/web/src/components/layout/GlobalBanner.tsx
   
   关键点：
   - 横幅高度和背景色
   - 关闭按钮样式
   - 文本对齐和间距
   - 渐变或阴影效果（如有）

3. Sidebar（侧边栏 - 如果项目有）
   旧文件：src/components/layout/
   新文件：apps/web/src/components/layout/Sidebar.tsx
   
   关键点：
   - 侧边栏宽度
   - 菜单项的 hover 效果
   - 图标和文字的对齐
   - 折叠/展开动画
Phase B: 聊天系统组件（P0）
请按以下顺序还原聊天系统组件：

1. ChatSidebar（对话列表侧边栏）
   旧文件：src/components/chat/ChatSidebar.jsx
   新文件：apps/web/src/components/chat/ChatSidebar.tsx
   
   还原要点：
   - 侧边栏宽度和背景色
   - 对话项的高度和间距
   - 选中状态的高亮样式
   - Hover 效果
   - 滚动条样式

2. ChatHeader（聊天头部）
   旧文件：src/components/chat/ChatHeader.jsx
   新文件：apps/web/src/components/chat/ChatHeader.tsx
   
   还原要点：
   - 头部高度和边框
   - 标题字体和颜色
   - 右侧按钮组的布局和间距
   - 下拉菜单的样式

3. MessageBubble（消息气泡）
   旧文件：src/components/chat/MessageBubble.jsx
   新文件：apps/web/src/components/chat/MessageBubble.tsx
   
   还原要点：（这是最关键的组件）
   - 用户消息和 AI 消息的颜色差异
   - 气泡的圆角和内边距
   - 头像的大小和位置
   - 时间戳的字体和颜色
   - 代码块的样式（如果支持 Markdown）
   - 消息间距

4. ChatMessages（消息列表容器）
   旧文件：src/components/chat/ChatMessages.jsx
   新文件：apps/web/src/components/chat/ChatMessages.tsx
   
   还原要点：
   - 容器的背景色
   - 消息列表的内边距
   - 滚动行为
   - 加载状态的样式

5. ChatInput（消息输入框）
   旧文件：src/components/chat/ChatInput.jsx
   新文件：apps/web/src/components/chat/ChatInput.tsx
   
   还原要点：
   - 输入框高度和边框
   - 占位符文字样式
   - 发送按钮的大小、颜色、位置
   - 附件按钮的样式（如有）
   - Focus 状态的边框颜色
   - 多行输入的最大高度

6. ChatInputArea（输入区域容器）
   旧文件：src/components/chat/ChatInputArea.jsx
   新文件：apps/web/src/components/chat/ChatInputArea.tsx

7. ModelSelector（模型选择器）
   旧文件：src/components/chat/ModelSelector.jsx
   新文件：apps/web/src/components/chat/ModelSelector.tsx
   
   还原要点：
   - 选择器的样式
   - 选项的高度和间距
   - 选中状态的高亮
   - 图标的大小和颜色

8. 其余聊天组件...
   - ChatDebugPanel.tsx
   - PromptModuleCard.tsx
   - PromptModuleGrid.tsx
   - TemplateCard.tsx
   - TokenUsageStats.tsx
   - FileAttachmentCard.tsx
   - ActiveModuleBanner.tsx
Phase C: 用户资料组件（P1）
请还原用户资料相关组件：

1. ProfileComponents（主资料组件）
   旧文件：src/components/profile/ProfileComponents.jsx (1,348行)
   新文件：apps/web/src/components/profile/ProfileComponents.tsx
   
   还原要点：
   - 整体布局（Grid/Flex）
   - 卡片间距
   - 标签页样式（如有）

2. PersonalInfoCard（个人信息卡片）
   旧文件：src/components/profile/PersonalInfoCard.jsx
   新文件：apps/web/src/components/profile/PersonalInfoCard.tsx
   
   还原要点：
   - 卡片的阴影和圆角
   - 表单字段的间距
   - 编辑/保存按钮的样式

3. AvatarCropper（头像裁剪）
   旧文件：src/components/profile/AvatarCropper.jsx
   新文件：apps/web/src/components/profile/AvatarCropper.tsx

4. CreditsDialog（积分对话框）
   旧文件：src/components/profile/CreditsDialog.jsx
   新文件：apps/web/src/components/profile/CreditsDialog.tsx

5. TicketsPanel（工单面板）
   旧文件：src/components/profile/TicketsPanel.jsx
   新文件：apps/web/src/components/profile/TicketsPanel.tsx
Phase D: 积分和工单组件（P1）
请还原积分和工单系统组件：

积分组件：
1. CreditBalance.tsx
2. CreditPackageCard.tsx

工单组件：
1. TicketCard.tsx
2. TicketInfo.tsx
3. TicketStatusBadge.tsx
4. TicketPriorityBadge.tsx
5. TicketReplyForm.tsx
6. TicketReplyList.tsx
7. TicketClosedNotice.tsx
8. LoadingSpinner.tsx
Phase E: 管理后台组件（P1）
请还原管理后台组件：

1. AdminSidebar（管理侧边栏）
2. StatsCard（统计卡片）
3. SystemStats（系统统计）
4. UserManagement（用户管理）
5. TicketManagement（工单管理）
6. ModelManagement（模型管理）
7. TemplateManagement（模板管理）
8. AIPerformanceMonitor（AI 性能监控）
9. MembershipPermissionsCard（会员权限卡片）
Phase F: 其他业务组件（P2）
请还原其他业务组件：

首页组件：
1. WelcomeBanner.tsx
2. QuickStartGuide.tsx
3. UpdatesSection.tsx

功能模块组件：
1. ModuleCard.tsx
2. ModuleDetailDialog.tsx
3. moduleIcons.tsx
4. iconConfig.tsx

通用组件：
1. ConversationList.tsx
2. CreditDisplay.tsx

其他：
1. InviteDialog.tsx
2. FeaturedModules.tsx
3.2 组件还原标准流程
对于每个组件，请按以下流程执行：
步骤 1：对比分析
- 在编辑器中并排打开旧组件和新组件文件
- 使用浏览器开发者工具检查旧项目的实际渲染样式
- 记录所有 className 和内联 style

步骤 2：样式迁移
- 复制旧组件的 className 组合
- 如果使用了自定义 CSS 类，在 globals.css 中定义
- 保持相同的 HTML 结构（div, section, etc.）
- 保持相同的 Flexbox/Grid 布局

步骤 3：状态样式迁移
- 迁移 hover: 伪类样式
- 迁移 focus: 伪类样式
- 迁移 active: 伪类样式
- 迁移 disabled: 状态样式
- 迁移 group-hover: 等复杂状态

步骤 4：响应式样式迁移
- 迁移 sm: 断点样式
- 迁移 md: 断点样式
- 迁移 lg: 断点样式
- 迁移 xl: 断点样式

步骤 5：视觉验证
- 在浏览器中并排对比旧项目和新项目
- 使用截图工具进行像素级对比
- 检查不同屏幕尺寸的表现
- 检查深色模式的表现（如果支持）

步骤 6：代码规范检查
- 确保 TypeScript 类型正确
- 确保组件 Props 保持不变
- 确保无 ESLint 警告
- 确保代码格式化正确

Step 4: Shadcn/ui 基础组件样式覆盖
目标：确保 49 个 Shadcn/ui 基础组件的样式与旧项目一致
执行指令：
Shadcn/ui 的 49 个基础组件需要特殊处理，因为它们被多个业务组件使用。

请执行以下操作：

1. 扫描旧项目的 `src/components/ui/` 目录
2. 对比新项目的 `packages/ui/src/components/` 目录（或 `apps/web/src/components/ui/`）
3. 逐个组件对比样式差异

关键组件优先级：
P0 - 高频使用组件：
- Button（按钮）
- Input（输入框）
- Card（卡片）
- Dialog（对话框）
- Select（选择器）
- Tabs（标签页）

P1 - 中频使用组件：
- Dropdown Menu（下拉菜单）
- Avatar（头像）
- Badge（徽章）
- Toast/Sonner（通知）
- Tooltip（工具提示）
- Separator（分隔线）

P2 - 其他组件：
- Accordion, Alert, Checkbox, Progress, Slider, Switch, Table, Textarea 等

还原方法：
- 如果旧项目有自定义样式，在组件文件中添加相应的 className
- 如果是全局覆盖，在 globals.css 中使用 CSS 选择器
- 保持组件的功能和 API 不变
修改文件：
* packages/ui/src/components/*.tsx（或对应路径）
* apps/web/src/app/globals.css（全局覆盖）

Step 5: 页面级布局还原
目标：确保页面整体布局与旧项目一致
执行指令：
还原以下关键页面的布局：

1. 首页 (/)
   旧文件：src/pages/Home.jsx
   新文件：apps/web/src/app/page.tsx
   
   关键点：
   - Hero 区域的高度和背景
   - 功能展示区的卡片布局
   - 页脚样式

2. 聊天页面 (/chat)
   旧文件：src/pages/Chat.jsx
   新文件：apps/web/src/app/(app)/chat/page.tsx
   
   关键点：
   - 三栏布局（侧边栏 + 聊天区 + 右侧栏，如有）
   - 固定头部和输入框
   - 滚动区域的处理

3. 用户资料页面 (/profile)
   旧文件：src/pages/Profile.jsx
   新文件：apps/web/src/app/(app)/profile/page.tsx
   
   关键点：
   - 标签页布局
   - 卡片网格布局
   - 响应式行为

4. 管理后台页面 (/admin/*)
   旧文件：src/pages/Admin*.jsx
   新文件：apps/web/src/app/(admin)/*/page.tsx
   
   关键点：
   - 侧边栏 + 主内容区布局
   - 数据表格样式
   - 统计卡片布局

5. 市场页面 (/marketplace)
   旧文件：src/pages/Marketplace.jsx
   新文件：apps/web/src/app/marketplace/page.tsx

6. 模板页面 (/templates)
   旧文件：src/pages/Templates.jsx
   新文件：apps/web/src/app/templates/page.tsx

Step 6: 细节打磨与最终验证
目标：确保像素级一致性
执行指令：
进行最终的细节打磨和全面验证：

1. 图标一致性检查：
   - 确保使用相同的图标库（lucide-react）
   - 确保图标大小一致（通常是 h-4 w-4, h-5 w-5, h-6 w-6）
   - 确保图标颜色与文字颜色一致

2. 字体一致性检查：
   - 标题字体大小（text-xl, text-2xl, text-3xl）
   - 正文字体大小（text-sm, text-base）
   - 字体粗细（font-normal, font-medium, font-semibold, font-bold）
   - 行高（leading-normal, leading-relaxed）

3. 间距一致性检查：
   - 组件内边距（p-2, p-4, p-6）
   - 组件间距（space-y-4, gap-4）
   - 容器最大宽度（max-w-7xl, max-w-4xl）

4. 动画一致性检查：
   - 过渡时间（transition-all duration-200）
   - 动画效果（animate-in, fade-in, slide-in）

5. 响应式一致性检查：
   - 在 320px（移动端最小）下测试
   - 在 768px（平板）下测试
   - 在 1024px（桌面）下测试
   - 在 1920px（大屏）下测试

6. 深色主题一致性检查：
   - 所有页面在深色模式下的表现
   - 确保没有白色闪烁
   - 确保对比度足够

7. 交互状态一致性检查：
   - Hover 状态颜色和效果
   - Focus 状态边框
   - Active 状态反馈
   - Disabled 状态的灰度和不透明度
   - Loading 状态的动画

8. 边缘情况检查：
   - 长文本的截断或换行
   - 空状态的显示
   - 错误状态的显示
   - 加载状态的骨架屏

特殊注意事项
⚠️ 不要修改的内容
在还原 UI 的过程中，请确保不修改以下内容：

❌ 不要修改：
- 组件的 Props 接口和 TypeScript 类型
- 组件的业务逻辑和状态管理
- tRPC 调用和数据获取逻辑
- 事件处理函数的逻辑
- 路由配置和导航逻辑
- 认证和权限检查逻辑

✅ 只修改：
- className 属性
- 内联 style 属性（如果必要）
- CSS 文件中的样式定义
- Tailwind 配置
- HTML 结构（仅在确保不影响逻辑的情况下）

🎯 CSS Variables 使用规范
如果遇到 Tailwind 无法直接实现的样式，请在 globals.css 中定义：

示例 1: 复杂的渐变背景
.chat-message-gradient {
  background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
}

示例 2: 复杂的阴影
.card-elevation-2 {
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1),
              0 2px 4px -1px rgba(0, 0, 0, 0.06);
}

示例 3: 复杂的动画
@keyframes slide-in-right {
  from {
    transform: translateX(100%);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}

.animate-slide-in-right {
  animation: slide-in-right 0.3s ease-out;
}

使用位置：
- 将这些定义放在 apps/web/src/app/globals.css 的 @layer components 或 @layer utilities 中
- 确保类名不与 Tailwind 内置类冲突
- 添加注释说明用途

输出要求
1. 任务计划文档
更新 task_plan.md

2. 视觉设计系统文档
创建 VISUAL_DESIGN_SYSTEM.md（在 Step 1 中生成）
3. 组件还原记录
对于每个已还原的组件，在代码注释中添加：
/**
 * UI 还原状态: ✅ 已完成
 * 还原日期: 2026-01-XX
 * 参考文件: graylumAi-backup/src/components/chat/ChatInput.jsx
 * 关键还原点:
 * - 输入框高度: h-[60px]
 * - 边框颜色: border-input
 * - Focus 状态: focus:ring-2 focus:ring-ring
 * - 发送按钮: bg-primary hover:bg-primary/90
 */
export function ChatInput({ onSend, isLoading }: ChatInputProps) {
  // ...
}

验收标准
最终验收清单
UI 视觉一致性验收（必须全部通过）：
- [ ] 颜色系统 100% 匹配
- [ ] 字体系统 100% 匹配
- [ ] 间距系统 100% 匹配
- [ ] 阴影效果 100% 匹配
- [ ] 圆角系统 100% 匹配
- [ ] 边框系统 100% 匹配
- [ ] 动画效果 100% 匹配
- [ ] 响应式布局 100% 匹配
- [ ] 深色主题 100% 匹配

组件还原完成度：
- [ ] 105 个组件全部还原完成
- [ ] 49 个 Shadcn/ui 组件样式已覆盖
- [ ] 所有页面布局已还原

代码质量检查：
- [ ] TypeScript 无编译错误
- [ ] ESLint 无警告
- [ ] 组件逻辑未被破坏
- [ ] 所有功能正常运行

用户体验验收：
- [ ] 在不同屏幕尺寸下表现一致
- [ ] 交互状态反馈流畅
- [ ] 无视觉闪烁或跳动
- [ ] 加载状态友好

执行示例
~~~
示例 1: 还原 ChatInput 组件
// 旧项目：src/components/chat/ChatInput.jsx
<div className="border-t p-4 bg-card">
  <div className="max-w-3xl mx-auto flex gap-2">
    <textarea
      className="min-h-[60px] max-h-[200px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
      placeholder="输入消息... (Shift+Enter 换行)"
    />
    <button className="h-[60px] w-[60px] rounded-md bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center justify-center">
      <Send className="h-5 w-5" />
    </button>
  </div>
</div>

// 新项目：apps/web/src/components/chat/ChatInput.tsx
// 保持相同的 className 和结构
export function ChatInput({ onSend, isLoading }: ChatInputProps) {
  return (
    <div className="border-t p-4 bg-card">
      <div className="max-w-3xl mx-auto flex gap-2">
        <Textarea
          className="min-h-[60px] max-h-[200px]"
          placeholder="输入消息... (Shift+Enter 换行)"
          // ... 其他 props
        />
        <Button
          className="h-[60px] w-[60px]"
          size="icon"
          // ... 其他 props
        >
          <Send className="h-5 w-5" />
        </Button>
      </div>
    </div>
  );
}
~~~

