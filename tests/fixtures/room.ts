/**
 * Синтетична тестова кімната 4000 × 2700 × 3000 мм у двох видах:
 *   - GLB (glTF 2.0, бінарний, один файл) — room-4000x2700x3000.glb;
 *   - ZIP «як з Polycam»: папка з .gltf + .bin + текстурою підлоги — room-4000x2700x3000.zip.
 *
 * Навіщо: перевіряти масштаб і осі на відомих розмірах (етап 1 — габарит і «Рулетка»).
 *   X: ширина 4000 мм, стіни на x = −2 м і x = +2 м
 *   Y: висота 2700 мм, підлога y = 0, стеля y = 2,7 м (вертикаль — Y, як у glTF)
 *   Z: глибина 3000 мм, стіни на z = −1,5 м і z = +1,5 м
 * Одиниці — метри (як у glTF і в сцені). Поверхні дивляться всередину кімнати,
 * тож іззовні її видно «в розрізі», а зсередини — як справжнє приміщення.
 *
 * Без сторонніх бібліотек: GLB, PNG і ZIP пишуться вручну. Результат детермінований
 * (однакові байти при кожній генерації), щоб тест міг звірити файли в репозиторії.
 */
import { deflateSync } from 'node:zlib';
import { crc32 } from '../../src/core/zip.ts';
import { writeZip } from './zip-writer.ts';

export const ROOM_SIZE_MM = { x: 4000, y: 2700, z: 3000 } as const;
export const ROOM_FILE_NAME = 'room-4000x2700x3000.glb';
export const ROOM_ZIP_FILE_NAME = 'room-4000x2700x3000.zip';
/** Папка всередині ZIP — з пробілом, як буває в назвах сканів. */
export const ROOM_ZIP_FOLDER = 'Room 4000x2700x3000';
export const ROOM_TEXTURE_PATH = 'textures/floor tile.png';

type Vec3 = [number, number, number];
type Vec2 = [number, number];
type Rgba = [number, number, number, number];

interface Surface {
  name: string;
  /** Чотири кути прямокутника, обхід проти годинникової стрілки, якщо дивитись зсередини кімнати. */
  corners: [Vec3, Vec3, Vec3, Vec3];
  normal: Vec3;
  color: Rgba;
}

const FLOOR: Rgba = [0.55, 0.55, 0.58, 1];
const WALL: Rgba = [0.86, 0.86, 0.84, 1];
const WALL_ACCENT: Rgba = [0.78, 0.84, 0.9, 1];
const CEILING: Rgba = [0.95, 0.95, 0.95, 1];

function roomSurfaces(): Surface[] {
  // Метри. Переведення з мм тут, а не через src/core/units.ts, щоб фікстура
  // не залежала від коду, який нею перевіряють.
  const hx = ROOM_SIZE_MM.x / 2 / 1000;
  const h = ROOM_SIZE_MM.y / 1000;
  const hz = ROOM_SIZE_MM.z / 2 / 1000;
  return [
    {
      name: 'floor',
      corners: [[-hx, 0, -hz], [-hx, 0, hz], [hx, 0, hz], [hx, 0, -hz]],
      normal: [0, 1, 0],
      color: FLOOR,
    },
    {
      name: 'ceiling',
      corners: [[-hx, h, -hz], [hx, h, -hz], [hx, h, hz], [-hx, h, hz]],
      normal: [0, -1, 0],
      color: CEILING,
    },
    {
      name: 'wall-x-minus',
      corners: [[-hx, 0, -hz], [-hx, h, -hz], [-hx, h, hz], [-hx, 0, hz]],
      normal: [1, 0, 0],
      color: WALL_ACCENT,
    },
    {
      name: 'wall-x-plus',
      corners: [[hx, 0, -hz], [hx, 0, hz], [hx, h, hz], [hx, h, -hz]],
      normal: [-1, 0, 0],
      color: WALL_ACCENT,
    },
    {
      name: 'wall-z-minus',
      corners: [[-hx, 0, -hz], [hx, 0, -hz], [hx, h, -hz], [-hx, h, -hz]],
      normal: [0, 0, 1],
      color: WALL,
    },
    {
      name: 'wall-z-plus',
      corners: [[-hx, 0, hz], [-hx, h, hz], [hx, h, hz], [hx, 0, hz]],
      normal: [0, 0, -1],
      color: WALL,
    },
  ];
}

const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;

const align4 = (n: number) => Math.ceil(n / 4) * 4;

interface RoomGltf {
  json: Record<string, unknown> & { buffers: Array<{ byteLength: number; uri?: string }> };
  bin: Uint8Array;
}

/**
 * glTF кімнати: JSON + бінарний буфер.
 * textured: підлога з текстурою (UV у метрах, плитка повторюється) — для ZIP «як з Polycam».
 */
function buildRoomGltf(textured: boolean): RoomGltf {
  const surfaces = roomSurfaces();

  const binParts: Uint8Array[] = [];
  let binLength = 0;
  const bufferViews: object[] = [];
  const accessors: object[] = [];

  function addBufferView(bytes: Uint8Array, target: number): number {
    const byteOffset = binLength;
    const padded = new Uint8Array(align4(bytes.byteLength));
    padded.set(bytes);
    binParts.push(padded);
    binLength += padded.byteLength;
    bufferViews.push({ buffer: 0, byteOffset, byteLength: bytes.byteLength, target });
    return bufferViews.length - 1;
  }

  function addAccessor(accessor: object): number {
    accessors.push(accessor);
    return accessors.length - 1;
  }

  const meshes: object[] = [];
  const nodes: object[] = [];
  const materials: object[] = [];

  surfaces.forEach((surface, index) => {
    const positions = new Float32Array(surface.corners.flat());
    const normals = new Float32Array([surface.normal, surface.normal, surface.normal, surface.normal].flat());
    const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);

    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i++) {
      const axis = i % 3;
      const value = positions[i] as number;
      min[axis] = Math.min(min[axis] as number, value);
      max[axis] = Math.max(max[axis] as number, value);
    }

    const position = addAccessor({
      bufferView: addBufferView(new Uint8Array(positions.buffer), ARRAY_BUFFER),
      componentType: FLOAT,
      count: 4,
      type: 'VEC3',
      min,
      max,
    });
    const normal = addAccessor({
      bufferView: addBufferView(new Uint8Array(normals.buffer), ARRAY_BUFFER),
      componentType: FLOAT,
      count: 4,
      type: 'VEC3',
    });
    const attributes: Record<string, number> = { POSITION: position, NORMAL: normal };
    const isTexturedFloor = textured && surface.name === 'floor';
    if (isTexturedFloor) {
      // UV у метрах: одна копія текстури на 1 × 1 м (повтор — режим REPEAT за замовчуванням).
      const uv: Vec2[] = surface.corners.map(([x, , z]) => [x, z]);
      attributes.TEXCOORD_0 = addAccessor({
        bufferView: addBufferView(new Uint8Array(new Float32Array(uv.flat()).buffer), ARRAY_BUFFER),
        componentType: FLOAT,
        count: 4,
        type: 'VEC2',
      });
    }
    const indexAccessor = addAccessor({
      bufferView: addBufferView(new Uint8Array(indices.buffer), ELEMENT_ARRAY_BUFFER),
      componentType: UNSIGNED_SHORT,
      count: indices.length,
      type: 'SCALAR',
    });

    const pbr: Record<string, unknown> = { baseColorFactor: surface.color, metallicFactor: 0, roughnessFactor: 1 };
    if (isTexturedFloor) {
      pbr.baseColorFactor = [1, 1, 1, 1];
      pbr.baseColorTexture = { index: 0 };
    }
    materials.push({ name: surface.name, pbrMetallicRoughness: pbr });
    meshes.push({
      name: surface.name,
      primitives: [{ attributes, indices: indexAccessor, material: index }],
    });
    nodes.push({ name: surface.name, mesh: index });
  });

  const json: RoomGltf['json'] = {
    asset: { version: '2.0', generator: 'duct-route-3d tests/fixtures/room.ts' },
    extras: { sizeMm: ROOM_SIZE_MM, units: 'm', up: 'Y' },
    scene: 0,
    scenes: [{ name: 'room-4000x2700x3000', nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    materials,
    ...(textured
      ? {
          textures: [{ source: 0, sampler: 0 }],
          samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
          // URI закодований (%20), як пишуть експортери для назв із пробілами.
          images: [{ uri: encodeURI(ROOM_TEXTURE_PATH), mimeType: 'image/png' }],
        }
      : {}),
    accessors,
    bufferViews,
    buffers: [{ byteLength: binLength }],
  };

  const bin = new Uint8Array(binLength);
  let offset = 0;
  for (const part of binParts) {
    bin.set(part, offset);
    offset += part.byteLength;
  }
  return { json, bin };
}

/** Збирає GLB-файл кімнати. */
export function buildRoomGlb(): Uint8Array {
  const { json, bin } = buildRoomGltf(false);

  // JSON-чанк доповнюється пробілами, BIN-чанк — нулями (вимога GLB: кратність 4).
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = align4(jsonBytes.byteLength);
  const total = 12 + 8 + jsonLength + 8 + bin.byteLength;

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  view.setUint32(offset, 0x46546c67, true); // 'glTF'
  view.setUint32(offset + 4, 2, true);
  view.setUint32(offset + 8, total, true);
  offset += 12;

  view.setUint32(offset, jsonLength, true);
  view.setUint32(offset + 4, 0x4e4f534a, true); // 'JSON'
  offset += 8;
  out.fill(0x20, offset, offset + jsonLength);
  out.set(jsonBytes, offset);
  offset += jsonLength;

  view.setUint32(offset, bin.byteLength, true);
  view.setUint32(offset + 4, 0x004e4942, true); // 'BIN\0'
  offset += 8;
  out.set(bin, offset);

  return out;
}

/** Мінімальний PNG (RGB, 8 біт): шахова плитка 64 × 64 px — текстура підлоги. */
export function buildFloorPng(): Uint8Array {
  const size = 64;
  const tile = 8;
  const raw = new Uint8Array(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 3);
    raw[row] = 0; // фільтр None
    for (let x = 0; x < size; x++) {
      const light = (Math.floor(x / tile) + Math.floor(y / tile)) % 2 === 0;
      const p = row + 1 + x * 3;
      raw[p] = light ? 214 : 150;
      raw[p + 1] = light ? 206 : 140;
      raw[p + 2] = light ? 190 : 120;
    }
  }

  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    const typeAndData = new Uint8Array(4 + data.length);
    typeAndData.set(new TextEncoder().encode(type), 0);
    typeAndData.set(data, 4);
    out.set(typeAndData, 4);
    dv.setUint32(8 + data.length, crc32(typeAndData));
    return out;
  };

  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, size);
  iv.setUint32(4, size);
  ihdr[8] = 8; // біт на канал
  ihdr[9] = 2; // RGB
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw, { level: 9 }))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

/**
 * ZIP «як з Polycam»: папка з пробілом у назві → room.gltf + room.bin + textures/floor tile.png,
 * плюс службовий файл macOS (__MACOSX), який додаток має ігнорувати.
 */
export function buildRoomZip(): Uint8Array {
  const { json, bin } = buildRoomGltf(true);
  json.buffers[0] = { byteLength: bin.byteLength, uri: 'room.bin' };
  const gltfText = new TextEncoder().encode(JSON.stringify(json, null, 2));
  const folder = ROOM_ZIP_FOLDER;
  return writeZip([
    { name: `${folder}/`, data: new Uint8Array(0), method: 0 },
    { name: `${folder}/room.gltf`, data: gltfText },
    { name: `${folder}/room.bin`, data: bin, dataDescriptor: true },
    { name: `${folder}/textures/`, data: new Uint8Array(0), method: 0 },
    { name: `${folder}/${ROOM_TEXTURE_PATH}`, data: buildFloorPng(), method: 0 },
    { name: `__MACOSX/${folder}/._room.gltf`, data: new Uint8Array([0, 5, 22, 7, 0, 2, 0, 0]), method: 0 },
  ]);
}
