import { describe, expect, it } from 'vitest';
import {
  axisVelocity,
  createStickController,
  movePoint,
  NUDGE_DEAD_ZONE,
  NUDGE_MAX_DT_S,
  NUDGE_MAX_MM_S,
  NUDGE_MIN_MM_S,
  nudgeSpeed,
  pickAxis,
  sliderStep,
  sliderVelocity,
} from '../../src/core/nudge.ts';

/** Вигляд згори-збоку: +X на екрані вправо-вниз, +Z вліво-вниз (як стартова камера). */
const OBLIQUE = { X: { x: 90, y: 30 }, Z: { x: -70, y: 40 } };
/** Вигляд прямо згори: +X вправо, +Z вниз. */
const TOP = { X: { x: 100, y: 0 }, Z: { x: 0, y: 100 } };
/** Дивимось уздовж Z (спереду): Z «дивиться в камеру» — майже точка. */
const FRONT = { X: { x: 100, y: 0 }, Z: { x: 0.5, y: -2 } };

describe('швидкість від сили відхилення', () => {
  it('мертва зона — 0; одразу за нею — 5 мм/с; до краю — 500 мм/с (0,5 м/с)', () => {
    expect(nudgeSpeed(0)).toBe(0);
    expect(nudgeSpeed(NUDGE_DEAD_ZONE)).toBe(0);
    expect(nudgeSpeed(NUDGE_DEAD_ZONE + 1e-9)).toBeCloseTo(NUDGE_MIN_MM_S, 3);
    expect(NUDGE_MIN_MM_S).toBe(5);
    expect(NUDGE_MAX_MM_S).toBe(500);
    expect(nudgeSpeed(1)).toBeCloseTo(500, 9);
    expect(nudgeSpeed(5)).toBeCloseTo(500, 9); // більше за край — як край
    expect(nudgeSpeed(-1)).toBeCloseTo(500, 9);
  });

  it('плавно зростає (чим сильніше — тим швидше)', () => {
    let previous = 0;
    for (let d = 0.11; d <= 1; d += 0.01) {
      const speed = nudgeSpeed(d);
      expect(speed).toBeGreaterThan(previous);
      previous = speed;
    }
    // Посередині — десятки мм/с: зручно доводити.
    expect(nudgeSpeed(0.55)).toBeCloseTo(50, 6);
  });

  it('NaN — 0, а не «NaN мм»', () => {
    expect(nudgeSpeed(Number.NaN)).toBe(0);
  });
});

describe('вибір осі за напрямком на екрані', () => {
  it('тягну туди, куди на екрані дивиться стрілка — та вісь і вибирається', () => {
    expect(pickAxis({ x: 0.9, y: 0.3 }, OBLIQUE)).toBe('X');
    expect(pickAxis({ x: -0.8, y: 0.45 }, OBLIQUE)).toBe('Z');
    // Протилежний бік — та сама вісь (рух у мінус).
    expect(pickAxis({ x: -0.9, y: -0.3 }, OBLIQUE)).toBe('X');
    expect(pickAxis({ x: 0.5, y: 0 }, TOP)).toBe('X');
    expect(pickAxis({ x: 0, y: -0.5 }, TOP)).toBe('Z');
  });

  it('діагональ — одна вісь (ближча), ніколи дві', () => {
    expect(pickAxis({ x: 0.6, y: 0.5 }, TOP)).toBe('X');
    expect(pickAxis({ x: 0.5, y: 0.6 }, TOP)).toBe('Z');
  });

  it('у мертвій зоні — нічого', () => {
    expect(pickAxis({ x: 0.05, y: 0.05 }, TOP)).toBeNull();
  });

  it('вісь, що «дивиться в камеру», не вибирається', () => {
    expect(pickAxis({ x: 0, y: -0.9 }, FRONT)).toBe('X');
  });
});

describe('швидкість уздовж вибраної осі', () => {
  it('знак — за напрямком стрілки осі на екрані', () => {
    expect(axisVelocity({ x: 1, y: 0 }, TOP.X)).toBeCloseTo(500, 6);
    expect(axisVelocity({ x: -1, y: 0 }, TOP.X)).toBeCloseTo(-500, 6);
    expect(axisVelocity({ x: 0, y: 1 }, TOP.Z)).toBeCloseTo(500, 6);
  });

  it('поперек осі — точка стоїть', () => {
    expect(axisVelocity({ x: 0, y: 1 }, TOP.X)).toBe(0);
  });
});

describe('рух лише по одній осі', () => {
  const p = { x: 1.2345, y: 0.5, z: -2.25 };

  it('X: змінюється лише x (на 12,5 мм), y і z — рівно як були', () => {
    const q = movePoint(p, 'X', 12.5);
    expect(q.x).toBeCloseTo(1.247, 12);
    expect(q.y).toBe(p.y);
    expect(q.z).toBe(p.z);
  });

  it('Z і Y так само', () => {
    expect(movePoint(p, 'Z', -100)).toEqual({ x: p.x, y: p.y, z: p.z - 0.1 });
    const q = movePoint(p, 'Y', 1);
    expect(q.x).toBe(p.x);
    expect(q.z).toBe(p.z);
    expect(q.y).toBeCloseTo(0.501, 12);
  });
});

describe('джойстик між кадрами', () => {
  it('вісь фіксується при першому русі й не змінюється, навіть якщо потім тягнути вбік', () => {
    const c = createStickController();
    expect(c.update({ x: 0.05, y: 0 }, TOP, 0.016)).toBeNull(); // мертва зона
    expect(c.axis).toBeNull();
    const first = c.update({ x: 0.8, y: 0.1 }, TOP, 0.016)!;
    expect(first.axis).toBe('X');
    expect(first.deltaMm).toBeGreaterThan(0);
    // Повели палець майже вертикально — вісь лишається X, рух по Z не починається.
    const second = c.update({ x: 0.2, y: 0.9 }, TOP, 0.016);
    expect(c.axis).toBe('X');
    expect(second?.axis ?? 'X').toBe('X');
    c.release();
    expect(c.axis).toBeNull();
    expect(c.update({ x: 0.1, y: 0.9 }, TOP, 0.016)!.axis).toBe('Z');
  });

  it('за секунду до краю — 500 мм; ледь відхилив — кілька мм', () => {
    const fast = createStickController();
    let total = 0;
    for (let i = 0; i < 60; i++) total += fast.update({ x: 1, y: 0 }, TOP, 1 / 60)?.deltaMm ?? 0;
    expect(total).toBeCloseTo(500, 6);

    const slow = createStickController();
    let small = 0;
    for (let i = 0; i < 60; i++) small += slow.update({ x: 0.12, y: 0 }, TOP, 1 / 60)?.deltaMm ?? 0;
    expect(small).toBeGreaterThan(4);
    expect(small).toBeLessThan(7);
  });

  it('довга пауза між кадрами не дає стрибка', () => {
    const c = createStickController();
    const step = c.update({ x: 1, y: 0 }, TOP, 5)!;
    expect(step.deltaMm).toBeCloseTo(NUDGE_MAX_MM_S * NUDGE_MAX_DT_S, 6);
  });
});

describe('повзунок Y', () => {
  it('вгору — +Y, вниз — −Y, у мертвій зоні — нічого', () => {
    expect(sliderVelocity(1)).toBeCloseTo(500, 6);
    expect(sliderVelocity(-1)).toBeCloseTo(-500, 6);
    expect(sliderStep(0.05, 0.016)).toBeNull();
    const step = sliderStep(-0.5, 0.1)!;
    expect(step.axis).toBe('Y');
    expect(step.deltaMm).toBeLessThan(0);
  });
});
