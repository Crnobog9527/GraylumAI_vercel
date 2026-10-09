# UI-FINISH：字体商用交付核对（2026-10-10）

本记录正在核对实际 staging 字体交付与仓库许可。当前只确认部署身份和源码字体入口；完整产物枚举尚未取得，不能把仓库文件完整当成部署验收通过。本次只写核对记录，不改代码、字体或配置，不使用浏览器，不合并。

## 范围与交接

- 依据：#716 中 2026-10-10 的字体商用只读核对授权，以及本任务明确要求的 docs PR。
- 当前目标：`auth-staging.graylum.com`，READY 部署 `dpl_4VEnRgR4HKFx7aPRgBm3R9UoBGwT`。
- 对应源码与初始 staging：`986c01c6cc4dc0231d84efc95eceb6d31a050399`。
- 已做：读取授权 PDF、NOTICE、字体入口与依赖清单；Vercel 部署身份确认。
- 进行中：172 个公开资源（168 个字体、CSS、manifest、NOTICE、PDF）的 HTTP 字节核对、其他字体来源排查。
- 缺口：Vercel 文件树 API 在指定团队后仍返回 404 `File tree not found`；浏览器按要求 NOT_RUN。
- 后续：补齐核对结果，运行文档检查与 CI，转为可审查并读取独立结论后停下。
