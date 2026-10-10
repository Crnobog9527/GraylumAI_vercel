/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { crc32, type ZipMember } from './zip-guard';

/**
 * mammoth drops `w:fldSimple` together with the field's displayed result (dates, page and
 * cross-reference text). When a checked part contains one, the wrapper tags are removed so the
 * result runs stay, and the package is rebuilt: changed parts are stored uncompressed, every other
 * member is copied byte for byte. Field instructions are never evaluated.
 */

const FIELD_WRAPPER = /<w:fldSimple(?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*\s*\/?>|<\/w:fldSimple>/g;

export function unwrapSimpleFields(xml: string): string {
  return xml.replace(FIELD_WRAPPER, '');
}

function header(size: number, member: ZipMember, method: number, crc: number, compressed: number, central: boolean) {
  const nameLength = member.nameBytes.length;
  const out = new DataView(new ArrayBuffer(size));
  out.setUint32(0, central ? 0x02014b50 : 0x04034b50, true);
  const base = central ? 2 : 0;
  if (central) out.setUint16(4, 20, true);
  out.setUint16(base + 4, 20, true);
  out.setUint16(base + 6, 0x0800, true);
  out.setUint16(base + 8, method, true);
  out.setUint32(base + 14, crc, true);
  out.setUint32(base + 18, compressed, true);
  out.setUint32(base + 22, member.size, true);
  out.setUint16(base + 26, nameLength, true);
  return out;
}

/** Rebuilds the archive with `replaced` members (name → new XML text) stored uncompressed. */
export function rebuildZip(members: ZipMember[], replaced: Map<string, string>): Uint8Array {
  const encoder = new TextEncoder();
  const pieces: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const original of members) {
    const text = replaced.get(original.name);
    const data = text === undefined ? original.raw : encoder.encode(text);
    const member = text === undefined ? original : { ...original, size: data.length };
    const method = text === undefined ? original.method : 0;
    const crc = text === undefined ? original.crc : crc32([data]);
    const local = header(30 + member.nameBytes.length, member, method, crc, data.length, false);
    const entry = header(46 + member.nameBytes.length, member, method, crc, data.length, true);
    entry.setUint32(42, offset, true);
    const localBytes = new Uint8Array(local.buffer);
    localBytes.set(member.nameBytes, 30);
    const entryBytes = new Uint8Array(entry.buffer);
    entryBytes.set(member.nameBytes, 46);
    pieces.push(localBytes, data);
    central.push(entryBytes);
    offset += localBytes.length + data.length;
  }
  const centralSize = central.reduce((sum, piece) => sum + piece.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, members.length, true);
  end.setUint16(10, members.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const all = [...pieces, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((sum, piece) => sum + piece.length, 0));
  let position = 0;
  for (const piece of all) {
    out.set(piece, position);
    position += piece.length;
  }
  return out;
}
