/**
 * Етап 4.1: джойстик у режимі 45°. Точка йде по діагоналі, тож на екрані — уздовж суми стрілок
 * основної й другої осі; джойстик веде її за цим напрямком (а не лише за стрілкою основної осі).
 */
import { describe, expect, it } from 'vitest';
import { axisVelocity, diagonalScreenDirection, diagonalStep, NUDGE_MAX_DT_S, type Vec2 } from '../../src/core/nudge';

const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;

describe('режим 45°: напрямок діагоналі на екрані', () => {
  // Камера з кута +X+Z: стрілка X+ — вправо-вниз, Z+ — вліво-вниз (тупий кут між ними).
  const X: Vec2 = { x: 60, y: 25 };
  const Z: Vec2 = { x: -55, y: 30 };

  it('основна вісь у плюс, друга в плюс: сума стрілок; у мінус — різниця', () => {
    expect(diagonalScreenDirection(X, Z, 1, 1)).toEqual({ x: 5, y: 55 });
    expect(diagonalScreenDirection(X, Z, 1, -1)).toEqual({ x: 115, y: -5 });
  });

  it('точка по основній осі з мінусового боку: друга координата зменшується, коли основна зростає', () => {
    // Відрізок X−, Z+: зростання X веде назад до початку — Z при цьому теж зменшується.
    expect(diagonalScreenDirection(X, Z, -1, 1)).toEqual({ x: 115, y: -5 });
    expect(diagonalScreenDirection(X, Z, -1, -1)).toEqual({ x: 5, y: 55 });
  });

  it('поштовх у бік будь-якої з двох підсвічених стрілок веде точку вперед (геть від початку)', () => {
    for (const side of [1, -1] as const) {
      for (const sign of [1, -1] as const) {
        const plusMain = diagonalScreenDirection(X, Z, side, sign);
        // «Вперед» — у бік руху від початку: для основної осі це її бік `side`.
        const forward = { x: side * plusMain.x, y: side * plusMain.y };
        const mainArrow = { x: side * X.x, y: side * X.y };
        const secondArrow = { x: sign * Z.x, y: sign * Z.y };
        expect(dot(forward, mainArrow), `side ${side}, sign ${sign}: стрілка основної`).toBeGreaterThan(0);
        expect(dot(forward, secondArrow), `side ${side}, sign ${sign}: стрілка другої`).toBeGreaterThan(0);
      }
    }
  });

  it('діагональ «у камеру» (на екрані майже точка): джойстик угору веде геть від початку', () => {
    const into = diagonalScreenDirection({ x: 40, y: 10 }, { x: -39.5, y: -10.2 }, 1, 1);
    expect(into).toEqual({ x: 0, y: -1 });
    expect(diagonalScreenDirection({ x: 40, y: 10 }, { x: -39.5, y: -10.2 }, -1, -1)).toEqual({ x: 0, y: 1 });
    // Обидві стрілки нульові (точка за камерою) — теж без NaN.
    expect(diagonalScreenDirection({ x: 0, y: 0 }, { x: 0, y: 0 }, 1, 1)).toEqual({ x: 0, y: -1 });
  });
});

describe('режим 45°: крок джойстика', () => {
  const along: Vec2 = { x: 5, y: 55 };

  it('поштовх уздовж діагоналі — та сама швидкість, що й уздовж осі; навпаки — назад', () => {
    const l = Math.hypot(along.x, along.y);
    const stick = { x: along.x / l, y: along.y / l };
    const step = diagonalStep(stick, along, 0.05);
    expect(step).toBeGreaterThan(0);
    expect(step).toBeCloseTo(axisVelocity({ x: 1, y: 0 }, { x: 1, y: 0 }) * 0.05, 9);
    expect(diagonalStep({ x: -stick.x, y: -stick.y }, along, 0.05)).toBeCloseTo(-step, 9);
  });

  it('поперек діагоналі (мертва зона) — точка стоїть; NaN і від’ємний час — теж', () => {
    expect(diagonalStep({ x: -55, y: 5 }, along, 0.05)).toBe(0);
    expect(diagonalStep({ x: Number.NaN, y: 1 }, along, 0.05)).toBe(0);
    expect(diagonalStep({ x: 0, y: 1 }, along, -1)).toBe(0);
  });

  it('довгий кадр обмежено, як і без 45°', () => {
    const one = diagonalStep({ x: 0, y: 1 }, along, NUDGE_MAX_DT_S);
    expect(diagonalStep({ x: 0, y: 1 }, along, 5)).toBeCloseTo(one, 9);
  });
});
