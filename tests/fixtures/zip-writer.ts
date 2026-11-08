/**
 * Мінімальний запис ZIP для тестів і фікстур (Node). Детермінований: фіксована дата файлів.
 * Підтримує те, що трапляється в реальних архівах: store/deflate, data descriptor, UTF-8 імена.
 */
import { deflateRawSync } from 'node:zlib';
import { crc32 } from '../../src/core/zip.ts';

export interface ZipInput {
  name: string;
  data: Uint8Array;
  /** 0 — без стиснення, 8 — deflate (за замовчуванням). */
  method?: 0 | 8;
  /** Розміри й CRC після даних (біт 3), а в локальному заголовку — нулі (так пишуть macOS і деякі програми). */
  dataDescriptor?: boolean;
  /** Позначити як зашифрований (біт 0) — для перевірки помилки. */
  encrypted?: boolean;
}

// 2026-01-01 00:00:00 у форматі DOS
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

export function writeZip(files: ZipInput[], comment = ''): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const method = file.method ?? 8;
    const body = method === 8 ? new Uint8Array(deflateRawSync(file.data)) : file.data;
    const crc = crc32(file.data);
    const flags = 0x0800 | (file.dataDescriptor ? 0x0008 : 0) | (file.encrypted ? 0x0001 : 0);

    const local = new Uint8Array(30 + name.length + body.length + (file.dataDescriptor ? 16 : 0));
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    if (!file.dataDescriptor) {
      lv.setUint32(14, crc, true);
      lv.setUint32(18, body.length, true);
      lv.setUint32(22, file.data.length, true);
    }
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    local.set(body, 30 + name.length);
    if (file.dataDescriptor) {
      const d = 30 + name.length + body.length;
      lv.setUint32(d, 0x08074b50, true);
      lv.setUint32(d + 4, crc, true);
      lv.setUint32(d + 8, body.length, true);
      lv.setUint32(d + 12, file.data.length, true);
    }

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, file.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }

  const commentBytes = encoder.encode(comment);
  const cdSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const eocd = new Uint8Array(22 + commentBytes.length);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, commentBytes.length, true);
  eocd.set(commentBytes, 22);

  const out = new Uint8Array(offset + cdSize + eocd.length);
  let p = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}
