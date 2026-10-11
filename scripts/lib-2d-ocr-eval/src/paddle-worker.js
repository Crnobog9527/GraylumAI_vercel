import * as ort from 'onnxruntime-web';
import { probeNetwork } from './probe.js';
import { deskew } from './deskew.js';
import { orderColumns, orderRows } from './columns.js';
let service = null;
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
      let r;
      if (data.columns) {
        const f = await service.recognize(input, { flatten: true, strategy: 'per-box' });
        const items = f.results || f;
        r = { text: orderColumns(items) ?? orderRows(items) };
      } else r = await service.recognize(input);
      self.postMessage({ type: 'result', id: data.id, text: r.text, ms: performance.now() - t0, angle });
    }
  } catch (e) {
    self.postMessage({ type: 'error', id: data.id, msg: String((e && (e.stack || e.message)) || e).slice(0, 800) });
  }
};
