/**
 * Траси повітропроводу: полілінія вузлів (вісь повітропроводу) у мм.
 *
 * Правила (рішення Єгора):
 * - кожен відрізок іде вздовж однієї осі X, Y або Z, або під 45° у площині двох осей (XZ, XY, ZY) —
 *   тоді зміщення по обох осях однакові (етап 4.1);
 * - між сусідніми відрізками — поворот на 45° або 90°, або пряме продовження; назад і «гострі»
 *   повороти (135°, 60° тощо) — не можна;
 * - траси пронумеровані; номер ніколи не змінюється (після видалення — пропуск, нова — наступний номер).
 *
 * Дані — єдине джерело правди; 3D будується з них. Чиста логіка: без Three.js і без DOM.
 */
import type { DuctSpec } from './duct';
import type { NudgeAxis } from './nudge';
import { mmToM, mToMm } from './units';

/** Точка в будь-яких одиницях (м у сцені, мм у трасі). */
export interface P3 {
  x: number;
  y: number;
  z: number;
}

/** Вузол траси — координати в мм. */
export type PointMm = P3;

export interface Route {
  /** Номер траси («Траса 3»). Не змінюється. */
  readonly id: number;
  readonly nodes: readonly PointMm[];
  /** Повітропровід траси (розмір і переходи) або null — ще не задано (див. duct.ts). */
  readonly duct?: DuctSpec | null;
}

export interface RouteSet {
  readonly routes: readonly Route[];
  /** Номер для наступної траси. */
  readonly nextId: number;
}

/** Напрямок відрізка: вісь і знак (+1 / −1). */
export interface SegmentDir {
  axis: NudgeAxis;
  sign: 1 | -1;
}

/** Допуск «той самий» для координат вузлів у мм (± 0,1 мм за вимогами). */
export const NODE_TOLERANCE_MM = 0.1;

const KEYS: Record<NudgeAxis, keyof P3> = { X: 'x', Y: 'y', Z: 'z' };
const AXES: NudgeAxis[] = ['X', 'Y', 'Z'];

export function emptyRouteSet(): RouteSet {
  return { routes: [], nextId: 1 };
}

/** Точка сцени (м) → вузол траси (мм). */
export function toMm(p: P3): PointMm {
  return { x: mToMm(p.x), y: mToMm(p.y), z: mToMm(p.z) };
}

/** Вузол траси (мм) → точка сцени (м). */
export function toM(p: PointMm): P3 {
  return { x: mmToM(p.x), y: mmToM(p.y), z: mmToM(p.z) };
}

export function distance(a: P3, b: P3): number {
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
}

/** Довжини відрізків (у тих самих одиницях, що й вузли). */
export function segmentLengths(nodes: readonly P3[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < nodes.length; i++) out.push(distance(nodes[i - 1]!, nodes[i]!));
  return out;
}

export function routeLength(nodes: readonly P3[]): number {
  return segmentLengths(nodes).reduce((sum, l) => sum + l, 0);
}

/**
 * Вздовж якої осі йде відрізок a → b: рівно одна координата відрізняється більше за допуск.
 * null — нульовий відрізок або «по діагоналі».
 */
export function segmentDirection(a: P3, b: P3, tolerance = 0): SegmentDir | null {
  let found: SegmentDir | null = null;
  for (const axis of AXES) {
    const d = b[KEYS[axis]] - a[KEYS[axis]];
    if (Math.abs(d) > tolerance) {
      if (found) return null;
      found = { axis, sign: d > 0 ? 1 : -1 };
    }
  }
  return found;
}

export function segmentAxis(a: P3, b: P3, tolerance = 0): NudgeAxis | null {
  return segmentDirection(a, b, tolerance)?.axis ?? null;
}

/**
 * Напрямок відрізка: уздовж осі (одна складова) або під 45° у площині двох осей (дві складові,
 * у порядку X, Y, Z). `unit` — одиничний вектор ідеального напрямку (без похибки вузлів).
 */
export interface Heading {
  readonly parts: readonly SegmentDir[];
  readonly unit: P3;
}

const SQRT_HALF = Math.SQRT1_2;

/** Одиничний вектор напрямку з однієї чи двох складових (вісь або діагональ 45°). */
export function headingUnit(parts: readonly SegmentDir[]): P3 {
  const k = parts.length === 2 ? SQRT_HALF : 1;
  const unit: P3 = { x: 0, y: 0, z: 0 };
  for (const part of parts) unit[KEYS[part.axis]] = part.sign * k;
  return unit;
}

/**
 * Куди йде відрізок a → b: уздовж осі (одна координата змінюється більше за допуск) або під 45°
 * (дві координати змінюються однаково, з точністю до допуску; третя — ні).
 * null — нульовий відрізок або інший нахил.
 */
export function segmentHeading(a: P3, b: P3, tolerance = 0): Heading | null {
  const parts: SegmentDir[] = [];
  const sizes: number[] = [];
  for (const axis of AXES) {
    const d = b[KEYS[axis]] - a[KEYS[axis]];
    if (Math.abs(d) > tolerance) {
      parts.push({ axis, sign: d > 0 ? 1 : -1 });
      sizes.push(Math.abs(d));
    }
  }
  if (parts.length === 1) return { parts, unit: headingUnit(parts) };
  if (parts.length === 2 && Math.abs(sizes[0]! - sizes[1]!) <= tolerance) return { parts, unit: headingUnit(parts) };
  return null;
}

/** Допуск порівняння косинусів кутів між ідеальними напрямками. */
const TURN_EPS = 1e-9;

/**
 * Чи можна після відрізка з напрямком `previous` піти в напрямку `next` (одиничні вектори):
 * прямо, під 45° або під 90°. Назад, 135°, 60° і 120° — ні.
 */
export function turnAllowed(previous: P3, next: P3): boolean {
  const dot = previous.x * next.x + previous.y * next.y + previous.z * next.z;
  return Math.abs(dot - 1) < TURN_EPS || Math.abs(dot - SQRT_HALF) < TURN_EPS || Math.abs(dot) < TURN_EPS;
}

/**
 * Траса за правилами: ≥ 2 вузли; кожен відрізок — уздовж осі або під 45° (допуск у мм);
 * між сусідніми відрізками — прямо, 45° або 90°.
 */
export function isValidRoute(nodes: readonly PointMm[], toleranceMm = NODE_TOLERANCE_MM): boolean {
  if (nodes.length < 2) return false;
  // Пошкоджені координати (NaN, нескінченність) — траса не за правилами.
  if (!nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.z))) return false;
  let previous: Heading | null = null;
  for (let i = 1; i < nodes.length; i++) {
    const heading = segmentHeading(nodes[i - 1]!, nodes[i]!, toleranceMm);
    if (!heading) return false;
    if (previous && !turnAllowed(previous.unit, heading.unit)) return false;
    previous = heading;
  }
  return true;
}

/**
 * Чи можна підтвердити наступну точку (м сцени) від попереднього вузла: той самий допуск і те саме
 * переведення в мм, що й у перевірці траси (isValidRoute) — що підтвердили, те «Завершити» прийме.
 * `previous` — напрямок попереднього відрізка (одиничний), якщо він є.
 */
export function canAppendNode(anchorM: P3, pointM: P3, previous: P3 | null = null): boolean {
  const heading = segmentHeading(toMm(anchorM), toMm(pointM), NODE_TOLERANCE_MM);
  return heading !== null && (!previous || turnAllowed(previous, heading.unit));
}

/** Додати завершену трасу: отримує наступний номер. */
export function addRoute(set: RouteSet, nodes: readonly PointMm[]): { set: RouteSet; route: Route } {
  if (!isValidRoute(nodes)) {
    throw new RangeError('Траса має бути з ≥ 2 точок; відрізки — уздовж осей або під 45°, повороти — 45° чи 90°');
  }
  const route: Route = { id: set.nextId, nodes: nodes.map((n) => ({ ...n })) };
  return { set: { routes: [...set.routes, route], nextId: set.nextId + 1 }, route };
}

/** Видалити трасу за номером. Номери інших трас не змінюються. */
export function removeRoute(set: RouteSet, id: number): RouteSet {
  return { routes: set.routes.filter((r) => r.id !== id), nextId: set.nextId };
}

/** Напрямок останнього осьового відрізка (для заборони руху назад) або null. */
export function lastDirection(nodes: readonly P3[], tolerance = 0): SegmentDir | null {
  if (nodes.length < 2) return null;
  return segmentDirection(nodes[nodes.length - 2]!, nodes[nodes.length - 1]!, tolerance);
}

/** Напрямок останнього відрізка (вісь або 45°) — від нього залежить, куди можна повернути далі. */
export function lastHeading(nodes: readonly P3[], tolerance = 0): Heading | null {
  if (nodes.length < 2) return null;
  return segmentHeading(nodes[nodes.length - 2]!, nodes[nodes.length - 1]!, tolerance);
}

/** Режим 45°: друга вісь і бік зміщення (зміщення по ній дорівнює ходу по основній осі). */
export interface DiagonalChoice {
  axis: NudgeAxis;
  sign: 1 | -1;
}

const asUnit = (previous: P3 | SegmentDir | null): P3 | null =>
  previous ? ('axis' in previous ? headingUnit([previous]) : previous) : null;

/** Напрямок кроку: основна вісь зі знаком і, у режимі 45°, друга вісь. */
function stepUnit(axis: NudgeAxis, sign: 1 | -1, diagonal: DiagonalChoice | null): P3 {
  const parts: SegmentDir[] = [{ axis, sign }];
  if (diagonal) parts.push(diagonal);
  return headingUnit(parts);
}

/**
 * Варіанти другої осі для режиму 45°, коли основна вісь і її бік уже вибрані: дві інші осі × два боки.
 * `allowed` — чи дозволений такий відрізок після попереднього (`previous` — його одиничний напрямок).
 */
export function diagonalOptions(
  mainAxis: NudgeAxis,
  mainSign: 1 | -1,
  previous: P3 | null,
): Array<DiagonalChoice & { allowed: boolean }> {
  const out: Array<DiagonalChoice & { allowed: boolean }> = [];
  for (const axis of AXES) {
    if (axis === mainAxis) continue;
    for (const sign of [1, -1] as const) {
      const choice = { axis, sign };
      out.push({ ...choice, allowed: !previous || turnAllowed(previous, stepUnit(mainAxis, mainSign, choice)) });
    }
  }
  return out;
}

/** Відстань (у одиницях точок), ближче якої точка вважається «на початку відрізка». */
const SNAP = 1e-7;

/**
 * Один крок при витягуванні наступної точки від `anchor` (останнього вузла):
 * - поки точка на початку — можна рушити по будь-якій осі (окрім заборонених поворотів);
 * - щойно відійшла — рухається лише по цій осі, туди-сюди;
 * - повертаючись, точка зупиняється рівно на початку (не проскакує на інший бік) —
 *   тоді вісь знову вільна, і новим рухом можна вибрати іншу;
 * - `previous` — напрямок попереднього відрізка: новий може йти лише прямо, під 45° або 90° до нього
 *   (назад чи під гострим кутом точка не рухається — лишається на початку);
 * - `diagonal` — режим 45°: `axis` тоді — основна вісь, а по другій осі зміщення завжди дорівнює
 *   ходу по основній (у вибраний бік), тож відрізок іде рівно під 45°.
 * Решта координат завжди рівно як у `anchor`.
 * Усі координати в одних одиницях (м сцени); step — зсув у тих самих одиницях.
 */
export function stepAlongSegment(
  anchor: P3,
  point: P3,
  axis: NudgeAxis,
  step: number,
  previous: P3 | SegmentDir | null,
  diagonal: DiagonalChoice | null = null,
): P3 {
  if (!Number.isFinite(step)) return point;
  if (diagonal && diagonal.axis === axis) return point;
  if (!diagonal) {
    const locked = segmentAxis(anchor, point, SNAP);
    if (locked && locked !== axis) return point;
  }
  const key = KEYS[axis];
  const before = point[key] - anchor[key];
  let offset = before + step;
  // Проскочили початок — зупиняємось на ньому.
  if (Math.abs(before) >= SNAP && Math.sign(offset) !== Math.sign(before)) offset = 0;
  if (Math.abs(offset) < SNAP) offset = 0;
  // Заборонений поворот відносно попереднього відрізка (назад, 135°, 60°…) — лишаємось на початку.
  const prev = asUnit(previous);
  if (prev && offset !== 0 && !turnAllowed(prev, stepUnit(axis, offset > 0 ? 1 : -1, diagonal))) offset = 0;
  const next: P3 = { ...anchor };
  next[key] = anchor[key] + offset;
  if (diagonal) next[KEYS[diagonal.axis]] = anchor[KEYS[diagonal.axis]] + diagonal.sign * Math.abs(offset);
  return next;
}

/** Вісь, по якій уже йде відрізок від anchor до point (null — точка на початку). */
export function lockedAxis(anchor: P3, point: P3): NudgeAxis | null {
  return segmentAxis(anchor, point, SNAP);
}

/** «1 точка», «3 точки», «5 точок», «11 точок», «21 точка» — українські форми множини. */
export function formatPointCount(count: number): string {
  const n = Math.abs(Math.trunc(count));
  const last = n % 10;
  const lastTwo = n % 100;
  let word = 'точок';
  if (last === 1 && lastTwo !== 11) word = 'точка';
  else if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) word = 'точки';
  return `${n} ${word}`;
}
