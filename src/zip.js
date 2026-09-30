'use strict';

// 极小 ZIP 读写器（零第三方依赖），仅供方案包导入导出使用。
// - 写：每个条目独立 DEFLATE（deflateRaw），压缩后反而变大时回退 STORE；
//   不写数据描述符，CRC/尺寸在本地头与中央目录中直接给出。
// - 读：只信任“中央目录”（防止伪造本地头），逐条回到本地头取数据；
//   校验 CRC-32 与未压缩尺寸；拒绝 ZIP64、分卷、加密、数据描述符、重复条目。
// 路径安全（越界、穿越）由上层 packageio 在条目名上做语义校验。

const zlib = require('zlib');

class ZipError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ZipError';
  }
}

// ---------- CRC-32（与 ZIP 规范一致，IEEE 多项式 0xEDB88320） ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d = new Date()) {
  return {
    time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((Math.floor(d.getSeconds() / 2)) & 31),
    date: (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31),
  };
}

// entries: [{ name: string, data: Buffer }] → Buffer（ZIP 字节）
function zipEntries(entries) {
  if (!Array.isArray(entries)) throw new ZipError('entries 必须是数组');
  const { time, date } = dosDateTime();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    if (!entry || typeof entry.name !== 'string' || !entry.name) {
      throw new ZipError('ZIP 条目名非法');
    }
    if (!Buffer.isBuffer(entry.data)) throw new ZipError(`ZIP 条目 ${entry.name} 数据必须是 Buffer`);
    const nameBuf = Buffer.from(entry.name, 'utf8');
    if (nameBuf.length > 0xffff) throw new ZipError(`ZIP 条目名过长：${entry.name}`);

    const crc = crc32(entry.data);
    let method = 8;
    let payload;
    try {
      payload = zlib.deflateRawSync(entry.data);
    } catch (e) {
      throw new ZipError(`压缩条目失败：${entry.name}（${e.message}）`);
    }
    // 压缩无收益（照片本身已是压缩格式时常见）时以 STORE 存储。
    if (payload.length >= entry.data.length) {
      method = 0;
      payload = entry.data;
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    local.writeUInt16LE(20, 4);         // 解压所需版本
    local.writeUInt16LE(0, 6);          // 通用标志位
    local.writeUInt16LE(method, 8);     // 压缩方式：0=STORE 8=DEFLATE
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);         // 无扩展字段
    localParts.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // 中央目录文件头签名
    central.writeUInt16LE(20, 4);         // 打包版本
    central.writeUInt16LE(20, 6);         // 解压所需版本
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);         // 扩展字段长度
    central.writeUInt16LE(0, 32);         // 注释长度
    central.writeUInt16LE(0, 34);         // 起始分卷
    central.writeUInt16LE(0, 36);         // 内部属性
    central.writeUInt32LE(0, 38);         // 外部属性
    central.writeUInt32LE(offset, 42);    // 本地头偏移
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const cdOffset = offset;
  const cdSize = centralParts.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // 中央目录结束签名
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20); // 无注释

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

// 解包：从中央目录遍历全部条目，返回 Map(条目名 → 数据 Buffer)。
// maxEntries / maxTotalBytes 用于防止畸形包 / ZIP 炸弹。
function unzip(buffer, { maxEntries = 5000, maxTotalBytes = 512 * 1024 * 1024 } = {}) {
  if (!Buffer.isBuffer(buffer)) throw new ZipError('ZIP 数据必须是 Buffer');
  if (buffer.length < 22) throw new ZipError('不是有效的 ZIP 包（体积过小）');

  // EOCD 最小 22 字节，其后最多还可带 65535 字节注释；从尾部向前找签名。
  const scanMin = Math.max(0, buffer.length - 22 - 65535);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= scanMin; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('找不到 ZIP 中央目录结束标记，包已损坏或不是 ZIP');

  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipError('不支持 ZIP64 方案包');
  }
  if (totalEntries === 0) throw new ZipError('方案包为空（ZIP 内没有任何条目）');
  if (totalEntries > maxEntries) throw new ZipError(`方案包条目数超过上限 ${maxEntries}`);
  if (cdOffset >= buffer.length || cdOffset + cdSize > buffer.length) {
    throw new ZipError('ZIP 中央目录偏移越界，包已损坏');
  }

  const entries = new Map();
  let pos = cdOffset;
  let totalUncompressed = 0;

  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== 0x02014b50) {
      throw new ZipError('ZIP 中央目录条目损坏');
    }
    const flags = buffer.readUInt16LE(pos + 8);
    const method = buffer.readUInt16LE(pos + 10);
    const crc = buffer.readUInt32LE(pos + 16);
    const compSize = buffer.readUInt32LE(pos + 20);
    const uncompSize = buffer.readUInt32LE(pos + 24);
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    const diskStart = buffer.readUInt16LE(pos + 34);
    const localOffset = buffer.readUInt32LE(pos + 42);
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new ZipError('不支持 ZIP64 方案包');
    }
    if (pos + 46 + nameLen + extraLen + commentLen > buffer.length) {
      throw new ZipError('ZIP 中央目录条目长度越界');
    }
    const name = buffer.slice(pos + 46, pos + 46 + nameLen).toString('utf8');
    pos += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x0001) throw new ZipError('不支持加密的 ZIP 条目');
    if (flags & 0x0008) throw new ZipError('不支持带数据描述符的 ZIP 条目');
    if (diskStart !== 0) throw new ZipError('不支持跨分卷 ZIP 包');
    if (method !== 0 && method !== 8) throw new ZipError(`不支持的 ZIP 压缩方式（${method}）`);
    if (entries.has(name)) throw new ZipError(`ZIP 内存在重复条目：${name}`);

    // 零尺寸、以 / 结尾的条目视为目录条目，跳过（不参与方案文件清单）。
    const isDirectory = name.endsWith('/');
    if (isDirectory && uncompSize === 0) continue;

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new ZipError(`ZIP 本地文件头损坏：${name}`);
    }
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + compSize > buffer.length) {
      throw new ZipError(`ZIP 条目数据越界：${name}`);
    }
    const raw = buffer.slice(dataStart, dataStart + compSize);
    let data;
    if (method === 0) {
      data = raw;
    } else {
      try {
        data = zlib.inflateRawSync(raw);
      } catch (e) {
        throw new ZipError(`ZIP 条目解压失败：${name}（${e.message}）`);
      }
    }
    if (data.length !== uncompSize) {
      throw new ZipError(`ZIP 条目尺寸与中央目录不符：${name}`);
    }
    if (crc32(data) !== crc) {
      throw new ZipError(`ZIP 条目 CRC-32 校验失败：${name}（数据可能已损坏）`);
    }
    totalUncompressed += uncompSize;
    if (totalUncompressed > maxTotalBytes) {
      throw new ZipError('方案包解压后总体积超过上限（疑似 ZIP 炸弹）');
    }
    entries.set(name, data);
  }

  return entries;
}

module.exports = { zipEntries, unzip, ZipError, crc32 };
