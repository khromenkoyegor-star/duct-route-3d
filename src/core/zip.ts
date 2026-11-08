/**
 * Читання ZIP-архівів (Polycam експортує GLTF саме в ZIP).
 *
 * Без сторонніх бібліотек: зміст архіву читаємо з центрального каталогу (central directory),
 * розпаковуємо вбудованим DecompressionStream('deflate-raw') — він є в Safari 16.4+ і в Node 22.
 * Цілісність кожного файлу перевіряємо за CRC-32.
 *
 * Чиста логіка: без Three.js і без DOM.
 */

export type ZipErrorCode = 'not-zip' | 'corrupt' | 'zip64' | 'encrypted' | 'unsupported-method' | 'no-inflate';

export class ZipError extends Error {
  readonly code: ZipErrorCode;
  constructor(code: ZipErrorCode, message: string) {
    super(message);
    this.name = 'ZipError';
    this.code = code;
  }
}

export interface ZipEntry {
  /** Повний шлях у архіві, з «/» як роздільником. */
  name: string;
  isDirectory: boolean;
  /** 0 — без стиснення, 8 — deflate. */
  method: number;
  compressedSize: number;
  size: number;
  crc32: number;
  /** Зсув локального заголовка файлу. */
  localHeaderOffset: number;
  encrypted: boolean;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

/** Схоже на ZIP за першими байтами (PK\x03\x04 або порожній архів PK\x05\x06). */
export function looksLikeZip(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const sig = bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24);
  return sig === SIG_LOCAL || sig === SIG_EOCD;
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function findEndOfCentralDirectory(bytes: Uint8Array, dv: DataView): number {
  const stop = Math.max(0, bytes.length - EOCD_MIN - MAX_COMMENT);
  let loose = -1;
  for (let i = bytes.length - EOCD_MIN; i >= stop; i--) {
    if (dv.getUint32(i, true) !== SIG_EOCD) continue;
    // Справжній кінець каталогу: його коментар закінчується рівно в кінці файлу.
    // (Байти «PK\x05\x06» можуть траплятися й усередині самого коментаря.)
    if (i + EOCD_MIN + dv.getUint16(i + 20, true) === bytes.length) return i;
    if (loose < 0) loose = i;
  }
  return loose;
}

const utf8 = new TextDecoder('utf-8');

/** Список файлів архіву. Кидає ZipError, якщо це не ZIP або архів пошкоджений. */
export function readZipEntries(bytes: Uint8Array): ZipEntry[] {
  if (bytes.length < EOCD_MIN) throw new ZipError('not-zip', 'Файл замалий для ZIP-архіву');
  const dv = view(bytes);
  const eocd = findEndOfCentralDirectory(bytes, dv);
  if (eocd < 0) {
    throw looksLikeZip(bytes)
      ? new ZipError('corrupt', 'Архів обрізаний або пошкоджений: немає кінця каталогу')
      : new ZipError('not-zip', 'Це не ZIP-архів');
  }

  const totalEntries = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipError('zip64', 'Архів у форматі ZIP64 (понад 4 ГБ) не підтримується');
  }
  if (cdOffset + cdSize > eocd) throw new ZipError('corrupt', 'Архів пошкоджений: каталог виходить за межі файлу');

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (p + 46 > bytes.length || dv.getUint32(p, true) !== SIG_CENTRAL) {
      throw new ZipError('corrupt', 'Архів пошкоджений: зіпсований каталог файлів');
    }
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const crc32 = dv.getUint32(p + 16, true);
    const compressedSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLength = dv.getUint16(p + 28, true);
    const extraLength = dv.getUint16(p + 30, true);
    const commentLength = dv.getUint16(p + 32, true);
    const localHeaderOffset = dv.getUint32(p + 42, true);
    if (compressedSize === 0xffffffff || size === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw new ZipError('zip64', 'Архів у форматі ZIP64 (понад 4 ГБ) не підтримується');
    }
    const nameStart = p + 46;
    if (nameStart + nameLength > bytes.length) throw new ZipError('corrupt', 'Архів пошкоджений: обрізана назва файлу');
    // Біт 11 — UTF-8; інакше CP437, але Polycam і macOS пишуть ASCII/UTF-8 — читаємо як UTF-8.
    const name = utf8.decode(bytes.subarray(nameStart, nameStart + nameLength)).replaceAll('\\', '/');
    entries.push({
      name,
      isDirectory: name.endsWith('/'),
      method,
      compressedSize,
      size,
      crc32,
      localHeaderOffset,
      encrypted: (flags & 0x1) !== 0,
    });
    p = nameStart + nameLength + extraLength + commentLength;
  }
  return entries;
}

let crcTable: Uint32Array | null = null;

/** CRC-32 (IEEE), як у ZIP. */
export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new ZipError('no-inflate', 'Цей браузер не вміє розпаковувати ZIP. Оновіть iOS / iPadOS до 16.4 або новішої');
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  }).pipeThrough(new DecompressionStream('deflate-raw') as unknown as TransformStream<Uint8Array, Uint8Array>);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Розпакувати один файл архіву з перевіркою розміру й CRC-32. */
export async function extractZipEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  if (entry.isDirectory) return new Uint8Array(0);
  if (entry.encrypted) throw new ZipError('encrypted', `Файл «${entry.name}» в архіві зашифрований (з паролем)`);
  const dv = view(bytes);
  const p = entry.localHeaderOffset;
  if (p + 30 > bytes.length || dv.getUint32(p, true) !== SIG_LOCAL) {
    throw new ZipError('corrupt', `Архів пошкоджений: не знайдено «${entry.name}»`);
  }
  const dataStart = p + 30 + dv.getUint16(p + 26, true) + dv.getUint16(p + 28, true);
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > bytes.length) throw new ZipError('corrupt', `Архів обрізаний: «${entry.name}» неповний`);
  const raw = bytes.subarray(dataStart, dataEnd);

  let data: Uint8Array;
  if (entry.method === 0) {
    data = raw.slice();
  } else if (entry.method === 8) {
    try {
      data = await inflateRaw(raw);
    } catch (error) {
      if (error instanceof ZipError) throw error;
      throw new ZipError('corrupt', `Архів пошкоджений: не вдалося розпакувати «${entry.name}»`);
    }
  } else {
    throw new ZipError('unsupported-method', `Файл «${entry.name}» стиснутий непідтримуваним способом (${entry.method})`);
  }

  if (data.byteLength !== entry.size || crc32(data) !== entry.crc32) {
    throw new ZipError('corrupt', `Архів пошкоджений: «${entry.name}» не збігається з контрольною сумою`);
  }
  return data;
}
