import * as ort from 'onnxruntime-web';
import { probeNetwork } from './probe.js';
import { deskew } from './deskew.js';
import { orderColumns, orderRows } from './columns.js';
let service = null;
async function rotate180(input) {
  const bmp = input instanceof OffscreenCanvas ? input : await createImageBitmap(new Blob([input]));
  const c = new OffscreenCanvas(bmp.width, bmp.height), x = c.getContext('2d');
  x.translate(bmp.width, bmp.height);
  x.rotate(Math.PI);
  x.drawImage(bmp, 0, 0);
  return c;
}
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'probe') {
      self.postMessage({ type: 'probe', result: await probeNetwork(data.base) });
      return;
    }
    if (data.type === 'init') {
      const t0 = performance.now();
      ort.env.wasm.wasmBinary = data.wasm; // bytes handed in; no wasmPaths, no fetch
      ort.env.wasm.wasmPaths = { wasm: 'blocked://ort.wasm' }; // object form: keeps the embedded JS glue, stops ppu's jsDelivr default
      ort.env.wasm.numThreads = data.threads || 1;
      ort.env.wasm.proxy = false;
      const { PaddleOcrService } = await import('ppu-paddle-ocr/web');
      service = new PaddleOcrService({
        model: { detection: data.det, recognition: data.rec, charactersDictionary: data.dict },
        session: { executionProviders: ['wasm'], graphOptimizationLevel: 'disabled' },
        ...(data.options || {}),
      });
      await service.initialize();
      self.postMessage({ type: 'ready', initMs: performance.now() - t0 });
      return;
    }
    if (data.type === 'ocr') {
      const t0 = performance.now();
      let input = data.bytes,
        angle;
      if (data.deskew) {
        const d = await deskew(data.bytes);
        angle = d.angle;
        input = d.canvas;
      }
      const once = async (img) => {
        if (!data.columns) return service.recognize(img);
        const f = await service.recognize(img, { flatten: true, strategy: 'per-box' });
        const items = f.results || f;
        const conf = items.length ? items.reduce((a, i) => a + (i.confidence || 0), 0) / items.length : 0;
        return { text: orderColumns(items) ?? orderRows(items), confidence: conf };
      };
      let r = await once(input);
      // +orient: a page scanned upside down reads as low-confidence noise; retry it turned 180° and keep the better pass.
      if (data.orient && !(r.confidence >= 0.8)) {
        const flipped = await rotate180(input);
        const second = await once(flipped);
        if ((second.confidence || 0) > (r.confidence || 0)) r = { ...second, flipped: true };
      }
      self.postMessage({ type: 'result', id: data.id, text: r.text, ms: performance.now() - t0, angle, flipped: !!r.flipped });
    }
  } catch (e) {
    self.postMessage({ type: 'error', id: data.id, msg: String((e && (e.stack || e.message)) || e).slice(0, 800) });
  }
};
