#!/usr/bin/env node
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Bundles the library sandbox parser Workers (LIB-2b) into public/library-sandbox/ so they are served
// from Graylum's own origin, never a CDN. The page fetches the bundle text and starts it from a blob
// inside the sandboxed frame. Third-party license texts go into a file next to each bundle.

import { build } from 'esbuild';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const SANDBOX_WORKERS = {
  'docx-worker': 'src/lib/library-sandbox/docx/worker-entry.ts',
};

/** Package roots (directories holding package.json) of every node_modules input in the bundle. */
function packageRoots(inputs) {
  const roots = new Set();
  for (const input of inputs) {
    const parts = input.split(/[\\/]/);
    const index = parts.lastIndexOf('node_modules');
    if (index < 0) continue;
    const size = parts[index + 1]?.startsWith('@') ? 2 : 1;
    roots.add(path.resolve(webRoot, parts.slice(0, index + 1 + size).join('/')));
  }
  return [...roots].sort();
}

/**
 * Adds every production dependency of the bundled packages: some ship prebuilt files that already
 * contain their dependencies (JSZip's dist includes pako), so their notices must be listed too.
 */
async function withDependencies(roots) {
  const all = new Set(roots);
  const queue = [...roots];
  while (queue.length) {
    const root = queue.pop();
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    const require = createRequire(path.join(root, 'package.json'));
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      const dependency = path.dirname(require.resolve(`${name}/package.json`));
      if (!all.has(dependency)) {
        all.add(dependency);
        queue.push(dependency);
      }
    }
  }
  return [...all].sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

async function licenseText(root) {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const file = (await readdir(root)).find((name) => /^(?:license|licence|copying)(?:\.|$)/i.test(name));
  const text = file ? await readFile(path.join(root, file), 'utf8') : '(no license file shipped in the package)';
  return `${manifest.name}@${manifest.version} — ${manifest.license ?? 'UNKNOWN'}\n\n${text.trim()}\n`;
}

/**
 * Returns `{ name: { code, licenses } }`; writes files unless `outdir` is null.
 * @param {{ outdir?: string | null, minify?: boolean }} [options]
 * @returns {Promise<Record<string, { code: string, licenses: string }>>}
 */
export async function buildLibrarySandbox({ outdir = path.join(webRoot, 'public/library-sandbox'), minify = true } = {}) {
  /** @type {Record<string, { code: string, licenses: string }>} */
  const results = {};
  for (const [name, entry] of Object.entries(SANDBOX_WORKERS)) {
    const output = await build({
      entryPoints: [path.join(webRoot, entry)],
      absWorkingDir: webRoot,
      bundle: true,
      platform: 'browser',
      format: 'iife',
      target: ['es2022'],
      minify,
      write: false,
      metafile: true,
      legalComments: 'eof',
      logLevel: 'warning',
      define: { 'process.env.NODE_ENV': '"production"' },
      banner: { js: `/* Graylum library sandbox worker. Third-party licenses: ${name}.licenses.txt */` },
    });
    const roots = await withDependencies(packageRoots(Object.keys(output.metafile.inputs)));
    const licenses = (await Promise.all(roots.map(licenseText))).join('\n---\n\n');
    results[name] = { code: output.outputFiles[0].text, licenses };
    if (outdir) {
      await mkdir(outdir, { recursive: true });
      await writeFile(path.join(outdir, `${name}.js`), results[name].code);
      await writeFile(path.join(outdir, `${name}.licenses.txt`), licenses);
    }
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = await buildLibrarySandbox();
  for (const [name, { code }] of Object.entries(results)) {
    console.log(`library sandbox: ${name}.js ${code.length} bytes`);
  }
}
