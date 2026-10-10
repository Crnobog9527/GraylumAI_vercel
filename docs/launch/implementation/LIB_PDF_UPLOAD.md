# LIB-DOCS PDF 上传后端

风险 high；对应 LIB_DOCS_PLAN 4.2/4.4 及 #794 的 PdfExtraction。上传开关保持关闭，不部署、不合并。
没有服务器 PDF 解析器、识别调用、前端接线、计费或 Runtime 变更。

## 接线

1. `library.beginPdfUpload({requestId,filename,contentType:'application/pdf',bytes,purpose})`。
   `.pdf` 文件 1–10,000,000 字节；双路径各预留 10 MB，只签发 original，禁止覆盖。
2. 原件直传后 `library.beginPdfTextUpload({documentId})`。服务端只检查 MIME、大小和 `%PDF-` 文件头，
   不打开、解压或解析 PDF。成功后原子认领第二阶段，只签发一次 text；重复请求不重签。
3. 提取器 `PdfExtraction.text` 原样 UTF-8 编码、以 `text/plain` 直传 text。
   `\f` 是页分隔符；每页保留一个槽，扫描页/空白页为空。单页扫描件的 text 是合法的零字节对象。
4. `library.completePdfUpload({documentId,pageCount,pages})`，其中 pages 直接使用 #794 的
   `{status:'text'|'scanned'|'blank',imageCoverage:number}` 数组；最多 500 页。
   #794 输出不带额外 offset 字段。页码由数组次序（从 1 开始）、位置由原文的换页符边界唯一确定；
   服务端推导，不信任调用方另给偏移，避免第二套位置来源。页数和文本槽数必须相等。
   文字页必须有可见文字且 imageCoverage 为 0；扫描/空白页必须是空槽，扫描覆盖率至少 0.5。
   保留 extractor 对 blank 的边界舍入结果，不以舍入后的覆盖率改判状态。

文字最多 10 MB、每段最多 8192 字节，总共最多 10,000 段，单行沿用 65,536 字节限制。
按页分段并保留 `page_number`、`source=extracted`；不跨页拼接、不为无文字页制造正文。
整份原件、正文分段、每页识别单元在同一发布事务中可用。每页一行 `pdf_page`；
text: has_text=true/complete，scanned: false/pending，blank: false/complete；本次不执行识别。
重复完成直接返回 ready。无效数据进入既有双路径清理；原件暂未到达可重试第二阶段。

## 额度与删除

复用 Word 双阶段生命周期，提取为局部共享服务，保留 Word RPC、返回和校验规则。
复用既有四张表、服务角色 RPC、账号锁及文档锁；没有新增持久状态源。
对象保护期内两路径按最大可写量占用，段落按正文实际字节单独占用。保护期后 text_hold 收缩到
实际 text 对象字节数（含换页符），segment_hold 只计正文。零文本仍保留第二阶段保护。
既有单条删除清除分段和未计费识别单元；注销沿用映射、双桶证明、两次无对象证明和财务保留。

## 下载文件名

download 使用存储的原文件名；URLSearchParams 单次编码，避免 SDK 的 download 选项二次编码。
控制字符及路径分隔符替换为下划线，中文、空格及普通标点作为字面文件名保留；空旧名称使用 download。
不拼接 HTTP 响应头，不允许文件名改动签名参数或 fragment。60 秒有效期和签发后再次检查删除不变，预览仍内联。

## 迁移与交接

迁移编号已在 #800 评论申请，未自行定号。暂存 `packages/db/tests/library/pdf-pending.sql` 仅用于本地
PG17 回归，不进入 migrations、不部署。编号及前置链确定后移动为正式追加迁移并重建共享指纹。
先应用正式迁移再部署新增 PDF 接口。恢复时保持开关关闭，回退 API 即停止新增 PDF；保留双路径清理及
识别单元删除规则，不删除已上传数据或回退额度保护。迁移可重复执行，不更新设置和 Storage 桶。
本地测试结果和最终检查/审查记录以 PR Handoff 为准；真实 Storage、前端体验和 24 小时积压验证未运行。
