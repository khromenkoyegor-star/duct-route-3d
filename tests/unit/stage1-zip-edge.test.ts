/**
 * Етап 1 (від tester): ZIP-архіви «з життя», яких немає в zip.test.ts.
 * Як пишуть архіви macOS («Стиснути»), iOS «Файли», Windows, Info-ZIP, Java:
 * додаткові поля (extra) у локальному заголовку, коментарі, data descriptor без підпису,
 * порожні файли, неправильна кількість записів тощо.
 */
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crc32, extractZipEntry, readZipEntries, ZipError } from '../../src/core/zip.ts';
import { lcg } from '../fixtures/gltf-builder.ts';
import { writeZip } from '../fixtures/zip-writer.ts';

const enc = new TextEncoder();
const text = (s: string) => enc.encode(s);
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

function noise(length: number, seed = 7): Uint8Array {
  const rnd = lcg(seed);
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (rnd() * 256) | 0;
  return out;
}

interface RawEntry {
  name: string;
  data: Uint8Array;
  method?: 0 | 8;
  /** Додаткове поле лише в локальному заголовку (macOS/Info-ZIP пишуть різні extra тут і в каталозі). */
  localExtra?: Uint8Array;
  centralExtra?: Uint8Array;
  fileComment?: string;
  /** Data descriptor: true — з підписом 0x08074b50, 'nosig' — без підпису (дозволено специфікацією). */
  descriptor?: boolean | 'nosig';
  /** Підмінити стиснуті байти (наприклад, порожній deflate). */
  body?: Uint8Array;
}

/** Ручний запис ZIP з можливостями, яких немає в tests/fixtures/zip-writer.ts. */
function rawZip(entries: RawEntry[], options: { comment?: Uint8Array; prefix?: Uint8Array; countOverride?: number } = {}) {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = options.prefix?.length ?? 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const method = e.method ?? 8;
    const body = e.body ?? (method === 8 ? new Uint8Array(deflateRawSync(e.data)) : e.data);
    const crc = crc32(e.data);
    const flags = 0x0800 | (e.descriptor ? 0x0008 : 0);
    const lx = e.localExtra ?? new Uint8Array(0);
    const cx = e.centralExtra ?? new Uint8Array(0);
    const fc = enc.encode(e.fileComment ?? '');
    const descLen = e.descriptor === true ? 16 : e.descriptor === 'nosig' ? 12 : 0;
    const local = new Uint8Array(30 + name.length + lx.length + body.length + descLen);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, method, true);
    if (!e.descriptor) {
      lv.setUint32(14, crc, true);
      lv.setUint32(18, body.length, true);
      lv.setUint32(22, e.data.length, true);
    }
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, lx.length, true);
    local.set(name, 30);
    local.set(lx, 30 + name.length);
    local.set(body, 30 + name.length + lx.length);
    let d = 30 + name.length + lx.length + body.length;
    if (e.descriptor === true) {
      lv.setUint32(d, 0x08074b50, true);
      d += 4;
    }
    if (e.descriptor) {
      lv.setUint32(d, crc, true);
      lv.setUint32(d + 4, body.length, true);
      lv.setUint32(d + 8, e.data.length, true);
    }
    const central = new Uint8Array(46 + name.length + cx.length + fc.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 0x031e, true); // «зроблено в Unix»
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, cx.length, true);
    cv.setUint16(32, fc.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    central.set(cx, 46 + name.length);
    central.set(fc, 46 + name.length + cx.length);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const comment = options.comment ?? new Uint8Array(0);
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22 + comment.length);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  const count = options.countOverride ?? entries.length;
  ev.setUint16(8, count, true);
  ev.setUint16(10, count, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, comment.length, true);
  eocd.set(comment, 22);
  const all = [...(options.prefix ? [options.prefix] : []), ...locals, ...centrals, eocd];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let p = 0;
  for (const part of all) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

/** Extra-поле «UT» (час) + «ux» (власник), як пише macOS / Info-ZIP. */
function macExtra(): Uint8Array {
  const out = new Uint8Array(9 + 15);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, 0x5455, true);
  dv.setUint16(2, 5, true);
  out[4] = 1;
  dv.setUint32(5, 1_700_000_000, true);
  dv.setUint16(9, 0x7875, true);
  dv.setUint16(11, 11, true);
  out[13] = 1;
  out[14] = 4;
  dv.setUint32(15, 501, true);
  out[19] = 4;
  dv.setUint32(20, 20, true);
  return out;
}

async function codeOf(run: () => unknown): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    return error instanceof ZipError ? error.code : `не ZipError: ${String(error)}`;
  }
  return undefined;
}

describe('ZIP «з життя»: читається правильно', () => {
  it('macOS «Стиснути»: різні extra-поля в локальному заголовку й каталозі, data descriptor', async () => {
    const gltf = text('{"asset":{"version":"2.0"}}');
    const bin = noise(70_000);
    const zip = rawZip([
      { name: 'Scan/', data: new Uint8Array(0), method: 0, localExtra: macExtra(), centralExtra: macExtra().subarray(0, 9) },
      { name: 'Scan/scene.gltf', data: gltf, localExtra: macExtra(), centralExtra: macExtra().subarray(0, 9), descriptor: true },
      { name: 'Scan/scene.bin', data: bin, localExtra: macExtra(), descriptor: true },
      { name: '__MACOSX/Scan/._scene.gltf', data: noise(120), localExtra: macExtra() },
    ]);
    const entries = readZipEntries(zip);
    expect(entries.map((e) => e.name)).toEqual(['Scan/', 'Scan/scene.gltf', 'Scan/scene.bin', '__MACOSX/Scan/._scene.gltf']);
    expect(decode(await extractZipEntry(zip, entries[1]!))).toBe('{"asset":{"version":"2.0"}}');
    expect(await extractZipEntry(zip, entries[2]!)).toEqual(bin);
  });

  it('data descriptor без підпису (дозволено специфікацією)', async () => {
    const data = noise(3000, 9);
    const zip = rawZip([
      { name: 'a.bin', data, descriptor: 'nosig' },
      { name: 'b.bin', data: text('hello'), descriptor: 'nosig' },
    ]);
    const [a, b] = readZipEntries(zip);
    expect(await extractZipEntry(zip, a!)).toEqual(data);
    expect(decode(await extractZipEntry(zip, b!))).toBe('hello');
  });

  it('коментарі до файлів у каталозі не збивають читання наступних записів', async () => {
    const zip = rawZip([
      { name: 'one.txt', data: text('1'), fileComment: 'перший файл', centralExtra: macExtra() },
      { name: 'two.txt', data: text('22'), fileComment: 'другий' },
    ]);
    const entries = readZipEntries(zip);
    expect(entries.map((e) => e.name)).toEqual(['one.txt', 'two.txt']);
    expect(decode(await extractZipEntry(zip, entries[1]!))).toBe('22');
  });

  it('порожні файли: store і deflate (Java/Windows пишуть порожній deflate-блок)', async () => {
    const zip = rawZip([
      { name: 'empty-store.txt', data: new Uint8Array(0), method: 0 },
      { name: 'empty-deflate.txt', data: new Uint8Array(0), method: 8 },
    ]);
    const entries = readZipEntries(zip);
    for (const entry of entries) {
      expect(entry.size, entry.name).toBe(0);
      expect((await extractZipEntry(zip, entry)).byteLength, entry.name).toBe(0);
    }
  });

  it('архів із даними перед ним (наприклад, самостійно розпаковуваний) — зсуви з каталогу правильні', async () => {
    // Наш zip без префікса, але каталог вказує правильні зсуви з урахуванням префікса.
    const prefix = new Uint8Array(512).fill(0x90);
    const zip = rawZip([{ name: 'scene.gltf', data: text('{"a":1}') }], { prefix });
    const [entry] = readZipEntries(zip);
    expect(decode(await extractZipEntry(zip, entry!))).toBe('{"a":1}');
  });

  it('коментар архіву довжиною до 65 535 байт', async () => {
    const comment = new Uint8Array(65_535).fill(0x41);
    const zip = rawZip([{ name: 'x.txt', data: text('ok') }], { comment });
    const [entry] = readZipEntries(zip);
    expect(decode(await extractZipEntry(zip, entry!))).toBe('ok');
  });

  it('коментар архіву, у якому трапляються байти «PK\\x05\\x06» (підпис кінця каталогу)', async () => {
    // Наприклад, коментар містить інший zip або випадкові бінарні дані.
    const comment = new Uint8Array(40);
    comment.set([0x50, 0x4b, 0x05, 0x06], 4);
    const zip = rawZip([{ name: 'scene.gltf', data: text('{"asset":{}}') }], { comment });
    const entries = readZipEntries(zip);
    expect(entries.map((e) => e.name)).toEqual(['scene.gltf']);
    expect(decode(await extractZipEntry(zip, entries[0]!))).toBe('{"asset":{}}');
  });

  it('великий архів ≈ 40 МБ (як найбільший скан Єгора): усі файли цілі, CRC збігається', async () => {
    const bin = new Uint8Array(28 * 1024 * 1024);
    const rnd = lcg(5);
    // Схоже на float32-координати: старші байти повторюються, молодші — шум.
    for (let i = 0; i < bin.length; i++) bin[i] = i % 4 === 3 ? 0x3f : (rnd() * 256) | 0;
    const tex = noise(12 * 1024 * 1024, 11);
    const zip = writeZip([
      { name: 'Big Scan/scene.gltf', data: text('{"asset":{"version":"2.0"}}') },
      { name: 'Big Scan/scene.bin', data: bin, dataDescriptor: true },
      { name: 'Big Scan/textures/texture 0.jpg', data: tex, method: 0 },
    ]);
    expect(zip.length).toBeGreaterThan(30 * 1024 * 1024);
    const entries = readZipEntries(zip);
    const t0 = performance.now();
    const outBin = await extractZipEntry(zip, entries[1]!);
    const outTex = await extractZipEntry(zip, entries[2]!);
    const ms = performance.now() - t0;
    expect(outBin.length).toBe(bin.length);
    expect(crc32(outBin)).toBe(crc32(bin));
    expect(crc32(outTex)).toBe(crc32(tex));
    // Не жорсткий поріг — лише щоб помітити катастрофічне сповільнення.
    expect(ms).toBeLessThan(20_000);
  }, 60_000);
});

describe('ZIP «з життя»: пошкоджені архіви → зрозуміла помилка (ZipError), а не виліт', () => {
  it('у кінці каталогу вказано більше файлів, ніж є', async () => {
    const zip = rawZip([{ name: 'a.txt', data: text('a') }], { countOverride: 3 });
    expect(await codeOf(() => readZipEntries(zip))).toBe('corrupt');
  });

  it('зсув каталогу вказує за межі файлу', async () => {
    const zip = writeZip([{ name: 'a.txt', data: text('abc') }]);
    const broken = zip.slice();
    new DataView(broken.buffer).setUint32(broken.length - 22 + 16, broken.length + 100, true);
    expect(await codeOf(() => readZipEntries(broken))).toBe('corrupt');
  });

  it('зсув локального заголовка вказує в нікуди', async () => {
    const zip = writeZip([{ name: 'a.txt', data: text('abc') }]);
    const [entry] = readZipEntries(zip);
    expect(await codeOf(() => extractZipEntry(zip, { ...entry!, localHeaderOffset: zip.length - 10 }))).toBe('corrupt');
    expect(await codeOf(() => extractZipEntry(zip, { ...entry!, localHeaderOffset: 7 }))).toBe('corrupt');
  });

  it('стиснутий розмір більший за файл (обрізані дані)', async () => {
    const zip = writeZip([{ name: 'a.bin', data: noise(1000) }]);
    const [entry] = readZipEntries(zip);
    expect(await codeOf(() => extractZipEntry(zip, { ...entry!, compressedSize: zip.length * 2 }))).toBe('corrupt');
  });

  it('розмір у каталозі не збігається з фактичним (store)', async () => {
    const zip = writeZip([{ name: 'a.bin', data: noise(1000), method: 0 }]);
    const [entry] = readZipEntries(zip);
    expect(await codeOf(() => extractZipEntry(zip, { ...entry!, size: 999 }))).toBe('corrupt');
  });

  it('обрізаний deflate-потік (недокачаний файл усередині архіву)', async () => {
    const data = noise(50_000, 3);
    const zip = writeZip([{ name: 'a.bin', data }]);
    const [entry] = readZipEntries(zip);
    expect(await codeOf(() => extractZipEntry(zip, { ...entry!, compressedSize: entry!.compressedSize - 1000 }))).toBe(
      'corrupt',
    );
  });

  it('випадкові байти з підписом ZIP на початку', async () => {
    const junk = noise(10_000, 99);
    junk.set([0x50, 0x4b, 0x03, 0x04], 0);
    const code = await codeOf(() => readZipEntries(junk));
    expect(['corrupt', 'not-zip']).toContain(code);
  });

  it('усі можливі обрізання маленького архіву: або ZipError, або правильні дані — ніколи інша помилка', async () => {
    const zip = writeZip([
      { name: 'Room/scene.gltf', data: text('{"asset":{"version":"2.0"}}') },
      { name: 'Room/scene.bin', data: noise(300), method: 0 },
    ]);
    for (let cut = 0; cut < zip.length; cut++) {
      const part = zip.subarray(0, cut);
      let entries;
      try {
        entries = readZipEntries(part);
      } catch (error) {
        expect(error, `обрізано до ${cut}`).toBeInstanceOf(ZipError);
        continue;
      }
      for (const entry of entries) {
        try {
          await extractZipEntry(part, entry);
        } catch (error) {
          expect(error, `обрізано до ${cut}, ${entry.name}`).toBeInstanceOf(ZipError);
        }
      }
    }
  });

  it('пошкодження кожного байта каталогу: тільки ZipError або коректний результат', async () => {
    const zip = writeZip([
      { name: 'Room/scene.gltf', data: text('{"asset":{"version":"2.0"}}') },
      { name: 'Room/scene.bin', data: noise(300), method: 0 },
    ]);
    const cdStart = new DataView(zip.buffer).getUint32(zip.length - 22 + 16, true);
    for (let i = cdStart; i < zip.length; i++) {
      for (const value of [0x00, 0xff]) {
        const broken = zip.slice();
        broken[i] = value;
        try {
          for (const entry of readZipEntries(broken)) {
            try {
              await extractZipEntry(broken, entry);
            } catch (error) {
              expect(error, `байт ${i} = ${value}`).toBeInstanceOf(ZipError);
            }
          }
        } catch (error) {
          expect(error, `байт ${i} = ${value}`).toBeInstanceOf(ZipError);
        }
      }
    }
  });
});
