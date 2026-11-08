/**
 * Синтетична тестова кімната 4000 × 2700 × 3000 мм у форматі GLB (glTF 2.0, бінарний).
 *
 * Навіщо: перевіряти масштаб і осі на відомих розмірах (етап 1 — габарит і «Рулетка»).
 *   X: ширина 4000 мм, стіни на x = −2 м і x = +2 м
 *   Y: висота 2700 мм, підлога y = 0, стеля y = 2,7 м (вертикаль — Y, як у glTF)
 *   Z: глибина 3000 мм, стіни на z = −1,5 м і z = +1,5 м
 * Одиниці — метри (як у glTF і в сцені). Поверхні дивляться всередину кімнати,
 * тож іззовні її видно «в розрізі», а зсередини — як справжнє приміщення.
 *
 * Без сторонніх бібліотек: мінімальний запис GLB вручну. Результат детермінований
 * (однакові байти при кожній генерації), щоб тест міг звірити файл у репозиторії.
 */

export const ROOM_SIZE_MM = { x: 4000, y: 2700, z: 3000 } as const;
export const ROOM_FILE_NAME = 'room-4000x2700x3000.glb';

type Vec3 = [number, number, number];
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

/** Збирає GLB-файл кімнати. */
export function buildRoomGlb(): Uint8Array {
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
    const indexAccessor = addAccessor({
      bufferView: addBufferView(new Uint8Array(indices.buffer), ELEMENT_ARRAY_BUFFER),
      componentType: UNSIGNED_SHORT,
      count: indices.length,
      type: 'SCALAR',
    });

    materials.push({
      name: surface.name,
      pbrMetallicRoughness: { baseColorFactor: surface.color, metallicFactor: 0, roughnessFactor: 1 },
    });
    meshes.push({
      name: surface.name,
      primitives: [{ attributes: { POSITION: position, NORMAL: normal }, indices: indexAccessor, material: index }],
    });
    nodes.push({ name: surface.name, mesh: index });
  });

  const gltf = {
    asset: { version: '2.0', generator: 'duct-route-3d tests/fixtures/room.ts' },
    extras: { sizeMm: ROOM_SIZE_MM, units: 'm', up: 'Y' },
    scene: 0,
    scenes: [{ name: 'room-4000x2700x3000', nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: binLength }],
  };

  // JSON-чанк доповнюється пробілами, BIN-чанк — нулями (вимога GLB: кратність 4).
  const jsonBytes = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonLength = align4(jsonBytes.byteLength);
  const total = 12 + 8 + jsonLength + 8 + binLength;

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

  view.setUint32(offset, binLength, true);
  view.setUint32(offset + 4, 0x004e4942, true); // 'BIN\0'
  offset += 8;
  for (const part of binParts) {
    out.set(part, offset);
    offset += part.byteLength;
  }

  return out;
}
