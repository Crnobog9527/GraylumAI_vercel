# 资料库扫描件识别模型（LIB-2d）

PaddlePaddle 官方发布的 PP-OCRv6 tiny 模型（Apache-2.0，见 `LICENSE-Apache-2.0.txt`），ONNX 格式，原样入库，未改动：

| 文件 | 来源（Hugging Face，固定版本） | SHA-256 |
| --- | --- | --- |
| `PP-OCRv6_tiny_det.onnx` | `PaddlePaddle/PP-OCRv6_tiny_det_onnx` @ `2ba1506c0380b8f0b03dd142459aac66d4421f6c` `inference.onnx` | `193bab7a04fca699a6c82e6abb5b81bdb28177f0abd4062552b04908dafb19f8` |
| `PP-OCRv6_tiny_det.inference.yml` | 同上 `inference.yml` | `3ac018be6f97499a08faa3bbdeb33640968d9307f6736d152902747a9f259593` |
| `PP-OCRv6_tiny_rec.onnx` | `PaddlePaddle/PP-OCRv6_tiny_rec_onnx` @ `2612ab37152ae0a677521bae4e1e3d4fb4cf7c30` `inference.onnx` | `9ef676d6ed3c88256a2d92c640c44f25b0c40947e111b14b8be8f594091563e6` |
| `PP-OCRv6_tiny_rec.inference.yml` | 同上 `inference.yml`（字典取自其中的 `character_dict`） | `66170210bad538e83fff3c4a3867e547d6bf20b50d64b20347c4b913f3034ea1` |

`scripts/library-ocr-assets.mjs` 在构建时核对这些 SHA-256 和 onnxruntime-web 的 wasm，从 yml 取出字典，复制到
`public/library-sandbox/ocr/`（由网站自己提供，不走 CDN）。模型只是数据：在识别专用沙箱里由 onnxruntime-web 运行，沙箱禁止联网。

更新模型：换成新的官方版本号和文件，同时更新本表和脚本里的 SHA-256，并重跑 `scripts/lib-2d-ocr-eval/` 的准确率对照。
