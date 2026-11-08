import { describe, expect, it } from 'vitest';
import {
  addRoute,
  emptyRouteSet,
  isValidRoute,
  lastDirection,
  lockedAxis,
  removeRoute,
  routeLength,
  segmentAxis,
  segmentDirection,
  segmentLengths,
  stepAlongSegment,
  toM,
  toMm,
} from '../../src/core/route.ts';

const L = [
  { x: 0, y: 1200, z: 0 },
  { x: 1000, y: 1200, z: 0 },
  { x: 1000, y: 1200, z: 2000 },
  { x: 1000, y: 1700, z: 2000 },
];

describe('траса: довжини й осі', () => {
  it('«1000 мм по +X → 2000 мм по +Z → 500 мм вгору»', () => {
    expect(segmentLengths(L)).toEqual([1000, 2000, 500]);
    expect(routeLength(L)).toBe(3500);
    expect(segmentDirection(L[0]!, L[1]!)).toEqual({ axis: 'X', sign: 1 });
    expect(segmentDirection(L[1]!, L[2]!)).toEqual({ axis: 'Z', sign: 1 });
    expect(segmentDirection(L[2]!, L[3]!)).toEqual({ axis: 'Y', sign: 1 });
    expect(isValidRoute(L)).toBe(true);
  });

  it('діагональ і нульовий відрізок — не за правилами', () => {
    expect(segmentAxis({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 1 })).toBeNull();
    expect(segmentAxis({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })).toBeNull();
    expect(isValidRoute([L[0]!, { x: 500, y: 1200, z: 300 }])).toBe(false);
    expect(isValidRoute([L[0]!, L[0]!])).toBe(false);
    expect(isValidRoute([L[0]!])).toBe(false);
  });

  it('у межах допуску ±0,1 мм — ще вздовж осі', () => {
    expect(isValidRoute([L[0]!, { x: 1000, y: 1200.08, z: -0.05 }])).toBe(true);
    expect(isValidRoute([L[0]!, { x: 1000, y: 1200.2, z: 0 }])).toBe(false);
  });

  it('назад по попередньому відрізку — не за правилами; прямо далі — можна', () => {
    expect(isValidRoute([L[0]!, L[1]!, { x: 400, y: 1200, z: 0 }])).toBe(false);
    expect(isValidRoute([L[0]!, L[1]!, { x: 1500, y: 1200, z: 0 }])).toBe(true);
    expect(lastDirection(L)).toEqual({ axis: 'Y', sign: 1 });
  });

  it('мм ↔ м тільки через units', () => {
    expect(toM({ x: 2500, y: -100, z: 0 })).toEqual({ x: 2.5, y: -0.1, z: 0 });
    expect(toMm({ x: 2.5, y: -0.1, z: 0 }).x).toBeCloseTo(2500, 9);
  });
});

describe('набір трас: номери не змінюються', () => {
  it('1, 2, 3 → видалили 2 → лишились 1 і 3, нова — 4', () => {
    let set = emptyRouteSet();
    for (let i = 0; i < 3; i++) set = addRoute(set, L).set;
    expect(set.routes.map((r) => r.id)).toEqual([1, 2, 3]);
    set = removeRoute(set, 2);
    expect(set.routes.map((r) => r.id)).toEqual([1, 3]);
    const { set: next, route } = addRoute(set, L);
    expect(route.id).toBe(4);
    expect(next.routes.map((r) => r.id)).toEqual([1, 3, 4]);
  });

  it('траса копіюється (зміни зовні її не псують); неправильну — не додаємо', () => {
    const nodes = L.map((n) => ({ ...n }));
    const { route } = addRoute(emptyRouteSet(), nodes);
    nodes[0]!.x = 999;
    expect(route.nodes[0]!.x).toBe(0);
    expect(() => addRoute(emptyRouteSet(), [L[0]!])).toThrow(RangeError);
  });

  it('траса на 600 точок — без проблем', () => {
    const many = [{ x: 0, y: 0, z: 0 }];
    for (let i = 1; i < 600; i++) {
      const p = many[i - 1]!;
      many.push(i % 2 ? { ...p, x: p.x + 100 } : { ...p, z: p.z + 100 });
    }
    expect(isValidRoute(many)).toBe(true);
    expect(routeLength(many)).toBe(59_900);
  });
});

describe('витягування наступної точки', () => {
  const A = { x: 1, y: 1.2, z: 0.5 };

  it('перший рух вибирає вісь; інші осі після цього не рухають точку', () => {
    let p = stepAlongSegment(A, A, 'X', 0.3, null);
    expect(p).toEqual({ x: 1.3, y: 1.2, z: 0.5 });
    expect(lockedAxis(A, p)).toBe('X');
    expect(stepAlongSegment(A, p, 'Z', 0.2, null)).toBe(p);
    expect(stepAlongSegment(A, p, 'Y', 0.2, null)).toBe(p);
    p = stepAlongSegment(A, p, 'X', -0.1, null);
    expect(p.x).toBeCloseTo(1.2, 12);
    expect(p.y).toBe(A.y);
    expect(p.z).toBe(A.z);
  });

  it('повертаючись, точка зупиняється рівно на початку — і вісь знову вільна', () => {
    let p = stepAlongSegment(A, A, 'Z', 0.05, null);
    p = stepAlongSegment(A, p, 'Z', -0.2, null);
    expect(p).toEqual(A);
    expect(lockedAxis(A, p)).toBeNull();
    p = stepAlongSegment(A, p, 'Y', 0.4, null);
    expect(lockedAxis(A, p)).toBe('Y');
  });

  it('у протилежний бік від початку (не назад по відрізку) — можна', () => {
    const p = stepAlongSegment(A, A, 'X', -0.25, null);
    expect(p.x).toBeCloseTo(0.75, 12);
  });

  it('назад по попередньому відрізку — ні; прямо далі — так', () => {
    const back = { axis: 'X' as const, sign: 1 as const }; // попередній відрізок ішов по +X
    expect(stepAlongSegment(A, A, 'X', -0.3, back)).toEqual(A);
    expect(stepAlongSegment(A, A, 'X', 0.3, back).x).toBeCloseTo(1.3, 12);
    expect(stepAlongSegment(A, A, 'Z', -0.3, back).z).toBeCloseTo(0.2, 12);
  });

  it('дві інші координати — рівно як у початку, навіть після тисяч кроків', () => {
    let p = { ...A };
    for (let i = 0; i < 5000; i++) p = stepAlongSegment(A, p, 'Y', 0.0003 * Math.sin(i) + 0.0001, null);
    expect(p.x).toBe(A.x);
    expect(p.z).toBe(A.z);
  });

  it('NaN-крок нічого не ламає', () => {
    expect(stepAlongSegment(A, A, 'X', Number.NaN, null)).toEqual(A);
  });
});
