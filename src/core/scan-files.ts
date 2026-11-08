/**
 * Файли скану: що за файл вибрано, де в архіві головна модель, які зовнішні файли їй потрібні.
 * Чиста логіка — без Three.js і без DOM.
 */

export type ScanFileKind = 'zip' | 'glb' | 'gltf' | 'unknown';

function extension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/**
 * Тип файлу — за вмістом (перші байти), а розширення лише як підказка:
 * на iOS «Файли» іноді віддають файл без розширення чи з іншим.
 */
export function detectScanFileKind(name: string, head: Uint8Array): ScanFileKind {
  const b = (i: number) => head[i] ?? -1;
  if (b(0) === 0x50 && b(1) === 0x4b && (b(2) === 0x03 || b(2) === 0x05) && (b(3) === 0x04 || b(3) === 0x06)) {
    return 'zip';
  }
  if (b(0) === 0x67 && b(1) === 0x6c && b(2) === 0x54 && b(3) === 0x46) return 'glb'; // 'glTF'
  // JSON-файл glTF починається з «{» (можливо, після BOM і пробілів).
  for (let i = 0; i < Math.min(head.length, 64); i++) {
    const c = head[i]!;
    if (c === 0xef || c === 0xbb || c === 0xbf || c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) continue;
    if (c === 0x7b) return 'gltf';
    break;
  }
  const ext = extension(name);
  if (ext === 'gltf') return 'gltf';
  return 'unknown';
}

/** Службові файли архівів macOS тощо — ніколи не модель. */
export function isJunkPath(path: string): boolean {
  const parts = path.split('/');
  const last = parts[parts.length - 1] ?? '';
  return parts.includes('__MACOSX') || last.startsWith('._') || last === '.DS_Store' || last === 'Thumbs.db';
}

/** Нормалізує шлях: «\» → «/», без «./», «..» згортаються, без «/» на початку. */
export function normalizePath(path: string): string {
  const out: string[] = [];
  for (const part of path.replaceAll('\\', '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

export function dirname(path: string): string {
  const normalized = normalizePath(path);
  const slash = normalized.lastIndexOf('/');
  return slash < 0 ? '' : normalized.slice(0, slash);
}

export function basename(path: string): string {
  const normalized = normalizePath(path);
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

/** Відносний URI з glTF (може бути закодований: «my%20tex.jpg») → шлях у архіві. */
export function resolveUri(baseDir: string, uri: string): string {
  let decoded = uri;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    // залишаємо як є
  }
  return normalizePath(baseDir ? `${baseDir}/${decoded}` : decoded);
}

/** Чи це зовнішній файл (а не вбудовані data: / blob: / мережеві адреси). */
export function isExternalUri(uri: string): boolean {
  return !/^(data:|blob:|https?:|\/\/)/i.test(uri);
}

/**
 * Головна модель серед файлів архіву: .gltf або .glb, не службовий файл;
 * якщо кілька — найменш вкладений, потім за абеткою.
 */
export function pickMainModel(paths: readonly string[]): string | null {
  const candidates = paths
    .filter((p) => !p.endsWith('/') && !isJunkPath(p))
    .filter((p) => {
      const ext = extension(p);
      return ext === 'gltf' || ext === 'glb';
    })
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  return candidates[0] ?? null;
}

/** Опис того, на що посилається glTF (зовнішні файли). */
export interface GltfReference {
  kind: 'buffer' | 'image';
  index: number;
  uri: string;
}

interface GltfJsonLike {
  buffers?: Array<{ uri?: unknown }>;
  images?: Array<{ uri?: unknown }>;
  extensionsRequired?: unknown;
}

/** Зовнішні файли, потрібні моделі (буфери геометрії й текстури). */
export function externalReferences(json: unknown): GltfReference[] {
  const gltf = json as GltfJsonLike;
  const refs: GltfReference[] = [];
  gltf.buffers?.forEach((buffer, index) => {
    if (typeof buffer.uri === 'string' && isExternalUri(buffer.uri)) refs.push({ kind: 'buffer', index, uri: buffer.uri });
  });
  gltf.images?.forEach((image, index) => {
    if (typeof image.uri === 'string' && isExternalUri(image.uri)) refs.push({ kind: 'image', index, uri: image.uri });
  });
  return refs;
}

/** Обов'язкові розширення glTF, яких додаток поки не вміє (наприклад, стиснення Draco). */
const SUPPORTED_REQUIRED = new Set(['KHR_materials_unlit', 'KHR_texture_transform', 'KHR_mesh_quantization']);

export function unsupportedRequiredExtensions(json: unknown): string[] {
  const required = (json as GltfJsonLike).extensionsRequired;
  if (!Array.isArray(required)) return [];
  return required.filter((name): name is string => typeof name === 'string' && !SUPPORTED_REQUIRED.has(name));
}

/** MIME-тип за розширенням (Safari краще декодує blob із правильним типом). */
export function mimeType(path: string): string {
  switch (extension(path)) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'ktx2':
      return 'image/ktx2';
    case 'gltf':
      return 'model/gltf+json';
    case 'glb':
      return 'model/gltf-binary';
    default:
      return 'application/octet-stream';
  }
}
