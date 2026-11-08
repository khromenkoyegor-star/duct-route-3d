/**
 * Етап 1 (від tester): відкриття скану (src/scene/scan-loader.ts) без браузера.
 * Файли подаємо так само, як їх дає «Файли» на iPad/iPhone: { name, size, arrayBuffer() }.
 *
 * Декодування картинок у Node немає, тому createImageBitmap і canvas — заглушки:
 * «картинка» знає лише свій розмір із заголовка PNG і чи її закрили (close()).
 * Перевіряємо: габарит (±0,1 мм), трикутники, дивні й пошкоджені архіви, зменшення текстур,
 * звільнення пам'яті (dispose), тимчасові адреси blob: прибрано.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Box3, type BufferGeometry, type Material, type Mesh, type Object3D, type Texture } from 'three';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  boxRoom,
  buildGlb,
  buildGltf,
  heavyRoomMesh,
  makePng,
  pngSize,
  quad,
  quatY,
  toGlb,
  type GltfInput,
  type MeshInput,
} from '../fixtures/gltf-builder.ts';
import { ROOM_SIZE_MM } from '../fixtures/room.ts';
import { writeZip, type ZipInput } from '../fixtures/zip-writer.ts';

type LoaderModule = typeof import('../../src/scene/scan-loader.ts');
let loadScan: LoaderModule['loadScan'];
let ScanLoadError: LoaderModule['ScanLoadError'];

/** ±0,1 мм у метрах. */
const TOL_M = 0.0001;
const enc = new TextEncoder();

// ───────────── заглушки браузера ─────────────

class FakeBitmap {
  closed = false;
  constructor(
    public width: number,
    public height: number,
    public from: 'file' | 'canvas',
  ) {}
  close() {
    // Як у справжнього ImageBitmap: після close() розміри стають 0.
    this.closed = true;
    this.width = 0;
    this.height = 0;
  }
}

class FakeCanvas {
  isFakeCanvas = true;
  width = 0;
  height = 0;
  draws: unknown[] = [];
  getContext() {
    return {
      imageSmoothingEnabled: false,
      imageSmoothingQuality: 'low',
      drawImage: (image: unknown) => {
        if (image instanceof FakeBitmap && image.closed) throw new Error('drawImage: картинку вже закрито');
        this.draws.push(image);
      },
    };
  }
}

const bitmaps: FakeBitmap[] = [];
const liveUrls = new Set<string>();

beforeAll(async () => {
  vi.stubGlobal('self', globalThis);
  // FileLoader (three.js) повідомляє про хід завантаження через ProgressEvent — у Node його немає.
  vi.stubGlobal(
    'ProgressEvent',
    class extends Event {
      constructor(type: string, init: Record<string, unknown> = {}) {
        super(type);
        Object.assign(this, init);
      }
    },
  );
  vi.stubGlobal('createImageBitmap', async (source: unknown) => {
    if (source instanceof Blob) {
      const size = pngSize(new Uint8Array(await source.arrayBuffer()));
      if (!size) throw new Error('не вдалося декодувати картинку');
      const b = new FakeBitmap(size.width, size.height, 'file');
      bitmaps.push(b);
      return b;
    }
    if (source instanceof FakeCanvas) {
      const b = new FakeBitmap(source.width, source.height, 'canvas');
      bitmaps.push(b);
      return b;
    }
    throw new Error('createImageBitmap: невідоме джерело');
  });
  vi.stubGlobal('document', { createElement: () => new FakeCanvas() });
  const create = URL.createObjectURL.bind(URL);
  const revoke = URL.revokeObjectURL.bind(URL);
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob | MediaSource) => {
    const url = create(blob as Blob);
    liveUrls.add(url);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
    liveUrls.delete(url);
    revoke(url);
  });
  ({ loadScan, ScanLoadError } = await import('../../src/scene/scan-loader.ts'));
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  bitmaps.length = 0;
});

// ───────────── допоміжне ─────────────

const file = (name: string, bytes: Uint8Array) => ({
  name,
  size: bytes.byteLength,
  arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
});

const TABLET = { maxTextureSide: 8192 };
const PHONE = { maxTextureSide: 4096 };

async function errorOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('очікувалась помилка, а скан відкрився');
}

/** Помилка має бути зрозумілою людині (ScanLoadError), а не технічною. */
async function expectScanError(promise: Promise<unknown>, message?: RegExp): Promise<void> {
  const error = await errorOf(promise);
  expect(error, String(error)).toBeInstanceOf(ScanLoadError);
  if (message) expect(error.message).toMatch(message);
}

function meshesOf(root: Object3D): Mesh[] {
  const out: Mesh[] = [];
  root.traverse((o) => {
    if ((o as Mesh).isMesh) out.push(o as Mesh);
  });
  return out;
}

function texturesOf(root: Object3D): Texture[] {
  const out = new Set<Texture>();
  for (const mesh of meshesOf(root)) {
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      for (const value of Object.values(m)) if (value && (value as Texture).isTexture) out.add(value as Texture);
    }
  }
  return [...out];
}

/** Точний габарит за вершинами (м) — еталон для перевірки. */
function exactBox(root: Object3D): Box3 {
  root.updateMatrixWorld(true);
  return new Box3().setFromObject(root, true);
}

function expectStatsBox(stats: { min: readonly number[]; max: readonly number[] }, min: number[], max: number[]) {
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(stats.min[i]! - min[i]!), `min[${i}] = ${stats.min[i]}, очікувалось ${min[i]}`).toBeLessThan(TOL_M);
    expect(Math.abs(stats.max[i]! - max[i]!), `max[${i}] = ${stats.max[i]}, очікувалось ${max[i]}`).toBeLessThan(TOL_M);
  }
}

/** glTF + .bin (+ картинки) у ZIP, як експортує Polycam. */
function gltfZip(
  folder: string,
  json: Record<string, unknown> & { buffers: Array<{ byteLength: number; uri?: string }> },
  bin: Uint8Array,
  extra: ZipInput[] = [],
  names: { gltf?: string; bin?: string } = {},
): Uint8Array {
  const gltfName = names.gltf ?? 'scene.gltf';
  const binName = names.bin ?? 'scene.bin';
  json.buffers[0] = { byteLength: bin.byteLength, uri: binName };
  const prefix = folder ? `${folder}/` : '';
  return writeZip([
    ...(folder ? [{ name: prefix, data: new Uint8Array(0), method: 0 as const }] : []),
    { name: `${prefix}${gltfName}`, data: enc.encode(JSON.stringify(json)) },
    { name: `${prefix}${binName}`, data: bin, dataDescriptor: true },
    ...extra,
  ]);
}

const ROOM_MIN = [-2, 0, -1.5];
const ROOM_MAX = [2, 2.7, 1.5];
const room = () => boxRoom([-2, 0, -1.5], [2, 2.7, 1.5]);

/** Матеріал з однією текстурою кольору. */
function texturedInput(meshes: MeshInput[], uris: string[]): GltfInput & { materials: object[]; textures: object[] } {
  return {
    meshes: meshes.map((m) => ({ ...m, material: 0, uvs: m.uvs ?? new Float32Array((m.positions.length / 3) * 2) })),
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0 } }],
    textures: uris.map((_, i) => ({ source: i })),
    images: uris.map((uri) => ({ uri })),
  };
}

// ───────────── тести ─────────────

describe('тестова кімната (файли з репозиторію)', () => {
  const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

  for (const name of ['room-4000x2700x3000.zip', 'room-4000x2700x3000.glb']) {
    it(`${name}: габарит 4000 × 2700 × 3000 мм (±0,1 мм), 12 трикутників, розмір файлу`, async () => {
      const bytes = new Uint8Array(await readFile(fixture(name)));
      const scan = await loadScan([file(name, bytes)], TABLET);
      expectStatsBox(scan.stats, ROOM_MIN, ROOM_MAX);
      expect((scan.stats.max[0] - scan.stats.min[0]) * 1000).toBeCloseTo(ROOM_SIZE_MM.x, 1);
      expect(scan.stats.triangles).toBe(12);
      expect(scan.stats.fileBytes).toBe(bytes.byteLength);
      expect(scan.name).toBe(name);
      scan.dispose();
    });
  }

  it('ZIP: текстура підлоги знайдена (папка з пробілом, %20 у назві), блоб-адреси прибрано', async () => {
    const bytes = new Uint8Array(await readFile(fixture('room-4000x2700x3000.zip')));
    const scan = await loadScan([file('room.zip', bytes)], TABLET);
    expect(scan.stats.textures).toBe(1);
    expect(scan.stats.texturePixels).toBe(64 * 64);
    expect(liveUrls.size, 'усі тимчасові blob: адреси звільнено').toBe(0);
    scan.dispose();
  });
});

describe('звільнення пам\'яті (dispose)', () => {
  it('після dispose(): кожна геометрія, матеріал і текстура звільнені, картинки закрито', async () => {
    const { json, bin } = buildGltf(texturedInput([room(), quad([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], 'q')], ['a.png', 'b.png']));
    const zip = gltfZip('Scan', json, bin, [
      { name: 'Scan/a.png', data: makePng(64, 64), method: 0 },
      { name: 'Scan/b.png', data: makePng(32, 16), method: 0 },
    ]);
    const scan = await loadScan([file('scan.zip', zip)], TABLET);
    const disposed = new Set<unknown>();
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();
    for (const mesh of meshesOf(scan.root)) {
      geometries.add(mesh.geometry);
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(m);
    }
    const textures = texturesOf(scan.root);
    expect(textures.length).toBeGreaterThan(0);
    for (const item of [...geometries, ...materials, ...textures]) {
      item.addEventListener('dispose', () => disposed.add(item));
    }
    const images = textures.map((t) => t.image as FakeBitmap);
    scan.dispose();
    for (const item of [...geometries, ...materials, ...textures]) {
      expect(disposed.has(item), `${item.constructor.name} не звільнено`).toBe(true);
    }
    for (const image of images) expect(image.closed, 'картинку текстури не закрито (close)').toBe(true);
    expect(scan.root.parent).toBeNull();
    expect(scan.root.children).toHaveLength(0);
  });

  it('невикористані текстури (нормалі, шорсткість) звільняються одразу, бо скан показуємо без освітлення', async () => {
    const input = texturedInput([room()], ['color.png', 'normal.png']);
    input.materials = [
      {
        pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
        normalTexture: { index: 1 },
      },
    ];
    const { json, bin } = buildGltf(input);
    const zip = gltfZip('', json, bin, [
      { name: 'color.png', data: makePng(64, 64), method: 0 },
      { name: 'normal.png', data: makePng(64, 32), method: 0 },
    ]);
    const scan = await loadScan([file('scan.zip', zip)], TABLET);
    const normal = bitmaps.find((b) => b.from === 'file' && b.closed);
    expect(normal, 'картинку нормалей закрито').toBeDefined();
    const color = (texturesOf(scan.root)[0]!.image as FakeBitmap);
    expect(color.closed).toBe(false);
    expect(color.width).toBe(64);
    scan.dispose();
  });

  it('одна картинка для кольору й нормалей (різні семплери) — колір не зіпсовано', async () => {
    // Буває в експортах, де одна текстура використовується двічі з різними налаштуваннями.
    const input = texturedInput([room()], ['atlas.png']);
    input.textures = [
      { source: 0, sampler: 0 },
      { source: 0, sampler: 1 },
    ];
    input.samplers = [
      { magFilter: 9729, minFilter: 9987 },
      { magFilter: 9728, minFilter: 9728 },
    ];
    input.materials = [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, normalTexture: { index: 1 } }];
    const { json, bin } = buildGltf(input);
    const zip = gltfZip('', json, bin, [{ name: 'atlas.png', data: makePng(64, 64), method: 0 }]);
    const scan = await loadScan([file('scan.zip', zip)], TABLET);
    const map = texturesOf(scan.root)[0]!;
    const image = map.image as FakeBitmap;
    expect(image.closed, 'картинку, яку ще показує скан, закрито → текстура буде чорною / помилка WebGL').toBe(false);
    expect(scan.stats.texturePixels).toBe(64 * 64);
    scan.dispose();
  });
});

describe('зменшення великих текстур (пам\'ять iPhone)', () => {
  async function loadWithTextures(sizes: Array<[number, number]>, options: { maxTextureSide: number }) {
    const uris = sizes.map((_, i) => `textures/tex ${i}.png`);
    const quads = sizes.map((_, i) => quad([[i, 0, 0], [i + 1, 0, 0], [i + 1, 1, 0], [i, 1, 0]], `q${i}`));
    const input = texturedInput(quads, uris.map(encodeURI));
    input.meshes = input.meshes.map((m, i) => ({ ...m, material: i }));
    input.materials = sizes.map((_, i) => ({ pbrMetallicRoughness: { baseColorTexture: { index: i } } }));
    const { json, bin } = buildGltf(input);
    const zip = gltfZip(
      'Scan',
      json,
      bin,
      sizes.map(([w, h], i) => ({ name: `Scan/${uris[i]}`, data: makePng(w, h), method: 0 as const })),
    );
    return loadScan([file('scan.zip', zip)], options);
  }

  it('iPhone (4096): 5000 × 100 і 4200 × 4200 зменшено, 4096 × 64 і 300 × 300 — ні', async () => {
    const scan = await loadWithTextures(
      [
        [5000, 100],
        [4200, 4200],
        [4096, 64],
        [300, 300],
      ],
      PHONE,
    );
    expect(scan.stats.texturesReduced).toBe(2);
    const sizes = texturesOf(scan.root)
      .map((t) => [(t.image as FakeBitmap).width, (t.image as FakeBitmap).height])
      .sort((a, b) => b[0]! * b[1]! - a[0]! * a[1]!);
    for (const [w, h] of sizes) expect(Math.max(w!, h!)).toBeLessThanOrEqual(4096);
    expect(sizes).toContainEqual([4096, 4096]);
    expect(sizes).toContainEqual([4096, 82]); // пропорції збережено
    expect(sizes).toContainEqual([300, 300]);
    // Великі оригінали закрито — пам'ять звільнено одразу.
    const originals = bitmaps.filter((b) => b.from === 'file');
    expect(originals.filter((b) => b.closed)).toHaveLength(2);
    expect(scan.stats.texturePixels).toBe(4096 * 4096 + 4096 * 82 + 4096 * 64 + 300 * 300);
    scan.dispose();
    expect(bitmaps.every((b) => b.closed), 'після dispose усі картинки закрито').toBe(true);
  });

  it('iPad (8192): 9000 × 50 зменшено до 8192, 8192 × 100 — ні', async () => {
    const scan = await loadWithTextures(
      [
        [9000, 50],
        [8192, 100],
      ],
      TABLET,
    );
    expect(scan.stats.texturesReduced).toBe(1);
    for (const t of texturesOf(scan.root)) expect((t.image as FakeBitmap).width).toBeLessThanOrEqual(8192);
    scan.dispose();
  });

  it('межа зменшення не змінює геометрію: габарит той самий', async () => {
    const scan = await loadWithTextures([[6000, 6000]], PHONE);
    expectStatsBox(scan.stats, [0, 0, 0], [1, 1, 0]);
    scan.dispose();
  });
});

describe('дивні архіви й файли', () => {
  const roomGltf = () => buildGltf({ meshes: [room()] });

  it('вкладені папки й відносні шляхи («data/scene.bin», «../shared/…»)', async () => {
    const input = texturedInput([room()], ['../shared/tex%201.png']);
    const { json, bin } = buildGltf(input);
    json.buffers[0] = { byteLength: bin.byteLength, uri: 'data/scene.bin' };
    const zip = writeZip([
      { name: 'Export/Room 1/scene.gltf', data: enc.encode(JSON.stringify(json)) },
      { name: 'Export/Room 1/data/scene.bin', data: bin },
      { name: 'Export/shared/tex 1.png', data: makePng(16, 16), method: 0 },
    ]);
    const scan = await loadScan([file('export.zip', zip)], TABLET);
    expectStatsBox(scan.stats, ROOM_MIN, ROOM_MAX);
    expect(scan.stats.textures).toBe(1);
    scan.dispose();
  });

  it('%-кодування в URI: пробіли, кирилиця, літера «%» у назві файлу', async () => {
    const names = ['Текстура 1.png', '100%.png', 'a b+c.png'];
    const quads = names.map((_, i) => quad([[i, 0, 0], [i + 1, 0, 0], [i + 1, 1, 0], [i, 1, 0]]));
    const input = texturedInput(quads, names.map((n) => encodeURIComponent(n)));
    input.meshes = input.meshes.map((m, i) => ({ ...m, material: i }));
    input.materials = names.map((_, i) => ({ pbrMetallicRoughness: { baseColorTexture: { index: i } } }));
    const { json, bin } = buildGltf(input);
    const zip = gltfZip('Скан', json, bin, names.map((n) => ({ name: `Скан/${n}`, data: makePng(8, 8), method: 0 as const })));
    const scan = await loadScan([file('скан.zip', zip)], TABLET);
    expect(scan.stats.textures).toBe(3);
    scan.dispose();
  });

  it('URI з пробілом без кодування («floor tile.png») теж знаходиться', async () => {
    const { json, bin } = buildGltf(texturedInput([room()], ['floor tile.png']));
    const zip = gltfZip('', json, bin, [{ name: 'floor tile.png', data: makePng(8, 8), method: 0 }]);
    const scan = await loadScan([file('scan.zip', zip)], TABLET);
    expect(scan.stats.textures).toBe(1);
    scan.dispose();
  });

  it('назви в архіві з «./» на початку (так пишуть деякі програми архівації)', async () => {
    const { json, bin } = roomGltf();
    json.buffers[0] = { byteLength: bin.byteLength, uri: 'scene.bin' };
    const zip = writeZip([
      { name: './scene.gltf', data: enc.encode(JSON.stringify(json)) },
      { name: './scene.bin', data: bin },
    ]);
    const scan = await loadScan([file('scan.zip', zip)], TABLET);
    expectStatsBox(scan.stats, ROOM_MIN, ROOM_MAX);
    scan.dispose();
  });

  it('шляхи зі зворотною косою рискою (архів з Windows)', async () => {
    const { json, bin } = roomGltf();
    json.buffers[0] = { byteLength: bin.byteLength, uri: 'scene.bin' };
    const zip = writeZip([
      { name: 'Room\\scene.gltf', data: enc.encode(JSON.stringify(json)) },
      { name: 'Room\\scene.bin', data: bin },
    ]);
    const scan = await loadScan([file('scan.zip', zip)], TABLET);
    expectStatsBox(scan.stats, ROOM_MIN, ROOM_MAX);
    scan.dispose();
  });

  it('великі літери в розширеннях (SCENE.GLTF, Scene.BIN)', async () => {
    const { json, bin } = roomGltf();
    const zip = gltfZip('Room', json, bin, [], { gltf: 'SCENE.GLTF', bin: 'Scene.BIN' });
    const scan = await loadScan([file('SCAN.ZIP', zip)], TABLET);
    expectStatsBox(scan.stats, ROOM_MIN, ROOM_MAX);
    scan.dispose();
  });

  it('кілька моделей в архіві: береться найменш вкладена, без помилки', async () => {
    const small = buildGlb({ meshes: [boxRoom([0, 0, 0], [0.1, 0.1, 0.1])] });
    const { json, bin } = roomGltf();
    const zip = gltfZip('', json, bin, [
      { name: 'preview/thumb.glb', data: small },
      { name: '__MACOSX/._scene.gltf', data: new Uint8Array([0, 5, 22, 7]) },
    ]);
    const scan = await loadScan([file('scan.zip', zip)], TABLET);
    expectStatsBox(scan.stats, ROOM_MIN, ROOM_MAX);
    scan.dispose();
  });

  it('GLB усередині ZIP', async () => {
    const zip = writeZip([{ name: 'Scan/scan.glb', data: buildGlb({ meshes: [room()] }) }]);
    const scan = await loadScan([file('scan.zip', zip)], TABLET);
    expectStatsBox(scan.stats, ROOM_MIN, ROOM_MAX);
    scan.dispose();
  });

  it('файли без розширення: GLB «scan», glTF «scene» (вбудовані дані), ZIP «Polycam export»', async () => {
    const glb = await loadScan([file('scan', buildGlb({ meshes: [room()] }))], TABLET);
    expectStatsBox(glb.stats, ROOM_MIN, ROOM_MAX);
    glb.dispose();

    const { json, bin } = roomGltf();
    json.buffers[0] = { byteLength: bin.byteLength, uri: `data:application/octet-stream;base64,${Buffer.from(bin).toString('base64')}` };
    const gltf = await loadScan([file('scene', enc.encode(JSON.stringify(json)))], TABLET);
    expectStatsBox(gltf.stats, ROOM_MIN, ROOM_MAX);
    gltf.dispose();

    const { json: j2, bin: b2 } = roomGltf();
    const zip = await loadScan([file('Polycam export', gltfZip('Room', j2, b2))], TABLET);
    expectStatsBox(zip.stats, ROOM_MIN, ROOM_MAX);
    zip.dispose();
  });

  it('модель без розширення всередині ZIP — зрозуміла помилка, не виліт', async () => {
    const { json, bin } = roomGltf();
    const zip = gltfZip('', json, bin, [], { gltf: 'scene' });
    await expectScanError(loadScan([file('scan.zip', zip)], TABLET));
  });

  it('порожній архів', async () => {
    await expectScanError(loadScan([file('empty.zip', writeZip([]))], TABLET), /немає 3D-моделі/);
  });

  it('архів лише зі службовими файлами macOS', async () => {
    const zip = writeZip([
      { name: '__MACOSX/', data: new Uint8Array(0), method: 0 },
      { name: '__MACOSX/Scan/._scene.gltf', data: new Uint8Array([0, 5, 22, 7]) },
      { name: 'Scan/.DS_Store', data: new Uint8Array(8) },
    ]);
    await expectScanError(loadScan([file('scan.zip', zip)], TABLET), /немає 3D-моделі/);
  });

  it('файл нульового розміру (.zip, .glb, .gltf)', async () => {
    for (const name of ['scan.zip', 'scan.glb', 'scene.gltf', 'scan']) {
      await expectScanError(loadScan([file(name, new Uint8Array(0))], TABLET));
    }
  });

  it('у ZIP: .gltf нульового розміру', async () => {
    const { bin } = roomGltf();
    const zip = writeZip([
      { name: 'scene.gltf', data: new Uint8Array(0) },
      { name: 'scene.bin', data: bin },
    ]);
    await expectScanError(loadScan([file('scan.zip', zip)], TABLET));
  });

  it('у ZIP: .bin нульового розміру або коротший, ніж треба', async () => {
    for (const cut of [0, 10]) {
      const { json, bin } = roomGltf();
      // byteLength у JSON — справжній, а файл .bin обрізаний.
      const zip = writeZip([
        { name: 'scene.gltf', data: enc.encode(JSON.stringify({ ...json, buffers: [{ byteLength: bin.byteLength, uri: 'scene.bin' }] })) },
        { name: 'scene.bin', data: bin.subarray(0, cut) },
      ]);
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expectScanError(loadScan([file('scan.zip', zip)], TABLET));
      errors.mockRestore();
    }
    expect(liveUrls.size, 'blob: адреси прибрано й після помилки').toBe(0);
  });

  it('пошкоджена текстура в архіві (CRC не збігається) — зрозуміла помилка', async () => {
    const { json, bin } = buildGltf(texturedInput([room()], ['t.png']));
    const zip = gltfZip('', json, bin, [{ name: 't.png', data: makePng(32, 32), method: 0 }]);
    // Зіпсувати байт усередині PNG (дані йдуть одразу після локального заголовка «t.png»).
    const marker = enc.encode('t.png');
    let at = -1;
    for (let i = 0; i < zip.length - marker.length; i++) {
      if (marker.every((b, k) => zip[i + k] === b)) {
        at = i;
        break;
      }
    }
    const broken = zip.slice();
    broken[at + marker.length + 40] = broken[at + marker.length + 40]! ^ 0xff;
    await expectScanError(loadScan([file('scan.zip', broken)], TABLET), /пошкоджен/);
    expect(liveUrls.size).toBe(0);
  });

  it('текстура, яку неможливо декодувати — скан усе одно відкривається (геометрія ціла)', async () => {
    const { json, bin } = buildGltf(texturedInput([room()], ['t.png']));
    const zip = gltfZip('', json, bin, [{ name: 't.png', data: enc.encode('це не картинка'), method: 0 }]);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const scan = await loadScan([file('scan.zip', zip)], TABLET);
    errors.mockRestore();
    expectStatsBox(scan.stats, ROOM_MIN, ROOM_MAX);
    scan.dispose();
  });

  it('glTF без жодної поверхні — 0 трикутників, без вильоту', async () => {
    const json = { asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0 };
    const scan = await loadScan([file('empty.gltf', enc.encode(JSON.stringify(json)))], TABLET);
    expect(scan.stats.triangles).toBe(0);
    expect(scan.stats.min).toEqual([0, 0, 0]);
    scan.dispose();
  });

  it('JSON, але не glTF / glTF з непідтримуваним стисненням Draco', async () => {
    await expectScanError(loadScan([file('notes.gltf', enc.encode('{"hello":1}'))], TABLET));
    const { json, bin } = roomGltf();
    json.extensionsUsed = ['KHR_draco_mesh_compression'];
    json.extensionsRequired = ['KHR_draco_mesh_compression'];
    await expectScanError(loadScan([file('scan.zip', gltfZip('', json, bin))], TABLET), /KHR_draco_mesh_compression/);
  });

  it('GLB зі стисненням Draco — та сама зрозуміла підказка, що й для .gltf', async () => {
    const { json, bin } = roomGltf();
    json.extensionsUsed = ['KHR_draco_mesh_compression'];
    json.extensionsRequired = ['KHR_draco_mesh_compression'];
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = await errorOf(loadScan([file('scan.glb', toGlb(json, bin))], TABLET));
    errors.mockRestore();
    expect(error).toBeInstanceOf(ScanLoadError);
    expect(error.message, 'замість «файл пошкоджений» — підказка про стиснення').toMatch(/KHR_draco_mesh_compression|стисн/);
  });

  it('ZIP разом з іншим файлом; нічого не вибрано; файл не читається (iCloud)', async () => {
    const { json, bin } = roomGltf();
    const zip = gltfZip('', json, bin);
    await expectScanError(loadScan([file('a.zip', zip), file('b.glb', buildGlb({ meshes: [room()] }))], TABLET));
    await expectScanError(loadScan([], TABLET));
    const failing = { name: 'scan.zip', size: 100, arrayBuffer: () => Promise.reject(new Error('NotReadableError')) };
    await expectScanError(loadScan([failing], TABLET), /iCloud/);
  });

  it('кілька окремих файлів (.gltf + .bin + текстура в підпапці URI) без ZIP', async () => {
    const { json, bin } = buildGltf(texturedInput([room()], ['textures/floor%20tile.png']));
    json.buffers[0] = { byteLength: bin.byteLength, uri: 'scene.bin' };
    const scan = await loadScan(
      [file('scene.gltf', enc.encode(JSON.stringify(json))), file('scene.bin', bin), file('floor tile.png', makePng(8, 8))],
      TABLET,
    );
    expect(scan.stats.textures).toBe(1);
    expectStatsBox(scan.stats, ROOM_MIN, ROOM_MAX);
    scan.dispose();
  });
});

describe('габарит і масштаб: як у файлі, точно до 0,1 мм', () => {
  it('скан зсунутий від нуля: X і Z — як у файлі, по висоті низ стає на Y = 0', async () => {
    const glb = buildGlb({ meshes: [room()], root: { translation: [50, 1.25, -30] } });
    const scan = await loadScan([file('far.glb', glb)], TABLET);
    expectStatsBox(scan.stats, [48, 0, -31.5], [52, 2.7, -28.5]);
    expect(scan.stats.offsetY).toBeCloseTo(-1.25, 9);
    scan.dispose();
  });

  it('підлога на −1,4 м (нуль Polycam — там, де був телефон) → низ на Y = 0, габарит той самий', async () => {
    const glb = buildGlb({ meshes: [room()], root: { translation: [0, -1.4, 0] } });
    const scan = await loadScan([file('polycam-like.glb', glb)], TABLET);
    expectStatsBox(scan.stats, [-2, 0, -1.5], [2, 2.7, 1.5]);
    expect(scan.stats.offsetY).toBeCloseTo(1.4, 9);
    // Сам вміст скану не змінено: зсунута лише обгортка.
    expect(scan.root.position.y).toBeCloseTo(1.4, 9);
    expect(scan.root.scale.toArray()).toEqual([1, 1, 1]);
    expect(scan.root.quaternion.toArray()).toEqual([0, 0, 0, 1]);
    expect(scan.root.position.x).toBe(0);
    expect(scan.root.position.z).toBe(0);
    scan.dispose();
  });

  it('модель у міліметрах з масштабом вузла 0,001 — габарит 4000 × 2700 × 3000 мм', async () => {
    const mm = boxRoom([-2000, 0, -1500], [2000, 2700, 1500]);
    const glb = buildGlb({ meshes: [mm], root: { scale: [0.001, 0.001, 0.001] } });
    const scan = await loadScan([file('mm.glb', glb)], TABLET);
    expectStatsBox(scan.stats, ROOM_MIN, ROOM_MAX);
    scan.dispose();
  });

  it('вузол, повернутий на 90° навколо Y — габарит X і Z міняються місцями', async () => {
    const glb = buildGlb({ meshes: [{ ...room(), rotation: quatY(90) }] });
    const scan = await loadScan([file('rot90.glb', glb)], TABLET);
    expectStatsBox(scan.stats, [-1.5, 0, -2], [1.5, 2.7, 2]);
    scan.dispose();
  });

  it('вузол, повернутий на 30° навколо Y — габарит за справжніми вершинами, а не роздутий', async () => {
    // Восьмикутна «кругла» кімната (наприклад, резервуар) діаметром 4 м, повернута на 30°.
    const ring: number[] = [];
    const indices: number[] = [];
    const n = 8;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      ring.push(2 * Math.cos(a), 0, 2 * Math.sin(a), 2 * Math.cos(a), 2.7, 2 * Math.sin(a));
    }
    for (let i = 0; i < n; i++) {
      const a = i * 2;
      const b = ((i + 1) % n) * 2;
      indices.push(a, b, b + 1, a, b + 1, a + 1);
    }
    const mesh: MeshInput = { name: 'tank', positions: new Float32Array(ring), indices: new Uint16Array(indices), rotation: quatY(30) };
    const scan = await loadScan([file('tank.glb', buildGlb({ meshes: [mesh] }))], TABLET);
    const exact = exactBox(scan.root);
    expectStatsBox(scan.stats, exact.min.toArray(), exact.max.toArray());
    scan.dispose();
  });

  it('трикутники: індексовані й без індексів, кілька мешів', async () => {
    const plain = {
      name: 'plain',
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1]), // 2 трикутники без індексів
    };
    const glb = buildGlb({ meshes: [room(), plain] });
    const scan = await loadScan([file('mixed.glb', glb)], TABLET);
    expect(scan.stats.triangles).toBe(14);
    scan.dispose();
  });
});

describe('важкий скан ≈ 1 млн трикутників у ZIP (як великий скан Polycam)', () => {
  it('відкривається; габарит 4000 × 2700 × 3000 мм (±0,1 мм); трикутники пораховано точно', async () => {
    const mesh = heavyRoomMesh();
    const triangles = mesh.indices!.length / 3;
    expect(triangles).toBeGreaterThan(1_000_000);
    const input = texturedInput([mesh], ['textures/texture%200.png']);
    const { json, bin } = buildGltf(input);
    const zip = gltfZip('Big Scan', json, bin, [{ name: 'Big Scan/textures/texture 0.png', data: makePng(5000, 5000), method: 0 }]);
    const scan = await loadScan([file('big.zip', zip)], PHONE);
    expect(scan.stats.triangles).toBe(triangles);
    expectStatsBox(scan.stats, ROOM_MIN, ROOM_MAX);
    expect(scan.stats.texturesReduced).toBe(1);
    expect(scan.stats.fileBytes).toBe(zip.byteLength);
    expect(liveUrls.size).toBe(0);
    scan.dispose();
  }, 120_000);
});
