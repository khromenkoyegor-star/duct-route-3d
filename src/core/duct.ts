/**
 * Повітропровід по осі траси: прямі ділянки, коліна 90° на поворотах і переходи.
 *
 * Рішення Єгора (етап 4):
 * - траса має один розмір (круглий Ø або прямокутний Ш × В); де треба — він ставить переходи;
 * - перехід стоїть на початку вибраного відрізка (одразу після коліна), далі — новий розмір;
 * - круглі коліна — сегментні, R = D по осі, 4 сегменти; переходи — концентричні.
 * Розміри деталей, яких Єгор не давав, — з каталогів (джерела біля констант); він їх підтверджує.
 *
 * Чиста логіка: усе в мм, без Three.js і без DOM. 3D будується з цих даних (scene/duct-mesh.ts).
 */
import { type P3, type PointMm, type RouteSet, segmentDirection } from './route';

/** Діаметри круглих повітропроводів, мм — список Єгора (09.11.2026). */
export const DUCT_DIAMETERS_MM: readonly number[] = [100, 125, 150, 160, 200, 250, 315, 355, 400, 450];

/** Межі сторони прямокутного повітропроводу, який Єгор вводить сам, мм (перевірка введення). */
export const RECT_SIDE_MIN_MM = 50;
export const RECT_SIDE_MAX_MM = 3000;

/**
 * Сегментне коліно 90° круглого повітропроводу: радіус по осі R = D (каталоги: «радіус повороту
 * в стандартному відводі дорівнює діаметру»; Lindab — rm ≈ 1·d), 4 сегменти: дві половинки на кінцях
 * і дві цілі (вибір Єгора).
 */
export const ELBOW_ROUND_R_FACTOR = 1;
export const ELBOW_ROUND_SEGMENTS = 4;

/**
 * Радіусне коліно прямокутного повітропроводу: внутрішній радіус, мм (каталоги, напр. Вентека
 * «250×250-90-100»). Припущення до підтвердження Єгором.
 */
export const RECT_ELBOW_INNER_R_MM = 100;

/**
 * Перехід: нахил стінки до осі, градуси. Каталожні довжини концентричних переходів
 * (Ф1000→710 — 545 мм, →800 — 375 мм, →900 — 190 мм) дають L ≈ 1,87·ΔD, тобто 15°.
 */
export const TRANSITION_SLOPE_DEG = 15;
/** Найкоротший перехід, мм (припущення до підтвердження Єгором: інакше 150→160 був би 19 мм). */
export const TRANSITION_MIN_MM = 100;

export type DuctSection =
  | { readonly shape: 'round'; readonly diameterMm: number }
  | { readonly shape: 'rect'; readonly widthMm: number; readonly heightMm: number };

/** Перехід на початку відрізка `segment` на розмір `to` (та сама форма, що й траса). */
export interface DuctTransition {
  readonly segment: number;
  readonly to: DuctSection;
}

/** Повітропровід траси: розмір від початку й переходи (за зростанням номера відрізка). */
export interface DuctSpec {
  readonly section: DuctSection;
  readonly transitions: readonly DuctTransition[];
}

/** Рамка перерізу: u — напрямок ширини, v — напрямок висоти (одиничні, ⟂ осі). */
export interface Frame {
  u: P3;
  v: P3;
}

export interface DuctSegmentInfo {
  index: number;
  /** Розмір відрізка після переходу на ньому (якщо є). */
  section: DuctSection;
  dir: P3;
  frame: Frame;
  lengthMm: number;
}

export interface DuctStraight {
  segment: number;
  from: P3;
  to: P3;
  lengthMm: number;
  section: DuctSection;
  dir: P3;
  frame: Frame;
}

export interface DuctElbow {
  /** Вузол траси (кут повороту). */
  node: number;
  at: P3;
  dirIn: P3;
  dirOut: P3;
  /** Радіус по осі, мм; дотична довжина коліна 90° — теж R. */
  radiusMm: number;
  section: DuctSection;
  /** Рамка перерізу на вході в коліно. */
  frameIn: Frame;
  /** Початок і кінець коліна на осі (= at ∓ dir·R) і центр дуги. */
  start: P3;
  end: P3;
  centre: P3;
}

export interface DuctTransitionPiece {
  segment: number;
  from: P3;
  to: P3;
  lengthMm: number;
  fromSection: DuctSection;
  toSection: DuctSection;
  dir: P3;
  frame: Frame;
}

/** Відрізок закороткий для деталей на ньому: потрібно needMm, є haveMm. */
export interface DuctProblem {
  segment: number;
  needMm: number;
  haveMm: number;
}

export interface DuctLayout {
  segments: DuctSegmentInfo[];
  straights: DuctStraight[];
  elbows: DuctElbow[];
  transitions: DuctTransitionPiece[];
  problems: DuctProblem[];
}

/** Допуск «вміщається», мм (як і в трасі). */
const FIT_TOLERANCE_MM = 0.1;

// ── Вектори (мм) ──
const add = (a: P3, b: P3): P3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a: P3, b: P3): P3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const scale = (a: P3, k: number): P3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const dot = (a: P3, b: P3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: P3, b: P3): P3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const length = (a: P3) => Math.hypot(a.x, a.y, a.z);
const along = (p: P3, dir: P3, k: number): P3 => add(p, scale(dir, k));
/** Прибрати −0 і похибку на кшталт 1e-17 у ортах. */
const clean = (a: P3): P3 => ({ x: Math.round(a.x * 1e12) / 1e12 || 0, y: Math.round(a.y * 1e12) / 1e12 || 0, z: Math.round(a.z * 1e12) / 1e12 || 0 });

const AXIS_UNIT: Record<'X' | 'Y' | 'Z', P3> = {
  X: { x: 1, y: 0, z: 0 },
  Y: { x: 0, y: 1, z: 0 },
  Z: { x: 0, y: 0, z: 1 },
};

// ── Розміри ──

export function isValidSection(section: DuctSection): boolean {
  if (section.shape === 'round') return DUCT_DIAMETERS_MM.includes(section.diameterMm);
  const ok = (v: number) => Number.isFinite(v) && v >= RECT_SIDE_MIN_MM && v <= RECT_SIDE_MAX_MM;
  return section.shape === 'rect' && ok(section.widthMm) && ok(section.heightMm);
}

export function sameSection(a: DuctSection, b: DuctSection): boolean {
  if (a.shape === 'round' && b.shape === 'round') return a.diameterMm === b.diameterMm;
  if (a.shape === 'rect' && b.shape === 'rect') return a.widthMm === b.widthMm && a.heightMm === b.heightMm;
  return false;
}

/** «Ø200» або «500×300». */
export function formatSection(section: DuctSection): string {
  return section.shape === 'round' ? `Ø${section.diameterMm}` : `${section.widthMm}×${section.heightMm}`;
}

/** Найбільший розмір перерізу (для вибору дотиком і перевірок), мм. */
export function sectionSpanMm(section: DuctSection): number {
  return section.shape === 'round' ? section.diameterMm : Math.max(section.widthMm, section.heightMm);
}

/** Довжина переходу між розмірами однієї форми, мм: нахил стінки 15°, не коротше TRANSITION_MIN_MM. */
export function transitionLengthMm(from: DuctSection, to: DuctSection): number {
  let delta = 0;
  if (from.shape === 'round' && to.shape === 'round') delta = Math.abs(from.diameterMm - to.diameterMm);
  else if (from.shape === 'rect' && to.shape === 'rect') {
    delta = Math.max(Math.abs(from.widthMm - to.widthMm), Math.abs(from.heightMm - to.heightMm));
  } else throw new RangeError('Перехід з круглого на прямокутний — пізніше (див. «Ідеї на потім»)');
  const slope = Math.tan((TRANSITION_SLOPE_DEG * Math.PI) / 180);
  return Math.max(TRANSITION_MIN_MM, delta / (2 * slope));
}

// ── Специфікація траси ──

/** Розмір кожного відрізка (після переходу на ньому, якщо є). */
export function sectionsBySegment(spec: DuctSpec, segmentCount: number): DuctSection[] {
  const out: DuctSection[] = [];
  let current = spec.section;
  let t = 0;
  const transitions = [...spec.transitions].sort((a, b) => a.segment - b.segment);
  for (let i = 0; i < segmentCount; i++) {
    while (t < transitions.length && transitions[t]!.segment === i) current = transitions[t++]!.to;
    out.push(current);
  }
  return out;
}

/**
 * Специфікація за правилами: розміри зі списку / в межах; переходи — на наявних відрізках,
 * не більше одного на відрізок, тієї самої форми й справді на інший розмір.
 */
export function isValidDuctSpec(spec: DuctSpec, segmentCount: number): boolean {
  if (!isValidSection(spec.section)) return false;
  let previous = spec.section;
  let lastSegment = -1;
  for (const t of spec.transitions) {
    if (!Number.isInteger(t.segment) || t.segment <= lastSegment || t.segment < 0 || t.segment >= segmentCount) return false;
    if (!isValidSection(t.to) || t.to.shape !== spec.section.shape || sameSection(t.to, previous)) return false;
    previous = t.to;
    lastSegment = t.segment;
  }
  return true;
}

/**
 * Змінити розмір траси від початку. Іншої форми — переходи прибираються (з круглого
 * на прямокутний перехід поки не робимо); тієї самої — лишаються, крім тих, що стали «на той самий розмір».
 */
export function withSection(spec: DuctSpec | null, section: DuctSection): DuctSpec {
  if (!isValidSection(section)) throw new RangeError('Розмір поза списком або межами');
  if (!spec || spec.section.shape !== section.shape) return { section, transitions: [] };
  return { section, transitions: dropRedundant(section, spec.transitions) };
}

/** Поставити (або замінити) перехід на початку відрізка `segment`. */
export function withTransition(spec: DuctSpec, segment: number, to: DuctSection, segmentCount: number): DuctSpec {
  if (!Number.isInteger(segment) || segment < 0 || segment >= segmentCount) throw new RangeError('Немає такого відрізка');
  if (!isValidSection(to) || to.shape !== spec.section.shape) throw new RangeError('Перехід — лише на розмір тієї самої форми зі списку');
  const before = sectionsBySegment({ section: spec.section, transitions: spec.transitions.filter((t) => t.segment < segment) }, segment + 1)[segment]!;
  if (sameSection(before, to)) throw new RangeError('Перехід має бути на інший розмір');
  const transitions = [...spec.transitions.filter((t) => t.segment !== segment), { segment, to }].sort((a, b) => a.segment - b.segment);
  return { section: spec.section, transitions: dropRedundant(spec.section, transitions) };
}

/** Прибрати перехід з відрізка `segment` (далі — розмір, що був до нього). */
export function withoutTransition(spec: DuctSpec, segment: number): DuctSpec {
  return { section: spec.section, transitions: dropRedundant(spec.section, spec.transitions.filter((t) => t.segment !== segment)) };
}

function dropRedundant(section: DuctSection, transitions: readonly DuctTransition[]): DuctTransition[] {
  const out: DuctTransition[] = [];
  let previous = section;
  for (const t of [...transitions].sort((a, b) => a.segment - b.segment)) {
    if (sameSection(t.to, previous)) continue;
    out.push(t);
    previous = t.to;
  }
  return out;
}

// ── Рамка прямокутного перерізу ──

/**
 * Рамки перерізу по відрізках. На першій горизонтальній ділянці висота — вертикально (v = +Y);
 * якщо траса починається вертикально — ширина вздовж +X. Через коліно рамка повертається разом
 * з трубою (поворот навколо осі «вхід × вихід»), як у справжньому повітропроводі: вектор,
 * перпендикулярний площині повороту, лишається; той, що в площині, з напрямку виходу стає −входом.
 */
export function segmentFrames(dirs: readonly P3[]): Frame[] {
  if (dirs.length === 0) return [];
  const d0 = dirs[0]!;
  let frame: Frame;
  if (Math.abs(d0.y) < 0.5) {
    const v = AXIS_UNIT.Y;
    frame = { u: clean(cross(v, d0)), v };
  } else {
    const u = AXIS_UNIT.X;
    frame = { u, v: clean(cross(d0, u)) };
  }
  const frames = [frame];
  for (let i = 1; i < dirs.length; i++) {
    const a = dirs[i - 1]!;
    const b = dirs[i]!;
    const n = cross(a, b);
    const turn = (w: P3) => clean(sub(scale(n, dot(w, n)), scale(a, dot(w, b))));
    frame = { u: turn(frame.u), v: turn(frame.v) };
    frames.push(frame);
  }
  return frames;
}

/** Радіус по осі коліна 90° для перерізу: круглі — R = D; прямокутні — внутрішній радіус + B/2. */
export function elbowRadiusMm(section: DuctSection, frameIn: Frame, dirOut: P3): number {
  if (section.shape === 'round') return ELBOW_ROUND_R_FACTOR * section.diameterMm;
  // Сторона в площині повороту: та, що дивиться у напрямку виходу.
  const bend = Math.abs(dot(frameIn.u, dirOut)) > 0.5 ? section.widthMm : section.heightMm;
  return RECT_ELBOW_INNER_R_MM + bend / 2;
}

// ── Розкладання траси на деталі ──

/**
 * Траса (вузли в мм) + повітропровід → прямі ділянки, коліна, переходи й проблеми.
 * Пряма ділянка відрізка = його довжина − коліно на початку (R) − перехід (L) − коліно в кінці (R).
 */
export function ductLayout(nodes: readonly PointMm[], spec: DuctSpec): DuctLayout {
  const count = Math.max(0, nodes.length - 1);
  const dirs: P3[] = [];
  const lengths: number[] = [];
  for (let i = 0; i < count; i++) {
    const a = nodes[i]!;
    const b = nodes[i + 1]!;
    const d = segmentDirection(a, b);
    if (!d) throw new RangeError('Траса має йти вздовж осей (див. route.ts)');
    dirs.push(scale(AXIS_UNIT[d.axis], d.sign));
    lengths.push(length(sub(b, a)));
  }
  const sections = sectionsBySegment(spec, count);
  const frames = segmentFrames(dirs);
  const segments: DuctSegmentInfo[] = dirs.map((dir, index) => ({
    index,
    section: sections[index]!,
    dir,
    frame: frames[index]!,
    lengthMm: lengths[index]!,
  }));

  // Коліно у вузлі k (1…count−1) — розміру відрізка k−1: перехід, якщо є, стоїть уже після коліна.
  const elbows: DuctElbow[] = [];
  const elbowAt: number[] = new Array(count + 1).fill(0);
  for (let k = 1; k < count; k++) {
    const dirIn = dirs[k - 1]!;
    const dirOut = dirs[k]!;
    const section = sections[k - 1]!;
    const frameIn = frames[k - 1]!;
    const radiusMm = elbowRadiusMm(section, frameIn, dirOut);
    const at = nodes[k]!;
    const start = along(at, dirIn, -radiusMm);
    elbows.push({
      node: k,
      at: { ...at },
      dirIn,
      dirOut,
      radiusMm,
      section,
      frameIn,
      start,
      end: along(at, dirOut, radiusMm),
      centre: along(start, dirOut, radiusMm),
    });
    elbowAt[k] = radiusMm;
  }

  const straights: DuctStraight[] = [];
  const transitions: DuctTransitionPiece[] = [];
  const problems: DuctProblem[] = [];
  const transitionOn = new Map(spec.transitions.map((t) => [t.segment, t.to]));
  for (let i = 0; i < count; i++) {
    const dir = dirs[i]!;
    const start = along(nodes[i]!, dir, elbowAt[i]!);
    let cursor = 0;
    const to = transitionOn.get(i);
    let section = sections[i]!;
    if (to) {
      const fromSection = i === 0 ? spec.section : sections[i - 1]!;
      const lengthMm = transitionLengthMm(fromSection, to);
      transitions.push({
        segment: i,
        from: start,
        to: along(start, dir, lengthMm),
        lengthMm,
        fromSection,
        toSection: to,
        dir,
        frame: frames[i]!,
      });
      cursor = lengthMm;
      section = to;
    }
    const need = elbowAt[i]! + cursor + elbowAt[i + 1]!;
    const have = lengths[i]!;
    if (need > have + FIT_TOLERANCE_MM) problems.push({ segment: i, needMm: need, haveMm: have });
    const straightLength = have - need;
    if (straightLength > FIT_TOLERANCE_MM) {
      const from = along(start, dir, cursor);
      straights.push({
        segment: i,
        from,
        to: along(from, dir, straightLength),
        lengthMm: straightLength,
        section,
        dir,
        frame: frames[i]!,
      });
    }
  }
  return { segments, straights, elbows, transitions, problems };
}

/**
 * Вісь сегментного коліна — ламана: кінці на дузі радіуса R, внутрішні вершини — на площинах стиків
 * (для 4 сегментів — 15°, 45°, 75°) на відстані R / cos(Δ/2) від центру, де Δ — кут цілого сегмента.
 * Кінцеві сегменти — половинки (Δ/2). Повертає точки від початку коліна до кінця.
 */
export function roundElbowPolyline(elbow: DuctElbow, segments = ELBOW_ROUND_SEGMENTS): P3[] {
  const quarter = Math.PI / 2;
  const full = quarter / (segments - 1);
  const r = elbow.radiusMm;
  const at = (theta: number, radius: number) =>
    add(elbow.centre, add(scale(elbow.dirOut, -radius * Math.cos(theta)), scale(elbow.dirIn, radius * Math.sin(theta))));
  const points: P3[] = [elbow.start];
  for (let i = 0; i < segments - 1; i++) points.push(at(full / 2 + i * full, r / Math.cos(full / 2)));
  points.push(elbow.end);
  return points;
}

/** Точка на осі радіусного (прямокутного) коліна під кутом θ (0…90°, у радіанах) від початку. */
export function elbowArcPoint(elbow: DuctElbow, theta: number): P3 {
  return add(
    elbow.centre,
    add(scale(elbow.dirOut, -elbow.radiusMm * Math.cos(theta)), scale(elbow.dirIn, elbow.radiusMm * Math.sin(theta))),
  );
}

/** Довжина повітропроводу по осі, мм (прямі + коліна по ламаній/дузі + переходи). */
export function ductAxisLengthMm(layout: DuctLayout): number {
  let total = 0;
  for (const s of layout.straights) total += s.lengthMm;
  for (const t of layout.transitions) total += t.lengthMm;
  for (const e of layout.elbows) {
    if (e.section.shape === 'round') {
      const pts = roundElbowPolyline(e);
      for (let i = 1; i < pts.length; i++) total += length(sub(pts[i]!, pts[i - 1]!));
    } else total += (Math.PI / 2) * e.radiusMm;
  }
  return total;
}

/** Задати (null — прибрати) повітропровід траси `id`. Інші траси й номери не змінюються. */
export function withRouteDuct(set: RouteSet, id: number, duct: DuctSpec | null): RouteSet {
  const route = set.routes.find((r) => r.id === id);
  if (!route) throw new RangeError(`Немає траси ${id}`);
  if (duct && !isValidDuctSpec(duct, route.nodes.length - 1)) throw new RangeError('Повітропровід не за правилами');
  return { routes: set.routes.map((r) => (r.id === id ? { ...r, duct } : r)), nextId: set.nextId };
}
