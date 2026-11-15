/**
 * Етап 4.1: відрізки під 45° і правило поворотів (45° або 90°).
 */
import { describe, expect, it } from 'vitest';
import {
  addRoute,
  canAppendNode,
  diagonalOptions,
  emptyRouteSet,
  headingUnit,
  isValidRoute,
  lastHeading,
  type P3,
  segmentHeading,
  stepAlongSegment,
  toMm,
  turnAllowed,
} from '../../src/core/route.ts';

const S = Math.SQRT1_2;
const O = { x: 0, y: 0, z: 0 };

describe('напрямок відрізка: вісь або 45°', () => {
  it('уздовж осі — одна складова; під 45° — дві однакові; інший нахил — не за правилами', () => {
    expect(segmentHeading(O, { x: 1000, y: 0, z: 0 })?.parts).toEqual([{ axis: 'X', sign: 1 }]);
    const d = segmentHeading(O, { x: 1000, y: 0, z: -1000 })!;
    expect(d.parts).toEqual([
      { axis: 'X', sign: 1 },
      { axis: 'Z', sign: -1 },
    ]);
    expect(d.unit.x).toBeCloseTo(S, 12);
    expect(d.unit.z).toBeCloseTo(-S, 12);
    expect(d.unit.y).toBe(0);
    // Підйом під 45°: X і Y.
    expect(segmentHeading(O, { x: -500, y: 500, z: 0 })?.parts).toEqual([
      { axis: 'X', sign: -1 },
      { axis: 'Y', sign: 1 },
    ]);
    expect(segmentHeading(O, { x: 1000, y: 0, z: 600 })).toBeNull();
    expect(segmentHeading(O, { x: 1000, y: 1000, z: 1000 })).toBeNull();
    expect(segmentHeading(O, O)).toBeNull();
  });

  it('допуск ±0,1 мм: 1000 і 1000,08 — ще 45°; 1000 і 1000,3 — ні', () => {
    expect(segmentHeading(O, { x: 1000, y: 0, z: 1000.08 }, 0.1)?.parts).toHaveLength(2);
    expect(segmentHeading(O, { x: 1000, y: 0, z: 1000.3 }, 0.1)).toBeNull();
    // Друга координата в межах допуску — відрізок уздовж осі.
    expect(segmentHeading(O, { x: 1000, y: 0, z: 0.08 }, 0.1)?.parts).toEqual([{ axis: 'X', sign: 1 }]);
  });
});

describe('правило поворотів: прямо, 45° або 90°', () => {
  const X = headingUnit([{ axis: 'X', sign: 1 }]);
  const diag = (a: 'X' | 'Y' | 'Z', sa: 1 | -1, b: 'X' | 'Y' | 'Z', sb: 1 | -1) =>
    headingUnit([
      { axis: a, sign: sa },
      { axis: b, sign: sb },
    ]);

  it('дозволено: прямо, 45°, 90°', () => {
    expect(turnAllowed(X, X)).toBe(true);
    expect(turnAllowed(X, diag('X', 1, 'Z', 1))).toBe(true); // 45° у горизонталі
    expect(turnAllowed(X, diag('X', 1, 'Y', 1))).toBe(true); // 45° на підйом
    expect(turnAllowed(X, headingUnit([{ axis: 'Z', sign: -1 }]))).toBe(true); // 90°
    expect(turnAllowed(diag('X', 1, 'Z', 1), X)).toBe(true); // з діагоналі назад на вісь — 45°
    expect(turnAllowed(diag('X', 1, 'Z', 1), diag('X', 1, 'Z', -1))).toBe(true); // діагональ → діагональ, 90°
    expect(turnAllowed(X, diag('Y', 1, 'Z', 1))).toBe(true); // 90° у похилій площині
  });

  it('заборонено: назад, 135°, 60°, 120°', () => {
    expect(turnAllowed(X, headingUnit([{ axis: 'X', sign: -1 }]))).toBe(false);
    expect(turnAllowed(X, diag('X', -1, 'Z', 1))).toBe(false); // 135°
    expect(turnAllowed(diag('X', 1, 'Z', 1), headingUnit([{ axis: 'X', sign: -1 }]))).toBe(false); // 135°
    expect(turnAllowed(diag('X', 1, 'Z', 1), diag('X', 1, 'Y', 1))).toBe(false); // 60°
    expect(turnAllowed(diag('X', 1, 'Z', 1), diag('X', -1, 'Y', 1))).toBe(false); // 120°
    expect(turnAllowed(diag('X', 1, 'Z', 1), diag('X', -1, 'Z', -1))).toBe(false); // назад по діагоналі
  });

  it('траса з 45°: «1000 по X → 45° (X+Z) → далі по X» — за правилами; з гострим поворотом — ні', () => {
    const offset = [
      { x: 0, y: 2000, z: 0 },
      { x: 1000, y: 2000, z: 0 },
      { x: 1500, y: 2000, z: 500 },
      { x: 2500, y: 2000, z: 500 },
    ];
    expect(isValidRoute(offset)).toBe(true);
    expect(() => addRoute(emptyRouteSet(), offset)).not.toThrow();
    expect(lastHeading(offset.slice(0, 3))?.parts).toHaveLength(2);
    // Підйом під 45° і далі вгору.
    expect(
      isValidRoute([
        { x: 0, y: 0, z: 0 },
        { x: 1000, y: 0, z: 0 },
        { x: 1700, y: 700, z: 0 },
        { x: 1700, y: 1500, z: 0 },
      ]),
    ).toBe(true);
    // 135°: по X, потім назад-убік.
    expect(isValidRoute([offset[0]!, offset[1]!, { x: 500, y: 2000, z: 500 }])).toBe(false);
    // 60°: діагональ у горизонталі, потім діагональ на підйом.
    expect(isValidRoute([offset[1]!, offset[2]!, { x: 2000, y: 2500, z: 500 }])).toBe(false);
    // Не 45°: зміщення різні.
    expect(isValidRoute([offset[0]!, offset[1]!, { x: 1500, y: 2000, z: 300 }])).toBe(false);
  });

  it('старі траси (лише вздовж осей) лишаються за правилами', () => {
    expect(
      isValidRoute([
        { x: 0, y: 1200, z: 0 },
        { x: 1000, y: 1200, z: 0 },
        { x: 1000, y: 1200, z: 2000 },
        { x: 1000, y: 1700, z: 2000 },
        { x: 1000, y: 1700, z: 2500 },
      ]),
    ).toBe(true);
  });
});

describe('рух точки в режимі 45°', () => {
  const anchor: P3 = { x: 1.25, y: 2, z: -0.4 };
  const Zplus = { axis: 'Z', sign: 1 } as const;

  it('зміщення по другій осі завжди дорівнює ходу по основній; третя координата — рівно як у початку', () => {
    let p = anchor;
    for (let i = 0; i < 4000; i++) p = stepAlongSegment(anchor, p, 'X', 0.00037 * (1 + (i % 7)), null, Zplus);
    expect(p.y).toBe(anchor.y);
    expect(p.x - anchor.x).toBeGreaterThan(1);
    // Обидва зміщення однакові (до похибки округлення) — у мм у межах допуску траси.
    expect(Math.abs(p.x - anchor.x - (p.z - anchor.z))).toBeLessThan(1e-12);
    expect(segmentHeading(toMm(anchor), toMm(p), 0.1)?.parts).toEqual([
      { axis: 'X', sign: 1 },
      { axis: 'Z', sign: 1 },
    ]);
    expect(canAppendNode(anchor, p)).toBe(true);
  });

  it('основна вісь у мінус — друге зміщення все одно у вибраний бік; повернення — зупинка рівно на початку', () => {
    let p = stepAlongSegment(anchor, anchor, 'X', -0.3, null, Zplus);
    expect(p.x).toBeCloseTo(anchor.x - 0.3, 12);
    expect(p.z).toBeCloseTo(anchor.z + 0.3, 12);
    // Крок, що проскакує початок, — зупинка на початку, обидві координати як у початку.
    p = stepAlongSegment(anchor, p, 'X', 0.5, null, Zplus);
    expect(p).toEqual(anchor);
  });

  it('друга вісь не може збігатися з основною; по Y основній — діагональ у вертикальній площині', () => {
    const p = stepAlongSegment(anchor, anchor, 'X', 0.2, null, { axis: 'X', sign: 1 });
    expect(p).toEqual(anchor);
    const up = stepAlongSegment(anchor, anchor, 'Y', 0.25, null, { axis: 'X', sign: -1 });
    expect(up.y).toBeCloseTo(anchor.y + 0.25, 12);
    expect(up.x).toBeCloseTo(anchor.x - 0.25, 12);
    expect(up.z).toBe(anchor.z);
  });

  it('заборонений поворот: після відрізка +X діагональ (−X, +Z) — точка стоїть; (+X, +Z) — їде', () => {
    const previous = headingUnit([{ axis: 'X', sign: 1 }]);
    expect(stepAlongSegment(anchor, anchor, 'X', -0.2, previous, Zplus)).toEqual(anchor); // 135°
    const ok = stepAlongSegment(anchor, anchor, 'X', 0.2, previous, Zplus);
    expect(ok.x).toBeGreaterThan(anchor.x);
    // Після діагоналі (+X, +Z): по осі −X не можна (135°), по +X і +Z — можна (45°), по Y — можна (90°).
    const diagonal = headingUnit([
      { axis: 'X', sign: 1 },
      { axis: 'Z', sign: 1 },
    ]);
    expect(stepAlongSegment(anchor, anchor, 'X', -0.2, diagonal)).toEqual(anchor);
    expect(stepAlongSegment(anchor, anchor, 'Z', -0.2, diagonal)).toEqual(anchor);
    expect(stepAlongSegment(anchor, anchor, 'X', 0.2, diagonal).x).toBeGreaterThan(anchor.x);
    expect(stepAlongSegment(anchor, anchor, 'Y', -0.2, diagonal).y).toBeLessThan(anchor.y);
  });

  it('варіанти другої осі: дві інші осі × два боки; недозволені після попереднього відрізка — позначені', () => {
    const free = diagonalOptions('X', 1, null);
    expect(free.map((o) => `${o.axis}${o.sign > 0 ? '+' : '-'}`)).toEqual(['Y+', 'Y-', 'Z+', 'Z-']);
    expect(free.every((o) => o.allowed)).toBe(true);
    // Після відрізка +Z: діагональ (+X, −Z) — це 135° до попереднього; (+X, +Z) — 45°; (+X, ±Y) — 90°.
    const afterZ = diagonalOptions('X', 1, headingUnit([{ axis: 'Z', sign: 1 }]));
    const allowed = Object.fromEntries(afterZ.map((o) => [`${o.axis}${o.sign > 0 ? '+' : '-'}`, o.allowed]));
    expect(allowed).toEqual({ 'Y+': true, 'Y-': true, 'Z+': true, 'Z-': false });
  });

  it('підтвердити можна лише відрізок за правилами: з урахуванням попереднього напрямку', () => {
    const previous = headingUnit([{ axis: 'X', sign: 1 }]);
    expect(canAppendNode(anchor, { ...anchor, x: anchor.x + 0.5, z: anchor.z + 0.5 }, previous)).toBe(true);
    expect(canAppendNode(anchor, { ...anchor, x: anchor.x - 0.5, z: anchor.z + 0.5 }, previous)).toBe(false);
    expect(canAppendNode(anchor, { ...anchor, x: anchor.x + 0.5, z: anchor.z + 0.3 }, previous)).toBe(false);
  });
});
