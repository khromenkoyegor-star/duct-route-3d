/**
 * Етап 2 (tester): модель траси — перевірка «чорною скринькою» за критеріями готовності.
 *  - кожен відрізок строго вздовж однієї осі: дві інші координати сусідніх вузлів однакові (±0,1 мм, у нас — рівно);
 *  - повороти лише 90°, назад по попередньому відрізку не можна;
 *  - довжина відрізка = відстань між вузлами (±0,1 мм);
 *  - номери трас не змінюються, нова — наступний номер (навіть після видалення останньої чи всіх);
 *  - крайові випадки: перехід через початок, NaN/Infinity, дуже довгі траси, межа 0,1 мм.
 */
import { describe, expect, it } from 'vitest';
import { createStickController, type NudgeAxis, type Vec2 } from '../../src/core/nudge.ts';
import {
  addRoute,
  canAppendNode,
  distance,
  emptyRouteSet,
  formatPointCount,
  isValidRoute,
  lastDirection,
  lockedAxis,
  NODE_TOLERANCE_MM,
  type P3,
  removeRoute,
  routeLength,
  type SegmentDir,
  segmentLengths,
  stepAlongSegment,
  toM,
  toMm,
} from '../../src/core/route.ts';
import { formatMm, mToMm } from '../../src/core/units.ts';

const AXES: NudgeAxis[] = ['X', 'Y', 'Z'];
const KEY = { X: 'x', Y: 'y', Z: 'z' } as const;

/** Детермінований генератор випадкових чисел (щоб падіння відтворювалось). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Інші дві осі. */
const others = (axis: NudgeAxis) => AXES.filter((a) => a !== axis);

/**
 * «Як людина тягне точку»: багато кроків різної довжини й знаку по різних осях (як джойстик і повзунок),
 * у тому числі по забороненій осі та назад. Повертає точку після всіх кроків (м сцени).
 */
function drag(anchor: P3, back: SegmentDir | null, random: () => number, steps: number): P3 {
  let p = { ...anchor };
  for (let i = 0; i < steps; i++) {
    const axis = AXES[Math.floor(random() * 3)]!;
    // від 0,01 мм до 50 мм за кадр, обидва знаки
    const step = (random() < 0.5 ? -1 : 1) * (0.00001 + random() * 0.05);
    p = stepAlongSegment(anchor, p, axis, step, back);
  }
  return p;
}

describe('stage2/tester: відрізок завжди вздовж однієї осі', () => {
  it('тисячі випадкових кроків по різних осях: дві інші координати рівно як у початку, назад не йде', () => {
    const random = rng(7);
    for (let trial = 0; trial < 300; trial++) {
      const anchor = { x: (random() - 0.5) * 20, y: random() * 5, z: (random() - 0.5) * 20 };
      const back: SegmentDir | null =
        random() < 0.3 ? null : { axis: AXES[Math.floor(random() * 3)]!, sign: random() < 0.5 ? 1 : -1 };
      let p = { ...anchor };
      for (let i = 0; i < 200; i++) {
        const axis = AXES[Math.floor(random() * 3)]!;
        const step = (random() < 0.5 ? -1 : 1) * random() * 0.05;
        p = stepAlongSegment(anchor, p, axis, step, back);
        const moved = AXES.filter((a) => p[KEY[a]] !== anchor[KEY[a]]);
        // Рухається не більше однієї координати, інші — РІВНО як у початку (не «майже»).
        expect(moved.length).toBeLessThanOrEqual(1);
        if (back && moved[0] === back.axis) {
          // По осі попереднього відрізка — лише вперед (той самий знак).
          expect(Math.sign(p[KEY[back.axis]] - anchor[KEY[back.axis]])).toBe(back.sign);
        }
      }
    }
  });

  it('після підтвердження вузли (мм) — траса за правилами; дві інші координати однакові рівно', () => {
    const random = rng(42);
    const nodes: P3[] = [{ x: -1.2345678, y: 0.0012345, z: 2.3456789 }];
    while (nodes.length < 60) {
      const anchor = nodes.at(-1)!;
      const p = drag(anchor, lastDirection(nodes), random, 500);
      // Як у редакторі: нульовий/надто короткий відрізок не підтверджується.
      if (lockedAxis(anchor, p) === null || !(mToMm(distance(anchor, p)) > NODE_TOLERANCE_MM)) continue;
      nodes.push(p);
    }
    const mm = nodes.map(toMm);
    expect(isValidRoute(mm)).toBe(true);
    expect(() => addRoute(emptyRouteSet(), mm)).not.toThrow();
    for (let i = 1; i < mm.length; i++) {
      const a = mm[i - 1]!;
      const b = mm[i]!;
      const changed = (['x', 'y', 'z'] as const).filter((k) => a[k] !== b[k]);
      expect(changed).toHaveLength(1);
    }
  });

  it('перехід через початок: зупиняється рівно на початку, наступний крок — на інший бік (якщо це не «назад»)', () => {
    const A = { x: 0.3, y: 1.1, z: -0.7 };
    let p = stepAlongSegment(A, A, 'Z', 0.2, null);
    // Великий крок назад — проскакування немає, точка рівно на початку.
    p = stepAlongSegment(A, p, 'Z', -5, null);
    expect(p).toEqual(A);
    expect(lockedAxis(A, p)).toBeNull();
    // Тримаєш далі — точка йде на інший бік по тій самій осі.
    p = stepAlongSegment(A, p, 'Z', -0.1, null);
    expect(p.z).toBeCloseTo(-0.8, 12);
    expect(p.x).toBe(A.x);
    expect(p.y).toBe(A.y);
    // Попередній відрізок ішов по −Z (сюди прийшли рухом −Z) — тоді на +Z не можна навіть після переходу.
    const back: SegmentDir = { axis: 'Z', sign: -1 };
    let q = stepAlongSegment(A, A, 'Z', -0.2, back);
    q = stepAlongSegment(A, q, 'Z', 5, back);
    expect(q).toEqual(A);
    q = stepAlongSegment(A, q, 'Z', 0.1, back);
    expect(q).toEqual(A);
  });

  it('назад заборонено по осі попереднього відрізка будь-якого знаку; по інших осях — обидва боки', () => {
    const A = { x: 1, y: 2, z: 3 };
    for (const axis of AXES) {
      for (const sign of [1, -1] as const) {
        const back: SegmentDir = { axis, sign };
        expect(stepAlongSegment(A, A, axis, -sign * 0.5, back)).toEqual(A);
        expect(stepAlongSegment(A, A, axis, sign * 0.5, back)[KEY[axis]]).toBeCloseTo(A[KEY[axis]] + sign * 0.5, 12);
        for (const other of others(axis)) {
          expect(stepAlongSegment(A, A, other, 0.5, back)[KEY[other]]).toBeCloseTo(A[KEY[other]] + 0.5, 12);
          expect(stepAlongSegment(A, A, other, -0.5, back)[KEY[other]]).toBeCloseTo(A[KEY[other]] - 0.5, 12);
        }
      }
    }
  });

  it('NaN, ±Infinity і нульовий крок точку не зсувають і NaN у координати не вносять', () => {
    const A = { x: 1, y: 2, z: 3 };
    const p = stepAlongSegment(A, A, 'X', 0.25, null);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -0]) {
      const q = stepAlongSegment(A, p, 'X', bad, null);
      expect(Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z)).toBe(true);
      expect(q.x).toBeCloseTo(p.x, 12);
    }
  });

  it('далеко від початку координат (скан на 1 км) — інші координати все одно рівно як у початку', () => {
    const A = { x: 987.654321, y: 12.3456789, z: -543.210987 };
    let p = { ...A };
    for (let i = 0; i < 20_000; i++) p = stepAlongSegment(A, p, 'X', 0.0000137 * (i % 7 === 0 ? -1 : 1), null);
    expect(p.y).toBe(A.y);
    expect(p.z).toBe(A.z);
    expect(isValidRoute([toMm(A), toMm(p)])).toBe(true);
  });
});

describe('stage2/tester: довжини (±0,1 мм)', () => {
  it('довжина відрізка в м сцени (так рахує підпис) = відстані між вузлами в мм (±0,1 мм)', () => {
    const random = rng(3);
    for (let i = 0; i < 2000; i++) {
      const a = { x: (random() - 0.5) * 30, y: random() * 6, z: (random() - 0.5) * 30 };
      const axis = AXES[Math.floor(random() * 3)]!;
      const b = stepAlongSegment(a, a, axis, (random() - 0.5) * 20, null);
      const labelMm = mToMm(distance(a, b));
      const nodeMm = distance(toMm(a), toMm(b));
      expect(Math.abs(labelMm - nodeMm)).toBeLessThan(1e-6);
      // Підпис «1 234,5 мм» — округлення до 0,1 мм: різниця ≤ 0,05 мм.
      const shown = Number(formatMm(labelMm).replace(/\s|мм/g, '').replace(',', '.').replace('−', '-'));
      expect(Math.abs(shown - nodeMm)).toBeLessThanOrEqual(0.05 + 1e-9);
    }
  });

  it('довжина траси = сума відрізків; «Траса 1 · 4 точки · 7 350 мм»', () => {
    const nodes = [
      { x: 0, y: 500, z: 0 },
      { x: 3000, y: 500, z: 0 },
      { x: 3000, y: 500, z: 2000 },
      { x: 3000, y: 2850, z: 2000 },
    ];
    expect(segmentLengths(nodes)).toEqual([3000, 2000, 2350]);
    expect(routeLength(nodes)).toBe(7350);
    expect(`${formatPointCount(nodes.length)} · ${formatMm(routeLength(nodes))}`).toMatch(/^4 точки · 7\s350 мм$/);
  });

  it('мм → м → мм без втрат більше ніж 0,0001 мм (вузли зберігаються в мм)', () => {
    const random = rng(11);
    for (let i = 0; i < 2000; i++) {
      const p = { x: (random() - 0.5) * 1e5, y: random() * 1e4, z: (random() - 0.5) * 1e5 };
      const back = toMm(toM(p));
      for (const k of ['x', 'y', 'z'] as const) expect(Math.abs(back[k] - p[k])).toBeLessThan(1e-4);
    }
  });
});

describe('stage2/tester: межа «нульового» відрізка (0,1 мм)', () => {
  it('відрізок, коротший за 0,1 мм, — не за правилами; трохи довший — за правилами', () => {
    const a = { x: 1000, y: 1200, z: 0 };
    expect(isValidRoute([a, { ...a, x: a.x + 0.05 }])).toBe(false);
    expect(isValidRoute([a, { ...a, x: a.x + 0.099 }])).toBe(false);
    expect(isValidRoute([a, { ...a, x: a.x + 0.11 }])).toBe(true);
    expect(isValidRoute([a, { ...a, x: a.x - 0.11 }])).toBe(true);
  });

  it('усе, що редактор дозволяє підтвердити (canAppendNode), «Завершити» приймає (addRoute не кидає) — і на самій межі 0,1 мм', () => {
    // Раніше редактор рахував довжину в м сцени (mToMm(distance) > 0,1), а «Завершити» — у мм вузлів;
    // на межі 0,1 мм вони розходились: точку підтвердили, а addRoute кидав RangeError. Цей випадок — тут.
    const anchor = { x: 3.704268295023181, y: 0.5, z: 1.25 };
    const point = { ...anchor, x: 3.704368295023181 };
    expect(canAppendNode(anchor, point)).toBe(isValidRoute([toMm(anchor), toMm(point)]));
    const random = rng(99);
    let allowed = 0;
    for (let i = 0; i < 200_000; i++) {
      const a = { x: (random() - 0.5) * 20, y: random() * 3, z: (random() - 0.5) * 20 };
      const axis = AXES[Math.floor(random() * 3)]!;
      const len = (random() < 0.5 ? -1 : 1) * (0.0001 + (random() - 0.5) * 1e-12);
      const b = stepAlongSegment(a, a, axis, len, null);
      if (!canAppendNode(a, b)) continue;
      allowed++;
      expect(() => addRoute(emptyRouteSet(), [toMm(a), toMm(b)])).not.toThrow();
    }
    expect(allowed).toBeGreaterThan(0);
  });

  it('відрізок, коротший за 0,1 мм, редактор не підтверджує; 0,15 мм — підтверджує', () => {
    const a = { x: 1.2, y: 0.8, z: -0.4 };
    expect(canAppendNode(a, stepAlongSegment(a, a, 'Z', 0.00006, null))).toBe(false);
    expect(canAppendNode(a, a)).toBe(false);
    expect(canAppendNode(a, stepAlongSegment(a, a, 'Z', 0.00015, null))).toBe(true);
    expect(canAppendNode(a, stepAlongSegment(a, a, 'Y', -0.00015, null))).toBe(true);
  });
});

describe('stage2/tester: правило «назад не можна» у перевірці траси', () => {
  it('назад після кількох відрізків уперед по тій самій осі — не за правилами', () => {
    const n = [
      { x: 0, y: 0, z: 0 },
      { x: 500, y: 0, z: 0 },
      { x: 900, y: 0, z: 0 },
      { x: 700, y: 0, z: 0 },
    ];
    expect(isValidRoute(n)).toBe(false);
  });

  it('П-подібна траса (+X, +Z, −X) і замкнена петля — дозволені (назад лише по попередньому)', () => {
    expect(
      isValidRoute([
        { x: 0, y: 0, z: 0 },
        { x: 1000, y: 0, z: 0 },
        { x: 1000, y: 0, z: 1000 },
        { x: 0, y: 0, z: 1000 },
        { x: 0, y: 0, z: 0 },
      ]),
    ).toBe(true);
  });

  it('вгору, потім одразу вниз — не за правилами', () => {
    expect(isValidRoute([{ x: 0, y: 0, z: 0 }, { x: 0, y: 1000, z: 0 }, { x: 0, y: 400, z: 0 }])).toBe(false);
  });

  it('пошкоджені координати (NaN, ±Infinity) — траса не за правилами', () => {
    // Знадобиться для «пошкодженого файлу» проєкту (етап 6); зараз через loadRoutes.
    expect(isValidRoute([{ x: 0, y: 0, z: 0 }, { x: Number.NaN, y: 0, z: 1000 }])).toBe(false);
    expect(isValidRoute([{ x: 0, y: 0, z: 0 }, { x: Number.POSITIVE_INFINITY, y: 0, z: 0 }])).toBe(false);
    expect(isValidRoute([{ x: Number.NaN, y: 0, z: 0 }, { x: 1000, y: 0, z: 0 }])).toBe(false);
  });
});

describe('stage2/tester: номери трас', () => {
  const two = [
    { x: 0, y: 0, z: 0 },
    { x: 1000, y: 0, z: 0 },
  ];

  it('видалили останню (найбільший номер) — нова все одно отримує наступний, а не той самий', () => {
    let set = emptyRouteSet();
    for (let i = 0; i < 3; i++) set = addRoute(set, two).set;
    set = removeRoute(set, 3);
    const { route } = addRoute(set, two);
    expect(route.id).toBe(4);
  });

  it('видалили всі — номери не починаються знову з 1', () => {
    let set = emptyRouteSet();
    for (let i = 0; i < 2; i++) set = addRoute(set, two).set;
    set = removeRoute(removeRoute(set, 1), 2);
    expect(set.routes).toHaveLength(0);
    expect(addRoute(set, two).route.id).toBe(3);
  });

  it('видалення неіснуючого номера нічого не змінює; набір не змінюється «на місці»', () => {
    const set = addRoute(emptyRouteSet(), two).set;
    const same = removeRoute(set, 99);
    expect(same.routes.map((r) => r.id)).toEqual([1]);
    expect(same.nextId).toBe(2);
    const next = addRoute(set, two).set;
    expect(set.routes).toHaveLength(1);
    expect(next.routes).toHaveLength(2);
  });

  it('траса на 1000 точок: додається, номер 1, довжина рахується точно', () => {
    const nodes: P3[] = [{ x: 0, y: 1200, z: 0 }];
    for (let i = 1; i < 1000; i++) {
      const p = nodes[i - 1]!;
      nodes.push(i % 2 ? { ...p, x: p.x + 3.3 } : { ...p, z: p.z + 4.4 });
    }
    const { route } = addRoute(emptyRouteSet(), nodes);
    expect(route.id).toBe(1);
    expect(route.nodes).toHaveLength(1000);
    expect(routeLength(route.nodes)).toBeCloseTo(500 * 3.3 + 499 * 4.4, 6);
  });
});

describe('stage2/tester: джойстик у режимі відрізка (only)', () => {
  const screen: Record<'X' | 'Z', Vec2> = { X: { x: 40, y: 0 }, Z: { x: 0, y: 40 } };

  it('відрізок іде по X: джойстик убік Z — точка не рухається; по діагоналі — лише X', () => {
    const c = createStickController();
    expect(c.update({ x: 0, y: 0.9 }, screen, 0.05, 'X')).toBeNull();
    expect(c.axis).toBe('X');
    c.release();
    const step = c.update({ x: 0.6, y: 0.6 }, screen, 0.05, 'X');
    expect(step?.axis).toBe('X');
    expect(step!.deltaMm).toBeGreaterThan(0);
  });

  it('only не міняє вісь, уже зафіксовану цим утриманням (до відпускання)', () => {
    const c = createStickController();
    c.update({ x: 0, y: 0.9 }, screen, 0.05);
    expect(c.axis).toBe('Z');
    const step = c.update({ x: 0.9, y: 0 }, screen, 0.05, 'X');
    // Зафіксована вісь лишається Z (рух — проєкція на Z, тут ≈ 0).
    expect(c.axis).toBe('Z');
    expect(step).toBeNull();
  });
});
