/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// The #549 adversarial corpus (packages/api/src/services/__tests__/lib1/dependencies.test.ts),
// rebuilt with the same ZIP writer, plus the container tricks LIB-2b adds. `code` is what the whole
// browser extraction returns; `stage` says which guard unit test also covers the sample directly.
import { crc32 } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { buildDocx, para, zipFixture } from './docx-fixture';

export type MaliciousSample = { name: string; bytes: Buffer; code: string; stage: 'input' | 'zip' | 'xml' | 'docx'; xml?: string };

const xmlSample = (name: string, xml: string, code: string): MaliciousSample =>
  ({ name, xml, code, stage: 'xml', bytes: zipFixture([{ name: 'word/document.xml', body: xml }]) });

/** Member A (stored) is stretched so its data covers member B's local header. */
function overlappingZip(): Buffer {
  const zip = zipFixture([{ name: 'a.xml', body: '<a/>' }, { name: 'b.xml', body: '<b/>' }]);
  const centralA = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const localB = zip.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), 4);
  const dataA = 30 + 'a.xml'.length;
  const stretched = zip.subarray(dataA, centralA);
  const crc = crc32(stretched);
  for (const [base, crcAt, sizesAt] of [[0, 14, 18], [centralA, 16, 20]]) {
    zip.writeUInt32LE(crc, base + crcAt);
    zip.writeUInt32LE(stretched.length, base + sizesAt);
    zip.writeUInt32LE(stretched.length, base + sizesAt + 4);
  }
  if (localB <= dataA) throw new Error('fixture layout changed');
  return zip;
}

export function maliciousSamples(): MaliciousSample[] {
  const valid = zipFixture([{ body: '<x/>' }]);
  return [
    ...['../escape', '/absolute', 'C:/drive', 'word\\escape', 'word/./document.xml'].map((name): MaliciousSample =>
      ({ name: `path ${name}`, bytes: zipFixture([{ name, body: 'x' }]), code: 'ZIP_PATH', stage: 'zip' })),
    { name: 'high-ratio bomb', bytes: zipFixture([{ body: 'x'.repeat(1_000_000), deflate: true }]), code: 'ZIP_RATIO', stage: 'zip' },
    { name: 'understated inflated size', code: 'ZIP_SIZE_MISMATCH', stage: 'zip',
      bytes: zipFixture([{ body: 'x'.repeat(100_000), deflate: true, declaredSize: 100 }]) },
    { name: 'not a ZIP', bytes: Buffer.from('not a ZIP'), code: 'ZIP_INVALID', stage: 'zip' },
    { name: 'truncated ZIP', bytes: valid.subarray(0, valid.length - 5), code: 'ZIP_INVALID', stage: 'zip' },
    { name: 'bad CRC', bytes: zipFixture([{ body: '<x/>', badCrc: true }]), code: 'ZIP_CRC', stage: 'zip' },
    { name: 'declared entry over 20,000,000 bytes', code: 'ZIP_ENTRY_SIZE', stage: 'zip',
      bytes: zipFixture([{ deflate: true, declaredSize: 20_000_001 }]) },
    { name: '2,001 entries', code: 'ZIP_ENTRY_COUNT', stage: 'zip',
      bytes: zipFixture(Array.from({ length: 2_001 }, (_, i) => ({ name: String(i) }))) },
    { name: 'duplicate names', bytes: zipFixture([{ body: '<x/>' }, { body: '<x/>' }]), code: 'ZIP_DUPLICATE', stage: 'zip' },
    { name: 'case-folded duplicate', code: 'ZIP_DUPLICATE', stage: 'zip',
      bytes: zipFixture([{ name: 'word/a.xml', body: '<x/>' }, { name: 'WORD/A.xml', body: '<x/>' }]) },
    { name: 'symlink', bytes: zipFixture([{ symlink: true }]), code: 'ZIP_SYMLINK', stage: 'zip' },
    { name: 'encrypted', bytes: zipFixture([{ flags: 1, deflate: true }]), code: 'ZIP_ENCRYPTED', stage: 'zip' },
    { name: 'overlapping members', bytes: overlappingZip(), code: 'ZIP_OVERLAP', stage: 'zip' },
    { name: 'nested ZIP member', code: 'DOCX_NESTED_ARCHIVE', stage: 'zip',
      bytes: zipFixture([{ name: 'word/media/x.png', body: zipFixture([{ body: '<x/>' }]) }]) },
    xmlSample('external file entity', '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///not-a-real-file">]><x>&e;</x>', 'XML_DTD'),
    xmlSample('external DTD URL', '<!DOCTYPE x SYSTEM "https://example.invalid/xxe"><x/>', 'XML_DTD'),
    xmlSample('entity expansion', '<!DOCTYPE x [<!ENTITY a "123"><!ENTITY b "&a;&a;&a;">]><x>&b;</x>', 'XML_DTD'),
    xmlSample('malformed XML', '<x>', 'XML_MALFORMED'),
    xmlSample('XML depth 65', '<x>'.repeat(65) + '</x>'.repeat(65), 'XML_DEPTH'),
    xmlSample('100 KB attribute', `<x a="${'x'.repeat(100_000)}"/>`, 'XML_TOKEN'),
    { name: 'input over 10,000,000 bytes', bytes: Buffer.alloc(10_000_001), code: 'INPUT_TOO_LARGE', stage: 'input' },
    { name: 'text over 10,000,000 UTF-8 bytes', code: 'TEXT_TOO_LARGE', stage: 'docx',
      bytes: buildDocx({ body: Array.from({ length: 10 }, () => para(randomBytes(750_001).toString('base64'))).join('') }) },
    { name: 'macro project', code: 'DOCX_MACRO', stage: 'docx',
      bytes: buildDocx({ body: para('x'), extra: [{ name: 'word/vbaProject.bin', body: 'x' }] }) },
  ];
}
