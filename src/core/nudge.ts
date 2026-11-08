/**
 * Точне доведення точки джойстиком: лише по одній осі за раз, швидкість — від сили відхилення.
 *
 * Джойстик (2D) рухає точку по X або Z: вісь вибирається за напрямком на екрані — та,
 * чия стрілка біля точки найближча до напрямку джойстика. Вибрана вісь фіксується до відпускання.
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

/** Мертва зона джойстика (частка радіуса): дрібне тремтіння пальця точку не рухає. */
export const NUDGE_DEAD_ZONE = 0.1;
/** Найменша швидкість (одразу за мертвою зоною), мм/с. */
export const NUDGE_MIN_MM_S = 5;
/** Найбільша швидкість (джойстик до краю), мм/с. */
export const NUDGE_MAX_MM_S = 500;
/** Найдовший крок часу між кадрами, с: після паузи (вкладка у фоні) точка не «стрибає». */
export const NUDGE_MAX_DT_S = 0.1;
/** Вісь, коротша на екрані за цю частку від довшої, вважається «дивиться в камеру» і не вибирається. */
const DEGENERATE_AXIS_RATIO = 0.15;

/** Відхилення 0…1 → швидкість у мм/с (0 у мертвій зоні). */
export function nudgeSpeed(deflection: number): number {
  const d = Math.min(1, Math.abs(deflection));
  if (!(d > NUDGE_DEAD_ZONE)) return 0;
  const t = (d - NUDGE_DEAD_ZONE) / (1 - NUDGE_DEAD_ZONE);
  return NUDGE_MIN_MM_S * (NUDGE_MAX_MM_S / NUDGE_MIN_MM_S) ** t;
}

const length = (v: Vec2) => Math.hypot(v.x, v.y);

/**
 * Яка вісь (X чи Z) найкраще збігається на екрані з напрямком джойстика.
 * screen — напрямки +X і +Z біля точки на екрані (будь-якої довжини).
 * null — джойстик у мертвій зоні або обидві осі «дивляться в камеру».
 */
export function pickAxis(stick: Vec2, screen: Record<HorizontalAxis, Vec2>): HorizontalAxis | null {
  const s = length(stick);
  if (!(s > NUDGE_DEAD_ZONE)) return null;
  const lx = length(screen.X);
  const lz = length(screen.Z);
  const longest = Math.max(lx, lz);
  if (!(longest > 0)) return null;
  let best: HorizontalAxis | null = null;
  let bestCos = -1;
  for (const axis of ['X', 'Z'] as const) {
    const dir = screen[axis];
    const l = axis === 'X' ? lx : lz;
    if (l < longest * DEGENERATE_AXIS_RATIO) continue;
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
  /** Один кадр: джойстик, напрямки осей на екрані, час кадру (с) → крок або null. */
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
      if (!axis) axis = pickAxis(stick, screen);
      if (!axis) return null;
      const velocity = axisVelocity(stick, screen[axis]);
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
