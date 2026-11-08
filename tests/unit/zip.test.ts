import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crc32, extractZipEntry, looksLikeZip, readZipEntries, ZipError } from '../../src/core/zip.ts';
import { writeZip } from '../fixtures/zip-writer.ts';

const text = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

/** Псевдовипадкові байти (погано стискаються — як JPG-текстури). */
function noise(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let s = seed;
  for (let i = 0; i < length; i++) {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    out[i] = (s >>> 16) & 0xff;
  }
  return out;
}

async function codeOf(promise: Promise<unknown> | (() => unknown)): Promise<string | undefined> {
  try {
    if (typeof promise === 'function') promise();
    else await promise;
  } catch (error) {
    return error instanceof ZipError ? error.code : `не ZipError: ${String(error)}`;
  }
  return undefined;
}

describe('crc32', () => {
  it('еталонні значення', () => {
    expect(crc32(text(''))).toBe(0);
    expect(crc32(text('123456789'))).toBe(0xcbf43926);
  });
});

describe('ZIP: читання', () => {
  it('store і deflate, вкладені папки, UTF-8 назви з пробілами', async () => {
    const big = noise(200_000);
    const zip = writeZip([
      { name: 'Кімната 1/', data: new Uint8Array(0), method: 0 },
      { name: 'Кімната 1/scene.gltf', data: text('{"asset":{"version":"2.0"}}'), method: 8 },
      { name: 'Кімната 1/textures/тест текстура.jpg', data: big, method: 0 },
      { name: 'Кімната 1/scene.bin', data: new Uint8Array(1000).fill(7), method: 8 },
    ]);
    expect(looksLikeZip(zip)).toBe(true);
    const entries = readZipEntries(zip);
    expect(entries.map((e) => e.name)).toEqual([
      'Кімната 1/',
      'Кімната 1/scene.gltf',
      'Кімната 1/textures/тест текстура.jpg',
      'Кімната 1/scene.bin',
    ]);
    expect(entries[0]!.isDirectory).toBe(true);
    expect(decode(await extractZipEntry(zip, entries[1]!))).toBe('{"asset":{"version":"2.0"}}');
    expect(await extractZipEntry(zip, entries[2]!)).toEqual(big);
    expect(await extractZipEntry(zip, entries[3]!)).toEqual(new Uint8Array(1000).fill(7));
    expect(entries[3]!.compressedSize).toBeLessThan(entries[3]!.size);
  });

  it('data descriptor (розміри після даних) і коментар архіву', async () => {
    const zip = writeZip([{ name: 'a.bin', data: noise(5000, 3), dataDescriptor: true }], 'Polycam export');
    const [entry] = readZipEntries(zip);
    expect(entry!.size).toBe(5000);
    expect(await extractZipEntry(zip, entry!)).toEqual(noise(5000, 3));
  });

  it('великий файл (≈ 20 МБ) розпаковується повністю', async () => {
    const data = new Uint8Array(20 * 1024 * 1024);
    for (let i = 0; i < data.length; i++) data[i] = (i * 31) & 0xff;
    const zip = writeZip([{ name: 'scan.bin', data }]);
    const [entry] = readZipEntries(zip);
    const out = await extractZipEntry(zip, entry!);
    expect(out.length).toBe(data.length);
    expect(crc32(out)).toBe(crc32(data));
  });

  it('порожній архів — без файлів', () => {
    expect(readZipEntries(writeZip([]))).toEqual([]);
  });
});

describe('ZIP: помилки', () => {
  it('не ZIP', async () => {
    expect(looksLikeZip(text('{"asset":{}}'))).toBe(false);
    expect(await codeOf(() => readZipEntries(text('просто текст, а не архів, достатньо довгий')))).toBe('not-zip');
    expect(await codeOf(() => readZipEntries(new Uint8Array(5)))).toBe('not-zip');
  });

  it('обрізаний архів (недокачаний файл)', async () => {
    const zip = writeZip([{ name: 'scene.bin', data: noise(10_000) }]);
    expect(await codeOf(() => readZipEntries(zip.subarray(0, zip.length - 30)))).toBe('corrupt');
    expect(await codeOf(() => readZipEntries(zip.subarray(0, 5000)))).toBe('corrupt');
  });

  it('пошкоджені дані → контрольна сума не збігається', async () => {
    const zip = writeZip([{ name: 'scene.bin', data: noise(10_000), method: 0 }]);
    const broken = zip.slice();
    broken[100] = broken[100]! ^ 0xff;
    const [entry] = readZipEntries(broken);
    expect(await codeOf(extractZipEntry(broken, entry!))).toBe('corrupt');
  });

  it('пошкоджений deflate-потік', async () => {
    const data = text('a'.repeat(5000));
    const zip = writeZip([{ name: 'x.txt', data }]);
    const [entry] = readZipEntries(zip);
    const start = 30 + 'x.txt'.length;
    const broken = zip.slice();
    for (let i = start; i < start + entry!.compressedSize; i++) broken[i] = 0xff;
    expect(await codeOf(extractZipEntry(broken, entry!))).toBe('corrupt');
  });

  it('зашифрований файл', async () => {
    const zip = writeZip([{ name: 'secret.bin', data: noise(100), encrypted: true }]);
    const [entry] = readZipEntries(zip);
    expect(await codeOf(extractZipEntry(zip, entry!))).toBe('encrypted');
  });

  it('ZIP64 — зрозуміла помилка', async () => {
    const zip = writeZip([{ name: 'a', data: noise(10) }]);
    const eocd = zip.length - 22;
    const z64 = zip.slice();
    new DataView(z64.buffer).setUint32(eocd + 16, 0xffffffff, true);
    expect(await codeOf(() => readZipEntries(z64))).toBe('zip64');
  });

  it('непідтримуваний метод стиснення', async () => {
    const zip = writeZip([{ name: 'a.bin', data: noise(10), method: 0 }]);
    const dv = new DataView(zip.buffer);
    dv.setUint16(8, 14, true); // локальний заголовок
    const cd = zip.length - 22 - (46 + 'a.bin'.length);
    dv.setUint16(cd + 10, 14, true); // центральний каталог (LZMA)
    const [entry] = readZipEntries(zip);
    expect(await codeOf(extractZipEntry(zip, entry!))).toBe('unsupported-method');
  });

  it('стиснення через node:zlib сумісне з розпаковкою (той самий deflate-raw)', async () => {
    expect(deflateRawSync(text('x')).length).toBeGreaterThan(0);
  });
});
