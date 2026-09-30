// Dependency qualification only. Never imported by application code.
const yauzl = require('yauzl');
const sax = require('sax');
const { crc32 } = require('node:zlib');
const { StringDecoder } = require('node:string_decoder');
const { readFileSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const limits = {
  input: 10_000_000, entries: 2_000, entry: 20_000_000,
  total: 50_000_000, ratio: 100, text: 10_000_000, depth: 64,
};
function requireLimit(condition, code) {
  if (!condition) throw new Error(code);
}
async function qualify(input) {
  requireLimit(input.length <= limits.input, 'INPUT_LIMIT');
  const zip = await yauzl.fromBufferPromise(input, {
    lazyEntries: true, validateEntrySizes: true, strictFileNames: true,
  });
  requireLimit(zip.entryCount <= limits.entries, 'ENTRY_COUNT');
  let declared = 0;
  let actual = 0;
  let text = 0;
  const names = new Set();
  for await (const entry of zip.eachEntry()) {
    // yauzl rejects traversal/absolute/backslash names. Reject aliases too.
    requireLimit(!entry.fileName.split('/').includes('.'), 'PATH_ALIAS');
    requireLimit(!names.has(entry.fileName), 'DUPLICATE');
    names.add(entry.fileName);
    requireLimit(!entry.isEncrypted(), 'ENCRYPTED');
    requireLimit(((entry.externalFileAttributes >>> 16) & 0xf000) !== 0xa000, 'SYMLINK');
    requireLimit(entry.uncompressedSize <= limits.entry, 'ENTRY_SIZE');
    declared += entry.uncompressedSize;
    requireLimit(declared <= limits.total, 'TOTAL_SIZE');
    requireLimit(entry.uncompressedSize <= Math.max(1, entry.compressedSize) * limits.ratio, 'RATIO');
    const stream = await zip.openReadStreamPromise(entry);
    let size = 0;
    let crc = 0;
    let depth = 0;
    const xml = entry.fileName.endsWith('.xml') || entry.fileName.endsWith('.rels');
    const decoder = new StringDecoder('utf8');
    const parser = xml ? sax.parser(true, { xmlns: true, strictEntities: true }) : null;
    if (parser) {
      parser.ondoctype = () => { throw new Error('DTD_FORBIDDEN'); };
      parser.onopentag = node => {
        requireLimit(++depth <= limits.depth, 'XML_DEPTH');
        requireLimit(Buffer.byteLength(node.name) <= 65_536, 'XML_TOKEN');
      };
      parser.onattribute = attr => {
        requireLimit(Buffer.byteLength(attr.name) <= 65_536 && Buffer.byteLength(attr.value) <= 65_536, 'XML_TOKEN');
      };
      parser.onclosetag = () => { depth--; };
      parser.ontext = parser.oncdata = value => {
        text += Buffer.byteLength(value);
        requireLimit(text <= limits.text, 'TEXT_SIZE');
      };
      parser.onerror = error => { throw error; };
    }
    try {
      for await (const chunk of stream) {
        size += chunk.length;
        actual += chunk.length;
        requireLimit(size <= limits.entry && actual <= limits.total, 'ACTUAL_SIZE');
        crc = crc32(chunk, crc);
        if (parser) parser.write(decoder.write(chunk));
      }
      if (parser) parser.write(decoder.end()).close();
      requireLimit(size === entry.uncompressedSize, 'SIZE_MISMATCH');
      requireLimit(crc === entry.crc32, 'CRC_MISMATCH');
    } finally {
      stream.destroy();
    }
  }
  return { entries: names.size, actual, text };
}
async function main() {
  const mode = process.argv[2];
  // Deliberate fault injection is confined to this test executable.
  if (mode === 'hang') {
    process.stdout.write('READY\n');
    for (;;) { /* CPU-bound parser stand-in: deadline must kill, not just reject. */ }
  }
  if (mode === 'permissions') {
    const codes = [];
    for (const action of [
      () => readFileSync(process.argv[3]),
      () => writeFileSync('lib1-forbidden-write', 'x'),
      () => spawnSync(process.execPath, ['-e', '']),
    ]) {
      try { action(); codes.push('ALLOWED'); } catch (error) { codes.push(error.code); }
    }
    return { codes, envKeys: Object.keys(process.env) };
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    requireLimit(length <= limits.input, 'INPUT_LIMIT');
    chunks.push(chunk);
  }
  return qualify(Buffer.concat(chunks));
}
main().then(result => process.stdout.write(JSON.stringify({ ok: true, ...result })))
  .catch(error => {
    process.stdout.write(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  });
