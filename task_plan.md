# Task Plan: GraylumAI Phase 3 迁移

## Goal
完成 GraylumAI 项目从阶段九到阶段十四的所有迁移工作，包括：
- 阶段九至十一：业务逻辑迁移（工单系统、系统设置、邀请推广、AI模型管理、管理后台）
- 阶段十二至十四：UI 还原（全局样式、核心组件、页面布局）

## Current Phase
阶段九、十、十一（业务逻辑）全部完成 ✅
阶段十二、十三、十四（UI 还原）全部完成 ✅
**Phase 3 迁移全部完成！**

## Phases

### 阶段九：工单与系统设置迁移 ✅ 已完成
- [x] 任务 9.1：迁移工单系统 API (创建 ticketRouter)
- [x] 任务 9.2：迁移系统设置 API (创建 settingsRouter)
- [x] 任务 9.3：创建工单页面 (tickets/page.tsx)
- [x] 任务 9.4：提交第九阶段成果
- **Status:** ✅ 已完成并验证通过
- **验证结果:** tickets 页面正常访问，数据可写入数据库

### 阶段十：邀请推广与模型管理迁移 ✅ 已完成
- [x] 任务 10.1：迁移 AI 模型管理 API (创建 modelRouter)
- [x] 任务 10.2：迁移邀请推广 API (创建 invitationRouter)
- [x] 任务 10.3：创建 AI 模型管理页面 (models/page.tsx)
- [x] 任务 10.4：创建邀请码管理页面 (invitations/page.tsx)
- [x] 任务 10.5：提交第十阶段成果
- **Status:** ✅ 已完成并验证通过
- **验证结果:** models 和 invitations 页面正常访问，数据可写入数据库

### 阶段十一：管理后台与最终优化 ✅ 已完成
- [x] 任务 11.1：实现管理员角色权限控制 (adminProcedure)
- [x] 任务 11.2：应用管理员权限到相关 API
- [x] 任务 11.3：创建管理后台仪表盘 (admin/page.tsx)
- [x] 任务 11.4：创建获取统计数据的 API (getStatistics)
- [x] 任务 11.5：最终代码提交与部署准备
- [x] 修复：models/invitations 页面添加访问拒绝提示，getAvailableModels 改为 adminProcedure
- **Status:** ✅ 已完成并验证通过
- **验证结果:**
  - 管理员可正常访问 /admin、/models、/invitations 页面
  - 普通用户无法访问以上管理员页面，显示 Access Denied

---

## 🎨 UI 还原阶段

### 阶段十二：全局样式与主题还原 ✅ 已完成
**目标**: 将原有设计系统中的全局颜色、字体、间距、圆角、阴影等变量，配置到 Tailwind CSS 和 Shadcn/ui 的主题中。

- [x] 任务 12.1：配置 Tailwind CSS 颜色变量
  - 使用 Tailwind v4 的 `@theme inline` 块配置（项目使用 v4，不需要 tailwind.config.ts）
  - 引入 GraylumAI 自定义颜色（graylumPrimary, graylumBgPrimary 等）
- [x] 任务 12.2：配置 Shadcn/ui 主题颜色
  - 更新 `globals.css` 中的 CSS 变量（:root 和 .dark）
  - 配置字体变量（使用系统字体后备方案）
  - 添加间距、圆角、阴影、过渡、z-index 变量
  - 添加全局基础样式（滚动条、选择样式、聚焦样式）
- [x] 任务 12.3：配置 Tailwind CSS 字体和间距
  - 通过 `@theme inline` 块添加所有配置
- [x] 任务 12.4：提交第十二阶段成果
- [x] 修复：字体加载 404 错误 - 移除 @font-face 声明
- **Status:** ✅ 已完成并验证通过
- **验证结果:**
  - 页面背景色、文字颜色正确显示
  - Shadcn/ui 组件主题颜色正确（黄色主题）
- **遇到的错误:**
  | 错误 | 原因 | 解决方案 | 状态 |
  |------|------|----------|------|
  | 字体 404 (Inter, JetBrains Mono) | @font-face URL 不完整 | 移除 @font-face，使用系统字体后备 | ✅ 已修复 |

### 阶段十三：核心 UI 组件样式还原 ✅ 已完成
**目标**: 针对 Shadcn/ui 的核心组件，根据原有 UI 的设计稿进行样式定制。

- [x] 任务 13.1：定制 Button 组件样式
  - 添加过渡动画 (`transition-all duration-200`)
  - 添加悬停阴影 (`hover:shadow-lg`)、点击缩放 (`active:scale-[0.98]`)
- [x] 任务 13.2：定制 Card 组件样式
  - 添加边框 (`border-border`)、中等阴影 (`shadow-md`)
  - 添加悬停阴影过渡 (`hover:shadow-lg`)
- [x] 任务 13.3：定制 Input 和 Textarea 组件样式
  - 添加背景色 (`bg-muted`)
  - 添加聚焦环和边框高亮 (`focus-visible:ring-2 focus-visible:border-primary`)
- [x] 任务 13.4：提交第十三阶段成果
- **Status:** ✅ 已完成并验证通过
- **验证结果:**
  - 按钮颜色、悬停效果、点击反馈正常
  - 卡片背景、边框、阴影正确显示
  - 输入框背景、聚焦效果正常

### 阶段十四：页面布局与交互细节还原 ✅ 已完成
**目标**: 调整关键页面的布局并恢复特定的交互细节（动画、滚动条等）。

- [x] 任务 14.1：调整聊天页面布局
  - 更新 `page.tsx` 主页布局：320px 侧边栏、bg-card 背景、border-border 分隔线
  - 添加 overflow 处理
- [x] 任务 14.2：恢复自定义滚动条样式
  - 已在阶段十二配置（Webkit + Firefox 滚动条样式）
- [x] 任务 14.3：恢复全局动画和过渡效果
  - 添加 @keyframes 动画（fade-in, slide-up/down, scale-in, pulse）
  - 添加动画工具类（animate-graylum-*）
  - 添加过渡工具类（transition-graylum-fast/normal/slow/bounce）
- [x] 任务 14.4：提交第十四阶段成果
- **Status:** ✅ 已完成并验证通过
- **验证结果:**
  - 聊天页面布局正确
  - 滚动条样式正常
  - 动画效果可用

---

## 🚀 Phase 4: 完整 UI 还原（未来工作）

> **参考文档**: `movetonew/instruction_ui_all_v1.md`
> **目标**: 将新架构项目的 UI 完全还原为旧项目（graylumAi-backup）的视觉样式，确保用户体验的连续性。

### 前置条件
- [x] 阅读旧项目架构文档: https://github.com/Crnobog9527/graylumAi-backup/blob/main/.claude/ARCHITECTURE_ANALYSIS.md
- [x] 克隆旧项目仓库: https://github.com/Crnobog9527/graylumAi-backup (位于 `/home/user/graylumAi-backup-ref/`)

### Step 4.1: 视觉系统分析与提取 ✅ 已完成
**目标**: 建立完整的视觉设计规范文档 (`VISUAL_DESIGN_SYSTEM.md`)

扫描旧项目文件:
- [x] `src/theme.css` (376行) - 主题系统变量
- [x] `src/components.css` (1224行) - 组件样式库
- [x] `src/index.css` - 全局样式
- [x] `tailwind.config.js` - Tailwind 配置

提取设计元素:
- [x] 🎨 颜色系统（所有 CSS 变量）
- [x] 📏 间距系统（padding, margin, gap）
- [x] 🔤 字体系统（font-family, font-size, font-weight, line-height）
- [x] 🌑 阴影系统（box-shadow）
- [x] 📐 圆角系统（border-radius）
- [x] 🔲 边框系统（border-width, border-color）
- [x] 🎭 动画系统（transition, animation）
- [x] 📱 响应式断点（媒体查询规则）

**输出文件**: `movetonew/VISUAL_DESIGN_SYSTEM.md` ✅

### Step 4.2: 全局样式配置更新 ✅ 已完成
**目标**: 补充 Phase 12 中可能遗漏的样式

- [x] 对比旧项目 CSS 变量，补充遗漏项
  - 添加 `--color-primary-10/20/30` 透明度变体
  - 添加 `--success-bg/warning-bg/error-bg/info-bg` 状态背景色
  - 添加 `--sidebar-*` 侧边栏变量
  - 添加 `--chart-1~5` 图表颜色
- [x] 添加组件类 (btn, card, badge, skeleton, text-gradient)
- [x] 验证深色主题配置

**修改文件**:
- `apps/web/src/app/globals.css` ✅

### Step 4.3: UI 组件逐个还原（105 个组件）

#### Phase A: 核心布局组件（P0）
| 组件 | 旧文件 | 新文件 | 状态 |
|------|--------|--------|------|
| AppHeader | src/components/layout/AppHeader.jsx | apps/web/src/components/layout/AppHeader.tsx | ✅ |
| GlobalBanner | src/components/layout/GlobalBanner.jsx | apps/web/src/components/layout/GlobalBanner.tsx | ⬜ |
| Sidebar | src/components/layout/ | apps/web/src/components/layout/Sidebar.tsx | ⬜ |

#### Phase B: 聊天系统组件（P0 - 15个）- 核心组件已完成
| 组件 | 旧文件 | 新文件 | 状态 |
|------|--------|--------|------|
| ChatSidebar | src/components/chat/ChatSidebar.jsx | apps/web/src/components/chat/ChatSidebar.tsx | ✅ |
| ChatHeader | src/components/chat/ChatHeader.jsx | apps/web/src/components/chat/ChatHeader.tsx | ✅ |
| MessageBubble | src/components/chat/MessageBubble.jsx | apps/web/src/components/chat/ChatInterface.tsx (内置) | ✅ |
| ChatMessages | src/components/chat/ChatMessages.jsx | apps/web/src/components/chat/ChatInterface.tsx (内置) | ✅ |
| ChatInput | src/components/chat/ChatInput.jsx | apps/web/src/components/chat/ChatInterface.tsx (内置) | ✅ |
| ChatInputArea | src/components/chat/ChatInputArea.jsx | apps/web/src/components/chat/ChatInterface.tsx (内置) | ✅ |
| ModelSelector | src/components/chat/ModelSelector.jsx | apps/web/src/components/chat/ModelSelector.tsx | ⬜ |
| ChatDebugPanel | - | apps/web/src/components/chat/ChatDebugPanel.tsx | ⬜ |
| PromptModuleCard | - | apps/web/src/components/chat/PromptModuleCard.tsx | ⬜ |
| PromptModuleGrid | - | apps/web/src/components/chat/PromptModuleGrid.tsx | ⬜ |
| TemplateCard | - | apps/web/src/components/chat/TemplateCard.tsx | ⬜ |
| TokenUsageStats | - | apps/web/src/components/chat/TokenUsageStats.tsx | ⬜ |
| FileAttachmentCard | - | apps/web/src/components/chat/FileAttachmentCard.tsx | ⬜ |
| ActiveModuleBanner | - | apps/web/src/components/chat/ActiveModuleBanner.tsx | ⬜ |

#### Phase C: 用户资料组件（P1 - 5个）
| 组件 | 旧文件 | 新文件 | 状态 |
|------|--------|--------|------|
| ProfileComponents | src/components/profile/ProfileComponents.jsx (1348行) | apps/web/src/components/profile/ProfileComponents.tsx | ⬜ |
| PersonalInfoCard | src/components/profile/PersonalInfoCard.jsx | apps/web/src/components/profile/PersonalInfoCard.tsx | ⬜ |
| AvatarCropper | src/components/profile/AvatarCropper.jsx | apps/web/src/components/profile/AvatarCropper.tsx | ⬜ |
| CreditsDialog | src/components/profile/CreditsDialog.jsx | apps/web/src/components/profile/CreditsDialog.tsx | ⬜ |
| TicketsPanel | src/components/profile/TicketsPanel.jsx | apps/web/src/components/profile/TicketsPanel.tsx | ⬜ |

#### Phase D: 积分和工单组件（P1 - 10个）
积分组件:
| 组件 | 状态 |
|------|------|
| CreditBalance.tsx | ⬜ |
| CreditPackageCard.tsx | ⬜ |

工单组件:
| 组件 | 状态 |
|------|------|
| TicketCard.tsx | ⬜ |
| TicketInfo.tsx | ⬜ |
| TicketStatusBadge.tsx | ⬜ |
| TicketPriorityBadge.tsx | ⬜ |
| TicketReplyForm.tsx | ⬜ |
| TicketReplyList.tsx | ⬜ |
| TicketClosedNotice.tsx | ⬜ |
| LoadingSpinner.tsx | ⬜ |

#### Phase E: 管理后台组件（P1 - 9个）
| 组件 | 旧文件 | 新文件 | 状态 |
|------|--------|--------|------|
| AdminSidebar | src/components/admin/AdminSidebar.jsx | apps/web/src/components/admin/AdminSidebar.tsx | ⬜ |
| StatsCard | src/components/admin/StatsCard.jsx | apps/web/src/components/admin/StatsCard.tsx | ⬜ |
| SystemStats | src/components/admin/SystemStats.jsx | apps/web/src/components/admin/SystemStats.tsx | ⬜ |
| UserManagement | src/components/admin/UserManagement.jsx | apps/web/src/components/admin/UserManagement.tsx | ⬜ |
| TicketManagement | src/components/admin/TicketManagement.jsx | apps/web/src/components/admin/TicketManagement.tsx | ⬜ |
| ModelManagement | src/components/admin/ModelManagement.jsx | apps/web/src/components/admin/ModelManagement.tsx | ⬜ |
| TemplateManagement | src/components/admin/TemplateManagement.jsx | apps/web/src/components/admin/TemplateManagement.tsx | ⬜ |
| AIPerformanceMonitor | src/components/admin/AIPerformanceMonitor.jsx | apps/web/src/components/admin/AIPerformanceMonitor.tsx | ⬜ |
| MembershipPermissionsCard | src/components/admin/MembershipPermissionsCard.jsx | apps/web/src/components/admin/MembershipPermissionsCard.tsx | ⬜ |

#### Phase E.2: 管理后台页面（P1 - 12个）
| 页面 | 旧文件 | 新文件 | 状态 |
|------|--------|--------|------|
| 仪表盘 | src/pages/AdminDashboard.jsx | apps/web/src/app/admin/page.tsx | ⬜ |
| 用户管理 | src/pages/AdminUsers.jsx | apps/web/src/app/admin/users/page.tsx | ⬜ |
| 工单管理 | src/pages/AdminTickets.jsx | apps/web/src/app/admin/tickets/page.tsx | ⬜ |
| AI模型管理 | src/pages/AdminModels.jsx | apps/web/src/app/admin/models/page.tsx | ⬜ |
| 模块/提示词管理 | src/pages/AdminPrompts.jsx | apps/web/src/app/admin/prompts/page.tsx | ⬜ |
| 邀请码管理 | src/pages/AdminInvitations.jsx | apps/web/src/app/admin/invitations/page.tsx | ⬜ |
| 积分包管理 | src/pages/AdminPackages.jsx | apps/web/src/app/admin/packages/page.tsx | ⬜ |
| 交易记录 | src/pages/AdminTransactions.jsx | apps/web/src/app/admin/transactions/page.tsx | ⬜ |
| 财务统计 | src/pages/AdminFinance.jsx | apps/web/src/app/admin/finance/page.tsx | ⬜ |
| 公告管理 | src/pages/AdminAnnouncements.jsx | apps/web/src/app/admin/announcements/page.tsx | ⬜ |
| 系统设置 | src/pages/AdminSettings.jsx | apps/web/src/app/admin/settings/page.tsx | ⬜ |
| 性能监控 | src/pages/AdminPerformance.jsx | apps/web/src/app/admin/performance/page.tsx | ⬜ |

#### Phase F: 其他业务组件（P2）
首页组件:
| 组件 | 状态 |
|------|------|
| WelcomeBanner.tsx | ✅ |
| SixStepsGuide.tsx | ✅ |
| UpdatesSection.tsx | ✅ |

功能模块组件:
| 组件 | 状态 |
|------|------|
| ModuleCard.tsx | ✅ |
| ModuleDetailDialog.tsx | ⬜ |
| FeaturedModules.tsx | ✅ |
| iconConfig.tsx | ✅ |

通用组件:
| 组件 | 状态 |
|------|------|
| ConversationList.tsx | ✅ |
| CreditDisplay.tsx | ⬜ |
| InviteDialog.tsx | ⬜ |
| FeaturedModules.tsx | ⬜ |

### Step 4.4: Shadcn/ui 基础组件样式覆盖（49个组件）

#### P0 - 高频使用组件（Phase 13 已部分完成）
| 组件 | 状态 | 备注 |
|------|------|------|
| Button | ✅ | Phase 13 已完成 |
| Input | ✅ | Phase 13 已完成 |
| Textarea | ✅ | Phase 13 已完成 |
| Card | ✅ | Phase 13 已完成 |
| Dialog | ⬜ | 需还原 |
| Select | ⬜ | 需还原 |
| Tabs | ⬜ | 需还原 |

#### P1 - 中频使用组件
| 组件 | 状态 |
|------|------|
| Dropdown Menu | ✅ |
| Avatar | ✅ |
| Badge | ⬜ |
| Toast/Sonner | ⬜ |
| Tooltip | ⬜ |
| Separator | ⬜ |
| Dialog | ✅ |
| Select | ✅ |
| Sheet | ✅ |

#### P2 - 其他组件
| 组件 | 状态 |
|------|------|
| Accordion | ⬜ |
| Alert | ⬜ |
| Checkbox | ⬜ |
| Progress | ⬜ |
| Slider | ⬜ |
| Switch | ⬜ |
| Table | ⬜ |
| ... (其余 30+ 组件) | ⬜ |

### Step 4.5: 页面级布局还原

#### 已完成页面
| 页面 | 旧文件 | 新文件 | 状态 | 备注 |
|------|--------|--------|------|------|
| 首页 (/) | src/pages/Home.jsx | apps/web/src/app/page.tsx | ✅ | commit: 62568f4 |
| 聊天页面 (/chat) | src/pages/Chat.jsx | apps/web/src/app/chat/page.tsx | ✅ | commit: 06e9bfd |
| 用户资料 (/profile) | src/pages/Profile.jsx | apps/web/src/app/profile/page.tsx | ✅ | commit: e09d60d, d99b2c6 |
| 市场页面 (/marketplace) | src/pages/Marketplace.jsx | apps/web/src/app/marketplace/page.tsx | ✅ | commit: 3f4395d |

#### 管理后台页面 (12个) - 进行中 (1/12 完成)
| 页面 | 旧文件 | 新文件 | 状态 |
|------|--------|--------|------|
| 仪表盘 | src/pages/AdminDashboard.jsx | apps/web/src/app/admin/page.tsx | ✅ |
| 用户管理 | src/pages/AdminUsers.jsx | apps/web/src/app/admin/users/page.tsx | ⬜ |
| 工单管理 | src/pages/AdminTickets.jsx | apps/web/src/app/admin/tickets/page.tsx | ⬜ |
| AI模型管理 | src/pages/AdminModels.jsx | apps/web/src/app/admin/models/page.tsx | ⬜ |
| 模块管理 | src/pages/AdminPrompts.jsx | apps/web/src/app/admin/prompts/page.tsx | ⬜ |
| 邀请码管理 | src/pages/AdminInvitations.jsx | apps/web/src/app/admin/invitations/page.tsx | ⬜ |
| 积分包管理 | src/pages/AdminPackages.jsx | apps/web/src/app/admin/packages/page.tsx | ⬜ |
| 交易记录 | src/pages/AdminTransactions.jsx | apps/web/src/app/admin/transactions/page.tsx | ⬜ |
| 财务统计 | src/pages/AdminFinance.jsx | apps/web/src/app/admin/finance/page.tsx | ⬜ |
| 公告管理 | src/pages/AdminAnnouncements.jsx | apps/web/src/app/admin/announcements/page.tsx | ⬜ |
| 系统设置 | src/pages/AdminSettings.jsx | apps/web/src/app/admin/settings/page.tsx | ⬜ |
| 性能监控 | src/pages/AdminPerformance.jsx | apps/web/src/app/admin/performance/page.tsx | ⬜ |

#### 待完成页面
| 页面 | 旧文件 | 新文件 | 状态 |
|------|--------|--------|------|
| 模板页面 (/templates) | src/pages/Templates.jsx | apps/web/src/app/templates/page.tsx | ⬜ |

### Step 4.6: 细节打磨与最终验证

#### 验收清单
UI 视觉一致性:
- [ ] 颜色系统 100% 匹配
- [ ] 字体系统 100% 匹配
- [ ] 间距系统 100% 匹配
- [ ] 阴影效果 100% 匹配
- [ ] 圆角系统 100% 匹配
- [ ] 边框系统 100% 匹配
- [ ] 动画效果 100% 匹配
- [ ] 响应式布局 100% 匹配
- [ ] 深色主题 100% 匹配

组件还原完成度:
- [ ] 105 个组件全部还原完成
- [ ] 49 个 Shadcn/ui 组件样式已覆盖
- [ ] 所有页面布局已还原

代码质量检查:
- [ ] TypeScript 无编译错误
- [ ] ESLint 无警告
- [ ] 组件逻辑未被破坏
- [ ] 所有功能正常运行

响应式测试:
- [ ] 320px（移动端最小）
- [ ] 768px（平板）
- [ ] 1024px（桌面）
- [ ] 1920px（大屏）

---

## 执行流程

每个阶段完成后：
1. 提交代码并推送到 `claude/install-plugin-wACm3` 分支
2. 等待用户确认 Vercel 部署是否有报错
3. 如有报错，优先解决报错
4. 用户确认无误后，继续下一阶段

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| 按阶段分步执行 | 便于 Vercel 验证每步的正确性 |
| 每次推送后等待确认 | 确保部署无误再继续 |
| 使用 snake_case 字段名 | 匹配 Supabase 数据库表结构 |
| 使用单例模式的 Supabase 客户端 | 确保 session 正确获取 |

## Errors Encountered
| Error | Cause | Resolution | Status |
|-------|-------|------------|--------|
| 401 Unauthorized | tRPC 请求未携带认证头 | 修改 provider.tsx 添加 authorization header | 已修复 |
| 401 Unauthorized | 数据库字段名不匹配 (camelCase vs snake_case) | 更新所有 router 和前端页面使用 snake_case | 已修复 |
| 401 Unauthorized | 缺少 Supabase middleware | 添加 middleware.ts 刷新 session | 已修复 |
| 401 Unauthorized | Supabase 客户端每次创建新实例导致 session 丢失 | 使用单例模式 + useRef 保持客户端实例 | 已修复 |
| 401 Unauthorized | 服务端 getUser() 未正确接收 JWT token | 直接传递 token 给 getUser(token) | 无效 |
| 401 Unauthorized | 客户端 getSession() 返回 null，header 认证失效 | 改用 cookie-based 认证，服务端用 createServerClient 读取 cookies | 无效 |
| ERR_PNPM_OUTDATED_LOCKFILE | 添加依赖后未更新 pnpm-lock.yaml | 运行 pnpm install 更新 lockfile | 已修复 |
| Cannot find module 'next/dist/...' | api 包导入 Next.js 内部类型但没有 next 依赖 | 使用通用 CookieStore 接口替代 | 已修复 |
| 401 Unauthorized | cookie-based 认证无效，需要 Authorization header + service role key | 恢复 Authorization header，使用 getUser(token) 验证，使用 service role key | 已修复 |
| 401 Unauthorized | getSession() 时机问题，headers() 调用时 session 可能未初始化 | async getSession() 直接在 headers() 中调用 + persistSession 配置 | 已修复 |
| Can't resolve '@supabase/ssr' | api 包中 @supabase/ssr 在 Vercel 构建时无法解析 | 移除 cookie 回退，只使用 Authorization header | 已修复 |
| 500 Internal Server Error (tickets) | 外键引用 `profiles.id` 而非 `auth.users.id`，INSERT 时外键约束失败 | 在 protectedProcedure 中获取 profile，使用 ctx.profileId | 已修复 |
| 500 Internal Server Error (invitations) | 外键引用 `profiles.id` 而非 `auth.users.id`，INSERT 时外键约束失败 | 使用 ctx.profileId 代替 ctx.user.id | 已修复 |
| 500 全局错误 (所有页面) | protectedProcedure 自动创建 profile 失败，profiles 表有额外必填字段 | 移除自动创建逻辑，只查询 profile | 已修复 |
| 500 (profiles 缺少 email) | profiles 表缺少 email 字段导致 profile 创建失败 | 在 Supabase 添加 email 列 + 更新 Drizzle schema | 已修复 |
| Drizzle db:push 删除 email 列 | 数据库手动添加 email 列后，Drizzle schema 未同步更新 | 在 schema.ts 中添加 email 字段定义 | 已修复 |
| Can't resolve '@/components/ui/dropdown-menu' | ChatSidebar 和 AppHeader 使用了未安装的 dropdown-menu 组件 | 安装 @radix-ui/react-dropdown-menu 并手动创建 dropdown-menu.tsx 组件 | 已修复 |
| Can't resolve '@radix-ui/react-dropdown-menu' | pnpm-lock.yaml 未正确同步到 Vercel 构建环境 | 确保 pnpm-lock.yaml 已提交并重新触发部署 | 已修复 |
| ChunkLoadError: Failed to load chunk (login/global-error) | Turbopack/Webpack 在 GitHub Codespaces 环境中加载 chunk 失败 | 待修复 - 可能是 Codespaces 网络/MIME 类型问题 | 待修复 |
| Can't resolve '@/components/ui/avatar' | Profile 页面使用了未创建的 Avatar 组件 | 安装 @radix-ui/react-avatar 并创建组件 | 已修复 |
| Can't resolve '@/components/ui/dialog' | Profile 页面使用了未创建的 Dialog 组件 | 安装 @radix-ui/react-dialog 并创建组件 | 已修复 |
| Can't resolve '@/components/ui/select' | Profile 页面使用了未创建的 Select 组件 | 安装 @radix-ui/react-select 并创建组件 | 已修复 |
| Can't resolve '@/components/ui/sheet' | Profile 页面使用了未创建的 Sheet 组件 | 安装 @radix-ui/react-dialog 并创建组件 | 已修复 |
| Can't resolve '@radix-ui/react-*' (Codespaces) | Turbopack 模块解析问题 | 添加 Radix UI 到 next.config.ts transpilePackages | 已修复 |
