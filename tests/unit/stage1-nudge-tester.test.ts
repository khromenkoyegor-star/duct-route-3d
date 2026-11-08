/**
 * Редактор точки — ядро (src/core/nudge.ts), перевірка від tester «як чорна скринька» за вимогами:
 *  - джойстик рухає точку лише по ОДНІЙ осі X або Z за раз, по діагоналі — ніколи, Y — ніколи;
 *  - вісь — «як на екрані» (у бік стрілки), фіксується до відпускання; якщо стрілки X і Z на екрані
 *    зливаються (< 35°) або одна «дивиться в камеру» — на джойстику їх розводять, обидві досяжні;
 *  - швидкість: мертва зона, одразу за нею ≈ 5 мм/с, до краю — 0,5 м/с, більше — ніколи;
 *  - довге утримання: дві інші координати рівно ті самі (дрейф = 0);
 *  - великий крок часу (вкладка у фоні) — не більше 0,1 с руху.
 *
 * Екранні напрямки осей рахуємо простою моделлю камери (поворот навколо Y + нахил), без Three.js.
 */
import { describe, expect, it } from 'vitest';
import {
  axisVelocity,
  createStickController,
  type HorizontalAxis,
  joystickDirections,
  movePoint,
  NUDGE_DEAD_ZONE,
  NUDGE_MAX_DT_S,
  NUDGE_MAX_MM_S,
  NUDGE_MIN_MM_S,
  type NudgeStep,
  nudgeSpeed,
  pickAxis,
  type PointM,
  sliderStep,
  sliderVelocity,
  type Vec2,
} from '../../src/core/nudge.ts';
import { mmToM, mToMm } from '../../src/core/units.ts';
import { lcg } from '../fixtures/gltf-builder.ts';

type V3 = [number, number, number];

const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * Камера: yaw — поворот навколо Y (рад), pitch — нахил (рад; + дивиться вниз, − вгору, ±π/2 — строго).
 * Повертає напрямки світових осей на екрані (px, y — вниз), як Viewer.screenAxes (ортографічно).
 */
function screenOf(yaw: number, pitch: number, scale = 100): Record<HorizontalAxis, Vec2> {
  const forward: V3 = [-Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
  const right: V3 = [Math.cos(yaw), 0, -Math.sin(yaw)];
  const up = cross(right, forward);
  const axis = (a: V3): Vec2 => ({ x: dot3(a, right) * scale, y: -dot3(a, up) * scale });
  return { X: axis([1, 0, 0]), Z: axis([0, 0, 1]) };
}

const len = (v: Vec2) => Math.hypot(v.x, v.y);
const unit = (v: Vec2): Vec2 => ({ x: v.x / len(v), y: v.y / len(v) });
const scaled = (v: Vec2, k: number): Vec2 => ({ x: v.x * k, y: v.y * k });
const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
/** Кут між ЛІНІЯМИ (0…90°). */
const lineAngleDeg = (a: Vec2, b: Vec2) => (Math.acos(Math.min(1, Math.abs(dot(unit(a), unit(b))))) * 180) / Math.PI;
/** «Звичайний» вид: стрілки X і Z добре розведені й жодна не «дивиться в камеру» (із запасом від порогів). */
const isNormalView = (s: Record<HorizontalAxis, Vec2>) =>
  Math.min(len(s.X), len(s.Z)) >= 0.16 * Math.max(len(s.X), len(s.Z)) && lineAngleDeg(s.X, s.Z) >= 36;
/** Стрілки явно злилися (< 34°) або одна явно «в камеру» (< 14 % довшої) — із запасом від порогів. */
const isMergedView = (s: Record<HorizontalAxis, Vec2>) =>
  Math.min(len(s.X), len(s.Z)) < 0.14 * Math.max(len(s.X), len(s.Z)) || lineAngleDeg(s.X, s.Z) < 34;

/** Камери: звичайні, згори, знизу (камера під точкою), уздовж осей, з кута на рівні очей, з протилежного боку. */
const rnd0 = lcg(20261108);
const VIEWS: Array<[string, number, number]> = [
  ['збоку-згори', 0.6, 0.5],
  ['строго згори', 0, Math.PI / 2 - 1e-6],
  ['строго знизу (камера під точкою)', 0.3, -Math.PI / 2 + 1e-6],
  ['рівень очей уздовж −Z (Z у камеру)', 0, 0],
  ['рівень очей уздовж −X (X у камеру)', Math.PI / 2, 0],
  ['рівень очей з кута 45° (X і Z на одній лінії)', Math.PI / 4, 0],
  ['з протилежного боку', Math.PI, 0.4],
  ['знизу-збоку', -2.2, -0.7],
];
for (let i = 0; i < 80; i++) VIEWS.push([`випадковий ${i}`, (rnd0() - 0.5) * 4 * Math.PI, (rnd0() - 0.5) * Math.PI * 0.999]);

describe('швидкість (мертва зона · одразу за нею ≈ 5 мм/с · максимум 0,5 м/с)', () => {
  it('константи', () => {
    // Єгор просив «мертва зона 0,1»; за UX-рецензією зроблено 0,15 (≈ 10 px при ході 64 px) — див. звіт.
    expect(NUDGE_DEAD_ZONE).toBeGreaterThanOrEqual(0.1);
    expect(NUDGE_DEAD_ZONE).toBeLessThanOrEqual(0.15);
    expect(NUDGE_MIN_MM_S).toBe(5);
    expect(NUDGE_MAX_MM_S).toBe(500);
  });

  it('у мертвій зоні — рівно 0, з обох боків', () => {
    for (const k of [0, 0.1, 0.5, 0.9, 0.999, 1]) {
      const d = NUDGE_DEAD_ZONE * k;
      expect(Math.abs(nudgeSpeed(d)), String(d)).toBe(0);
      expect(Math.abs(nudgeSpeed(-d)), String(-d)).toBe(0);
    }
  });

  it('одразу за мертвою зоною — ≈ 5 мм/с, а не стрибок до десятків', () => {
    expect(nudgeSpeed(NUDGE_DEAD_ZONE + 1e-6)).toBeGreaterThanOrEqual(5);
    expect(nudgeSpeed(NUDGE_DEAD_ZONE + 1e-6)).toBeLessThan(5.01);
    // Перший цілий піксель за мертвою зоною при ході 64 px — усе ще ≈ 5 мм/с.
    const firstPx = Math.ceil(NUDGE_DEAD_ZONE * 64 + 1e-9);
    expect(nudgeSpeed(firstPx / 64)).toBeLessThan(5.5);
  });

  it('ніколи не більше 0,5 м/с — навіть далеко за краєм джойстика', () => {
    for (const d of [0.99, 1, 1.0001, 2, 100, Number.POSITIVE_INFINITY, -1, -100, Number.NEGATIVE_INFINITY]) {
      const v = nudgeSpeed(d);
      expect(v, String(d)).toBeLessThanOrEqual(NUDGE_MAX_MM_S + 1e-9);
      expect(v, String(d)).toBeGreaterThan(400);
    }
    expect(nudgeSpeed(1)).toBeCloseTo(NUDGE_MAX_MM_S, 9);
  });

  it('монотонно росте від мертвої зони до краю (сильніше — швидше), без провалів і стрибків', () => {
    let prev = 0;
    for (let i = 1; i <= 1000; i++) {
      const d = NUDGE_DEAD_ZONE + ((1 - NUDGE_DEAD_ZONE) * i) / 1000;
      const v = nudgeSpeed(d);
      expect(v).toBeGreaterThan(prev);
      // Плавно: сусідні значення (крок < 0,001 ходу) відрізняються не більше ніж на 2 %.
      if (prev > 0) expect(v / prev).toBeLessThan(1.02);
      prev = v;
    }
  });

  it('повзунок: та сама крива, знак = напрямок (вгору +Y)', () => {
    for (const d of [0.2, 0.5, 0.9, 1]) {
      expect(sliderVelocity(d)).toBeCloseTo(nudgeSpeed(d), 9);
      expect(sliderVelocity(-d)).toBeCloseTo(-nudgeSpeed(d), 9);
    }
    // −0 і 0 — однаково «стоїть».
    expect(Math.abs(sliderVelocity(NUDGE_DEAD_ZONE / 2))).toBe(0);
    expect(Math.abs(sliderVelocity(-NUDGE_DEAD_ZONE / 2))).toBe(0);
  });
});

describe('напрямки осей на джойстику — з будь-якого положення камери', () => {
  it('завжди дві скінченні одиничні стрілки, розведені щонайменше на 35° — обидві осі досяжні', () => {
    for (const [name, yaw, pitch] of VIEWS) {
      const dirs = joystickDirections(screenOf(yaw, pitch));
      for (const axis of ['X', 'Z'] as const) {
        expect(Number.isFinite(dirs[axis].x) && Number.isFinite(dirs[axis].y), name).toBe(true);
        expect(Math.abs(len(dirs[axis]) - 1), name).toBeLessThan(1e-9);
      }
      expect(lineAngleDeg(dirs.X, dirs.Z), name).toBeGreaterThanOrEqual(35 - 1e-6);
    }
  });

  it('звичайний вид (стрілки добре розведені): на джойстику — рівно як стрілки біля точки', () => {
    let checked = 0;
    for (const [name, yaw, pitch] of VIEWS) {
      const s = screenOf(yaw, pitch);
      if (!isNormalView(s)) continue;
      checked++;
      const dirs = joystickDirections(s);
      for (const axis of ['X', 'Z'] as const) {
        expect(Math.abs(dirs[axis].x - unit(s[axis]).x), `${name} ${axis}`).toBeLessThan(1e-9);
        expect(Math.abs(dirs[axis].y - unit(s[axis]).y), `${name} ${axis}`).toBeLessThan(1e-9);
      }
    }
    expect(checked).toBeGreaterThan(30);
  });

  it('стрілки злилися або одна «у камеру»: довша — як на екрані, коротша — перпендикулярно, у бік своєї стрілки', () => {
    let checked = 0;
    for (const [name, yaw, pitch] of VIEWS) {
      const s = screenOf(yaw, pitch);
      const dirs = joystickDirections(s);
      const strong: HorizontalAxis = len(s.X) >= len(s.Z) ? 'X' : 'Z';
      const weak: HorizontalAxis = strong === 'X' ? 'Z' : 'X';
      // Довша вісь — завжди як на екрані.
      expect(dot(dirs[strong], unit(s[strong])), name).toBeGreaterThan(1 - 1e-9);
      // Коротша — ніколи не проти своєї справжньої стрілки.
      if (len(s[weak]) > 1e-6) expect(dot(dirs[weak], s[weak]), name).toBeGreaterThanOrEqual(-1e-9);
      if (!isMergedView(s)) continue;
      checked++;
      expect(Math.abs(dot(dirs.X, dirs.Z)), `${name}: перпендикулярно`).toBeLessThan(1e-9);
    }
    expect(checked).toBeGreaterThanOrEqual(3);
  });

  it('вісь «точно в камеру» (нульова стрілка) — на джойстику «вгору»', () => {
    const s = screenOf(0, 0); // рівень очей уздовж −Z: Z — точка
    expect(len(s.Z)).toBeLessThan(1e-9);
    const dirs = joystickDirections(s);
    expect(dirs.Z.y).toBeLessThan(-0.999);
  });
});

describe('джойстик між кадрами: одна вісь, «як на екрані», фіксація до відпускання', () => {
  it('з будь-якої камери: тягну вздовж стрілки осі на джойстику — вибирається саме вона, рух у плюс; назад — у мінус', () => {
    for (const [name, yaw, pitch] of VIEWS) {
      const s = screenOf(yaw, pitch);
      const dirs = joystickDirections(s);
      for (const axis of ['X', 'Z'] as const) {
        const step = createStickController().update(scaled(dirs[axis], 0.9), s, 1 / 60);
        expect(step?.axis, `${name}: ${axis}`).toBe(axis);
        expect(step!.deltaMm, `${name}: ${axis}`).toBeGreaterThan(0);
        const stepBack = createStickController().update(scaled(dirs[axis], -0.9), s, 1 / 60);
        expect(stepBack?.axis, `${name}: −${axis}`).toBe(axis);
        expect(stepBack!.deltaMm, `${name}: −${axis}`).toBeLessThan(0);
      }
    }
  });

  it('тягну вздовж стрілки на джойстику — точка на екрані ніколи не їде проти пальця', () => {
    for (const [name, yaw, pitch] of VIEWS) {
      const s = screenOf(yaw, pitch);
      const dirs = joystickDirections(s);
      for (const axis of ['X', 'Z'] as const) {
        for (const sign of [1, -1]) {
          const stick = scaled(dirs[axis], 0.8 * sign);
          const step = createStickController().update(stick, s, 1 / 60)!;
          const screenMove = scaled(s[step.axis as HorizontalAxis], step.deltaMm);
          expect(dot(screenMove, stick), `${name} ${sign > 0 ? '+' : '−'}${axis}`).toBeGreaterThanOrEqual(-1e-9);
        }
      }
    }
  });

  it('звичайний вид: будь-який напрямок пальця — точка на екрані не їде проти пальця', () => {
    const rnd = lcg(5);
    for (const [name, yaw, pitch] of VIEWS) {
      const s = screenOf(yaw, pitch);
      if (!isNormalView(s)) continue;
      for (let k = 0; k < 30; k++) {
        const a = rnd() * Math.PI * 2;
        const stick = { x: Math.cos(a) * 0.8, y: Math.sin(a) * 0.8 };
        const step = createStickController().update(stick, s, 1 / 60);
        if (!step) continue;
        expect(dot(scaled(s[step.axis as HorizontalAxis], step.deltaMm), stick), name).toBeGreaterThanOrEqual(-1e-9);
      }
    }
  });

  it('у мертвій зоні: вісь не вибирається і точка стоїть, скільки б кадрів не минуло', () => {
    const s = screenOf(0.6, 0.6);
    const c = createStickController();
    for (let i = 0; i < 600; i++) {
      const a = i * 0.37;
      const m = NUDGE_DEAD_ZONE * 0.95;
      expect(c.update({ x: Math.cos(a) * m, y: Math.sin(a) * m }, s, 1 / 60)).toBeNull();
    }
    expect(c.axis).toBeNull();
    expect(pickAxis({ x: NUDGE_DEAD_ZONE * 0.7, y: NUDGE_DEAD_ZONE * 0.7 }, joystickDirections(s))).toBeNull();
  });

  it('2000 випадкових утримань з обертанням камери між кадрами: кожен крок — одна вісь X або Z, та сама до release()', () => {
    const rnd = lcg(42);
    for (let hold = 0; hold < 2000; hold++) {
      const c = createStickController();
      let yaw = rnd() * 6.28;
      let pitch = (rnd() - 0.5) * 3;
      let locked: string | null = null;
      for (let f = 0; f < 30; f++) {
        // Палець «гуляє», камера крутиться (другим пальцем) — вісь не має перескочити.
        const a = rnd() * 6.28;
        const m = rnd();
        yaw += (rnd() - 0.5) * 0.3;
        pitch = Math.max(-1.5, Math.min(1.5, pitch + (rnd() - 0.5) * 0.3));
        const step = c.update({ x: Math.cos(a) * m, y: Math.sin(a) * m }, screenOf(yaw, pitch), rnd() * 0.05);
        if (c.axis) {
          if (!locked) locked = c.axis;
          expect(c.axis).toBe(locked);
        }
        if (step) {
          expect(step.axis).toBe(locked);
          expect(step.axis === 'X' || step.axis === 'Z').toBe(true);
          expect(Number.isFinite(step.deltaMm)).toBe(true);
          expect(Math.abs(step.deltaMm)).toBeLessThanOrEqual(NUDGE_MAX_MM_S * 0.05 + 1e-9);
        }
      }
      c.release();
      expect(c.axis).toBeNull();
    }
  });

  it('вісь зафіксована, палець повернувся в мертву зону — точка стоїть; повели до іншої осі — та сама вісь', () => {
    const s = screenOf(0.6, 0.6);
    const dirs = joystickDirections(s);
    const c = createStickController();
    expect(c.update(scaled(dirs.X, 0.9), s, 0.016)?.axis).toBe('X');
    expect(c.update(scaled(dirs.X, NUDGE_DEAD_ZONE * 0.5), s, 0.016)).toBeNull();
    expect(c.axis).toBe('X');
    const step = c.update(scaled(dirs.Z, 1), s, 0.016);
    if (step) expect(step.axis).toBe('X');
  });

  it('вид з кута (стрілки X і Z майже однакові й на одній лінії): крихітна зміна виду під час утримання не «перекидає» напрямок осі', () => {
    // Точка їде по X → перспектива трохи змінює довжини стрілок → «довшою» стає Z.
    // Палець нерухомий, вісь зафіксована (X) — точка має їхати далі з тією ж швидкістю, а не зупинитись чи поїхати назад.
    const before = { X: { x: 100, y: 1 }, Z: { x: -99.9, y: 1.5 } };
    const after = { X: { x: 99.9, y: 1 }, Z: { x: -100, y: 1.5 } };
    const stick = scaled(joystickDirections(before).X, 0.8);
    const c = createStickController();
    const s1 = c.update(stick, before, 1 / 60)!;
    expect(s1.axis).toBe('X');
    const s2 = c.update(stick, after, 1 / 60);
    expect(s2?.axis, 'другий кадр: вісь та сама').toBe('X');
    expect((s2?.deltaMm ?? 0) / s1.deltaMm, 'швидкість на другому кадрі відносно першого').toBeGreaterThan(0.5);
  });

  it('усі осі «за камерою» (нульові вектори): без NaN, не більше однієї осі', () => {
    const zero = { X: { x: 0, y: 0 }, Z: { x: 0, y: 0 } };
    for (const stick of [{ x: 1, y: 0 }, { x: 0, y: -1 }, { x: 0.7, y: 0.7 }]) {
      const step = createStickController().update(stick, zero, 0.016);
      if (step) {
        expect(['X', 'Z']).toContain(step.axis);
        expect(Number.isFinite(step.deltaMm)).toBe(true);
      }
    }
    expect(axisVelocity({ x: 1, y: 0 }, { x: 0, y: 0 })).toBe(0);
  });

  it('великий крок часу (вкладка у фоні 10 с, Infinity) — не більше 0,1 с руху на максимумі (50 мм)', () => {
    const s = screenOf(0, Math.PI / 2 - 1e-6);
    expect(NUDGE_MAX_MM_S * NUDGE_MAX_DT_S).toBe(50);
    for (const dt of [0.5, 10, 3600, Number.POSITIVE_INFINITY]) {
      const step = createStickController().update({ x: 5, y: 0 }, s, dt)!;
      expect(Math.abs(step.deltaMm)).toBeLessThanOrEqual(NUDGE_MAX_MM_S * NUDGE_MAX_DT_S + 1e-9);
      expect(Math.abs(sliderStep(1, dt)!.deltaMm)).toBeLessThanOrEqual(50 + 1e-9);
    }
  });

  it('нульовий і від’ємний крок часу (годинник «назад») — без руху', () => {
    const s = screenOf(0.6, 0.6);
    const c = createStickController();
    expect(c.update({ x: 1, y: 0 }, s, 0)).toBeNull();
    expect(c.update({ x: 1, y: 0 }, s, -0.5)).toBeNull();
    expect(sliderStep(1, 0)).toBeNull();
    expect(sliderStep(1, -1)).toBeNull();
  });

  it('пошкоджені дані кадру (NaN у часі чи значенні повзунка) — крок null або скінченний, а не NaN', () => {
    // Редактор потім працюватиме з точками траси: NaN у кроці → movePoint кидає RangeError посеред кадру,
    // цикл анімації обривається, а джойстик лишається «натиснутим».
    const s = screenOf(0.6, 0.6);
    const fromNanDt: NudgeStep | null = createStickController().update({ x: 1, y: 0 }, s, Number.NaN);
    if (fromNanDt) expect(Number.isFinite(fromNanDt.deltaMm), 'update(dt = NaN)').toBe(true);
    const fromNanSlider = sliderStep(Number.NaN, 0.016);
    if (fromNanSlider) expect(Number.isFinite(fromNanSlider.deltaMm), 'sliderStep(NaN)').toBe(true);
    expect(Number.isNaN(sliderVelocity(Number.NaN)), 'sliderVelocity(NaN)').toBe(false);
  });
});

describe('точність і накопичення: дві інші координати — рівно ті самі', () => {
  it('movePoint не змінює вхідну точку; нульовий зсув — та сама точка; від’ємний — у мінус', () => {
    const p: PointM = { x: 0.1, y: 0.2, z: 0.3 };
    const frozen = Object.freeze({ ...p });
    const q = movePoint(frozen, 'X', 5);
    expect(q.x).toBeCloseTo(0.105, 12);
    expect(q.y).toBe(0.2);
    expect(q.z).toBe(0.3);
    expect(frozen).toEqual(p);
    expect(movePoint(p, 'Z', 0)).toEqual(p);
    expect(movePoint(p, 'Y', -200).y).toBeCloseTo(0, 12);
  });

  it('60 с утримання при 60 к/с (камера крутиться, палець тремтить): Y і Z бітово ті самі, X = старт + Σ кроків', () => {
    const rnd = lcg(7);
    const start: PointM = { x: 1.2345678, y: 1.1, z: -0.9876543 };
    let p = start;
    const c = createStickController();
    let sumMm = 0;
    let yaw = 0.7;
    const frames = 60 * 60;
    for (let f = 0; f < frames; f++) {
      yaw += 0.002;
      const s = screenOf(yaw, 0.6);
      // Тягнемо приблизно вздовж стрілки X на джойстику з тремтінням ±15°.
      const dir = joystickDirections(s).X;
      const base = Math.atan2(dir.y, dir.x) + (f === 0 ? 0 : (rnd() - 0.5) * 0.5);
      const m = 0.35 + rnd() * 0.65;
      const step = c.update({ x: Math.cos(base) * m, y: Math.sin(base) * m }, s, 1 / 60 + (rnd() - 0.5) * 0.004);
      if (!step) continue;
      expect(step.axis).toBe('X');
      sumMm += step.deltaMm;
      p = movePoint(p, step.axis, step.deltaMm);
      expect(p.y).toBe(start.y);
      expect(p.z).toBe(start.z);
    }
    expect(Math.abs(sumMm)).toBeGreaterThan(1000);
    // Накопичена похибка додавання — значно менша за 0,1 мм.
    expect(Math.abs(mToMm(p.x - start.x) - sumMm)).toBeLessThan(1e-6);
    // Швидкість не перевищила 0,5 м/с.
    expect(Math.abs(sumMm)).toBeLessThanOrEqual(NUDGE_MAX_MM_S * frames * (1 / 60 + 0.002) + 1e-6);
  });

  it('повзунок 30 с: X і Z бітово ті самі', () => {
    const start: PointM = { x: -0.3333333, y: 0, z: 2.7182818 };
    let p = start;
    for (let f = 0; f < 1800; f++) {
      const step = sliderStep(f % 200 < 100 ? 0.7 : -0.4, 1 / 60);
      if (!step) continue;
      expect(step.axis).toBe('Y');
      p = movePoint(p, 'Y', step.deltaMm);
    }
    expect(p.x).toBe(start.x);
    expect(p.z).toBe(start.z);
    expect(p.y).not.toBe(start.y);
  });

  it('1000 кроків по 0,1 мм = рівно 100 мм (±0,1 мм — з величезним запасом)', () => {
    let p: PointM = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 1000; i++) p = movePoint(p, 'Z', 0.1);
    expect(Math.abs(mToMm(p.z) - 100)).toBeLessThan(1e-6);
    expect(p.z).toBeCloseTo(mmToM(100), 12);
  });
});
