# Task Plan: GraylumAI Phase 3 迁移

## Goal
完成 GraylumAI 项目从阶段九到阶段十四的所有迁移工作，包括：
- 阶段九至十一：业务逻辑迁移（工单系统、系统设置、邀请推广、AI模型管理、管理后台）
- 阶段十二至十四：UI 还原（全局样式、核心组件、页面布局）

## Current Phase
阶段九、十、十一（业务逻辑）全部完成 ✅
阶段十二、十三、十四（UI 还原）全部完成 ✅
**Phase 3 迁移全部完成！**

**Phase 4 UI 还原 & Phase 5 数据层完善:**
- Step 4.1 ~ 4.9: UI 组件还原 ✅ 完成 (73/73 组件)
- Step 5.0: 组件-页面关联集成 ✅ 完成
- Step 5.1: 数据层完善 ✅ 完成 (ProfilePage + MarketplacePage mock 数据已替换)
- Step 4.6: UI 视觉验证 ✅ 用户验证通过 (2026-01-20)

**Phase 6 安全加固:**
- Step 6.1: Supabase RLS 策略 ✅ 完成 (2026-01-20)
- Step 6.2: Admin 权限校验屏障 ✅ 完成 (2026-01-20)

**Phase 7 管理后台功能还原:** ✅ 完成
- Step 7.1: 功能差异分析 ✅ 完成 (2026-01-20)
- Step 7.2: 系统设置还原 (35项) ✅ 完成 (2026-01-20)
- Step 7.3: 会员套餐系统还原 ✅ 完成 (2026-01-20)
- Step 7.4: 模型管理完善 ✅ 完成 (2026-01-20)
- Step 7.5: 邀请管理完善 ✅ 完成 (2026-01-20)
- Step 7.6: 公告管理完善 ✅ 完成 (2026-01-20)

**Phase 8 AI 重构执行计划制定:** ✅ 已完成
- 参考文档: `movetonew/制定分阶段重构执行计划指导方法.md`
- 输出文档: `movetonew/GraylumAI_分阶段重构执行计划.md` ✅ 已创建 (2026-01-21)
- Step 8.1 ~ 8.8: 分阶段编写执行计划文档 ✅ 全部完成

**Phase 9 AI 对话系统重构实施:** ✅ 已完成
- 参考文档: `movetonew/GraylumAI_分阶段重构执行计划.md`
- 参考文档: `AI_REFACTOR_DESIGN_BRIEF.md`
- 阶段一: Schema & Types (数据库与类型定义) ✅ 已完成 (2026-01-21)
  - 新增 token_stats, billing_history, ai_usage_logs 表定义
  - 创建 AI 类型 (packages/api/src/types/ai.ts)
  - 创建计费类型 (packages/api/src/types/billing.ts)
  - 创建迁移 SQL + RLS 策略
- 阶段二: tRPC Procedures (后端核心逻辑) ✅ 已完成 (2026-01-21)
  - 安全检查中间件 (packages/api/src/middleware/securityChecks.ts)
  - 原子化计费服务 (packages/api/src/services/billing.ts)
  - Token 计数服务 (packages/api/src/services/tokenCounter.ts)
  - 智能模型路由 (packages/api/src/services/modelRouter.ts)
  - AI 对话路由 (packages/api/src/routers/ai.ts)
- 阶段三: AI Engine & Optimization (AI 引擎与成本优化) ✅ 已完成 (2026-01-21)

**Phase 10 安全与合规审计:** 🔄 进行中
- 目标: 全面检查系统安全性、计费正确性、合规性
- 开始时间: 2026-01-21

检查清单:
| # | 检查项 | 描述 | 状态 |
|---|--------|------|------|
| 1 | 后端计算流程 | 积分计算逻辑必须在 tRPC 后端完成 | ⬜ |
| 2 | 配置对齐 | 费率实时读取 models 表的 token_rate 字段 | ⬜ |
| 3 | 逻辑严密性 | 积分和钱的逻辑在后端完成最终校验 | ⬜ |
| 4 | 代码一致性 | 沿用 Drizzle Schema 和 tRPC 规范 | ⬜ |
| 5 | 数据共享 | 新功能与管理后台数据库层完全共享 | ⬜ |
| 6 | 积分实时显示 | Header 组件积分从 user.getProfile 获取 | ⬜ |
| 7 | Sidebar 切换 | 点击切换对话，聊天窗口随之更新 | ⬜ |
| 8 | 路由系统 | 所有页面跳转使用 Next.js 路由 | ⬜ |
| 9 | 接口安全 | tRPC 权限、请求签名、速率限制 | ⬜ |
| 10 | 计费反作弊 | 余额防御、消费熔断、Service Role 隔离 | ⬜ |
| 11 | 内容合规 | 双向内容审查、Prompt 注入防御 | ⬜ |
| 12 | 数据隐私 | 多租户隔离、敏感数据脱敏 | ⬜ |
| 13 | 环境安全 | CORS 限制、环境变量审计 | ⬜ |
| 14 | 事务安全 | 行级锁、CHECK 约束、预扣机制 | ⬜ |
| 15 | 智能路由 | 关键词预判联网搜索 | ⬜ |
| 16 | 上下文压缩 | 滑动窗口、保留策略、Prompt Caching | ⬜ |
| 17 | 异常处理 | 幂等性、对账日志 | ⬜ |
| 18 | 前端交互 | 流式中断信号与积分结算 | ⬜ |
  - Prompt 缓存构建器 (packages/api/src/services/promptCacheBuilder.ts)
  - 上下文滑动窗口管理器 (packages/api/src/services/contextManager.ts)
  - SSE 流式响应处理器 (packages/api/src/services/streamHandler.ts)
  - 内容审核服务 (packages/api/src/services/contentModerator.ts)
  - 成本计算器 (packages/api/src/services/costCalculator.ts)
- 阶段四: Frontend Integration (前端集成与 UI 还原) ✅ 已完成 (2026-01-21)
  - AI 对话核心 Hook (apps/web/src/hooks/useAIChat.ts)
  - SSE 流式响应 Hook (apps/web/src/hooks/useStreamResponse.ts)
  - 对话界面主组件 (apps/web/src/components/ai/ChatInterface.tsx)
  - 流式消息渲染 (apps/web/src/components/ai/MessageStream.tsx)
  - Token 使用显示 (apps/web/src/components/ai/TokenUsageDisplay.tsx)
  - 中断按钮 (apps/web/src/components/ai/InterruptButton.tsx)
- 阶段五: Testing & Security (测试与安全审计) ✅ 已完成 (2026-01-21)
  - Vitest 测试配置 (packages/api/vitest.config.ts)
  - 计费服务测试 (packages/api/src/services/__tests__/billing.test.ts)
  - Token 计数测试 (packages/api/src/services/__tests__/tokenCounter.test.ts)
  - 成本计算器测试 (packages/api/src/services/__tests__/costCalculator.test.ts)
  - 安全审计文档 (docs/SECURITY_AUDIT_PHASE9.md)

## 已发现的问题 (修复进度: 13/13) ✅ 全部完成

| # | 问题描述 | 影响范围 | 状态 |
|---|----------|----------|------|
| 1 | 除了仪表盘模块，点击其他模块后左边会出现 2 个侧边栏 | 管理后台所有子页面 | ✅ 已修复 |
| 2 | 提示词/模块添加表单与原项目不一致，缺少：系统提示词、用户提示词模板、指定模型、适用平台、模块特点、用户准备问题、图标选择器等字段 | 管理后台-提示词模块页面 | ✅ 已修复 |
| 3 | 积分包添加表单与原项目不一致，缺少：赠送积分、排序、热门标识（开启后前端购买界面有特殊UI装饰）、启用开关 | 管理后台-积分包页面 | ✅ 已修复 |
| 4 | 财务统计模块与原项目不一致，原项目有：总成本/收入/盈利、API请求数、输入/输出Tokens统计及成本、Web Search次数、各模型渠道统计表（显示每个模型的tokens/请求数/成本/收入/盈利）、积分换算规则 | 管理后台-财务统计页面 | ✅ 已修复 |
| 5 | 公告管理模块与原项目不一致，原项目有：全站横幅公告区、首页平台公告区、功能广场置顶模块区、首页引导设置（关联模块）、聊天页面设置（模型选择器开关+提示文案）；各区域有独立的添加弹窗和字段 | 管理后台-公告管理页面 | ✅ 已修复 |
| 6 | 工单详情页与原项目不一致，缺少：工单ID显示、分类标签、提交用户信息、问题描述区、附件预览区、回复记录中用户/管理员身份区分（原项目有"管理员"徽章）、"标记已解决"按钮 | 管理后台-工单管理页面 | ✅ 已修复 |
| 7 | 性能监控模块监控对象与原项目不一致，原项目"AI性能监控"有：总请求数、平均响应时间(P95)、缓存命中率、错误率、Token使用统计(输入/输出/缓存读取/创建)、成本统计(总成本/平均每次请求/缓存节省)、时间范围筛选、健康状态指示器 | 管理后台-性能监控页面 | ✅ 已修复 |
| 8 | 系统设置-会员权限Tab未与已创建的会员等级关联（显示占位提示），缺少：各等级对话历史保存天数配置、批量导出对话开关、对话历史清理功能（手动执行清理过期对话） | 管理后台-系统设置-会员权限 | ✅ 已修复 |
| 9 | 交易记录模块缺少搜索筛选功能（按用户搜索），且显示所有用户记录会有性能问题。建议：添加用户搜索框、分页加载、日期范围筛选、默认只显示汇总统计，点击用户后再展开明细 | 管理后台-交易记录页面 | ✅ 已修复 |
| 10 | 用户管理模块功能单一（仅调整积分），需增强：用户详情面板（头像/昵称/邮箱/注册时间/最后登录/IP归属地）、账号状态管理（启用/禁用/封禁）、会员等级调整、角色权限修改、登录历史、使用统计（对话数/消耗积分）、操作日志 | 管理后台-用户管理页面 | ✅ 已修复 |
| 11 | 仪表盘功能单一，需增强：建议添加更丰富的数据展示（今日/本周/本月数据对比、趋势图表、活跃用户排行、热门模型使用统计、收入趋势、系统健康状态、快捷操作入口等），提升管理体验 | 管理后台-仪表盘页面 | ✅ 已修复 |
| 12 | 管理后台侧边栏在页面切换时会短暂闪现两个侧边栏（#1 问题未完全修复） | 管理后台所有子页面 | ✅ 已修复 |
| 13 | 工单管理页面报错：Could not find a relationship between 'tickets' and 'profiles' in the schema cache | 管理后台-工单管理页面 | ✅ 已修复 |

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
| GlobalBanner | src/components/layout/GlobalBanner.jsx | apps/web/src/components/layout/GlobalBanner.tsx | ✅ |
| Sidebar | src/components/layout/ | ChatSidebar/AdminSidebar/ProfileSidebar | ✅ 已拆分 |

#### Phase B: 聊天系统组件（P0 - 15个）- 核心组件已完成
| 组件 | 旧文件 | 新文件 | 状态 |
|------|--------|--------|------|
| ChatSidebar | src/components/chat/ChatSidebar.jsx | apps/web/src/components/chat/ChatSidebar.tsx | ✅ |
| ChatHeader | src/components/chat/ChatHeader.jsx | apps/web/src/components/chat/ChatHeader.tsx | ✅ |
| MessageBubble | src/components/chat/MessageBubble.jsx | apps/web/src/components/chat/ChatInterface.tsx (内置) | ✅ |
| ChatMessages | src/components/chat/ChatMessages.jsx | apps/web/src/components/chat/ChatInterface.tsx (内置) | ✅ |
| ChatInput | src/components/chat/ChatInput.jsx | apps/web/src/components/chat/ChatInterface.tsx (内置) | ✅ |
| ChatInputArea | src/components/chat/ChatInputArea.jsx | apps/web/src/components/chat/ChatInterface.tsx (内置) | ✅ |
| ModelSelector | src/components/chat/ModelSelector.jsx | apps/web/src/components/chat/ModelSelector.tsx | ✅ |
| ChatDebugPanel | - | apps/web/src/components/chat/ChatDebugPanel.tsx | ✅ |
| PromptModuleCard | - | apps/web/src/components/chat/PromptModuleCard.tsx | ✅ |
| PromptModuleGrid | - | apps/web/src/components/chat/PromptModuleGrid.tsx | ✅ |
| TemplateCard | - | apps/web/src/components/chat/TemplateCard.tsx | ✅ |
| TokenUsageStats | - | apps/web/src/components/chat/TokenUsageStats.tsx | ✅ |
| FileAttachmentCard | - | apps/web/src/components/chat/FileAttachmentCard.tsx | ✅ |
| ActiveModuleBanner | - | apps/web/src/components/chat/ActiveModuleBanner.tsx | ✅ |

#### Phase C: 用户资料组件（P1 - 5个）✅ 核心已完成
| 组件 | 旧文件 | 新文件 | 状态 |
|------|--------|--------|------|
| ProfileComponents | src/components/profile/ProfileComponents.jsx (1348行) | 已拆分为独立组件 | ✅ 已拆分 |
| PersonalInfoCard | src/components/profile/PersonalInfoCard.jsx | apps/web/src/components/profile/PersonalInfoCard.tsx | ✅ |
| AvatarCropper | src/components/profile/AvatarCropper.jsx | apps/web/src/components/profile/AvatarCropper.tsx | ⏸️ 低优先级 |
| CreditsDialog | src/components/profile/CreditsDialog.jsx | apps/web/src/components/profile/CreditsDialog.tsx | ⏸️ 低优先级 |
| TicketsPanel | src/components/profile/TicketsPanel.jsx | apps/web/src/components/profile/TicketsPanel.tsx | ✅ |

#### Phase D: 积分和工单组件（P1 - 10个）✅ 功能已内联实现
积分组件:
| 组件 | 状态 | 备注 |
|------|------|------|
| CreditBalance.tsx | ✅ 内联 | 在 ProfileSidebar 中实现 |
| CreditPackageCard.tsx | ✅ 内联 | 在 packages/page.tsx 中实现 |

工单组件:
| 组件 | 状态 | 备注 |
|------|------|------|
| TicketCard.tsx | ✅ 内联 | 在 TicketsPanel 中实现 |
| TicketInfo.tsx | ✅ 内联 | 在 admin/tickets 中实现 |
| TicketStatusBadge.tsx | ✅ | 使用 status-badge.tsx |
| TicketPriorityBadge.tsx | ✅ | 使用 Badge 组件 |
| TicketReplyForm.tsx | ✅ 内联 | 在 admin/tickets 中实现 |
| TicketReplyList.tsx | ✅ 内联 | 在 admin/tickets 中实现 |
| TicketClosedNotice.tsx | ✅ 内联 | 在 admin/tickets 中实现 |
| LoadingSpinner.tsx | ✅ | components/ui/loading-spinner.tsx |

#### Phase E: 管理后台组件（P1 - 9个）✅ 全部完成（内联实现）
| 组件 | 旧文件 | 新文件 | 状态 | 备注 |
|------|--------|--------|------|------|
| AdminSidebar | src/components/admin/AdminSidebar.jsx | apps/web/src/components/admin/AdminSidebar.tsx | ✅ | 独立组件 |
| StatsCard | src/components/admin/StatsCard.jsx | apps/web/src/components/admin/StatsCard.tsx | ✅ | 独立组件 |
| SystemStats | src/components/admin/SystemStats.jsx | admin/page.tsx (584行) | ✅ 内联 | 仪表盘页面 |
| UserManagement | src/components/admin/UserManagement.jsx | admin/users/page.tsx (830行) | ✅ 内联 | 用户管理页面 |
| TicketManagement | src/components/admin/TicketManagement.jsx | admin/tickets/page.tsx (706行) | ✅ 内联 | 工单管理页面 |
| ModelManagement | src/components/admin/ModelManagement.jsx | admin/models/page.tsx (704行) | ✅ 内联 | 模型管理页面 |
| TemplateManagement | src/components/admin/TemplateManagement.jsx | admin/prompts/page.tsx (718行) | ✅ 内联 | 提示词管理页面 |
| AIPerformanceMonitor | src/components/admin/AIPerformanceMonitor.jsx | admin/performance/page.tsx (746行) | ✅ 内联 | 性能监控页面 |
| MembershipPermissionsCard | src/components/admin/MembershipPermissionsCard.jsx | admin/settings/page.tsx | ✅ 内联 | 系统设置页面 |

#### Phase E.2: 管理后台页面（P1 - 12个）✅ 全部完成并验证
| 页面 | 旧文件 | 新文件 | 状态 | 备注 |
|------|--------|--------|------|------|
| 仪表盘 | src/pages/AdminDashboard.jsx | apps/web/src/app/admin/page.tsx | ✅ | 已验证 |
| 用户管理 | src/pages/AdminUsers.jsx | apps/web/src/app/admin/users/page.tsx | ✅ | 已验证 |
| 工单管理 | src/pages/AdminTickets.jsx | apps/web/src/app/admin/tickets/page.tsx | ✅ | 已验证 |
| AI模型管理 | src/pages/AdminModels.jsx | apps/web/src/app/admin/models/page.tsx | ✅ | 已验证 |
| 邀请码管理 | src/pages/AdminInvitations.jsx | apps/web/src/app/admin/invitations/page.tsx | ✅ | 已验证 (key 已修复) |
| 系统设置 | src/pages/AdminSettings.jsx | apps/web/src/app/admin/settings/page.tsx | ✅ | 已验证 |
| 模块/提示词管理 | src/pages/AdminPrompts.jsx | apps/web/src/app/admin/prompts/page.tsx | ✅ | 已验证 (表已创建) |
| 积分包管理 | src/pages/AdminPackages.jsx | apps/web/src/app/admin/packages/page.tsx | ✅ | 已验证 |
| 交易记录 | src/pages/AdminTransactions.jsx | apps/web/src/app/admin/transactions/page.tsx | ✅ | 已验证 (查询已修复) |
| 财务统计 | src/pages/AdminFinance.jsx | apps/web/src/app/admin/finance/page.tsx | ✅ | 已验证 |
| 公告管理 | src/pages/AdminAnnouncements.jsx | apps/web/src/app/admin/announcements/page.tsx | ✅ | 已验证 (表已创建) |
| 性能监控 | src/pages/AdminPerformance.jsx | apps/web/src/app/admin/performance/page.tsx | ✅ | 已验证 |

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
| ModuleDetailDialog.tsx | ✅ |
| FeaturedModules.tsx | ✅ |
| iconConfig.tsx | ✅ |

通用组件:
| 组件 | 状态 | 备注 |
|------|------|------|
| ConversationList.tsx | ✅ | |
| CreditDisplay.tsx | ⏸️ | 低优先级，可内联 |
| InviteDialog.tsx | ⏸️ | 低优先级，可内联 |
| FeaturedModules.tsx | ✅ | 已存在 |

### Step 4.4: Shadcn/ui 基础组件样式覆盖（49个组件）

#### P0 - 高频使用组件（Phase 13 已部分完成）✅ 全部完成
| 组件 | 状态 | 备注 |
|------|------|------|
| Button | ✅ | Phase 13 已完成 |
| Input | ✅ | Phase 13 已完成 |
| Textarea | ✅ | Phase 13 已完成 |
| Card | ✅ | Phase 13 已完成 |
| Dialog | ✅ | 已存在 dialog.tsx |
| Select | ✅ | 已存在 select.tsx |
| Tabs | ✅ | 已存在 tabs.tsx |

#### P1 - 中频使用组件 ✅ 全部完成
| 组件 | 状态 |
|------|------|
| Dropdown Menu | ✅ |
| Avatar | ✅ |
| Badge | ✅ |
| Toast/Sonner | ✅ |
| Tooltip | ✅ |
| Separator | ✅ |
| Dialog | ✅ |
| Select | ✅ |
| Sheet | ✅ |
| Tabs | ✅ |
| Table | ✅ |
| Scroll Area | ✅ |

#### P2 - 其他组件 ✅ 全部完成
| 组件 | 状态 |
|------|------|
| Accordion | ✅ |
| Alert | ✅ |
| Checkbox | ✅ |
| Progress | ✅ |
| Slider | ✅ |
| Switch | ✅ |
| Collapsible | ✅ |
| Context Menu | ✅ |
| Hover Card | ✅ |
| Menubar | ✅ |
| Navigation Menu | ✅ |
| Popover | ✅ |
| Radio Group | ✅ |
| Toggle | ✅ |
| Toggle Group | ✅ |
| Alert Dialog | ✅ |
| Aspect Ratio | ✅ |

### Step 4.5: 页面级布局还原

#### 已完成页面
| 页面 | 旧文件 | 新文件 | 状态 | 备注 |
|------|--------|--------|------|------|
| 首页 (/) | src/pages/Home.jsx | apps/web/src/app/page.tsx | ✅ | commit: 62568f4 |
| 聊天页面 (/chat) | src/pages/Chat.jsx | apps/web/src/app/chat/page.tsx | ✅ | commit: 06e9bfd |
| 用户资料 (/profile) | src/pages/Profile.jsx | apps/web/src/app/profile/page.tsx | ✅ | commit: e09d60d, d99b2c6 |
| 市场页面 (/marketplace) | src/pages/Marketplace.jsx | apps/web/src/app/marketplace/page.tsx | ✅ | commit: 3f4395d |

#### 管理后台页面 (12个) - ✅ 全部完成 (12/12)
| 页面 | 旧文件 | 新文件 | 状态 | 备注 |
|------|--------|--------|------|------|
| 仪表盘 | src/pages/AdminDashboard.jsx | apps/web/src/app/admin/page.tsx | ✅ | 完整实现 |
| 用户管理 | src/pages/AdminUsers.jsx | apps/web/src/app/admin/users/page.tsx | ✅ | 完整实现 |
| 工单管理 | src/pages/AdminTickets.jsx | apps/web/src/app/admin/tickets/page.tsx | ✅ | 完整实现 |
| AI模型管理 | src/pages/AdminModels.jsx | apps/web/src/app/admin/models/page.tsx | ✅ | 完整实现 |
| 邀请码管理 | src/pages/AdminInvitations.jsx | apps/web/src/app/admin/invitations/page.tsx | ✅ | 完整实现 |
| 系统设置 | src/pages/AdminSettings.jsx | apps/web/src/app/admin/settings/page.tsx | ✅ | 完整实现 |
| 模块管理 | src/pages/AdminPrompts.jsx | apps/web/src/app/admin/prompts/page.tsx | ✅ | 完整 CRUD + 分类 |
| 积分包管理 | src/pages/AdminPackages.jsx | apps/web/src/app/admin/packages/page.tsx | ✅ | 完整 CRUD |
| 交易记录 | src/pages/AdminTransactions.jsx | apps/web/src/app/admin/transactions/page.tsx | ✅ | 交易列表 + 过滤 |
| 财务统计 | src/pages/AdminFinance.jsx | apps/web/src/app/admin/finance/page.tsx | ✅ | 财务仪表盘 |
| 公告管理 | src/pages/AdminAnnouncements.jsx | apps/web/src/app/admin/announcements/page.tsx | ✅ | 完整 CRUD |
| 性能监控 | src/pages/AdminPerformance.jsx | apps/web/src/app/admin/performance/page.tsx | ✅ | 性能仪表盘 |

> **说明**: 所有 12 个管理后台页面已完成，包含完整的前端 UI 和后端 API 支持

#### 待完成页面
| 页面 | 旧文件 | 新文件 | 状态 |
|------|--------|--------|------|
| 模板页面 (/templates) | src/pages/Templates.jsx | apps/web/src/app/templates/page.tsx | ⬜ |

### Step 4.7: 提取复用组件 ✅ 已完成

**目标**: 将 12 个管理后台页面中重复的代码模式提取为可复用组件，减少 40-50% 重复代码

#### 已提取组件列表

| 优先级 | 组件 | 文件路径 | 复用次数 | 状态 |
|--------|------|----------|----------|------|
| P0 | AdminLoadingState | components/admin/AdminLoadingState.tsx | 12 | ✅ |
| P0 | AdminErrorState | components/admin/AdminErrorState.tsx | 12 | ✅ |
| P0 | AdminPageHeader | components/admin/AdminPageHeader.tsx | 12 | ✅ |
| P0 | StatusBadge | components/ui/status-badge.tsx | 8+ | ✅ |
| P1 | EmptyState | components/ui/empty-state.tsx | 11+ | ✅ |
| P1 | StatsCardGrid | components/admin/StatsCardGrid.tsx | 8 | ✅ |
| P1 | FormDialog | components/ui/form-dialog.tsx | 5+ | ✅ |
| P1 | LoadingSpinner | components/ui/loading-spinner.tsx | 12+ | ✅ |
| P2 | FilterTabs | components/ui/filter-tabs.tsx | 3 | ⬜ 可选 |
| P2 | TableIconCell | components/ui/table-icon-cell.tsx | 10+ | ⬜ 可选 |

#### 重构后文件结构

```
/components/
├── admin/
│   ├── AdminSidebar.tsx (已有)
│   ├── StatsCard.tsx (已有)
│   ├── AdminLoadingState.tsx ✅ 新增
│   ├── AdminErrorState.tsx ✅ 新增
│   ├── AdminPageHeader.tsx ✅ 新增
│   └── StatsCardGrid.tsx ✅ 新增
└── ui/
    ├── status-badge.tsx ✅ 新增 (含 StatusBadge, ToggleBadge, RoleBadge)
    ├── empty-state.tsx ✅ 新增 (含 EmptyState, TableEmptyState)
    ├── form-dialog.tsx ✅ 新增 (含 FormDialog, ConfirmDialog)
    └── loading-spinner.tsx ✅ 新增 (含 LoadingSpinner, LoadingOverlay, InlineLoading)
```

#### 已重构页面示例
- `admin/users/page.tsx` - 使用 AdminLoadingState, AdminErrorState, AdminPageHeader, RoleBadge, TableEmptyState
- `admin/invitations/page.tsx` - 使用 AdminLoadingState, AdminErrorState, AdminPageHeader, StatsCardGrid, StatusBadge, TableEmptyState

#### 实现效果
- **代码减少**: 每个页面减少约 30-50 行重复代码
- **维护性提升**: 修改一处即可全局生效
- **一致性保证**: 统一的样式和行为
- **TypeScript 检查**: ✅ 通过

---

### Step 4.8: 补充 Shadcn/ui 组件库 ✅ 已完成

**目标**: 按优先级分阶段补充所有常用 Shadcn/ui 组件，构建完整的 UI 组件库

**最终状态**: 35 个组件 (14 原有 + 6 Phase A + 9 Phase B + 6 Phase C)

---

#### Phase A: 高频使用组件 (6个) ✅ 已完成

| 序号 | 组件 | 文件 | 依赖包 | 用途 | 状态 |
|------|------|------|--------|------|------|
| A1 | **Toast (Sonner)** | sonner.tsx | `sonner` | 操作成功/失败提示 | ✅ |
| A2 | **Tooltip** | tooltip.tsx | `@radix-ui/react-tooltip` | 图标按钮悬停说明 | ✅ |
| A3 | **Checkbox** | checkbox.tsx | `@radix-ui/react-checkbox` | 表单复选框 | ✅ |
| A4 | **Switch** | switch.tsx | `@radix-ui/react-switch` | 设置开关切换 | ✅ |
| A5 | **Progress** | progress.tsx | `@radix-ui/react-progress` | 上传/处理进度 | ✅ |
| A6 | **Skeleton** | skeleton.tsx | 无依赖 | 骨架屏加载 | ✅ |

**已安装依赖**: sonner, @radix-ui/react-tooltip, @radix-ui/react-checkbox, @radix-ui/react-switch, @radix-ui/react-progress

**附加导出**: Toaster, toast, SkeletonCard, SkeletonAvatar, SkeletonText, SkeletonTable, TooltipProvider

---

#### Phase B: 中频使用组件 (9个) ✅ 已完成

| 序号 | 组件 | 文件 | 依赖包 | 用途 | 状态 |
|------|------|------|--------|------|------|
| B1 | **Alert** | alert.tsx | 无依赖 | 警告/提示框 | ✅ |
| B2 | **Alert Dialog** | alert-dialog.tsx | `@radix-ui/react-alert-dialog` | 危险操作确认 | ✅ |
| B3 | **Separator** | separator.tsx | `@radix-ui/react-separator` | 分隔线 | ✅ |
| B4 | **Slider** | slider.tsx | `@radix-ui/react-slider` | 数值滑动条 | ✅ |
| B5 | **Radio Group** | radio-group.tsx | `@radix-ui/react-radio-group` | 单选按钮组 | ✅ |
| B6 | **Popover** | popover.tsx | `@radix-ui/react-popover` | 弹出框 | ✅ |
| B7 | **Aspect Ratio** | aspect-ratio.tsx | `@radix-ui/react-aspect-ratio` | 固定宽高比容器 | ✅ |
| B8 | **Toggle** | toggle.tsx | `@radix-ui/react-toggle` | 切换按钮 | ✅ |
| B9 | **Toggle Group** | toggle-group.tsx | `@radix-ui/react-toggle-group` | 切换按钮组 | ✅ |

**已安装依赖**: @radix-ui/react-alert-dialog, @radix-ui/react-separator, @radix-ui/react-slider, @radix-ui/react-radio-group, @radix-ui/react-popover, @radix-ui/react-aspect-ratio, @radix-ui/react-toggle, @radix-ui/react-toggle-group

---

#### Phase C: 低频使用组件 (6个) ✅ 已完成

| 序号 | 组件 | 文件 | 依赖包 | 用途 | 状态 |
|------|------|------|--------|------|------|
| C1 | **Accordion** | accordion.tsx | `@radix-ui/react-accordion` | FAQ/折叠面板 | ✅ |
| C2 | **Collapsible** | collapsible.tsx | `@radix-ui/react-collapsible` | 可折叠容器 | ✅ |
| C3 | **Context Menu** | context-menu.tsx | `@radix-ui/react-context-menu` | 右键菜单 | ✅ |
| C4 | **Hover Card** | hover-card.tsx | `@radix-ui/react-hover-card` | 悬停预览卡 | ✅ |
| C5 | **Navigation Menu** | navigation-menu.tsx | `@radix-ui/react-navigation-menu` | 导航菜单 | ✅ |
| C6 | **Menubar** | menubar.tsx | `@radix-ui/react-menubar` | 顶部菜单栏 | ✅ |

**已安装依赖**: @radix-ui/react-accordion, @radix-ui/react-collapsible, @radix-ui/react-context-menu, @radix-ui/react-hover-card, @radix-ui/react-navigation-menu, @radix-ui/react-menubar

---

#### 组件完成后文件结构

```
/components/ui/
├── 已有 (14个)
│   ├── avatar.tsx
│   ├── badge.tsx
│   ├── button.tsx
│   ├── card.tsx
│   ├── dialog.tsx
│   ├── dropdown-menu.tsx
│   ├── input.tsx
│   ├── label.tsx
│   ├── scroll-area.tsx
│   ├── select.tsx
│   ├── sheet.tsx
│   ├── table.tsx
│   ├── tabs.tsx
│   └── textarea.tsx
│
├── Phase A - 高频 (6个)
│   ├── sonner.tsx (Toast)
│   ├── tooltip.tsx
│   ├── checkbox.tsx
│   ├── switch.tsx
│   ├── progress.tsx
│   └── skeleton.tsx
│
├── Phase B - 中频 (9个)
│   ├── alert.tsx
│   ├── alert-dialog.tsx
│   ├── separator.tsx
│   ├── slider.tsx
│   ├── radio-group.tsx
│   ├── popover.tsx
│   ├── aspect-ratio.tsx
│   ├── toggle.tsx
│   └── toggle-group.tsx
│
└── Phase C - 低频 (6个)
    ├── accordion.tsx
    ├── collapsible.tsx
    ├── context-menu.tsx
    ├── hover-card.tsx
    ├── navigation-menu.tsx
    └── menubar.tsx
```

#### 执行计划

| 阶段 | 组件数 | 依赖安装 | 组件创建 | 验证测试 | 状态 |
|------|--------|----------|----------|----------|------|
| Phase A | 6 | 5个包 | 6个文件 | TypeScript + ESLint | ✅ |
| Phase B | 9 | 8个包 | 9个文件 | TypeScript + ESLint | ✅ |
| Phase C | 6 | 6个包 | 6个文件 | TypeScript + ESLint | ✅ |
| **总计** | **21** | **19个包** | **21个文件** | - | **✅ 完成** |

#### 验收标准

- [x] 所有组件 TypeScript 编译通过
- [x] 所有组件 ESLint 检查通过
- [x] 组件支持深色主题 (使用 CSS 变量)
- [x] 组件样式与项目主题一致
- [ ] 关键组件有使用示例 (可选)

---

### Step 4.9: 剩余业务组件还原 ✅ 完成

**目标**: 完成所有剩余的业务组件和页面还原

---

#### 组件完成统计 (2026-01-20 最终核查)

| 分类 | 已完成 | 待完成 | 完成率 |
|------|--------|--------|--------|
| UI 组件 (Shadcn) | 39 | 0 | 100% ✅ |
| 布局组件 | 2/2 | 0 | 100% ✅ |
| 聊天组件 | 12/12 | 0 | 100% ✅ |
| 用户资料组件 | 7/7 | 0 | 100% ✅ |
| 管理后台组件 | 6/6 | 0 | 100% ✅ |
| 首页组件 | 3/3 | 0 | 100% ✅ |
| 模块组件 | 3/3 | 0 | 100% ✅ |
| 市场组件 | 1/1 | 0 | 100% ✅ |
| **总计** | **73** | **0** | **100%** |

---

#### 已完成组件清单 ✅

**布局组件 (2/2)**:
- ✅ AppHeader.tsx
- ✅ GlobalBanner.tsx

**聊天组件 (12/12)** ✅:
- ✅ ChatSidebar.tsx
- ✅ ChatHeader.tsx
- ✅ ChatInterface.tsx
- ✅ ConversationList.tsx
- ✅ ModelSelector.tsx
- ✅ ChatDebugPanel.tsx
- ✅ PromptModuleCard.tsx (新增)
- ✅ PromptModuleGrid.tsx (新增)
- ✅ TemplateCard.tsx (新增)
- ✅ TokenUsageStats.tsx (新增)
- ✅ FileAttachmentCard.tsx (新增)
- ✅ ActiveModuleBanner.tsx (新增)

**用户资料组件 (7/7)**:
- ✅ ProfileSidebar.tsx
- ✅ PersonalInfoCard.tsx
- ✅ CreditRecordsCard.tsx
- ✅ SecuritySettingsCard.tsx
- ✅ SubscriptionCard.tsx
- ✅ TicketsPanel.tsx
- ✅ UsageHistoryCard.tsx

**管理后台组件 (6/6)** ✅:
- ✅ AdminSidebar.tsx
- ✅ StatsCard.tsx
- ✅ AdminErrorState.tsx
- ✅ AdminLoadingState.tsx
- ✅ AdminPageHeader.tsx
- ✅ StatsCardGrid.tsx
- 注: 管理功能(用户/工单/模型等)已内置于各admin页面

**首页组件 (3/3)**:
- ✅ WelcomeBanner.tsx
- ✅ SixStepsGuide.tsx
- ✅ UpdatesSection.tsx

**模块组件 (3/3)** ✅:
- ✅ ModuleCard.tsx
- ✅ iconConfig.tsx
- ✅ ModuleDetailDialog.tsx (新增)

**市场组件 (1/1)**:
- ✅ FeaturedModules.tsx

---

#### 已完成任务清单 ✅

**P0 - 聊天系统组件** (6个) ✅:
| 组件 | 用途 | 状态 |
|------|------|------|
| PromptModuleCard | 提示词模块卡片 | ✅ |
| PromptModuleGrid | 提示词模块网格 | ✅ |
| TemplateCard | 模板卡片 | ✅ |
| TokenUsageStats | Token 使用统计 | ✅ |
| FileAttachmentCard | 文件附件卡片 | ✅ |
| ActiveModuleBanner | 活跃模块横幅 | ✅ |

**P1 - 管理后台功能** ✅ (功能已内置在各页面):
| 页面 | 用途 | 状态 |
|------|------|------|
| admin/page.tsx | 统计仪表盘 | ✅ |
| admin/users/page.tsx | 用户管理 | ✅ |
| admin/tickets/page.tsx | 工单管理 | ✅ |
| admin/models/page.tsx | 模型管理 | ✅ |
| admin/prompts/page.tsx | 模板管理 | ✅ |
| admin/performance/page.tsx | 性能监控 | ✅ |

**P2 - 其他业务组件** (1个) ✅:
| 组件 | 用途 | 状态 |
|------|------|------|
| ModuleDetailDialog | 模块详情对话框 | ✅ |

---

#### 页面状态

| 页面 | 状态 | 备注 |
|------|------|------|
| 模板页面 (/templates) | 可选 | 功能已整合到 marketplace |

---

### Step 5.1: 数据层完善 ✅ 完成

**目标**: 替换 mock 数据为真实 tRPC 查询

---

#### 完成状态 (2026-01-20)

| 页面 | Mock 数据 | tRPC 替换 | 状态 |
|------|----------|-----------|------|
| ProfilePage | mockUser | user.getUserProfile + credits.getBalance + credits.getCreditsSummary | ✅ |
| MarketplacePage | mockModules + mockFeaturedModules | modules.getModules + modules.getFeaturedModules | ✅ |

---

#### 新增基础设施

**数据库表 (modules)**:
- 迁移文件: `supabase/migrations/20240117_create_modules_table.sql`
- 字段: id, title, description, icon, category, platform, usage_count, credits_cost, is_featured, image_url, badge_type, badge_text, credits_display, active, sort_order, created_at, updated_at
- RLS: 允许读取 active=true 的模块
- 种子数据: 8 条

**tRPC 路由 (modulesRouter)**:
| 端点 | 类型 | 用途 |
|------|------|------|
| getModules | query | 获取模块列表 (分类过滤、分页、排序) |
| getFeaturedModules | query | 获取精选模块 |
| getModuleById | query | 获取单个模块详情 |
| incrementUsage | mutation | 增加模块使用次数 |

---

#### 修改文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/api/src/routers/modules.ts` | 新增 | 模块 tRPC 路由 |
| `packages/api/src/root.ts` | 修改 | 注册 modulesRouter |
| `apps/web/src/app/profile/page.tsx` | 修改 | 替换 mockUser → tRPC |
| `apps/web/src/app/marketplace/page.tsx` | 修改 | 替换 mockModules → tRPC |
| `supabase/migrations/20240117_create_modules_table.sql` | 新增 | 数据库迁移 |

---

#### 部署注意事项

> **重要**: 需要在 Supabase 中执行 `20240117_create_modules_table.sql` 迁移脚本创建 `modules` 表后，MarketplacePage 才能正常从数据库获取数据。

---

### Step 6.1: Supabase RLS 安全策略 ✅ 完成

**目标**: 为所有数据库表配置 Row Level Security 策略，确保数据访问安全

---

#### RLS 策略概览

| 表名 | 用户权限 | 管理员权限 | 状态 |
|------|----------|------------|------|
| profiles | 读写自己的数据 | 读写所有数据 | ✅ |
| conversations | CRUD 自己的对话 | 读取所有对话 | ✅ |
| messages | CRUD 自己对话的消息 | 读取所有消息 | ✅ |
| credit_transactions | 读取自己的记录 | 完全访问 | ✅ |
| ai_models | 只读 | 完全访问 | ✅ |
| system_settings | 只读 | 完全访问 | ✅ |
| tickets | CRUD 自己的工单 | 完全访问 | ✅ |
| ticket_replies | 读写自己工单的回复 | 完全访问 | ✅ |
| credit_packages | 读取激活的套餐 | 完全访问 | ✅ |
| invitations | 读取自己创建的 | 完全访问 | ✅ |
| announcements | 读取激活的公告 | 完全访问 | ✅ |
| prompts | 读取激活的提示词 | 完全访问 | ✅ |
| modules | 读取激活的模块 | 完全访问 | ✅ |

---

#### 核心实现

**辅助函数:**
```sql
CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid()
    AND role = 'admin'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

**迁移文件:** `supabase/migrations/20240120_enable_rls_policies.sql`

---

#### 部署步骤

1. 在 Supabase SQL Editor 中执行迁移脚本
2. 验证 RLS 策略是否生效
3. 测试普通用户和管理员的数据访问权限

---

### Step 6.2: Admin 权限校验屏障 ✅ 完成

**目标**: 建立 tRPC 中间件安全屏障，非管理员访问受保护资源时跳转到专用错误页面

---

## Phase 8: AI 重构执行计划制定 ✅ 已完成

> **参考文档**: `movetonew/制定分阶段重构执行计划指导方法.md`
> **输出文档**: `movetonew/GraylumAI_分阶段重构执行计划.md` ✅ (2026-01-21)
> **目标**: 根据 `AI_REFACTOR_DESIGN_BRIEF.md` 简报，制定完整的 AI 系统重构执行计划

### Step 8.1 ~ 8.8: 执行计划编写 ✅ 全部完成

**已完成内容:**
- [x] 项目概览 (重构范围、核心目标、技术债务、风险评估)
- [x] 架构决策记录 ADR (4 个关键决策)
- [x] 阶段一计划: Schema & Types
- [x] 阶段二计划: tRPC Procedures
- [x] 阶段三计划: AI Engine & Optimization
- [x] 阶段四计划: Frontend Integration
- [x] 阶段五计划: Testing & Security
- [x] 风险缓解与回滚方案
- [x] 成功指标定义

---

## Phase 9: AI 对话系统重构实施 🆕 待执行

> **参考文档**: `movetonew/GraylumAI_分阶段重构执行计划.md`
> **设计简报**: `AI_REFACTOR_DESIGN_BRIEF.md`
> **目标**: 将 AI 对话系统从旧架构迁移到新架构，实现完整的 AI 对话功能

### 9.1 阶段一: Schema & Types (数据库与类型定义) ⬜ 待执行

**目标**: 建立 AI 系统所需的数据库表和 TypeScript 类型定义

#### 交付物
- [ ] `packages/db/schema/token-stats.ts` - Token 统计表
- [ ] `packages/db/schema/billing-history.ts` - 计费历史表
- [ ] `packages/api/src/types/ai.ts` - AI 请求/响应类型
- [ ] `packages/api/src/types/billing.ts` - 计费相关类型
- [ ] `supabase/migrations/xxx_create_ai_tables.sql` - 迁移文件
- [ ] RLS 策略定义

#### 验证标准
- [ ] 数据库迁移无错误执行
- [ ] RLS 策略测试通过 (用户隔离)
- [ ] TypeScript 无 `any` 警告
- [ ] 索引查询 <100ms

### 9.2 阶段二: tRPC Procedures (后端核心逻辑) ⬜ 待执行

**目标**: 实现 AI 对话的后端 API 和计费服务

#### 交付物
- [ ] `packages/api/src/middleware/securityChecks.ts` - 安全检查中间件
- [ ] `packages/api/src/routers/ai.ts` - AI 对话核心路由
- [ ] `packages/api/src/services/billing.ts` - 原子化计费服务 (预扣-结算-退费)
- [ ] `packages/api/src/services/modelRouter.ts` - AI 智能路由逻辑
- [ ] `packages/api/src/services/tokenCounter.ts` - Token 计数服务

#### 验证标准
- [ ] 未登录用户无法调用 (返回 401)
- [ ] 积分不足正确拒绝 (PRECONDITION_FAILED)
- [ ] 计费事务在异常时正确回滚
- [ ] 重复请求不会重复扣费 (幂等性)

### 9.3 阶段三: AI Engine & Optimization (AI 引擎与成本优化) ⬜ 待执行

**目标**: 实现 AI 调用核心引擎和成本优化模块

#### 交付物
- [ ] `packages/api/src/lib/ai/tokenCounter.ts` - Token 计数 (官方 API)
- [ ] `packages/api/src/lib/ai/contextManager.ts` - 上下文滑动窗口
- [ ] `packages/api/src/lib/ai/promptCaching.ts` - Prompt Caching 构建器
- [ ] `packages/api/src/lib/ai/streamHandler.ts` - SSE 流式传输
- [ ] `packages/api/src/lib/ai/costCalculator.ts` - 成本计算器
- [ ] `packages/api/src/lib/ai/contentModeration.ts` - 内容审查

#### 验证标准
- [ ] Token 统计与 API 计费误差 <2%
- [ ] 压缩后上下文保持对话连贯性
- [ ] 流式输出在网络中断后能恢复
- [ ] 缓存命中率 >30%

### 9.4 阶段四: Frontend Integration (前端集成与 UI 还原) ⬜ 待执行

**目标**: 将前端对话界面接入新的 tRPC API

#### 交付物
- [ ] `apps/web/src/components/chat/ChatInterface.tsx` - 对话界面 (接入新 tRPC)
- [ ] `apps/web/src/components/chat/MessageStream.tsx` - 流式消息渲染
- [ ] `apps/web/src/components/chat/InterruptButton.tsx` - 中断控制
- [ ] `apps/web/src/components/chat/TokenUsageDisplay.tsx` - Token 用量显示
- [ ] `apps/web/src/hooks/useAIChat.ts` - 封装 AI 对话逻辑
- [ ] `apps/web/src/hooks/useStreamResponse.ts` - 流式响应处理

#### 验证标准
- [ ] 界面与设计稿一致
- [ ] 流式输出延迟 <50ms (60fps)
- [ ] 中断按钮点击后 <100ms 停止
- [ ] Token/成本显示实时更新

### 9.5 阶段五: Testing & Security (测试与安全审计) ⬜ 待执行

**目标**: 完成测试覆盖和安全审计

#### 交付物
- [ ] `__tests__/unit/billing.test.ts` - 计费逻辑单元测试
- [ ] `__tests__/unit/tokenCounter.test.ts` - Token 统计测试
- [ ] `__tests__/integration/ai-chat.test.ts` - 对话流程集成测试
- [ ] `__tests__/e2e/user-journey.spec.ts` - 端到端测试
- [ ] `docs/SECURITY_AUDIT.md` - 安全审计报告

#### 验证标准
- [ ] 单元测试覆盖率 >80%
- [ ] 并发测试无数据竞争
- [ ] RLS 测试确认用户数据隔离
- [ ] 安全扫描无高危漏洞

### 成功指标

| 类别 | 指标 | 目标值 |
|------|------|--------|
| 功能 | AI 对话成功率 | >99% |
| 功能 | 平均响应时间 | <2s |
| 功能 | 流式首字节时间 | <500ms |
| 成本 | Token 计费误差 | <2% |
| 成本 | 缓存命中率 | >60% |
| 成本 | 成本节省 | >30% |
| 安全 | 高危漏洞数 | 0 |
| 安全 | RLS 绕过尝试 | 0 |
| 质量 | 测试覆盖率 | >80% |
| 质量 | TypeScript 严格模式 | 100% |

---

## Phase 7: 管理后台功能还原 ✅ 已完成

> **参考项目**: `/home/user/graylumAi-backup-ref/`
> **目标**: 还原旧项目管理后台的所有功能，确保与原版功能完全一致

### Step 7.1: 功能差异分析 ✅ 完成

**代码量对比:**
| 页面 | 旧项目 (行数) | 新项目 (行数) | 差异 |
|------|---------------|---------------|------|
| Announcements | 1117 | 567 | -550 |
| Models | 740 | 383 | -357 |
| Packages | 767 | 411 | -356 |
| Invitations | 352 | 191 | -161 |
| Settings | 366 | 218 | -148 |
| **总计** | **5784** | **4270** | **-1514** |

**关键缺失功能清单:**
1. 会员套餐系统 (完全缺失)
2. 系统设置 64项 → 6项 (90%缩减)
3. 模型管理 CRUD + 测试功能
4. 邀请码记录追踪 + 风险评估
5. 精选模块管理

### Step 7.2: 系统设置还原 ✅ 完成

**目标**: 还原完整的 35 项系统设置 (注: 原估计64项，实际分析后为35项)

**已实现的设置分类:**
| 分类 | 设置数量 | 设置项 |
|------|----------|--------|
| 基础设置 | 3 | site_name, support_email, maintenance_mode |
| 积分计费 | 5 | new_user_credits, input/output_credits_per_1k, web_search_credits, first_purchase_bonus_percent |
| 签到福利 | 6 | checkin_day1-5, checkin_monthly_bonus |
| 邀请奖励 | 10 | invite_inviter/invitee_reward, rebate, binding_days, limits, IP限制, risk_auto_reject |
| 功能设置 | 11 | smart_routing, smart_search, free_tier, token_stats, model_selector, billing_hint 等 |

**完成的任务:**
- [x] 重写 admin/settings/page.tsx (6个分类 Tab)
- [x] 实现 35 项设置配置
- [x] 使用 Switch 组件处理布尔类型
- [x] 批量保存功能
- [x] 会员权限 Tab 占位（依赖 Step 7.3）

**修改文件:**
- `apps/web/src/app/admin/settings/page.tsx` - 完全重写 (329行新增)

### Step 7.3: 会员套餐系统还原 ✅ 完成

**目标**: 还原完整的会员套餐管理

**已实现:**
- [x] 创建 membership_plans 数据库表 (含 RLS 策略)
- [x] 创建 membership plan CRUD 端点 (在 admin.ts 中)
- [x] 更新 admin/packages/page.tsx (双 Tab: 积分加油包 + 会员等级)
- [x] 种子数据: 免费版、Pro 专业版、Gold 黄金版

**会员套餐字段:**
- name - 等级名称
- level - 等级类型 (free/pro/gold)
- monthly_price, yearly_price - 月付/年付价格 (分)
- monthly_credits, yearly_credits - 月/年积分额度
- monthly_bonus_credits - 月奖励积分
- package_discount - 加油包折扣百分比
- features - 权益列表 (JSON 数组)
- is_active - 是否启用
- sort_order - 排序顺序

**新增/修改文件:**
| 文件 | 操作 | 说明 |
|------|------|------|
| packages/db/schema.ts | 修改 | 新增 membershipPlans 表定义 |
| packages/api/src/routers/admin.ts | 修改 | 新增 4 个会员套餐 CRUD 端点 |
| apps/web/src/app/admin/packages/page.tsx | 重写 | 双 Tab UI (积分包 + 会员等级) |
| supabase/migrations/20240121_create_membership_plans_table.sql | 新增 | 数据库迁移 + RLS 策略 |

### Step 7.4: 模型管理完善 ✅ 完成

**目标**: 还原完整的模型 CRUD 功能

**已实现:**
- [x] 添加 createModel, deleteModel, updateModel tRPC mutations
- [x] 添加 getActiveModels 端点 (用户可用)
- [x] 更新模型表字段 (分层定价)
- [x] 重写 admin/models/page.tsx (完整表单)

**模型字段更新:**
- model_id - 模型标识符
- api_key, api_endpoint - API 配置
- description - 模型描述
- max_tokens - 最大输出 Token
- input_limit - 上下文限制
- enable_web_search - 联网搜索开关
- input_token_cost, output_token_cost (≤200K)
- input_token_cost_above_200k, output_token_cost_above_200k (>200K)
- web_search_cost - 搜索成本
- is_active - 启用状态

**新增/修改文件:**
| 文件 | 操作 | 说明 |
|------|------|------|
| packages/db/schema.ts | 修改 | 扩展 aiModels 表字段 |
| packages/api/src/routers/model.ts | 重写 | 新增完整 CRUD 端点 |
| apps/web/src/app/admin/models/page.tsx | 重写 | 完整表单 + 分层定价 UI |
| supabase/migrations/20240122_update_ai_models_table.sql | 新增 | 数据库迁移 + RLS 策略 |

### Step 7.5: 邀请码管理完善 ✅ 完成

**目标**: 还原邀请记录追踪和分析功能

**已实现:**
- [x] 创建 invitation_records 数据库表
- [x] 更新 invitation tRPC router (记录追踪)
- [x] 添加 Recharts 图表组件
- [x] 重写 admin/invitations/page.tsx

**邀请记录字段:**
- inviter_id, invitee_id
- inviter_email, invitee_email
- status (pending/registered/rewarded/rejected)
- risk_level, block_reason
- inviter_reward, invitee_reward
- ip_address, user_agent
- created_at, rewarded_at

**新增/修改文件:**
| 文件 | 操作 | 说明 |
|------|------|------|
| packages/db/schema.ts | 修改 | 新增 invitationRecords 表定义 |
| packages/api/src/routers/invitation.ts | 修改 | 新增记录查询/统计/更新端点 |
| apps/web/src/app/admin/invitations/page.tsx | 重写 | 6 卡片 + 趋势图 + 风险图 + 记录表 |
| apps/web/package.json | 修改 | 新增 recharts 依赖 |
| supabase/migrations/20240123_create_invitation_records_table.sql | 新增 | 数据库迁移 + RLS 策略 |

### Step 7.6: 公告管理完善 ✅ 完成

**目标**: 还原公告横幅支持和增强字段

**已实现:**
- [x] 扩展 announcements 表 (添加横幅支持)
- [x] 更新 admin tRPC router (新增字段支持)
- [x] 创建数据库迁移

**新增公告字段:**
- announcement_type (homepage/banner) - 公告类型
- banner_style (info/warning/success/error/promo/announcement) - 横幅样式
- banner_link - 横幅链接
- icon, icon_color - 图标和颜色
- tag, tag_color - 标签和颜色

**新增/修改文件:**
| 文件 | 操作 | 说明 |
|------|------|------|
| packages/db/schema.ts | 修改 | 扩展 announcements 表字段 |
| packages/api/src/routers/admin.ts | 修改 | 公告端点支持新字段 |
| supabase/migrations/20240124_update_announcements_table.sql | 新增 | 数据库迁移 + 索引 |

**后续可选:**
- 精选模块管理 (需要新表 featured_modules)
- 首页引导设置
- 聊天页面设置

---

---

#### 实现架构

```
用户请求 → tRPC adminProcedure → 检查 profiles.role
                                    ↓
                            role !== 'admin'
                                    ↓
                         throw FORBIDDEN (403)
                                    ↓
                    前端 AdminGuard 捕获错误
                                    ↓
                      router.replace('/access-denied')
```

---

#### 核心实现

**1. tRPC 中间件 (packages/api/src/trpc.ts)**
```typescript
export const adminProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (ctx.userRole !== 'admin') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You do not have permission to access this resource. Admin role required.',
    });
  }
  return next({ ctx });
});
```

**2. 权限守卫组件 (components/admin/AdminGuard.tsx)**
- 调用 tRPC 验证管理员权限
- FORBIDDEN 错误自动重定向到 `/access-denied`
- 显示加载状态 "验证管理员权限..."

**3. 权限拒绝页面 (app/access-denied/page.tsx)**
- 专业的 403 错误页面设计
- 显示 "访问被拒绝" 和 "ERROR 403 - FORBIDDEN"
- 提供 "返回上一页" 和 "返回首页" 按钮

---

#### 受保护的 API 路由

| 路由文件 | 使用 adminProcedure 的端点 |
|----------|---------------------------|
| admin.ts | getStatistics, getAllUsers, adjustUserCredits, getAllTickets, updateTicketStatus, replyToTicket, getAllAnnouncements, createAnnouncement, updateAnnouncement, deleteAnnouncement, getAllPrompts, createPrompt, updatePrompt, deletePrompt, getFinanceStats, getPerformanceStats |
| model.ts | getAvailableModels, updateModelConfig |
| invitation.ts | generateInvitationCode, getInvitationHistory |
| settings.ts | getSystemSettings, updateSystemSettings |

---

#### 新增/修改文件

| 文件 | 用途 |
|------|------|
| `apps/web/src/app/access-denied/page.tsx` | 403 权限拒绝页面 |
| `apps/web/src/components/admin/AdminGuard.tsx` | 管理员权限守卫组件 |
| `apps/web/src/app/admin/layout.tsx` | Admin layout，统一包装 AdminGuard |

---

#### Bug Fix: 权限检查期间显示管理界面 ✅ 已验证

**问题**: 普通用户访问 /admin 时，在权限验证期间能看到 AdminSidebar
**原因**: AdminGuard 在加载状态时仍然渲染 AdminSidebar
**解决方案**:
1. 创建 `admin/layout.tsx` 在 layout 级别统一包装 AdminGuard
2. 修改 AdminGuard 加载状态只显示中性的 "验证访问权限..." 提示，不显示任何管理界面
3. 简化 `admin/page.tsx` 移除重复的 AdminSidebar 和权限检查逻辑
**验证**: ✅ 用户确认修复有效 (2026-01-20)

---

### Step 5.0: 组件-页面关联集成 ✅ 完成

**目标**: 将已复刻的 UI 组件与路由、状态管理、数据层完整对接，实现完整的交互功能

---

#### 关联状态最终报告 (2026-01-20)

| 分类 | 问题数 | 严重程度 | 状态 |
|------|--------|----------|------|
| 路由关联 | 3 | 🔴 Critical | ✅ 已修复 |
| 全局状态 | 1 | 🟡 Important | ✅ 已创建 |
| 数据流关联 | 4 | 🟡 Important | ✅ 已修复 |
| 交互反馈 | 3 | 🟠 Medium | ✅ 已完成 |

---

#### Phase 5.1: 路由关联修复 (P0 Critical) ✅

| 组件 | 问题 | 修复方案 | 状态 |
|------|------|----------|------|
| AppHeader 下拉菜单 | 4个菜单项无导航功能 | 添加 `<Link>` + `onClick` 登出 | ✅ |
| ProfileSidebar | 导入 `useRouter` 但未使用 | 实现登出跳转 | ✅ |
| ProfileSidebar 登出 | TODO: 未实现登出逻辑 | 调用 Supabase signOut + 跳转 | ✅ |

---

#### Phase 5.2: 全局状态管理 (P1 Important) ✅

**已创建 Stores:**

| Store | 用途 | 状态 |
|-------|------|------|
| useChatStore | activeConversationId, conversationListVersion, isSidebarCollapsed | ✅ |

**文件:** `apps/web/src/stores/useChatStore.ts`

---

#### Phase 5.3: 数据流关联 (P1 Important) ✅

| 页面/组件 | 问题 | 修复方案 | 状态 |
|-----------|------|----------|------|
| ChatPage | handleSend/handleSaveTitle 是 TODO | createConversation + sendMessage + updateTitle mutations | ✅ |
| chat.ts | 缺少创建/更新/删除接口 | 新增 createConversation, updateConversationTitle, deleteConversation | ✅ |
| ChatInterface | 使用 refetch() | 改用 utils.chat.getMessages.invalidate() | ✅ |

---

#### Phase 5.4: 交互反馈完善 (P2 Medium) ✅

| 组件 | 功能 | 修复方案 | 状态 |
|------|------|----------|------|
| ChatSidebar | 删除对话 | deleteConversation mutation + AlertDialog 确认 | ✅ |
| ChatSidebar | 重命名对话 | updateConversationTitle mutation + Dialog 输入 | ✅ |
| ChatPage | 保存标题 | updateTitle mutation | ✅ |

---

#### 新增/修改文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `stores/useChatStore.ts` | 新增 | Zustand 全局状态 |
| `stores/index.ts` | 新增 | 导出 barrel |
| `packages/api/src/routers/chat.ts` | 修改 | 新增 3 个 mutations |
| `components/layout/AppHeader.tsx` | 修改 | 下拉导航 + 登出 |
| `components/profile/ProfileSidebar.tsx` | 修改 | 登出功能 |
| `components/chat/ChatSidebar.tsx` | 修改 | 删除/重命名弹窗 |
| `components/chat/ChatInterface.tsx` | 修改 | invalidate 模式 |
| `app/chat/page.tsx` | 修改 | 使用 Zustand + mutations |

---

### Step 4.6: 细节打磨与最终验证 ✅ 已完成

#### 验收清单
代码质量检查:
- [x] TypeScript 无编译错误 (`pnpm tsc --noEmit` 通过)
- [x] ESLint 无警告 (`pnpm lint` 通过)
- [x] 组件逻辑未被破坏
- [x] 所有功能正常运行

组件还原完成度:
- [x] 核心组件全部完成 (39/39)
  - Layout: 2/2
  - Chat: 6/6
  - Admin: 2/2
  - Profile: 7/7
  - Home: 3/3
  - Modules: 2/2
  - Marketplace: 1/1
  - UI (Shadcn): 15/15
- [x] 所有页面布局已还原 (17/17)

修复记录:
- [x] admin.ts: getAllUsers 添加 avatar_url 字段
- [x] eslint.config.mjs: 迁移到 ESLint 9 flat config 格式

已知限制:
- 构建时 Google Fonts 获取失败（环境网络问题，Vercel 部署不受影响）

UI 视觉一致性 ✅ 用户验证通过 (2026-01-20):
- [x] 颜色系统匹配
- [x] 字体系统匹配
- [x] 间距系统匹配
- [x] 响应式布局验证

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
| 功能广场 404 | AppHeader 链接 `/features` 但页面路径是 `/marketplace` | 修改 AppHeader.tsx 链接为 `/marketplace` | 已修复 |
| Vercel 环境变量警告 | turbo.json 缺少环境变量声明 | 在 turbo.json 添加 globalEnv 配置 | 已修复 |
