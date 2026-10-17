# LIB-2d：浏览器识别扫描件（第 1 个实施 PR：识别引擎和专用沙箱）

依据：Owner 2026-10-17 原话（[#1040 记录](https://github.com/Crnobog9527/GraylumAI_vercel/pull/1040#issuecomment-6222723584)）
「同意：扫描件 PDF 和 Word 里的扫描图片用浏览器识别（PaddleOCR）。」「同意：扫描件识别专用的沙箱允许运行 WebAssembly
（wasm-unsafe-eval），仍然禁止联网。」方案见 [LIB_DOCS_PLAN.md](../LIB_DOCS_PLAN.md) 第 4.4、4.5 节。

风险 high（新依赖、放宽沙箱的脚本策略）。功能开关 `NEXT_PUBLIC_LIBRARY_SCAN_RECOGNITION` 默认关闭，页面里没有任何地方调用它。

## 做了什么

- `recognizeImagesInBrowser(images)`（`apps/web/src/lib/library-sandbox/ocr/client.ts`）：把扫描页图片（JPEG/PNG）
  在用户自己的浏览器里识别成文字。不上传图片、不调模型服务商、不扣积分。
- **专用沙箱**：沿用 LIB-2b 的结构（`sandbox="allow-scripts"` 的 iframe、blob Worker、`connect-src 'none'`），
  只多一项 `'wasm-unsafe-eval'`（`sandboxCsp(hash, { wasm: true })`）。Word / PDF 沙箱不变，测试证明它们仍然不能编译 WebAssembly。
- **识别流程**（全部是我们自己的代码，按 LIB-2d 评测的配置写）：摆正（±6°）→ 文字检测（PP-OCRv6 tiny det）→
  每个文字框识别（PP-OCRv6 tiny rec，CTC 解码）→ 阅读顺序（递归 XY 切分：双栏先左后右，表格按行）→
  平均置信度低于 0.8 时整页转 180° 再识别一遍、取好的一遍。
- 每次沙箱运行最多 8 张图：模型每批加载一次，关掉页面最多丢一批；每张图单独成败，坏图不影响同批其他图。

## 新依赖审查

| 项 | 结论 |
| --- | --- |
| npm 新依赖 | 只有 `onnxruntime-web@1.30.0`（Microsoft，MIT，精确版本）。锁文件新增它和 6 个传递依赖：`onnxruntime-common`（MIT）、`flatbuffers`（Apache-2.0）、`guid-typescript`（ISC）、`long`（Apache-2.0）、`platform`（MIT）、`protobufjs`（BSD-3-Clause，含 `@protobufjs/*` 小包）。`protobufjs` 的安装脚本被 pnpm 默认拦下（没有加进 onlyBuiltDependencies）。 |
| 没有用 ppu-paddle-ocr | 评测用的 `ppu-paddle-ocr` 会把 `@techstark/opencv-js`（约 28 MB）和原生的 `@napi-rs/canvas`（约 28 MB，带平台二进制）装进每次安装，浏览器其实只用到它约 81 KB 的代码；发布方是小公司、发版很频繁。所以只参考它（MIT）的处理方法，自己用 TypeScript 写了检测、识别、阅读顺序和摆正（约 400 行），供应链只剩 Microsoft 的运行时。 |
| 模型来源 | PaddlePaddle 官方在 Hugging Face 发布的 ONNX（`PaddlePaddle/PP-OCRv6_tiny_det_onnx`、`_rec_onnx`，Apache-2.0，固定提交号），原样入库，SHA-256 写在 `apps/web/assets/library-ocr/README.md`；字典直接从官方 `inference.yml` 取出，和评测用的字典逐条相同。没有用评测时那份第三方转换的 `.ort` 文件。 |
| 体积 | Worker 代码 83 KB；运行时 wasm 14.2 MB、检测模型 1.8 MB、识别模型 4.5 MB、字典 27 KB，都由 Graylum 自己的网站提供（`public/library-sandbox/ocr/`，构建时生成），只在用户真正识别时下载，之后可缓存。现有页面的打包不变。 |
| 防篡改 | 构建时 `scripts/library-ocr-assets.mjs` 核对每个文件的 SHA-256，不对就构建失败；页面下载后在交给沙箱前再核对一次，不对就拒绝（有浏览器测试）。 |
| 能做的坏事 | 模型只是数据，在断网的沙箱 Worker 里运行；Worker 里的 fetch、XHR、WebSocket、EventSource、importScripts、eval、`new Function`、嵌套 Worker、IndexedDB、Cache 全部被拦（浏览器测试逐项证明，外部服务器 0 次请求）。 |
| 许可证文件 | 构建时生成 `ocr-worker.licenses.txt`（运行时和传递依赖的许可证全文）和 `ocr/MODELS-LICENSE.txt`（模型来源和 Apache-2.0 全文）。 |

## 验证

- 准确率对照（本机 Apple M1 Max，Chrome，`ocr-parity.browser.test.ts`，需要 `OCR_PARITY=1` 和评测工具生成的样本）：
  用生产代码和官方模型重跑评测的 86 页：第 1 步 50 页 **99.94%、50/50 ≥ 95%**；第 2 步 36 页 **99.75%、36/36**；
  双栏 100%、表格 99.8%、倒放 99.9%（3 页都翻转了）、最差一页 95.4%（低清黑白）。每页平均 2.7 秒、最慢 6.4 秒。
  评测时（第三方库 + 示例排序规则）是 99.9% / 99.7%。
- CI 里会跑：`ocr.test.ts`（检测框、CTC 解码、阅读顺序、摆正、打包、结果校验、CSP、资源哈希）、
  `ocr.browser.test.ts`（真实 Chromium：识别沙箱能编译 wasm 但联网全被拦、Word/PDF 沙箱仍不能编译 wasm、3 张样本准确率 ≥ 95%、倒放页被翻正、坏图单独失败、被改过的模型被拒绝）。

## 还没做（后续 PR）

1. ~~PDF 扫描页渲染成图片~~（第 2 个 PR 已做，见下面「扫描页渲染」）。
2. **服务端保存识别文字**（要一个新迁移）：识别结果写成分段（`source=recognized`）、识别单元标为完成、内容版本加一、计入空间；
   Word 上传时为内嵌图片建 `word_image` 识别单元。
3. **资料库页面接入**：上传后自动识别、打开资料库时接着识别、进度和失败提示。
4. **对用户打开前的补测**（LIB_DOCS_PLAN 第 4.5 节）：真实 Word 文件（内嵌扫描图）和一台中端 Windows 电脑的速度；
   第 3 步做好后写出操作步骤交总控，请 Owner 找电脑跑。不达标就报总控转 Owner，不自动改用 AI 识别。

## 扫描页渲染（第 2 个 PR）

- `renderPdfPagesInBrowser(file, pages)`（`pdf/render-client.ts`）：把扫描页渲染成 JPEG（长边 1,600 像素、不超过 600,000 字节，
  按 0.85 → 0.45 逐步降质量），每批最多 8 页。`recognizePdfPagesInBrowser(file, pages)`（`ocr/scan.ts`）= 渲染 + 识别。
- 渲染在 **PDF 沙箱**里做（不开 wasm、不联网），用和文字提取同一个打过补丁的 pdf.js（解压上限、对象数上限、拒绝 Brotli、
  不自起消息循环）；和文字提取不同的只有：图片会被解码（pdf.js 自带的解码器，单张最多 4,000 万像素，更大的直接不画）、
  画在 OffscreenCanvas 上（pdf.js 要的任何画布也不超过 4,000 万像素），批注、表单、脚本一律不画不跑。
- 识别仍在识别沙箱里做：渲染出的图片不离开浏览器。
- 已知限制：JPEG 2000（JPX）压缩的扫描页需要 pdf.js 的 wasm 解码器，渲染沙箱不开 wasm，这类图片画不出来，页面会识别出空文字；
  接入页面时按「识别失败」提示用户。
- 测试：`pdf-render.browser.test.ts`（真实 Chromium）：两页扫描 PDF 渲染成 1,600 像素、600 KB 以内的 JPEG，端到端识别准确率 ≥ 95%；
  声明 20,000 × 20,000 像素的图片被跳过而不是分配内存；3 个恶意 PDF（脚本/外链/附件、打开即启动、外部内容流）不发出任何请求、页面不卡；
  错误页码被拒绝。`pdf-render.test.ts`：输入打包。
