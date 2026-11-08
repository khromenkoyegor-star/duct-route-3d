/**
 * Конструктор синтетичних glTF / GLB / PNG для тестів етапу 1 (від tester).
 * Без сторонніх бібліотек. Нічого не пише на диск — лише байти в пам'яті.
 *
 * Одиниці — метри (як у glTF і сцені). Вертикаль — Y.
 */
import { deflateSync } from 'node:zlib';
import { crc32 } from '../../src/core/zip.ts';

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export interface MeshInput {
  name?: string;
  positions: Float32Array;
  indices?: Uint16Array | Uint32Array;
  normals?: Float32Array;
  uvs?: Float32Array;
  /** Індекс матеріалу в GltfInput.materials. */
  material?: number;
  translation?: Vec3;
  rotation?: Quat;
  scale?: Vec3;
}

export interface GltfInput {
  meshes: MeshInput[];
  materials?: object[];
  textures?: object[];
  samplers?: object[];
  images?: object[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  /** Батьківський вузол для всіх мешів (наприклад, поворот усього скану). */
  root?: { translation?: Vec3; rotation?: Quat; scale?: Vec3 };
}

export interface BuiltGltf {
  json: Record<string, unknown> & {
    buffers: Array<{ byteLength: number; uri?: string }>;
    images?: Array<Record<string, unknown>>;
    bufferViews: Array<Record<string, unknown>>;
  };
  bin: Uint8Array;
  /** Додати довільні байти в BIN (наприклад, вбудовану картинку) → індекс bufferView. */
}

const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;

const align4 = (n: number) => Math.ceil(n / 4) * 4;

export function buildGltf(input: GltfInput, extraBinParts: Uint8Array[] = []): BuiltGltf & { extraViews: number[] } {
  const parts: Uint8Array[] = [];
  let length = 0;
  const bufferViews: Array<Record<string, unknown>> = [];
  const accessors: object[] = [];

  const addView = (bytes: Uint8Array, target?: number): number => {
    const byteOffset = length;
    const padded = new Uint8Array(align4(bytes.byteLength));
    padded.set(bytes);
    parts.push(padded);
    length += padded.byteLength;
    bufferViews.push({ buffer: 0, byteOffset, byteLength: bytes.byteLength, ...(target ? { target } : {}) });
    return bufferViews.length - 1;
  };
  const addAccessor = (a: object) => {
    accessors.push(a);
    return accessors.length - 1;
  };
  const bytesOf = (a: ArrayBufferView) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

  const meshes: object[] = [];
  const nodes: Array<Record<string, unknown>> = [];
  input.meshes.forEach((mesh, i) => {
    const p = mesh.positions;
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < p.length; k++) {
      const axis = k % 3;
      min[axis] = Math.min(min[axis]!, p[k]!);
      max[axis] = Math.max(max[axis]!, p[k]!);
    }
    const attributes: Record<string, number> = {
      POSITION: addAccessor({
        bufferView: addView(bytesOf(p), ARRAY_BUFFER),
        componentType: FLOAT,
        count: p.length / 3,
        type: 'VEC3',
        min,
        max,
      }),
    };
    if (mesh.normals) {
      attributes.NORMAL = addAccessor({
        bufferView: addView(bytesOf(mesh.normals), ARRAY_BUFFER),
        componentType: FLOAT,
        count: mesh.normals.length / 3,
        type: 'VEC3',
      });
    }
    if (mesh.uvs) {
      attributes.TEXCOORD_0 = addAccessor({
        bufferView: addView(bytesOf(mesh.uvs), ARRAY_BUFFER),
        componentType: FLOAT,
        count: mesh.uvs.length / 2,
        type: 'VEC2',
      });
    }
    const primitive: Record<string, unknown> = { attributes };
    if (mesh.indices) {
      primitive.indices = addAccessor({
        bufferView: addView(bytesOf(mesh.indices), ELEMENT_ARRAY_BUFFER),
        componentType: mesh.indices instanceof Uint32Array ? UNSIGNED_INT : UNSIGNED_SHORT,
        count: mesh.indices.length,
        type: 'SCALAR',
      });
    }
    if (mesh.material !== undefined) primitive.material = mesh.material;
    meshes.push({ name: mesh.name ?? `mesh-${i}`, primitives: [primitive] });
    const node: Record<string, unknown> = { name: mesh.name ?? `mesh-${i}`, mesh: i };
    if (mesh.translation) node.translation = mesh.translation;
    if (mesh.rotation) node.rotation = mesh.rotation;
    if (mesh.scale) node.scale = mesh.scale;
    nodes.push(node);
  });

  const extraViews = extraBinParts.map((part) => addView(part));

  let sceneNodes = nodes.map((_, i) => i);
  if (input.root) {
    nodes.push({ name: 'root', children: sceneNodes, ...input.root });
    sceneNodes = [nodes.length - 1];
  }

  const json: BuiltGltf['json'] = {
    asset: { version: '2.0', generator: 'duct-route-3d tests/fixtures/gltf-builder.ts' },
    scene: 0,
    scenes: [{ nodes: sceneNodes }],
    nodes,
    meshes,
    accessors,
    bufferViews,
    buffers: [{ byteLength: length }],
  };
  if (input.materials) json.materials = input.materials;
  if (input.textures) json.textures = input.textures;
  if (input.samplers) json.samplers = input.samplers;
  if (input.images) json.images = input.images as Array<Record<string, unknown>>;
  if (input.extensionsUsed) json.extensionsUsed = input.extensionsUsed;
  if (input.extensionsRequired) json.extensionsRequired = input.extensionsRequired;

  const bin = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bin.set(part, offset);
    offset += part.byteLength;
  }
  return { json, bin, extraViews };
}

/** GLB з JSON і BIN. */
export function toGlb(json: object, bin: Uint8Array): Uint8Array {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = align4(jsonBytes.byteLength);
  const binLength = align4(bin.byteLength);
  const total = 12 + 8 + jsonLength + (binLength > 0 ? 8 + binLength : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.fill(0x20, 20, 20 + jsonLength);
  out.set(jsonBytes, 20);
  if (binLength > 0) {
    const p = 20 + jsonLength;
    view.setUint32(p, binLength, true);
    view.setUint32(p + 4, 0x004e4942, true);
    out.set(bin, p + 8);
  }
  return out;
}

/** Готовий GLB із мешів (без текстур). */
export function buildGlb(input: GltfInput): Uint8Array {
  const { json, bin } = buildGltf(input);
  return toGlb(json, bin);
}

/** Прямокутна поверхня з чотирьох кутів (два трикутники, індекси Uint16). */
export function quad(corners: [Vec3, Vec3, Vec3, Vec3], name?: string): MeshInput {
  return {
    ...(name ? { name } : {}),
    positions: new Float32Array(corners.flat()),
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
  };
}

/**
 * «Коробка-кімната» (6 поверхонь, 12 трикутників) з межами min..max, один меш.
 * Корисно для перевірки габариту, «Показати все» і рулетки.
 */
export function boxRoom(min: Vec3, max: Vec3, name = 'room'): MeshInput {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const v: Vec3[] = [
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y0, z1],
    [x0, y0, z1],
    [x0, y1, z0],
    [x1, y1, z0],
    [x1, y1, z1],
    [x0, y1, z1],
  ];
  // Обхід — лицем усередину.
  const faces = [
    [0, 3, 2, 0, 2, 1], // підлога (нормаль +Y)
    [4, 5, 6, 4, 6, 7], // стеля (нормаль −Y)
    [0, 4, 7, 0, 7, 3], // x0 (нормаль +X)
    [1, 2, 6, 1, 6, 5], // x1 (нормаль −X)
    [0, 1, 5, 0, 5, 4], // z0 (нормаль +Z)
    [3, 7, 6, 3, 6, 2], // z1 (нормаль −Z)
  ];
  return { name, positions: new Float32Array(v.flat()), indices: new Uint16Array(faces.flat()) };
}

/** Кватерніон повороту навколо осі Y на кут (градуси). */
export function quatY(deg: number): Quat {
  const r = (deg * Math.PI) / 180 / 2;
  return [0, Math.sin(r), 0, Math.cos(r)];
}

/** Псевдовипадкові числа (детерміновано). */
export function lcg(seed = 1): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export interface PngOptions {
  /** Кожен n-й рядок — шум (погано стискається, як фото). 0 — без шуму. */
  noiseEvery?: number;
  /** Рівень deflate (1 — швидко). */
  level?: number;
}

/** PNG RGB 8 біт заданого розміру: плитка + рядки шуму. */
export function makePng(width: number, height: number, options: PngOptions = {}): Uint8Array {
  const { noiseEvery = 0, level = 1 } = options;
  const stride = 1 + width * 3;
  const raw = new Uint8Array(stride * height);
  const rnd = lcg(width * 7 + height);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    raw[row] = 0;
    const noisy = noiseEvery > 0 && y % noiseEvery === 0;
    for (let x = 0; x < width; x++) {
      const p = row + 1 + x * 3;
      if (noisy) {
        raw[p] = (rnd() * 256) | 0;
        raw[p + 1] = (rnd() * 256) | 0;
        raw[p + 2] = (rnd() * 256) | 0;
      } else {
        const light = ((x >> 6) + (y >> 6)) % 2 === 0;
        raw[p] = light ? 210 : 140;
        raw[p + 1] = light ? 200 : 130;
        raw[p + 2] = light ? 185 : 115;
      }
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
  iv.setUint32(0, width);
  iv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const pieces = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw, { level }))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const png = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const piece of pieces) {
    png.set(piece, offset);
    offset += piece.length;
  }
  return png;
}

/** Ширина й висота з заголовка PNG (для заглушки createImageBitmap у Node). */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

/**
 * Важкий скан «як з Polycam»: кімната 4000 × 2700 × 3000 мм, кожна поверхня — дрібна сітка
 * з тремтінням вершин у площині (як у справжньому скані), ≈ 1 млн трикутників, нормалі й UV.
 * Межі кімнати точні: крайні вершини не зсуваються.
 */
export function heavyRoomMesh(cellsX = 360, cellsY = 243, cellsZ = 270): MeshInput {
  const hx = 2;
  const h = 2.7;
  const hz = 1.5;
  type Surface = { origin: Vec3; u: Vec3; v: Vec3; nu: number; nv: number; normal: Vec3 };
  // Для кожної поверхні: origin + u*s + v*t, s,t ∈ [0,1]; обхід — лицем усередину.
  const surfaces: Surface[] = [
    { origin: [-hx, 0, -hz], u: [0, 0, 2 * hz], v: [2 * hx, 0, 0], nu: cellsZ, nv: cellsX, normal: [0, 1, 0] },
    { origin: [-hx, h, -hz], u: [2 * hx, 0, 0], v: [0, 0, 2 * hz], nu: cellsX, nv: cellsZ, normal: [0, -1, 0] },
    { origin: [-hx, 0, -hz], u: [0, h, 0], v: [0, 0, 2 * hz], nu: cellsY, nv: cellsZ, normal: [1, 0, 0] },
    { origin: [hx, 0, -hz], u: [0, 0, 2 * hz], v: [0, h, 0], nu: cellsZ, nv: cellsY, normal: [-1, 0, 0] },
    { origin: [-hx, 0, -hz], u: [2 * hx, 0, 0], v: [0, h, 0], nu: cellsX, nv: cellsY, normal: [0, 0, 1] },
    { origin: [-hx, 0, hz], u: [0, h, 0], v: [2 * hx, 0, 0], nu: cellsY, nv: cellsX, normal: [0, 0, -1] },
  ];
  let vertexCount = 0;
  let indexCount = 0;
  for (const s of surfaces) {
    vertexCount += (s.nu + 1) * (s.nv + 1);
    indexCount += s.nu * s.nv * 6;
  }
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indices = new Uint32Array(indexCount);
  const rnd = lcg(42);
  let vBase = 0;
  let ip = 0;
  surfaces.forEach((s, si) => {
    const du = 1 / s.nu;
    const dv = 1 / s.nv;
    for (let j = 0; j <= s.nv; j++) {
      for (let i = 0; i <= s.nu; i++) {
        const edge = i === 0 || j === 0 || i === s.nu || j === s.nv;
        // Тремтіння в площині: до ±25 % клітинки, крайні вершини — точно на межі.
        const a = i * du + (edge ? 0 : (rnd() - 0.5) * 0.5 * du);
        const b = j * dv + (edge ? 0 : (rnd() - 0.5) * 0.5 * dv);
        const k = (vBase + j * (s.nu + 1) + i) * 3;
        for (let c = 0; c < 3; c++) positions[k + c] = s.origin[c]! + s.u[c]! * a + s.v[c]! * b;
        // Нормаль зі «шумом» сканера.
        const nx = s.normal[0] + (rnd() - 0.5) * 0.02;
        const ny = s.normal[1] + (rnd() - 0.5) * 0.02;
        const nz = s.normal[2] + (rnd() - 0.5) * 0.02;
        const len = Math.hypot(nx, ny, nz);
        normals[k] = nx / len;
        normals[k + 1] = ny / len;
        normals[k + 2] = nz / len;
        const t = (vBase + j * (s.nu + 1) + i) * 2;
        // Атлас текстури: 3 × 2 клітинки, по одній на поверхню.
        uvs[t] = ((si % 3) + a) / 3;
        uvs[t + 1] = (Math.floor(si / 3) + b) / 2;
      }
    }
    for (let j = 0; j < s.nv; j++) {
      for (let i = 0; i < s.nu; i++) {
        const a = vBase + j * (s.nu + 1) + i;
        const b = a + 1;
        const c = a + (s.nu + 1);
        const d = c + 1;
        indices[ip++] = a;
        indices[ip++] = b;
        indices[ip++] = d;
        indices[ip++] = a;
        indices[ip++] = d;
        indices[ip++] = c;
      }
    }
    vBase += (s.nu + 1) * (s.nv + 1);
  });
  return { name: 'heavy-room', positions, normals, uvs, indices, material: 0 };
}
