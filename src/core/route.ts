/**
 * Траси повітропроводу: полілінія вузлів (вісь повітропроводу) у мм.
 *
 * Правила версії 1 (рішення Єгора):
 * - кожен відрізок строго вздовж однієї осі X, Y або Z (повороти 90°);
 * - назад по щойно пройденому відрізку траса не йде (повітропровід сам у себе);
 * - траси пронумеровані; номер ніколи не змінюється (після видалення — пропуск, нова — наступний номер).
 *
 * Дані — єдине джерело правди; 3D будується з них. Чиста логіка: без Three.js і без DOM.
 */
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
 * Траса за правилами: ≥ 2 вузли, кожен відрізок — вздовж однієї осі (допуск у мм),
 * і жоден відрізок не повертає назад по попередньому.
 */
export function isValidRoute(nodes: readonly PointMm[], toleranceMm = NODE_TOLERANCE_MM): boolean {
  if (nodes.length < 2) return false;
  let previous: SegmentDir | null = null;
  for (let i = 1; i < nodes.length; i++) {
    const dir = segmentDirection(nodes[i - 1]!, nodes[i]!, toleranceMm);
    if (!dir) return false;
    if (previous && previous.axis === dir.axis && previous.sign !== dir.sign) return false;
    previous = dir;
  }
  return true;
}

/** Додати завершену трасу: отримує наступний номер. */
export function addRoute(set: RouteSet, nodes: readonly PointMm[]): { set: RouteSet; route: Route } {
  if (!isValidRoute(nodes)) throw new RangeError('Траса має бути з ≥ 2 точок, кожен відрізок — уздовж однієї осі');
  const route: Route = { id: set.nextId, nodes: nodes.map((n) => ({ ...n })) };
  return { set: { routes: [...set.routes, route], nextId: set.nextId + 1 }, route };
}

/** Видалити трасу за номером. Номери інших трас не змінюються. */
export function removeRoute(set: RouteSet, id: number): RouteSet {
  return { routes: set.routes.filter((r) => r.id !== id), nextId: set.nextId };
}

/** Напрямок останнього відрізка (для заборони руху назад) або null. */
export function lastDirection(nodes: readonly P3[], tolerance = 0): SegmentDir | null {
  if (nodes.length < 2) return null;
  return segmentDirection(nodes[nodes.length - 2]!, nodes[nodes.length - 1]!, tolerance);
}

/** Відстань (у одиницях точок), ближче якої точка вважається «на початку відрізка». */
const SNAP = 1e-7;

/**
 * Один крок при витягуванні наступної точки від `anchor` (останнього вузла):
 * - поки точка на початку — можна рушити по будь-якій осі (окрім ходу назад по `back`);
 * - щойно відійшла — рухається лише по цій осі, туди-сюди;
 * - повертаючись, точка зупиняється рівно на початку (не проскакує на інший бік) —
 *   тоді вісь знову вільна, і новим рухом можна вибрати іншу;
 * - назад по попередньому відрізку (`back` — його напрямок) — не далі за початок.
 * Інші дві координати завжди рівно як у `anchor` — відрізок строго вздовж осі.
 * Усі координати в одних одиницях (м сцени); step — зсув у тих самих одиницях.
 */
export function stepAlongSegment(
  anchor: P3,
  point: P3,
  axis: NudgeAxis,
  step: number,
  back: SegmentDir | null,
): P3 {
  if (!Number.isFinite(step)) return point;
  const locked = segmentAxis(anchor, point, SNAP);
  if (locked && locked !== axis) return point;
  const key = KEYS[axis];
  const before = point[key] - anchor[key];
  let offset = before + step;
  // Проскочили початок — зупиняємось на ньому.
  if (Math.abs(before) >= SNAP && Math.sign(offset) !== Math.sign(before)) offset = 0;
  // Назад по попередньому відрізку — заборонено: обмежуємо початком.
  if (back && back.axis === axis && offset * back.sign < 0) offset = 0;
  if (Math.abs(offset) < SNAP) offset = 0;
  const next: P3 = { ...anchor };
  next[key] = anchor[key] + offset;
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
