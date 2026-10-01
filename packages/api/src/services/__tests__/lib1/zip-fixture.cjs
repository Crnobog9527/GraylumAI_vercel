// Tiny deterministic ZIP writer for tests, NOT a ZIP parser or application code.
const { deflateRawSync, crc32 } = require('node:zlib');
exports.zipFixture = function zipFixture(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name || 'word/document.xml');
    const body = Buffer.from(entry.body || '');
    const data = entry.deflate ? deflateRawSync(body) : body;
    const crc = entry.badCrc ? (crc32(body) ^ 1) >>> 0 : crc32(body);
    const size = entry.declaredSize ?? body.length;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(entry.flags || 0, 6);
    header.writeUInt16LE(entry.deflate ? 8 : 0, 8);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(size, 22);
    header.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(0x0314, 4);
    header.copy(directory, 6, 4, 28);
    directory.writeUInt32LE(entry.symlink ? 0xa0000000 : 0, 38);
    directory.writeUInt32LE(offset, 42);
    local.push(header, name, data);
    central.push(directory, name);
    offset += header.length + name.length + data.length;
  }
  const index = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(index.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, index, end]);
};
