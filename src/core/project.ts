/**
 * Проєкт «Траса 3D 2» у файлі (етап 6): траси (точки в мм), повітропроводи, відбиток скану, вигляд камери.
 * Сам скан у файл не потрапляє — він лишається на пристрої (CLAUDE.md, «Скани й приватність»).
 *
 * Файл — звичайний JSON (кілька кілобайт): його можна зберегти у «Файли», надіслати AirDrop чи поштою.
 * Читання перевіряє все: траси — за правилами (route.ts), повітропроводи — за duct.ts. Пошкоджений, чужий
 * чи новіший файл дає зрозуміле повідомлення, а не зламаний стан програми.
 */
import { type DuctSection, type DuctSpec, type DuctTransition, isValidDuctSpec } from './duct';
import { isValidRoute, type PointMm, type Route, type RouteSet } from './route';
import type { ScanInfo } from './scan-info';

export const PROJECT_FORMAT = 'trasa-3d-project';
export const PROJECT_VERSION = 1;
/** Розширення файлу проєкту: звичайний JSON — його відкриє будь-яка програма й прийме «Файли» iOS. */
export const PROJECT_EXTENSION = '.json';
/** Розміри «того самого» скану можуть відрізнятися на частки мм (округлення) — допуск, мм. */
const SAME_SCAN_SIZE_TOLERANCE_MM = 1;

/** За чим упізнати скан: назва (для повідомлень), трикутники й габарит (для порівняння). */
export interface ScanFingerprint {
  name: string;
  triangles: number;
  sizeMm: { x: number; y: number; z: number };
  fileBytes: number;
}

export type ProjectProjection = 'perspective' | 'ortho';
export type ProjectDisplayMode = 'route' | 'duct' | 'both';

/** Вигляд камери в мм (як і траси): звідки дивимось, на що, з перспективою чи «Орто». */
export interface ProjectView {
  position: PointMm;
  target: PointMm;
  projection: ProjectProjection;
}

/** Що показано (траса / повітропровід / обидва) і прозорість скану 0…0,9. */
export interface ProjectDisplay {
  mode: ProjectDisplayMode;
  transparency: number;
}

export interface ProjectData {
  name: string;
  /** Коли збережено (ISO 8601). */
  savedAt: string;
  scan: ScanFingerprint | null;
  set: RouteSet;
  view: ProjectView | null;
  display: ProjectDisplay | null;
}

export type ParsedProject = { ok: true; project: ProjectData } | { ok: false; error: string };

/** Відбиток відкритого скану (назва файлу й опис зі scan-info.ts). */
export function scanFingerprint(name: string, info: ScanInfo): ScanFingerprint {
  return { name, triangles: info.triangles, sizeMm: { ...info.sizeMm }, fileBytes: info.fileBytes };
}

/**
 * Чи це той самий скан: однакова кількість трикутників і габарит (±1 мм). Назву й розмір файлу не
 * порівнюємо — файл могли перейменувати чи перепакувати в інший архів.
 */
export function sameScan(a: ScanFingerprint, b: ScanFingerprint): boolean {
  const close = (u: number, v: number) => Math.abs(u - v) <= SAME_SCAN_SIZE_TOLERANCE_MM;
  return a.triangles === b.triangles && close(a.sizeMm.x, b.sizeMm.x) && close(a.sizeMm.y, b.sizeMm.y) && close(a.sizeMm.z, b.sizeMm.z);
}

/**
 * Ключ скану для чернеток — кількість трикутників (габарит не округлюємо: на межі округлення той самий
 * скан отримав би два ключі). Що це справді той самий скан, перевіряє sameScan під час читання чернетки.
 */
export function scanKey(scan: ScanFingerprint): string {
  return `t${scan.triangles}`;
}

/** Файл проєкту — JSON з відступами (його можна й прочитати очима). */
export function serializeProject(data: ProjectData): string {
  return JSON.stringify(
    {
      format: PROJECT_FORMAT,
      version: PROJECT_VERSION,
      app: 'Траса 3D 2',
      name: data.name,
      savedAt: data.savedAt,
      scan: data.scan,
      nextId: data.set.nextId,
      routes: data.set.routes.map((r) => ({ id: r.id, nodes: r.nodes, duct: r.duct ?? null })),
      view: data.view,
      display: data.display,
    },
    null,
    2,
  );
}

const NOT_A_PROJECT = 'Це не файл проєкту «Траса 3D 2» — можливо, вибрано інший файл або його пошкоджено.';

/** Прочитати й перевірити файл проєкту. */
export function parseProject(text: string): ParsedProject {
  let raw: unknown;
  try {
    // BOM на початку (так зберігають деякі редактори) — не частина JSON.
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return { ok: false, error: NOT_A_PROJECT };
  }
  if (!isObject(raw) || raw.format !== PROJECT_FORMAT) return { ok: false, error: NOT_A_PROJECT };
  if (typeof raw.version !== 'number' || !Number.isInteger(raw.version) || raw.version < 1) return { ok: false, error: NOT_A_PROJECT };
  if (raw.version > PROJECT_VERSION) {
    return { ok: false, error: 'Файл збережено новішою версією програми. Оновіть сторінку «Траса 3D 2» і відкрийте його знову.' };
  }
  if (!Array.isArray(raw.routes)) return { ok: false, error: NOT_A_PROJECT };

  const routes: Route[] = [];
  const ids = new Set<number>();
  for (let i = 0; i < raw.routes.length; i++) {
    const item: unknown = raw.routes[i];
    const label = isObject(item) && isPositiveInt(item.id) ? `Траса ${item.id}` : `Траса №${i + 1} у файлі`;
    if (!isObject(item) || !isPositiveInt(item.id)) return { ok: false, error: `${label}: немає правильного номера.` };
    if (ids.has(item.id)) return { ok: false, error: `${label} у файлі двічі.` };
    const nodes = parsePoints(item.nodes);
    if (!nodes || !isValidRoute(nodes)) {
      return { ok: false, error: `${label} не за правилами (відрізки — уздовж осей або під 45°, повороти — 45° чи 90°).` };
    }
    let duct: DuctSpec | null = null;
    if (item.duct !== null && item.duct !== undefined) {
      const parsed = parseDuctSpec(item.duct);
      if (!parsed || !isValidDuctSpec(parsed, nodes.length - 1)) return { ok: false, error: `${label}: неправильний розмір повітропроводу чи переходу.` };
      duct = parsed;
    }
    ids.add(item.id);
    routes.push({ id: item.id, nodes, duct });
  }
  const maxId = Math.max(0, ...ids);
  // Номер наступної траси — більший за всі наявні (якщо у файлі його немає чи він замалий — виправляємо).
  const nextId = isPositiveInt(raw.nextId) && raw.nextId > maxId ? raw.nextId : maxId + 1;

  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'Без назви';
  const savedAt = typeof raw.savedAt === 'string' ? raw.savedAt : '';
  return {
    ok: true,
    project: { name, savedAt, scan: parseScan(raw.scan), set: { routes, nextId }, view: parseView(raw.view), display: parseDisplay(raw.display) },
  };
}

/** Назва проєкту за замовчуванням: «Цех 2 · 27.11.2026» (назва скану без розширення й дата). */
export function defaultProjectName(scanName: string | null, date: Date): string {
  const base = (scanName ?? '').replace(/\.(zip|glb|gltf)$/i, '').trim();
  const d = `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
  return base ? `${base} · ${d}` : `Проєкт · ${d}`;
}

/**
 * Ім'я файлу: назва без символів, яких не люблять «Файли» (/ \ : * ? " < > |), без крапки на початку
 * (такий файл «Файли» iOS ховають), не довша за 80 символів (емодзі не розрізаються навпіл), і «.json».
 */
export function projectFileName(name: string): string {
  const cleaned = name
    .replace(/[/\\:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .trim();
  const safe = Array.from(cleaned).slice(0, 80).join('').trim() || 'Проєкт';
  return `${safe}${PROJECT_EXTENSION}`;
}

/** Схоже на файл проєкту (за назвою): .json. Остаточно вирішує parseProject. */
export function looksLikeProjectFile(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(PROJECT_EXTENSION);
}

/** «1 траса», «3 траси», «5 трас», «11 трас», «21 траса». */
export function formatRouteCount(count: number): string {
  const n = Math.abs(Math.trunc(count));
  const last = n % 10;
  const lastTwo = n % 100;
  let word = 'трас';
  if (last === 1 && lastTwo !== 11) word = 'траса';
  else if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) word = 'траси';
  return `${n} ${word}`;
}

// ───────────────────────── перевірка частин файлу ─────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Ціле додатне й «точне» (до 2⁵³): інакше n + 1 === n, і дві траси отримали б однаковий номер. */
function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v < Number.MAX_SAFE_INTEGER;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function parsePoint(v: unknown): PointMm | null {
  if (!isObject(v) || !isFiniteNumber(v.x) || !isFiniteNumber(v.y) || !isFiniteNumber(v.z)) return null;
  return { x: v.x, y: v.y, z: v.z };
}

function parsePoints(v: unknown): PointMm[] | null {
  if (!Array.isArray(v)) return null;
  const out: PointMm[] = [];
  for (const item of v) {
    const p = parsePoint(item);
    if (!p) return null;
    out.push(p);
  }
  return out;
}

function parseSection(v: unknown): DuctSection | null {
  if (!isObject(v)) return null;
  if (v.shape === 'round' && isFiniteNumber(v.diameterMm)) return { shape: 'round', diameterMm: v.diameterMm };
  if (v.shape === 'rect' && isFiniteNumber(v.widthMm) && isFiniteNumber(v.heightMm)) {
    return { shape: 'rect', widthMm: v.widthMm, heightMm: v.heightMm };
  }
  return null;
}

function parseDuctSpec(v: unknown): DuctSpec | null {
  if (!isObject(v) || !Array.isArray(v.transitions)) return null;
  const section = parseSection(v.section);
  if (!section) return null;
  const transitions: DuctTransition[] = [];
  for (const t of v.transitions) {
    if (!isObject(t) || typeof t.segment !== 'number' || !Number.isInteger(t.segment)) return null;
    const to = parseSection(t.to);
    if (!to) return null;
    transitions.push({ segment: t.segment, to });
  }
  return { section, transitions };
}

function parseScan(v: unknown): ScanFingerprint | null {
  if (!isObject(v) || !isObject(v.sizeMm)) return null;
  const size = v.sizeMm;
  if (!isFiniteNumber(v.triangles) || !isFiniteNumber(size.x) || !isFiniteNumber(size.y) || !isFiniteNumber(size.z)) return null;
  return {
    name: typeof v.name === 'string' ? v.name : '',
    triangles: v.triangles,
    sizeMm: { x: size.x, y: size.y, z: size.z },
    fileBytes: isFiniteNumber(v.fileBytes) ? v.fileBytes : 0,
  };
}

function parseView(v: unknown): ProjectView | null {
  if (!isObject(v)) return null;
  const position = parsePoint(v.position);
  const target = parsePoint(v.target);
  if (!position || !target) return null;
  if (position.x === target.x && position.y === target.y && position.z === target.z) return null;
  const projection: ProjectProjection = v.projection === 'ortho' ? 'ortho' : 'perspective';
  return { position, target, projection };
}

function parseDisplay(v: unknown): ProjectDisplay | null {
  if (!isObject(v)) return null;
  const mode = v.mode === 'route' || v.mode === 'duct' || v.mode === 'both' ? v.mode : null;
  if (!mode) return null;
  const t = isFiniteNumber(v.transparency) ? Math.min(0.9, Math.max(0, v.transparency)) : 0;
  return { mode, transparency: t };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
