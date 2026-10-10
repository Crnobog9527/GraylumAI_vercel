# LIB-2a 后端补充

风险 high：仅资料库后端、私有文档和迁移 0208；不合并，不改变上传开关或远程配置。
对应 #789 总控评论及 #778 Word 接口约定。

目标：列表只读返回 uploadEnabled；上传时间与 ID 倒序稳定游标；完整段落目录与范围读取；
Word 原文件与 UTF-8 纯文本分别直传，标题元数据由服务端校验后分段。服务器不解析 Word。
复用 0203 四张表、双路径占用及删除/注销闭环，不新增持久基础设施。

验收：服务测试及本机 PG17 验证排序跨页、权限、版本、标题校验、并发额度、双路径清理和注销。
不改前端、PDF、计费、Runtime 或 #782–#785 的业务文件。不使用浏览器。

迁移 0208 等待 0205 (#784)、0206 (#783)、0207 (#782) 按序合并。
共享 built-fingerprint.json 属于上述任务，当前不改；依赖合并后才重新生成最终完整指纹。

## 前端接线契约（本 PR 不改前端）

- `library.list({ cursor?: { createdAt, id } })` 每页最多 50 条，按 `created_at DESC, id DESC`。
  返回 `uploadEnabled: boolean`、`nextCursor: { createdAt, id } | null`，原样回传游标，不用 JS Date
  重写时间（必须保留微秒）。已有 `afterId` 仍接受，并查本人记录的时间作为游标；记录已经彻底删除时
  返回 `LIBRARY_INVALID_CURSOR`。新游标不依赖记录存活。新文件出现在重新加载的第一页。
- `library.directory({ documentId, version })` 一次返回全部 `{ ordinal, title }`，不包含正文。
  最大 10,000 段；标题最多 512 UTF-8 字节。只给本人可读、未删除的对应版本。
- `library.segments({ documentId, version, start, count? })` 从零基序号 start 起返回最多 count 段，
  默认 1，最大 50；越过末尾返回空数组。旧版本返回 `LIBRARY_VERSION_CHANGED`。
- `library.beginWordUpload({ requestId, filename, contentType, bytes, purpose })`：contentType 固定 Word MIME，
  filename 必须 `.docx`。返回 `uploads: { original, text } | null`，每项沿用签名上传返回结构。
  两路径均先占 10,000,000 字节；同请求重试仅返回状态，不重签令牌。`uploads=null` 时不能另发直传。
- 浏览器将原 docx 直传 original（Word MIME），提取后的 UTF-8 字节直传 text（`text/plain`）。
  两个对象均限制 1–10,000,000 字节；纯文本不能包含 NUL，不接受文件 URL 或 HTML/XML 对象载荷。
  正文中的字面标记按普通文字保留，不解析、不执行。
- `library.completeWordUpload({ documentId, headings: [{ offset, level, text }] })`：offset 是解码后 UTF-16
  索引，标题顺序严格递增、不重叠、必须对应完整行、level 1–9、每项最多 512 UTF-8 字节、最多 10,000 项。
  校验不通过明确拒绝；不静默截断标题或正文。保留表格制表符、页眉/页脚/脚注及换行。
  原文件只核对 MIME/大小/ZIP 头；只有 text 路径被完整读回，服务端不调用 Word 解析器。
  分段每段最多 8192 字节、总计最多 10,000,000 字节、最多 10,000 段，单行上限沿用 txt 的 65,536 字节。
- 两对象和分段发布复用同一事务、用户锁和文档锁。标题随分段保存，不另建私有元数据存储。
  上传占用仍按可能写入上限保留；分段额外占用按现有规则检查；降级不允许扩大占用。
  成功发布的重复完成不读取 Storage；失败先标不可读，再走双路径清理。结果不明时沿用相同请求/文档 ID。
  旧 `completeUpload({documentId})` 不支持 Word，必须使用新完成接口。

## 兼容、删除与恢复

新增数据仍在 0203 的四张表/双路径中，公共删除和注销无需增加第五份所有者映射。
文本路径保护期和原路径共同决定释放时机；两次独立无对象证明前不释放。
清理候选和成功上传占用收缩现包含 text_hold，避免保留文本最大占用不再回收。
不改变会员容量、保留财务记录、删除后拒读、注销执行器或双桶证明规则。

先应用 0208 再部署 API；现有单对象客户端及 afterId 调用仍兼容。恢复时保持上传关闭，保留新迁移和
双路径清理函数，仅回退 API（旧 API 不生成新 Word 上传）。不要回退到只核算 original_hold 的清理函数，
不要删除既有 Word 数据。0208 可重复执行；迁移不更新 system_settings 或 Storage 桶设置。

## 验证边界

本机 PG17 包含当前 staging 的迁移和 0208，不冒充已包含尚未合并的 0205–0207。
领域测试验证稳定分页、标题/范围、双路径占用、实际并发屏障、权限拒绝、删除和完整注销。
完整迁移 ledger 和最终 built-fingerprint 必须在前置合并后重跑；当前草稿不具备合并条件。
真实 staging Storage、24 小时积压证明、前端接线和浏览器体验本任务未运行。
