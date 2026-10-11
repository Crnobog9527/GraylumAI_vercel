# LIB-2d 第 1 步：浏览器识别评测工具

报告见 [docs/launch/evidence/LIB-2D-OCR-EVAL-2026-10-11.md](../../docs/launch/evidence/LIB-2D-OCR-EVAL-2026-10-11.md)。

**这个目录是独立的**：它有自己的 `package.json`，不在 pnpm 工作区里（工作区只有 `apps/*`、`packages/*`），
仓库根目录的 `pnpm install` 不会安装它，也不会进入产品构建。识别库只在这个目录里用 npm 临时安装，不是仓库依赖。

## 只复算分数（不需要安装任何东西）

`data/ground-truth.json` 是 54 页（50 页主测试 + 4 页常用字加测）的标准文本，`data/outputs.json` 是报告里
9 组运行的识别原文和逐页耗时，`data/manifest.json` 是每页的类别、字体和做旧参数。

```bash
node rescore.mjs
node summarize.mjs results-rescored/tess.json results-rescored/paddle-tiny+deskew+cols.json
```

计分规则在 `metrics.mjs`：NFKC 规范化、统一引号和破折号、去掉空白后算编辑距离，准确率 = 1 − 编辑次数 ÷ 标准字符数。

## 从头重跑

需要 Node 24 和 macOS 的中文系统字体（苹方、宋体、冬青黑体、华文黑体），否则生成的图片和标准文本会不同
（`gen.mjs` 会对照 `data/ground-truth.json` 报告差异）。报告用的是 Chrome for Testing 153.0.8010.12，
可以用 `CHROME_PATH` 指定；不指定时要先运行 `npx playwright install chromium` 安装 playwright 1.64.0 对应的浏览器。

```bash
npm ci --ignore-scripts   # 按提交的 package-lock.json 安装，依赖树和报告一致
npx playwright install chromium   # 没设 CHROME_PATH 时必需：npm ci 不会下载浏览器
npm run assets        # 下载模型和语言数据到 assets/，按 SHA-256 校验；Node 走代理时加 NODE_USE_ENV_PROXY=1
npm run build         # 把两个识别 Worker 打包到 dist/
npm run gen           # 生成 set/ 里的 54 页图片和标准文本（固定随机种子）
node run.mjs tess+deskew
node run.mjs paddle-tiny+deskew+cols
MANIFEST=set/manifest-vocab.json node run.mjs paddle-tiny+deskew+cols
node summarize.mjs results/*.json
```

配置名：`tess` 或 `paddle-tiny` / `paddle-small`，可加 `+deskew`（识别前摆正）和 `+cols`（Paddle 逐框输出后按栏排序）。
每次运行用一个新的浏览器进程，识别在 `sandbox="allow-scripts"` 的 iframe 里、从 blob 启动的 Worker 中进行，
CSP 为 `connect-src 'none'` 加 `'wasm-unsafe-eval'`（见 `server.mjs`）；另起的「外部」服务器记录任何泄漏请求。

`src/columns.js` 的双栏排序和 `src/deskew.js` 的摆正只是评测用的示例实现，不是产品代码。
