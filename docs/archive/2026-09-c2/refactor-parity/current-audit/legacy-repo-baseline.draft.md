# 旧仓库基线初稿

> 旧仓库来源：`https://github.com/Crnobog9527/graylumAi-backup`
>
> 对照提交：`722dd2e0171474500e6a05d257d1a6550ac9cc43`
>
> 说明：旧站已不可访问，本文件基于旧仓库代码推断用户可见行为。凡是依赖 Base44 托管登录页的行为，置信度会降低。

## 登录流程

### 功能：访客打开首页

- 旧版本入口路径：`/`
- 旧仓库证据位置：`src/App.jsx`、`src/Layout.jsx`、`src/lib/AuthContext.jsx`
- 旧版本操作步骤：访客打开根路径，应用先检查公共设置和登录态；未登录时由布局层或认证上下文触发 `base44.auth.redirectToLogin()`
- 旧版本预期结果：访客不会停留在公开首页，而是被带去 Base44 登录流程；旧版本首页本质上是登录后首页
- 置信度：高
- 备注：旧仓库没有明确的公开营销落地页

### 功能：访客进入登录页

- 旧版本入口路径：无明确站内 `/login` 路由
- 旧仓库证据位置：`src/App.jsx`、`src/lib/AuthContext.jsx`、`src/components/layout/AppHeader.jsx`
- 旧版本操作步骤：访客点击头部 `登录 / 注册`，或访问受保护页面时，前端直接调用 `base44.auth.redirectToLogin()`
- 旧版本预期结果：进入 Base44 托管的外部登录/注册流程，而不是站内自建登录页
- 置信度：高
- 备注：旧仓库里没有找到本地邮箱密码登录表单页面

### 功能：错误账号登录失败提示

- 旧版本入口路径：Base44 托管登录流程
- 旧仓库证据位置：`src/lib/AuthContext.jsx`、`src/components/layout/AppHeader.jsx`
- 旧版本操作步骤：访客被重定向到 Base44 登录页后输入错误账号信息
- 旧版本预期结果：认证应被拒绝，并留在外部登录流程；具体错误文案无法从旧仓库中确认
- 置信度：低
- 备注：错误提示 UI 不在当前仓库中实现

### 功能：正确账号登录成功

- 旧版本入口路径：`/`
- 旧仓库证据位置：`src/App.jsx`、`src/pages/Home.jsx`、`src/components/layout/AppHeader.jsx`
- 旧版本操作步骤：用户完成 Base44 登录后回到应用首页
- 旧版本预期结果：进入登录后首页，顶部导航可见 `首页`、`对话`、`功能广场`、`个人中心`，管理员还能看到 `管理后台`
- 置信度：高
- 备注：登录成功后的默认落点应是首页而非公开落地页

### 功能：已登录用户访问首页/资料页

- 旧版本入口路径：`/`、`/Profile`
- 旧仓库证据位置：`src/pages/Home.jsx`、`src/pages/Profile.jsx`、`src/components/profile/ProfileComponents.jsx`
- 旧版本操作步骤：已登录用户进入首页，再通过导航或用户菜单进入 `个人中心`
- 旧版本预期结果：首页展示欢迎和产品内容；资料页展示 `个人资料`、`订阅管理`、`积分记录`、`使用历史`、`账户安全`、`工单记录` 等标签
- 置信度：高
- 备注：资料页支持通过 query 参数切换 tab

## 聊天流程

### 功能：进入聊天页

- 旧版本入口路径：`/Chat`
- 旧仓库证据位置：`src/pages.config.js`、`src/components/layout/AppHeader.jsx`、`src/pages/Chat.jsx`、`src/components/chat/ChatSidebar.jsx`、`src/components/chat/ChatInputArea.jsx`
- 旧版本操作步骤：已登录用户点击顶部导航 `对话`
- 旧版本预期结果：进入聊天页，左侧有 `新建对话` 和 `全部对话` 列表，主区域有输入框和 `发送` 按钮
- 置信度：高
- 备注：未登录用户不会稳定留在该页，而是先经过登录校验

### 功能：发送一条普通消息

- 旧版本入口路径：`/Chat`
- 旧仓库证据位置：`src/pages/Chat.jsx`、`src/components/chat/ChatInputArea.jsx`
- 旧版本操作步骤：在占位符为 `请输入您的问题...` 的输入框中输入内容，点击 `发送`
- 旧版本预期结果：消息发送动作被触发，用户输入应进入当前会话；支持附带文件上传
- 置信度：中
- 备注：发送后的服务端回包细节主要在状态 Hook 中，当前基线只冻结可见交互

### 功能：等待回复并观察加载态

- 旧版本入口路径：`/Chat`
- 旧仓库证据位置：`src/pages/Chat.jsx`、`src/components/chat/ChatInputArea.jsx`
- 旧版本操作步骤：发送消息后等待回复
- 旧版本预期结果：输入区进入流式处理中状态，发送按钮显示 loading，输入框禁用；有消息后可显示 token 使用统计
- 置信度：高
- 备注：管理员可额外打开调试面板观察过程信息

### 功能：异常提示/失败提示

- 旧版本入口路径：`/Chat`
- 旧仓库证据位置：`src/pages/Chat.jsx`
- 旧版本操作步骤：发送过长内容或触发异常场景
- 旧版本预期结果：至少存在一类明确异常提示，即弹出 `检测到长文本` 对话框，告知预计 token/积分消耗，并允许 `取消` 或 `继续发送`
- 置信度：中
- 备注：一般 API 失败后的文案和展示样式，当前证据不足以高置信冻结

### 功能：历史记录/状态反馈

- 旧版本入口路径：`/Chat`
- 旧仓库证据位置：`src/pages/Chat.jsx`、`src/components/chat/ChatSidebar.jsx`、`src/components/chat/ChatHeader.jsx`
- 旧版本操作步骤：进入聊天页后查看左侧会话列表，切换或管理历史会话
- 旧版本预期结果：会话按 `今天 / 昨天 / 本周 / 更早` 分组；支持 `新建对话`、删除、批量管理、重命名标题、导出会话；管理员可见 `调试`
- 置信度：高
- 备注：默认新会话标题为 `新对话`

## 后台流程

### 功能：进入后台首页

- 旧版本入口路径：`/AdminDashboard`
- 旧仓库证据位置：`src/pages.config.js`、`src/components/layout/AppHeader.jsx`、`src/pages/AdminDashboard.jsx`
- 旧版本操作步骤：管理员从用户菜单点击 `管理后台`
- 旧版本预期结果：进入后台仪表盘，显示平台统计卡片和最近活动；非管理员会被送回首页，未登录用户会被重定向到 Base44 登录
- 置信度：高
- 备注：旧版本后台入口在用户下拉菜单里，不在公开页面

### 功能：进入模型管理页

- 旧版本入口路径：`/AdminModels`
- 旧仓库证据位置：`src/pages.config.js`、`src/pages/AdminModels.jsx`、`src/components/admin/LanguageContext.jsx`
- 旧版本操作步骤：管理员进入后台后打开模型管理
- 旧版本预期结果：页面展示模型列表和主表格，支持新增、编辑、删除模型，并展示供应商、状态等信息
- 置信度：高
- 备注：文案 key 对应中文 `AI模型`

### 功能：执行测试连接

- 旧版本入口路径：`/AdminModels`
- 旧仓库证据位置：`src/pages/AdminModels.jsx`
- 旧版本操作步骤：管理员在模型管理页点击测试按钮
- 旧版本预期结果：弹出测试对话框，显示 `正在测试API连接...` 过程状态，并返回 `测试成功` 或 `测试失败`，成功时显示响应预览和 token 使用情况
- 置信度：高
- 备注：测试逻辑通过 `callAIModel` 函数执行

### 功能：进入诊断页并运行测试

- 旧版本入口路径：`/AdminPerformance`
- 旧仓库证据位置：`src/pages.config.js`、`src/pages/AdminPerformance.jsx`、`src/components/admin/AdminSidebar.jsx`、`src/components/admin/LanguageContext.jsx`
- 旧版本操作步骤：管理员从后台侧边栏进入 `AI性能监控`
- 旧版本预期结果：可以进入性能监控页面，查看 AI 接口响应和资源使用监控
- 置信度：中
- 备注：旧仓库没有找到与新站 `/admin/diagnostics` 一一对应的“系统诊断 + 运行测试”页面；这里只能确认存在监控页，不能确认存在同名运行按钮

### 功能：进入用户页

- 旧版本入口路径：`/AdminUsers`
- 旧仓库证据位置：`src/pages.config.js`、`src/pages/AdminUsers.jsx`、`src/components/admin/LanguageContext.jsx`
- 旧版本操作步骤：管理员进入后台用户页
- 旧版本预期结果：页面展示用户表格和搜索框，支持搜索用户，并能通过 `Adjust` 打开积分调整对话框
- 置信度：高
- 备注：旧版本搜索占位符更接近 `搜索用户...`
