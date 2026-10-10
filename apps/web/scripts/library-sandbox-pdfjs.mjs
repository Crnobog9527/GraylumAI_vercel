/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// esbuild plugin for the PDF sandbox Worker (LIB-2c, LIB_DOCS_PLAN §4.2).
//
// 1. `graylum:pdf-cmaps` is a virtual module holding every packed CMap shipped with pdfjs-dist, so
//    Chinese/Japanese/Korean text can be decoded without any download (the sandbox has no network).
// 2. Four exact source edits to the pinned pdf.js worker build. Each target must occur exactly once
//    or the build fails, so a pdfjs-dist upgrade cannot silently drop a guard:
//    - every decoded stream (Flate, LZW, RunLength, ASCII85/Hex, predictors, decryption) is capped at
//      the limit the sandbox sets in `globalThis.__graylumPdfGuard` (fails closed when it is unset);
//    - images are never decoded: with `maxImageSize: 0` each image is recorded as a marker operation
//      (size and position only), which the scanned-page check measures;
//    - BrotliDecode streams are refused (its decoder has no output cap);
//    - pdf.js does not start its own message loop on the Worker global: it runs as an in-Worker
//      library ("fake worker") and only our one-shot reply is ever posted.

import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const pdfjsRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
export const PDFJS_WORKER_BUILD = path.join(pdfjsRoot, 'legacy/build/pdf.worker.mjs');
export const SKIPPED_IMAGE_MARKER = 'graylum:skipped-image';

const GUARD = 'globalThis.__graylumPdfGuard';

export const PDFJS_PATCHES = [
  {
    name: 'decoded stream cap',
    target: `  ensureBuffer(requested) {
    const buffer = this.buffer;
    if (requested <= buffer.byteLength) {
      return buffer;
    }
    let size = this.minBufferLength;
    while (size < requested) {
      size *= 2;
    }
    const buffer2 = new Uint8Array(size);
`,
    // Checked before the early return: the buffer grows by doubling, so a check only on growth would
    // let a stream fill a 64 MiB buffer unchecked. The allocation is also clamped to the limit.
    replacement: `  ensureBuffer(requested) {
    const graylumMax = ${GUARD}?.maxStreamBytes ?? 0;
    if (!(requested <= graylumMax)) {
      if (${GUARD}) ${GUARD}.hit ??= "PDF_STREAM_TOO_LARGE";
      throw new Error("graylum: decoded stream limit");
    }
    const buffer = this.buffer;
    if (requested <= buffer.byteLength) {
      return buffer;
    }
    let size = this.minBufferLength;
    while (size < requested) {
      size *= 2;
    }
    const buffer2 = new Uint8Array(Math.min(size, graylumMax));
`,
  },
  {
    name: 'images recorded, never decoded',
    target: `    if (maxImageSize !== -1 && w * h > maxImageSize) {
      const msg = "Image exceeded maximum allowed size and was removed.";
`,
    replacement: `    if (maxImageSize !== -1 && w * h > maxImageSize) {
      operatorList.addOp(OPS.paintImageXObject, [${JSON.stringify(SKIPPED_IMAGE_MARKER)}, w, h]);
      const msg = "Image exceeded maximum allowed size and was removed.";
`,
  },
  {
    name: 'BrotliDecode refused',
    target: `        case "BrotliDecode":
          return new BrotliStream(stream, maybeLength);
`,
    replacement: `        case "BrotliDecode":
          if (${GUARD}) ${GUARD}.hit ??= "PDF_UNSUPPORTED";
          throw new Error("graylum: BrotliDecode is not supported");
`,
  },
  {
    name: 'no self-started message loop',
    target: '    if (typeof window === "undefined" && !isNodeJS && typeof self !== "undefined" '
      + '&& typeof self.postMessage === "function" && "onmessage" in self) {\n'
      + '      this.initializeFromPort(self);\n'
      + '    }\n',
    replacement: `    if (false) {
      this.initializeFromPort(self);
    }
`,
  },
];

/** Applies every patch exactly once; throws if pdf.js no longer matches. */
export function patchPdfjsWorker(source) {
  let output = source;
  for (const patch of PDFJS_PATCHES) {
    const count = output.split(patch.target).length - 1;
    if (count !== 1) throw new Error(`pdf.js patch "${patch.name}" matched ${count} times; review the pdfjs-dist upgrade`);
    output = output.replace(patch.target, () => patch.replacement);
  }
  return output;
}

async function cmapModule() {
  const folder = path.join(pdfjsRoot, 'cmaps');
  const names = (await readdir(folder)).filter((name) => name.endsWith('.bcmap')).sort();
  const entries = await Promise.all(names.map(async (name) =>
    `${JSON.stringify(name.slice(0, -'.bcmap'.length))}:${JSON.stringify((await readFile(path.join(folder, name))).toString('base64'))}`));
  return `export default {${entries.join(',\n')}};\n`;
}

/** @returns {import('esbuild').Plugin} */
export function pdfjsSandboxPlugin() {
  return {
    name: 'graylum-pdfjs-sandbox',
    setup(build) {
      build.onResolve({ filter: /^graylum:pdf-cmaps$/ }, () => ({ path: 'pdf-cmaps', namespace: 'graylum-pdf-cmaps' }));
      build.onLoad({ filter: /.*/, namespace: 'graylum-pdf-cmaps' }, async () => ({ contents: await cmapModule(), loader: 'js' }));
      build.onLoad({ filter: /[\\/]pdfjs-dist[\\/]legacy[\\/]build[\\/]pdf\.worker\.mjs$/ }, async (args) => ({
        contents: patchPdfjsWorker(await readFile(args.path, 'utf8')),
        loader: 'js',
      }));
    },
  };
}
