/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { SandboxError } from '../errors';
import { ZIP_LIMITS } from '../limits';

/**
 * Pre-flight check of an untrusted ZIP container before any parser library sees it (#549 limits).
 * Every member is actually inflated with a hard byte cap, so the later JSZip/mammoth pass is bounded
 * by what was measured here, not by what the archive declares. Only XML-like members are kept.
 */

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_COMMENT = 0xffff;
/** Feed the inflater in small slices so one write cannot expand far beyond the cap. */
const INFLATE_SLICE = 1_024;

type CentralEntry = {
  name: string;
  nameBytes: Uint8Array;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
};

/** A checked member: its stored (possibly compressed) bytes, exactly as in the archive. */
export type ZipMember = { name: string; nameBytes: Uint8Array; method: number; crc: number; size: number; raw: Uint8Array };

export type InspectedZip = {
  /** Inflated bytes of `.xml` and `.rels` members, keyed by exact member name. */
  xmlParts: Map<string, Uint8Array>;
  names: string[];
  members: ZipMember[];
  totalInflatedBytes: number;
};

const fail = (code: ConstructorParameters<typeof SandboxError>[0]): never => {
  throw new SandboxError(code);
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(chunks: Uint8Array[]): number {
  let crc = 0xffffffff;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += 1) crc = CRC_TABLE[(crc ^ chunk[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function findEndOfCentralDirectory(view: DataView): number {
  const last = view.byteLength - 22;
  const first = Math.max(0, last - MAX_COMMENT);
  for (let offset = last; offset >= first; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD) return offset;
  }
  return fail('ZIP_INVALID');
}

const DECODER = new TextDecoder('utf-8', { fatal: true });

function decodeName(bytes: Uint8Array): string {
  try {
    return DECODER.decode(bytes);
  } catch {
    return fail('ZIP_PATH');
  }
}

/** Relative, forward-slash paths with no empty, `.` or `..` components and no drive prefix. */
export function isSafeMemberName(name: string): boolean {
  if (!name || name.length > 1_024 || name.startsWith('/') || name.includes('\\')) return false;
  if (/^[A-Za-z]:/.test(name) || /[\u0000-\u001f]/.test(name)) return false;
  const parts = name.split('/');
  return parts.every((part, index) => part !== '.' && part !== '..' && (part !== '' || index === parts.length - 1));
}

const SYMLINK_MODE = 0o120000;
const UNIX_HOST = 3;

function readCentralDirectory(bytes: Uint8Array, view: DataView): { entries: CentralEntry[]; centralOffset: number } {
  const eocd = findEndOfCentralDirectory(view);
  if (view.getUint16(eocd + 4, true) !== 0 || view.getUint16(eocd + 6, true) !== 0) fail('ZIP_UNSUPPORTED');
  const count = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) fail('ZIP_UNSUPPORTED');
  if (view.getUint16(eocd + 8, true) !== count) fail('ZIP_UNSUPPORTED');
  if (count > ZIP_LIMITS.maxEntries) fail('ZIP_ENTRY_COUNT');
  if (centralOffset + centralSize > eocd) fail('ZIP_INVALID');

  const entries: CentralEntry[] = [];
  const seen = new Set<string>();
  let declaredTotal = 0;
  let p = centralOffset;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > eocd || view.getUint32(p, true) !== CENTRAL) fail('ZIP_INVALID');
    const madeBy = view.getUint16(p + 4, true);
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const compressedSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    const external = view.getUint32(p + 38, true);
    const localOffset = view.getUint32(p + 42, true);
    const end = p + 46 + nameLength + extraLength + commentLength;
    if (end > eocd) fail('ZIP_INVALID');
    const nameBytes = bytes.subarray(p + 46, p + 46 + nameLength);
    // Without the UTF-8 flag JSZip would read non-ASCII names as CP437; refuse them so every check
    // here sees exactly the name the parser sees.
    if (!(flags & 0x800) && nameBytes.some((byte) => byte >= 0x80)) fail('ZIP_PATH');
    const name = decodeName(nameBytes);
    p = end;

    if (!isSafeMemberName(name)) fail('ZIP_PATH');
    const key = name.toLowerCase();
    if (seen.has(key)) fail('ZIP_DUPLICATE');
    seen.add(key);
    if (madeBy >> 8 === UNIX_HOST && ((external >>> 16) & 0o170000) === SYMLINK_MODE) fail('ZIP_SYMLINK');
    if (flags & 0x41) fail('ZIP_ENCRYPTED');
    if (compressedSize === 0xffffffff || size === 0xffffffff) fail('ZIP_UNSUPPORTED');
    if (method !== 0 && method !== 8) fail('ZIP_UNSUPPORTED');
    if (size > ZIP_LIMITS.maxEntryBytes) fail('ZIP_ENTRY_SIZE');
    if (method === 0 && compressedSize !== size) fail('ZIP_SIZE_MISMATCH');
    if (size >= ZIP_LIMITS.ratioCheckMinBytes && size > compressedSize * ZIP_LIMITS.maxRatio) fail('ZIP_RATIO');
    declaredTotal += size;
    if (declaredTotal > ZIP_LIMITS.maxTotalBytes) fail('ZIP_TOTAL_SIZE');
    if (name.endsWith('/')) continue;
    entries.push({ name, nameBytes, method, crc, compressedSize, size, localOffset });
  }
  return { entries, centralOffset };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** Locate member data; the local header must agree with the central directory and members must not overlap. */
function locateData(bytes: Uint8Array, view: DataView, entries: CentralEntry[], centralOffset: number) {
  const ranges = entries.map((entry) => {
    const offset = entry.localOffset;
    if (offset + 30 > centralOffset || view.getUint32(offset, true) !== LOCAL) fail('ZIP_INVALID');
    if (view.getUint16(offset + 6, true) & 0x41) fail('ZIP_ENCRYPTED');
    if (view.getUint16(offset + 8, true) !== entry.method) fail('ZIP_INVALID');
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    if (!sameBytes(bytes.subarray(offset + 30, offset + 30 + nameLength), entry.nameBytes)) fail('ZIP_INVALID');
    const start = offset + 30 + nameLength + extraLength;
    const end = start + entry.compressedSize;
    if (end > centralOffset) fail('ZIP_INVALID');
    return { entry, offset, start, end };
  });
  const sorted = [...ranges].sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].offset < sorted[i - 1].end) fail('ZIP_OVERLAP');
  }
  return ranges;
}

/** Inflate raw DEFLATE data, aborting as soon as the output passes `cap` bytes. */
export async function inflateRaw(data: Uint8Array, cap: number): Promise<Uint8Array[]> {
  if (typeof DecompressionStream !== 'function') fail('SANDBOX_UNAVAILABLE');
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let exceeded = false;
  const feeding = (async () => {
    for (let offset = 0; offset < data.length && !exceeded; offset += INFLATE_SLICE) {
      await writer.write(data.slice(offset, offset + INFLATE_SLICE));
    }
    if (!exceeded) await writer.close();
  })();
  feeding.catch(() => undefined);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > cap) {
        exceeded = true;
        await reader.cancel().catch(() => undefined);
        return fail('ZIP_SIZE_MISMATCH');
      }
      chunks.push(value);
    }
    await feeding;
  } catch (error) {
    if (error instanceof SandboxError) throw error;
    return fail('ZIP_INVALID');
  }
  return chunks;
}

export function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= size) break;
    const part = chunk.subarray(0, size - offset);
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const XML_PART = /\.(?:xml|rels)$/i;
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

export async function inspectZip(bytes: Uint8Array): Promise<InspectedZip> {
  if (bytes.length < 22) fail('ZIP_INVALID');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { entries, centralOffset } = readCentralDirectory(bytes, view);
  const located = locateData(bytes, view, entries, centralOffset);
  const xmlParts = new Map<string, Uint8Array>();
  const members: ZipMember[] = [];
  let totalInflatedBytes = 0;
  for (const { entry, start, end } of located) {
    const raw = bytes.subarray(start, end);
    const remaining = ZIP_LIMITS.maxTotalBytes - totalInflatedBytes;
    const chunks = entry.method === 0 ? [raw] : await inflateRaw(raw, Math.min(entry.size, remaining));
    const actual = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (actual !== entry.size) fail('ZIP_SIZE_MISMATCH');
    if (crc32(chunks) !== entry.crc) fail('ZIP_CRC');
    totalInflatedBytes += actual;
    const head = concat(chunks, Math.min(actual, ZIP_MAGIC.length));
    if (ZIP_MAGIC.every((byte, index) => head[index] === byte)) fail('DOCX_NESTED_ARCHIVE');
    if (XML_PART.test(entry.name)) xmlParts.set(entry.name, concat(chunks, actual));
    members.push({ name: entry.name, nameBytes: entry.nameBytes, method: entry.method, crc: entry.crc, size: entry.size, raw });
  }
  return { xmlParts, names: entries.map((entry) => entry.name), members, totalInflatedBytes };
}
