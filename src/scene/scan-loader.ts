/**
 * Відкриття скану: ZIP з Polycam (GLTF + .bin + текстури), один .glb або .gltf, або кілька файлів моделі.
 * Усе локально — файли нікуди не відправляються. Масштаб і осі скану не змінюються.
 */
import {
  Box3,
  type BufferGeometry,
  type Group,
  LoadingManager,
  type Material,
  Mesh,
  MeshBasicMaterial,
  type MeshStandardMaterial,
  type Object3D,
  type Texture,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { ScanStats } from '../core/scan-info';
import {
  basename,
  detectScanFileKind,
  dirname,
  externalReferences,
  foreignFormatHint,
  mimeType,
  normalizePath,
  pickMainModel,
  readGlbJson,
  resolveUri,
  unsupportedRequiredExtensions,
} from '../core/scan-files';
import { extractZipEntry, readZipEntries, ZipError } from '../core/zip';

/** Мінімум того, що потрібно від File (зручно для тестів). */
export interface ScanFile {
  readonly name: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type LoadPhase = 'reading' | 'unzipping' | 'parsing' | 'preparing';

/** Помилка з поясненням для користувача (українською). */
export class ScanLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScanLoadError';
  }
}

export interface LoadedScan {
  /** Назва для показу: ім'я вибраного файлу. */
  name: string;
  root: Group;
  stats: ScanStats;
  dispose(): void;
}

export interface LoadOptions {
  /** Найбільша сторона текстури; більші зменшуються (захист пам'яті iPhone). */
  maxTextureSide: number;
  onPhase?: (phase: LoadPhase) => void;
}

interface Source {
  read(): Promise<Uint8Array>;
}

const NOT_A_SCAN =
  'Це не схоже на скан. Виберіть ZIP-архів, експортований з Polycam у форматі GLTF, або файл .glb / .gltf.';

async function readFile(file: ScanFile): Promise<Uint8Array> {
  try {
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    throw new ScanLoadError(`Не вдалося прочитати файл «${file.name}». Можливо, він ще завантажується з iCloud — спробуйте ще раз.`);
  }
}

/** Зібрати всі доступні файли (з архіву або вибрані окремо) і знайти головну модель. */
async function collectSources(
  files: readonly ScanFile[],
  onPhase: (phase: LoadPhase) => void,
): Promise<{ sources: Map<string, Source>; main: string; flat: boolean }> {
  onPhase('reading');
  const contents = await Promise.all(files.map(async (file) => ({ file, bytes: await readFile(file) })));
  const zips = contents.filter((c) => detectScanFileKind(c.file.name, c.bytes) === 'zip');

  if (zips.length > 0) {
    if (contents.length > 1) {
      throw new ScanLoadError('Виберіть один ZIP-архів або файли моделі (.gltf + .bin + текстури), але не все разом.');
    }
    onPhase('unzipping');
    const { bytes } = zips[0]!;
    let entries;
    try {
      entries = readZipEntries(bytes);
    } catch (error) {
      throw new ScanLoadError(error instanceof ZipError ? error.message : 'Архів пошкоджений.');
    }
    const sources = new Map<string, Source>();
    for (const entry of entries) {
      // «./scene.bin», «Room\\scene.bin» тощо → однаковий вигляд шляху, як і в посиланнях моделі.
      const path = normalizePath(entry.name);
      if (!entry.isDirectory && path !== '') sources.set(path, { read: () => extractZipEntry(bytes, entry) });
    }
    const main = pickMainModel([...sources.keys()]);
    if (!main) {
      // USDZ — теж ZIP усередині: підказка за назвою самого файлу, потім — за вмістом архіву.
      const hint =
        foreignFormatHint(zips[0]!.file.name) ?? [...sources.keys()].map(foreignFormatHint).find((h) => h !== null);
      throw new ScanLoadError(
        hint ?? 'В архіві немає 3D-моделі (.gltf або .glb). Експортуйте скан з Polycam у форматі GLTF.',
      );
    }
    return { sources, main, flat: false };
  }

  // Окремі файли: «Файли» на iOS віддають їх без папок — шукаємо за назвою.
  const sources = new Map<string, Source>();
  for (const { file, bytes } of contents) sources.set(basename(file.name), { read: async () => bytes });
  let main = pickMainModel([...sources.keys()]);
  if (!main && contents.length === 1) {
    // Файл без розширення: визначаємо за вмістом.
    const only = contents[0]!;
    const kind = detectScanFileKind(only.file.name, only.bytes);
    if (kind === 'glb' || kind === 'gltf') main = basename(only.file.name);
  }
  if (!main) {
    const hint = contents.map((c) => foreignFormatHint(c.file.name)).find((h) => h !== null);
    throw new ScanLoadError(hint ?? NOT_A_SCAN);
  }
  return { sources, main, flat: true };
}

/** Перетворити Uint8Array на ArrayBuffer рівно потрібної довжини. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer
    ? bytes.buffer
    : (bytes.slice().buffer as ArrayBuffer);
}

const TEXTURE_KEYS = [
  'map',
  'alphaMap',
  'aoMap',
  'bumpMap',
  'displacementMap',
  'emissiveMap',
  'envMap',
  'lightMap',
  'metalnessMap',
  'normalMap',
  'roughnessMap',
  'specularMap',
  'clearcoatMap',
  'clearcoatNormalMap',
  'clearcoatRoughnessMap',
  'sheenColorMap',
  'sheenRoughnessMap',
  'transmissionMap',
  'thicknessMap',
  'iridescenceMap',
  'iridescenceThicknessMap',
  'anisotropyMap',
  'specularColorMap',
  'specularIntensityMap',
] as const;

function texturesOf(material: Material): Texture[] {
  const out: Texture[] = [];
  const record = material as unknown as Record<string, unknown>;
  for (const key of TEXTURE_KEYS) {
    const value = record[key] as Texture | null | undefined;
    if (value && (value as Texture).isTexture) out.push(value);
  }
  return out;
}

function disposeTexture(texture: Texture): void {
  texture.dispose();
  const image = texture.image as { close?: () => void } | null;
  image?.close?.();
}

function materialsOf(mesh: Mesh): Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

/** Звільнити все: геометрії, матеріали, текстури (і їхні ImageBitmap). */
export function disposeObject(root: Object3D): void {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  root.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    geometries.add(mesh.geometry);
    for (const material of materialsOf(mesh)) {
      materials.add(material);
      for (const texture of texturesOf(material)) textures.add(texture);
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) disposeTexture(texture);
  root.removeFromParent();
  root.clear();
}

/**
 * Скан показуємо «як є» — з його власними кольорами, без затемнення від освітлення сцени
 * (у текстурах скану освітлення вже є). Невикористані текстури (нормалі, шорсткість) звільняємо.
 */
function makeUnlit(root: Object3D): void {
  const converted = new Map<Material, Material>();
  const keep = new Set<Texture>();
  const drop = new Set<Texture>();

  const convert = (material: Material): Material => {
    const existing = converted.get(material);
    if (existing) return existing;
    let result: Material;
    if ((material as MeshBasicMaterial).isMeshBasicMaterial) {
      result = material;
    } else {
      const src = material as MeshStandardMaterial;
      result = new MeshBasicMaterial({
        name: src.name,
        color: src.color ? src.color.clone() : 0xffffff,
        map: src.map ?? null,
        alphaMap: src.alphaMap ?? null,
        vertexColors: src.vertexColors,
        side: src.side,
        transparent: src.transparent,
        opacity: src.opacity,
        alphaTest: src.alphaTest,
      });
      for (const texture of texturesOf(src)) drop.add(texture);
      src.dispose();
    }
    for (const texture of texturesOf(result)) keep.add(texture);
    converted.set(material, result);
    return result;
  };

  root.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(convert) : convert(mesh.material);
  });
  // Одна картинка може бути спільною для кольору й нормалей (різні семплери) —
  // таку картинку не закриваємо, лише звільняємо невикористану текстуру.
  const keptSources = new Set<unknown>([...keep].map((t) => t.source));
  for (const texture of drop) {
    if (keep.has(texture)) continue;
    if (keptSources.has(texture.source)) texture.dispose();
    else disposeTexture(texture);
  }
}

/** Зменшити текстури, більші за maxSide. Повертає кількість зменшених. */
async function limitTextures(root: Object3D, maxSide: number): Promise<number> {
  const textures = new Set<Texture>();
  root.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    for (const material of materialsOf(mesh)) for (const texture of texturesOf(material)) textures.add(texture);
  });

  let reduced = 0;
  for (const texture of textures) {
    const image = texture.image as (CanvasImageSource & { width: number; height: number; close?: () => void }) | null;
    if (!image || !image.width || !image.height) continue;
    const side = Math.max(image.width, image.height);
    if (side <= maxSide) continue;
    const k = maxSide / side;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * k));
    canvas.height = Math.max(1, Math.round(image.height * k));
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    image.close?.();
    if (typeof createImageBitmap === 'function') {
      texture.image = await createImageBitmap(canvas);
      canvas.width = 0;
      canvas.height = 0;
    } else {
      texture.image = canvas;
    }
    texture.needsUpdate = true;
    reduced++;
  }
  return reduced;
}

/** Статистика для панелі інформації: межі (м), трикутники, текстури. */
function collectStats(root: Object3D, fileBytes: number, texturesReduced: number): ScanStats {
  root.updateMatrixWorld(true);
  // precise: межі за справжніми вершинами (інакше повернутий вузол дає завищений габарит).
  const box = new Box3().setFromObject(root, true);
  let triangles = 0;
  const textures = new Set<Texture>();
  root.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry;
    const count = geometry.index ? geometry.index.count : (geometry.getAttribute('position')?.count ?? 0);
    triangles += Math.floor(count / 3);
    for (const material of materialsOf(mesh)) for (const texture of texturesOf(material)) textures.add(texture);
  });
  let texturePixels = 0;
  for (const texture of textures) {
    const image = texture.image as { width?: number; height?: number } | null;
    texturePixels += (image?.width ?? 0) * (image?.height ?? 0);
  }
  const empty = box.isEmpty();
  return {
    min: empty ? [0, 0, 0] : [box.min.x, box.min.y, box.min.z],
    max: empty ? [0, 0, 0] : [box.max.x, box.max.y, box.max.z],
    triangles,
    fileBytes,
    textures: textures.size,
    texturePixels,
    texturesReduced,
  };
}

/** Перевірений, але ще не побудований скан: файли прочитано, модель знайдено, усі її файли на місці. */
export interface PreparedScan {
  name: string;
  fileBytes: number;
  kind: 'glb' | 'gltf';
  main: string;
  mainBytes: Uint8Array;
  /** JSON моделі (для GLB — з першого чанку) і шляхи її зовнішніх файлів. */
  json: GltfJson;
  refs: Array<{ kind: 'buffer' | 'image'; index: number; path: string; source: Source }>;
}

type GltfJson = Record<string, unknown> & { buffers?: Array<{ uri?: string }>; images?: Array<{ uri?: string }> };

/**
 * Крок 1 — швидка перевірка без побудови 3D: чи це скан, чи цілий архів, чи всі файли на місці.
 * Якщо тут помилка — уже відкритий скан можна не закривати.
 */
export async function prepareScan(files: readonly ScanFile[], onPhase: (phase: LoadPhase) => void = () => {}): Promise<PreparedScan> {
  if (files.length === 0) throw new ScanLoadError('Файл не вибрано.');
  const fileBytes = files.reduce((sum, f) => sum + f.size, 0);
  const name = files.length === 1 ? files[0]!.name : `${files.length} файли`;

  const { sources, main, flat } = await collectSources(files, onPhase);
  let mainBytes: Uint8Array;
  try {
    mainBytes = await sources.get(main)!.read();
  } catch (error) {
    throw new ScanLoadError(error instanceof ZipError ? error.message : 'Архів пошкоджений.');
  }
  const kind = detectScanFileKind(main, mainBytes);

  if (kind !== 'gltf' && kind !== 'glb') throw new ScanLoadError(NOT_A_SCAN);

  let json: GltfJson;
  if (kind === 'glb') {
    const glbJson = readGlbJson(mainBytes);
    if (!glbJson) throw new ScanLoadError(`Файл моделі «${basename(main)}» пошкоджений.`);
    json = glbJson as GltfJson;
  } else {
    try {
      json = JSON.parse(new TextDecoder().decode(mainBytes));
    } catch {
      throw new ScanLoadError(`Файл моделі «${basename(main)}» пошкоджений.`);
    }
  }
  if (typeof json !== 'object' || json === null || typeof json.asset !== 'object') {
    throw new ScanLoadError(`Файл «${basename(main)}» — не 3D-модель glTF.`);
  }
  const unsupported = unsupportedRequiredExtensions(json);
  if (unsupported.length > 0) {
    throw new ScanLoadError(
      `Скан збережено з розширенням, яке поки не підтримується (${unsupported.join(', ')}). ` +
        'Експортуйте з Polycam без стиснення.',
    );
  }
  const refs: PreparedScan['refs'] = [];
  const missing: string[] = [];
  const baseDir = dirname(main);
  for (const ref of externalReferences(json)) {
    const path = resolveUri(baseDir, ref.uri);
    const source = sources.get(path) ?? (flat ? sources.get(basename(path)) : undefined);
    if (source) refs.push({ kind: ref.kind, index: ref.index, path, source });
    else missing.push(basename(path));
  }
  if (missing.length > 0) {
    throw new ScanLoadError(
      `Бракує файлів моделі: ${missing.join(', ')}. Відкрийте ZIP-архів з Polycam цілком ` +
        'або виберіть разом із .gltf усі його файли.',
    );
  }
  return { name, fileBytes, kind, main, mainBytes, json, refs };
}

/**
 * Жодних мережевих запитів: усі файли моделі — лише з вибраних файлів (blob:) або вбудовані (data:).
 * Будь-яку іншу адресу (сервер, сторонній сайт) підміняємо порожньою — скан нікуди не «дзвонить».
 */
function offlineManager(byUri: Map<string, string>): LoadingManager {
  const manager = new LoadingManager();
  manager.setURLModifier((url) => {
    const mapped = byUri.get(url);
    if (mapped) return mapped;
    if (/^(blob:|data:)/i.test(url)) return url;
    return 'data:,';
  });
  return manager;
}

/** Крок 2 — побудувати 3D: розпакувати файли моделі, завантажити, підготувати до показу. */
export async function buildScan(prepared: PreparedScan, options: LoadOptions): Promise<LoadedScan> {
  const onPhase = options.onPhase ?? (() => {});
  const urls: string[] = [];
  /** Як модель посилається на файл (рядок uri з файлу) → тимчасова локальна адреса blob:. */
  const byUri = new Map<string, string>();
  const json = prepared.json!;
  if (prepared.refs.length > 0) onPhase('unzipping');
  try {
    for (const ref of prepared.refs) {
      const bytes = await ref.source.read();
      const url = URL.createObjectURL(new Blob([toArrayBuffer(bytes)], { type: mimeType(ref.path) }));
      urls.push(url);
      const item = (ref.kind === 'buffer' ? json.buffers : json.images)![ref.index]!;
      if (typeof item.uri === 'string') byUri.set(item.uri, url);
      // Для .gltf підставляємо прямо в JSON; для GLB (JSON усередині файлу) — через byUri.
      if (prepared.kind === 'gltf') item.uri = url;
    }
  } catch (error) {
    for (const url of urls) URL.revokeObjectURL(url);
    if (error instanceof ZipError) throw new ScanLoadError(error.message);
    throw error;
  }
  const data: ArrayBuffer | string = prepared.kind === 'glb' ? toArrayBuffer(prepared.mainBytes) : JSON.stringify(json);

  onPhase('parsing');
  let root: Group;
  try {
    const gltf = await new GLTFLoader(offlineManager(byUri)).parseAsync(data, '');
    root = gltf.scene;
  } catch (error) {
    console.error(error);
    throw new ScanLoadError('Не вдалося прочитати 3D-модель: файл пошкоджений або в непідтримуваному форматі.');
  } finally {
    for (const url of urls) URL.revokeObjectURL(url);
  }

  onPhase('preparing');
  try {
    makeUnlit(root);
    const texturesReduced = await limitTextures(root, options.maxTextureSide);
    const stats = collectStats(root, prepared.fileBytes, texturesReduced);
    root.name = 'scan';
    return { name: prepared.name, root, stats, dispose: () => disposeObject(root) };
  } catch (error) {
    disposeObject(root);
    throw error;
  }
}

/** Відкрити скан із вибраних файлів (перевірка + побудова). */
export async function loadScan(files: readonly ScanFile[], options: LoadOptions): Promise<LoadedScan> {
  return buildScan(await prepareScan(files, options.onPhase), options);
}
