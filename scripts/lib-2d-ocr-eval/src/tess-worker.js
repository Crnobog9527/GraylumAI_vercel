import { probeNetwork } from './probe.js';
import { deskew } from './deskew.js';
const worker = require('tesseract.js/src/worker-script/index.js');
const gunzip = () => {
  throw new Error('gunzip happens before loadLanguage');
};
const ungz = async (buf) => new Uint8Array(await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
const TesseractCore = require('tesseract.js-core/tesseract-core-relaxedsimd-lstm.js');
let wasmBinary = null;
let jobSeq = 0;
const pending = new Map();
worker.setAdapter({
  getCore: async () => (opts) => TesseractCore({ ...opts, wasmBinary, locateFile: (f) => 'blocked://' + f }),
  gunzip,
  fetch: () => {
    throw new Error('no network');
  },
  readCache: async () => undefined,
  writeCache: async () => {},
  deleteCache: async () => {},
  checkCache: async () => false,
});
function call(action, payload) {
  const jobId = 'j' + ++jobSeq;
  return new Promise((resolve, reject) => {
    pending.set(jobId, { resolve, reject });
    worker.dispatchHandlers({ workerId: 'w', jobId, action, payload }, (m) => {
      if (m.status === 'resolve') {
        pending.delete(jobId);
        resolve(m.data);
      } else if (m.status === 'reject') {
        pending.delete(jobId);
        reject(new Error(String(m.data)));
      }
    });
  });
}
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'probe') {
      self.postMessage({ type: 'probe', result: await probeNetwork(data.base) });
      return;
    }
    if (data.type === 'init') {
      const t0 = performance.now();
      wasmBinary = new Uint8Array(data.wasm);
      await call('load', { options: { lstmOnly: true, corePath: 'unused', logging: false } });
      await call('loadLanguage', {
        langs: await Promise.all(data.langs.map(async (l) => ({ code: l.code, data: await ungz(l.data) }))),
        options: { cacheMethod: 'none', gzip: true, lstmOnly: true },
      });
      await call('initialize', { langs: data.langs.map((l) => l.code).join('+'), oem: 1, config: data.config || {} });
      if (data.params) await call('setParameters', { params: data.params });
      self.postMessage({ type: 'ready', initMs: performance.now() - t0 });
      return;
    }
    if (data.type === 'ocr') {
      const t0 = performance.now();
      let image = new Uint8Array(data.bytes),
        angle;
      if (data.deskew) {
        const d = await deskew(data.bytes);
        angle = d.angle;
        image = new Uint8Array(await (await d.canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
      }
      const r = await call('recognize', { image, options: {}, output: { text: true, blocks: false, hocr: false, tsv: false } });
      self.postMessage({ type: 'result', id: data.id, text: r.text, ms: performance.now() - t0, angle });
    }
  } catch (e) {
    self.postMessage({ type: 'error', id: data.id, msg: String((e && e.message) || e) });
  }
};
