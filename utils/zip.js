// Minimal ZIP reader (no dependencies): lists entries and extracts single files.
// Supports "stored" and "deflate" entries (what virtually every zip tool writes).
// Reads only the central directory and the requested entry, never the whole archive, and caps the
// inflated size so a zip bomb cannot exhaust memory.

import fs from 'node:fs/promises';
import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

async function readAt(handle, position, length) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead);
}

async function centralDirectory(handle, size) {
  const tailLen = Math.min(size, 65557); // max comment (65535) + EOCD (22)
  const tail = await readAt(handle, size - tailLen, tailLen);
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) !== EOCD_SIG) continue;
    const count = tail.readUInt16LE(i + 10);
    const cdSize = tail.readUInt32LE(i + 12);
    const cdOffset = tail.readUInt32LE(i + 16);
    if (cdOffset === 0xffffffff || count === 0xffff) throw new Error('ZIP64 archives are not supported.');
    return { count, cd: await readAt(handle, cdOffset, cdSize) };
  }
  throw new Error('Not a ZIP file (end of central directory not found).');
}

/** List entries: [{ name, size, compressedSize, method, dir, offset }]. */
export async function listZip(file) {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const { count, cd } = await centralDirectory(handle, size);
    const entries = [];
    let p = 0;
    for (let n = 0; n < count && p + 46 <= cd.length; n++) {
      if (cd.readUInt32LE(p) !== CEN_SIG) throw new Error('Corrupt ZIP central directory.');
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const compressedSize = cd.readUInt32LE(p + 20);
      const uncompressed = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const offset = cd.readUInt32LE(p + 42);
      const rawName = cd.subarray(p + 46, p + 46 + nameLen);
      const name = rawName.toString(flags & 0x800 ? 'utf8' : 'latin1').replace(/\\/g, '/');
      entries.push({ name, size: uncompressed, compressedSize, method, encrypted: Boolean(flags & 1), dir: name.endsWith('/'), offset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    await handle.close();
  }
}

/** Extract one entry as a Buffer. `maxBytes` caps the inflated size. */
export async function readZipEntry(file, name, { maxBytes = 5 * 1024 * 1024 } = {}) {
  const entries = await listZip(file);
  const entry = entries.find((e) => e.name === name) ?? entries.find((e) => e.name.toLowerCase() === String(name).toLowerCase());
  if (!entry) {
    const err = new Error(`"${name}" is not in the archive.`);
    err.code = 'ENTRY_NOT_FOUND';
    throw err;
  }
  if (entry.dir) throw new Error(`"${name}" is a folder inside the archive.`);
  if (entry.encrypted) throw new Error(`"${name}" is encrypted.`);
  const handle = await fs.open(file, 'r');
  try {
    const head = await readAt(handle, entry.offset, 30);
    if (head.length < 30 || head.readUInt32LE(0) !== LOC_SIG) throw new Error('Corrupt ZIP local header.');
    const start = entry.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
    const data = await readAt(handle, start, entry.compressedSize);
    if (entry.method === 0) return { entry, data: data.subarray(0, Math.min(data.length, maxBytes)), truncated: data.length > maxBytes };
    if (entry.method !== 8) throw new Error(`Unsupported compression method ${entry.method} for "${name}".`);
    try {
      return { entry, data: zlib.inflateRawSync(data, { maxOutputLength: maxBytes }), truncated: false };
    } catch (err) {
      if (err.code === 'ERR_BUFFER_TOO_LARGE') {
        // Too big to inflate fully: stream-inflate only the first maxBytes.
        const chunks = [];
        let total = 0;
        await new Promise((resolve, reject) => {
          const inflater = zlib.createInflateRaw();
          inflater.on('data', (c) => {
            if (total >= maxBytes) return;
            chunks.push(c);
            total += c.length;
            if (total >= maxBytes) inflater.destroy();
          });
          inflater.on('close', resolve);
          inflater.on('end', resolve);
          inflater.on('error', (e) => (total >= maxBytes ? resolve() : reject(e)));
          inflater.end(data);
        });
        return { entry, data: Buffer.concat(chunks).subarray(0, maxBytes), truncated: true };
      }
      throw err;
    }
  } finally {
    await handle.close();
  }
}

/** Build a ZIP in memory (deflate). Used by tests and handy for exporting; no dependencies. */
export function createZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    const data = zlib.deflateRawSync(raw);
    const crc = zlib.crc32 ? zlib.crc32(raw) : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOC_SIG, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CEN_SIG, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
