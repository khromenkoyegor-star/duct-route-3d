/**
 * Точне доведення точки джойстиком: лише по одній осі за раз, швидкість — від сили відхилення.
 *
 * Джойстик (2D) рухає точку по X або Z: вісь вибирається за напрямком на екрані — та,
 * чия стрілка (на джойстику й біля точки) найближча до напрямку руху. Вибрана вісь фіксується до відпускання.
 * Повзунок (1D) рухає точку тільки по Y.
 * Ледь відхилив — 5 мм/с, до краю — 500 мм/с (0,5 м/с), між ними — плавно (експонента).
 *
 * Чиста логіка: без Three.js і без DOM. Екранні вектори — у CSS-пікселях, y вниз.
 */
import { mmToM } from './units';

export type NudgeAxis = 'X' | 'Y' | 'Z';
export type HorizontalAxis = 'X' | 'Z';

export interface Vec2 {
  x: number;
  y: number;
}

export interface PointM {
  x: number;
  y: number;
  z: number;
}

/**
 * Мертва зона джойстика (частка ходу): поки палець не відійшов від місця дотику далі за неї,
 * точка не рухається і вісь не вибирається (при ході 64 px це ≈ 10 px).
 */
export const NUDGE_DEAD_ZONE = 0.15;
/** Найменша швидкість (одразу за мертвою зоною), мм/с. */
export const NUDGE_MIN_MM_S = 5;
/** Найбільша швидкість (джойстик до краю), мм/с. */
export const NUDGE_MAX_MM_S = 500;
/** Найдовший крок часу між кадрами, с: після паузи (вкладка у фоні) точка не «стрибає». */
export const NUDGE_MAX_DT_S = 0.1;
/** Вісь, коротша на екрані за цю частку від довшої, вважається «дивиться в камеру». */
const DEGENERATE_AXIS_RATIO = 0.15;
/** Якщо X і Z на екрані розходяться менше ніж на цей кут (рад), на джойстику їх розводимо. */
const MIN_AXIS_SEPARATION = (35 * Math.PI) / 180;

/**
 * Відхилення 0…1 → швидкість у мм/с (0 у мертвій зоні).
 * Крива пологіша на початку (степінь 1,5): широка зона повільного точного доведення.
 */
export function nudgeSpeed(deflection: number): number {
  const d = Math.min(1, Math.abs(deflection));
  if (!(d > NUDGE_DEAD_ZONE)) return 0;
  const t = (d - NUDGE_DEAD_ZONE) / (1 - NUDGE_DEAD_ZONE);
  return NUDGE_MIN_MM_S * (NUDGE_MAX_MM_S / NUDGE_MIN_MM_S) ** (t ** 1.5);
}

const length = (v: Vec2) => Math.hypot(v.x, v.y);
const unit = (v: Vec2): Vec2 => {
  const l = length(v);
  return l > 0 ? { x: v.x / l, y: v.y / l } : { x: 0, y: 0 };
};

/**
 * Напрямки X і Z на джойстику (одиничні, екранні: y вниз).
 * Зазвичай — так, як стрілки X і Z біля точки на екрані. Але якщо на екрані вони майже на одній
 * лінії (дивимось з кута на рівні очей) або одна з осей «дивиться в камеру», розрізнити їх неможливо.
 * Тоді довша лишається як є, а коротша отримує перпендикулярний напрямок (у бік її справжньої стрілки),
 * і джойстик показує це своїми стрілками — обидві осі завжди досяжні.
 */
export function joystickDirections(screen: Record<HorizontalAxis, Vec2>): Record<HorizontalAxis, Vec2> {
  const lx = length(screen.X);
  const lz = length(screen.Z);
  if (!(Math.max(lx, lz) > 0)) return { X: { x: 1, y: 0 }, Z: { x: 0, y: -1 } };
  const strong: HorizontalAxis = lx >= lz ? 'X' : 'Z';
  const weak: HorizontalAxis = strong === 'X' ? 'Z' : 'X';
  const s = unit(screen[strong]);
  const w = unit(screen[weak]);
  const degenerate = length(screen[weak]) < length(screen[strong]) * DEGENERATE_AXIS_RATIO;
  // Кут між лініями осей (0…90°): напрямок «туди чи назад» не важливий.
  const separation = Math.acos(Math.min(1, Math.abs(s.x * w.x + s.y * w.y)));
  if (!degenerate && separation >= MIN_AXIS_SEPARATION) {
    return strong === 'X' ? { X: s, Z: w } : { X: w, Z: s };
  }
  let perp: Vec2 = { x: -s.y, y: s.x };
  const dot = perp.x * w.x + perp.y * w.y;
  // У бік справжньої стрілки коротшої осі; якщо вона майже точка — «вгору» на екрані.
  if (dot < 0 || (Math.abs(dot) < 1e-6 && perp.y > 0)) perp = { x: -perp.x, y: -perp.y };
  return strong === 'X' ? { X: s, Z: perp } : { X: perp, Z: s };
}

/**
 * Яка вісь (X чи Z) найкраще збігається з напрямком джойстика.
 * dirs — напрямки осей на джойстику (див. joystickDirections). null — джойстик у мертвій зоні.
 */
export function pickAxis(stick: Vec2, dirs: Record<HorizontalAxis, Vec2>): HorizontalAxis | null {
  const s = length(stick);
  if (!(s > NUDGE_DEAD_ZONE)) return null;
  let best: HorizontalAxis | null = null;
  let bestCos = -1;
  for (const axis of ['X', 'Z'] as const) {
    const dir = dirs[axis];
    const l = length(dir);
    if (!(l > 0)) continue;
    const cos = Math.abs((stick.x * dir.x + stick.y * dir.y) / (s * l));
    if (cos > bestCos) {
      bestCos = cos;
      best = axis;
    }
  }
  return best;
}

/** Швидкість уздовж осі (мм/с, зі знаком): крива від проєкції джойстика на напрямок осі на екрані. */
export function axisVelocity(stick: Vec2, axisOnScreen: Vec2): number {
  const l = length(axisOnScreen);
  if (!(l > 0)) return 0;
  const along = (stick.x * axisOnScreen.x + stick.y * axisOnScreen.y) / l;
  return Math.sign(along) * nudgeSpeed(along);
}

/** Повзунок Y: значення −1…1 (вгору — додатне) → швидкість по Y у мм/с. */
export function sliderVelocity(value: number): number {
  return Math.sign(value) * nudgeSpeed(value);
}

/** Зсунути точку (м) на deltaMm лише по одній осі — дві інші координати лишаються рівно як були. */
export function movePoint(point: PointM, axis: NudgeAxis, deltaMm: number): PointM {
  const delta = mmToM(deltaMm);
  return {
    x: axis === 'X' ? point.x + delta : point.x,
    y: axis === 'Y' ? point.y + delta : point.y,
    z: axis === 'Z' ? point.z + delta : point.z,
  };
}

export interface NudgeStep {
  axis: NudgeAxis;
  deltaMm: number;
}

/**
 * Стан джойстика між кадрами: фіксує вісь при першому виході з мертвої зони
 * і тримає її, поки джойстик не відпущено (release).
 */
export interface StickController {
  readonly axis: HorizontalAxis | null;
  /** Один кадр: джойстик, напрямки осей на екрані біля точки, час кадру (с) → крок або null. */
  update(stick: Vec2, screen: Record<HorizontalAxis, Vec2>, dtS: number): NudgeStep | null;
  release(): void;
}

export function createStickController(): StickController {
  let axis: HorizontalAxis | null = null;
  return {
    get axis() {
      return axis;
    },
    update(stick, screen, dtS) {
      const dirs = joystickDirections(screen);
      if (!axis) axis = pickAxis(stick, dirs);
      if (!axis) return null;
      const velocity = axisVelocity(stick, dirs[axis]);
      const dt = Math.min(Math.max(dtS, 0), NUDGE_MAX_DT_S);
      if (velocity === 0 || dt === 0) return null;
      return { axis, deltaMm: velocity * dt };
    },
    release() {
      axis = null;
    },
  };
}

/** Один кадр повзунка Y. */
export function sliderStep(value: number, dtS: number): NudgeStep | null {
  const velocity = sliderVelocity(value);
  const dt = Math.min(Math.max(dtS, 0), NUDGE_MAX_DT_S);
  if (velocity === 0 || dt === 0) return null;
  return { axis: 'Y', deltaMm: velocity * dt };
}
