// Downloads model / language files into ./assets and checks them against the SHA-256 used in the report.
import fs from 'node:fs';
import crypto from 'node:crypto';
const HF = 'https://huggingface.co/snowfluke/ppu-paddle-ocr-models/resolve/main';
const TD = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data';
const FILES = [
  ['PP-OCRv6_tiny_det.ort', `${HF}/detection/ort/PP-OCRv6_tiny_det.ort`, '2816e82d26a09d6af722492f80f3059d458377c084eca88f34d84ddf9b385580'],
  ['PP-OCRv6_tiny_rec.ort', `${HF}/recognition/ort/PP-OCRv6_tiny_rec.ort`, 'efc46adf1bde1e05b58748268abb0e71791bfa8616c435676bbca13d1ea47767'],
  ['ppocrv6_tiny_dict.txt', `${HF}/recognition/ppocrv6_tiny_dict.txt`, '2f3717bbd530b681b6db3be35cc485e8a41a932b9558b833986bf0894eb21f2d'],
  ['PP-OCRv6_small_det.ort', `${HF}/detection/ort/PP-OCRv6_small_det.ort`, 'c21be8d8268f0f45e2693b1d52432a290a56d008f6c1ff28b4baa7c35bab250e'],
  ['PP-OCRv6_small_rec.ort', `${HF}/recognition/ort/PP-OCRv6_small_rec.ort`, '40bccd9fa3ae2d14d724bf9d020c8f0edfc801489477b92f7449162a538366df'],
  ['ppocrv6_dict.txt', `${HF}/recognition/ppocrv6_dict.txt`, '41557512862dfe31970cf22407742b629725461dd84c0d8771bde9c87c2202c8'],
  ['chi_sim.traineddata.gz', `${TD}/chi_sim@1.0.0/4.0.0_best_int/chi_sim.traineddata.gz`, 'b8a23f10c7de500891eb458a8adc9cc58ab7f242f08b7d149f5e9aea4ad5db7c'],
  ['eng.traineddata.gz', `${TD}/eng@1.0.0/4.0.0_best_int/eng.traineddata.gz`, '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91'],
];
fs.mkdirSync('assets', { recursive: true });
for (const [name, url, sha] of FILES) {
  const file = `assets/${name}`;
  if (!fs.existsSync(file)) fs.writeFileSync(file, Buffer.from(await (await fetch(url)).arrayBuffer()));
  const got = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (got !== sha) throw new Error(`${name}: sha256 ${got} does not match ${sha}`);
  console.log('ok', name);
}
