/**
 * Етап 4.1 (tester): повороти 45° у моделі траси — перевірка «від вимог».
 *
 * Правило рахуємо тут незалежно від коду: 18 можливих напрямків відрізка (6 уздовж осей і 12 діагоналей
 * у площинах XY, XZ, YZ), кут між двома напрямками — зі скалярного добутку цілих векторів. Дозволено
 * лише 0° (пряме продовження), 45° і 90°. Модель має погоджуватись із цим у всіх функціях одразу:
 * turnAllowed, isValidRoute, canAppendNode, stepAlongSegment, diagonalOptions, addRoute.
 */
import { describe, expect, it } from 'vitest';
import {
  addRoute,
  canAppendNode,
  type DiagonalChoice,
  diagonalOptions,
  emptyRouteSet,
  headingUnit,
  isValidRoute,
  lastHeading,
  NODE_TOLERANCE_MM,
  type P3,
  type SegmentDir,
  segmentHeading,
  stepAlongSegment,
  toM,
  toMm,
  turnAllowed,
} from '../../src/core/route.ts';

type Axis = 'X' | 'Y' | 'Z';
const KEY = { X: 'x', Y: 'y', Z: 'z' } as const;
const AXES: Axis[] = ['X', 'Y', 'Z'];
const SIGNS = [1, -1] as const;

interface Heading {
  name: string;
  /** Складові в порядку X, Y, Z. */
  parts: SegmentDir[];
  /** Цілий вектор напрямку (складові 0 або ±1). */
  v: P3;
}

const sign = (s: number) => (s > 0 ? '+' : '−');

/** Усі 18 напрямків: 6 осьових і 12 діагональних (3 площини × 4 комбінації знаків). */
const HEADINGS: Heading[] = (() => {
  const out: Heading[] = [];
  for (const a of AXES) {
    for (const s of SIGNS) {
      const v: P3 = { x: 0, y: 0, z: 0 };
      v[KEY[a]] = s;
      out.push({ name: `${a}${sign(s)}`, parts: [{ axis: a, sign: s }], v });
    }
  }
  for (const [a, b] of [
    ['X', 'Y'],
    ['X', 'Z'],
    ['Y', 'Z'],
  ] as const) {
    for (const sa of SIGNS) {
      for (const sb of SIGNS) {
        const v: P3 = { x: 0, y: 0, z: 0 };
        v[KEY[a]] = sa;
        v[KEY[b]] = sb;
        out.push({
          name: `${a}${sign(sa)}${b}${sign(sb)}`,
          parts: [
            { axis: a, sign: sa },
            { axis: b, sign: sb },
          ],
          v,
        });
      }
    }
  }
  return out;
})();

/** Кут між напрямками, градуси (ціле число) — незалежно від коду моделі. */
function angleDeg(a: Heading, b: Heading): number {
  const dot = a.v.x * b.v.x + a.v.y * b.v.y + a.v.z * b.v.z;
  const cos = dot / (Math.hypot(a.v.x, a.v.y, a.v.z) * Math.hypot(b.v.x, b.v.y, b.v.z));
  return Math.round((Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI);
}
/** Правило етапу 4.1: пряме продовження, 45° або 90°. */
const ruleAllows = (a: Heading, b: Heading) => [0, 45, 90].includes(angleDeg(a, b));

const along = (p: P3, h: Heading, length: number): P3 => ({ x: p.x + h.v.x * length, y: p.y + h.v.y * length, z: p.z + h.v.z * length });
const offset = (a: P3, b: P3): P3 => ({ x: b.x - a.x, y: b.y - a.y, z: b.z - a.z });

/** Детермінований генератор випадкових чисел 0…1 (щоб тест щоразу був однаковий). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('етап 4.1 (tester): напрямок відрізка — усі три площини й усі знаки', () => {
  const START: P3 = { x: 137.5, y: 2400, z: -911.25 };

  it('18 напрямків: 6 осьових і 12 діагоналей (по 4 у площинах XY, XZ, YZ)', () => {
    expect(HEADINGS).toHaveLength(18);
    expect(HEADINGS.filter((h) => h.parts.length === 2)).toHaveLength(12);
  });

  for (const length of [0.2, 1, 250, 1000, 123456.75]) {
    it(`відрізок ${length} мм у кожному з 18 напрямків розпізнається правильно; одиничний вектор — довжини 1`, () => {
      for (const h of HEADINGS) {
        const end = along(START, h, length);
        const got = segmentHeading(START, end, NODE_TOLERANCE_MM);
        expect(got, h.name).not.toBeNull();
        expect(got!.parts, h.name).toEqual(h.parts);
        const l = Math.hypot(h.v.x, h.v.y, h.v.z);
        expect(got!.unit.x, h.name).toBeCloseTo(h.v.x / l, 12);
        expect(got!.unit.y, h.name).toBeCloseTo(h.v.y / l, 12);
        expect(got!.unit.z, h.name).toBeCloseTo(h.v.z / l, 12);
        expect(Math.hypot(got!.unit.x, got!.unit.y, got!.unit.z), h.name).toBeCloseTo(1, 12);
        // Третя координата діагоналі не змінюється: складова одиничного вектора — рівно 0.
        for (const a of AXES) if (h.v[KEY[a]] === 0) expect(got!.unit[KEY[a]], `${h.name} ${a}`).toBe(0);
      }
    });
  }

  it('не 45°: нахили 1:2, 30°, 60°, просторова діагональ, усі три координати — не за правилами', () => {
    const O = { x: 0, y: 0, z: 0 };
    const bad: P3[] = [
      { x: 1000, y: 0, z: 500 },
      { x: 1000, y: 0, z: -2000 },
      { x: 1000, y: 577.35, z: 0 }, // 30°
      { x: 0, y: 1732.05, z: 1000 }, // 60°
      { x: 1000, y: 1000, z: 1000 },
      { x: 1000, y: -1000, z: 0.5 }, // діагональ, але третя координата «попливла» на 0,5 мм
      { x: 1000, y: 999.5, z: 0 }, // зміщення різняться на 0,5 мм
    ];
    for (const b of bad) {
      expect(segmentHeading(O, b, NODE_TOLERANCE_MM), JSON.stringify(b)).toBeNull();
      expect(isValidRoute([O, b]), JSON.stringify(b)).toBe(false);
      expect(canAppendNode(toM(O), toM(b)), JSON.stringify(b)).toBe(false);
    }
  });

  it('допуск 0,1 мм: різниця зміщень 0,09 мм — ще 45°, 0,11 мм — ні; третя координата 0,09 мм — так, 0,11 мм — ні', () => {
    const O = { x: 0, y: 0, z: 0 };
    for (const [a, b, c] of [
      ['x', 'z', 'y'],
      ['x', 'y', 'z'],
      ['y', 'z', 'x'],
    ] as const) {
      const make = (da: number, db: number, dc: number): P3 => ({ ...O, [a]: da, [b]: db, [c]: dc }) as P3;
      expect(isValidRoute([O, make(1000, 1000.09, 0)]), `${a}${b} +0,09`).toBe(true);
      expect(isValidRoute([O, make(1000, -999.91, 0)]), `${a}${b} −0,09`).toBe(true);
      expect(isValidRoute([O, make(1000, 1000.11, 0)]), `${a}${b} +0,11`).toBe(false);
      expect(isValidRoute([O, make(-1000, 999.89, 0)]), `${a}${b} −0,11`).toBe(false);
      expect(isValidRoute([O, make(1000, 1000, 0.09)]), `${a}${b} третя 0,09`).toBe(true);
      expect(isValidRoute([O, make(1000, 1000, -0.11)]), `${a}${b} третя 0,11`).toBe(false);
    }
  });

  it('нульовий відрізок і пошкоджені координати — не за правилами (і для діагоналей)', () => {
    const a = { x: 100, y: 200, z: 300 };
    expect(isValidRoute([a, { ...a }])).toBe(false);
    expect(isValidRoute([a, { x: 1100, y: 200, z: 1300 }, { x: 1100, y: 200, z: 1300 }])).toBe(false);
    expect(isValidRoute([a, { x: Number.NaN, y: 200, z: 1300 }])).toBe(false);
    expect(isValidRoute([a, { x: 1100, y: 200, z: Number.POSITIVE_INFINITY }])).toBe(false);
    expect(isValidRoute([a])).toBe(false);
    expect(isValidRoute([])).toBe(false);
    expect(canAppendNode(toM(a), toM(a))).toBe(false);
  });
});

describe('етап 4.1 (tester): повороти між сусідніми відрізками — повна таблиця 18 × 18', () => {
  const START: P3 = { x: 137.5, y: 2400, z: -911.25 };

  it('після осьового відрізка дозволено 13 напрямків, після діагонального — 7 (решта — 60°, 120°, 135°, назад)', () => {
    for (const a of HEADINGS) {
      const allowed = HEADINGS.filter((b) => ruleAllows(a, b));
      expect(allowed, a.name).toHaveLength(a.parts.length === 1 ? 13 : 7);
    }
    // Приклади з постановки задачі.
    const byName = (name: string) => HEADINGS.find((h) => h.name === name)!;
    expect(angleDeg(byName('X+Z+'), byName('X+Z−'))).toBe(90);
    expect(angleDeg(byName('X+Z+'), byName('X+Y+'))).toBe(60);
    expect(angleDeg(byName('X+Z+'), byName('X−Y+'))).toBe(120);
    expect(angleDeg(byName('X+'), byName('X−Z+'))).toBe(135);
  });

  it('turnAllowed: рівно за правилом для всіх 324 пар', () => {
    const wrong: string[] = [];
    for (const a of HEADINGS) {
      for (const b of HEADINGS) {
        if (turnAllowed(headingUnit(a.parts), headingUnit(b.parts)) !== ruleAllows(a, b)) wrong.push(`${a.name} → ${b.name} (${angleDeg(a, b)}°)`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('isValidRoute, canAppendNode і addRoute: траса з двох відрізків приймається рівно тоді, коли поворот 0°, 45° чи 90°', () => {
    const wrong: string[] = [];
    for (const a of HEADINGS) {
      for (const b of HEADINGS) {
        const ok = ruleAllows(a, b);
        const p1 = along(START, a, 1234.5);
        const p2 = along(p1, b, 777.25);
        const label = `${a.name} → ${b.name} (${angleDeg(a, b)}°)`;
        if (isValidRoute([START, p1, p2]) !== ok) wrong.push(`isValidRoute: ${label}`);
        if (canAppendNode(toM(p1), toM(p2), headingUnit(a.parts)) !== ok) wrong.push(`canAppendNode: ${label}`);
        let added = true;
        try {
          addRoute(emptyRouteSet(), [START, p1, p2]);
        } catch {
          added = false;
        }
        if (added !== ok) wrong.push(`addRoute: ${label}`);
        // Напрямок останнього відрізка (від нього залежить наступний поворот) — той, яким ішли.
        if (lastHeading([START, p1, p2], NODE_TOLERANCE_MM)?.parts.map((p) => `${p.axis}${sign(p.sign)}`).join('') !== b.name) {
          wrong.push(`lastHeading: ${label}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('stepAlongSegment: у дозволений бік точка їде рівно по напрямку, у заборонений — стоїть на початку (усі пари, обидва способи вибору основної осі)', () => {
    const anchor = toM(along(START, HEADINGS[0]!, 1234.5));
    const STEP = 0.25;
    const wrong: string[] = [];
    for (const a of HEADINGS) {
      const previous = headingUnit(a.parts);
      for (const b of HEADINGS) {
        const ok = ruleAllows(a, b);
        // Осьовий відрізок — один спосіб; діагональ — основною може бути будь-яка з двох осей.
        const ways: Array<{ main: SegmentDir; choice: DiagonalChoice | null }> =
          b.parts.length === 1
            ? [{ main: b.parts[0]!, choice: null }]
            : [
                { main: b.parts[0]!, choice: b.parts[1]! },
                { main: b.parts[1]!, choice: b.parts[0]! },
              ];
        for (const { main, choice } of ways) {
          const label = `${a.name} → ${b.name} (${angleDeg(a, b)}°), основна ${main.axis}`;
          const next = stepAlongSegment(anchor, anchor, main.axis, main.sign * STEP, previous, choice);
          const d = offset(anchor, next);
          const want = ok ? { x: b.v.x * STEP, y: b.v.y * STEP, z: b.v.z * STEP } : { x: 0, y: 0, z: 0 };
          if (Math.abs(d.x - want.x) > 1e-12 || Math.abs(d.y - want.y) > 1e-12 || Math.abs(d.z - want.z) > 1e-12) {
            wrong.push(`${label}: зсув ${JSON.stringify(d)}`);
          }
          // У заборонений бік точка лишається РІВНО на початку.
          if (!ok && (next.x !== anchor.x || next.y !== anchor.y || next.z !== anchor.z)) wrong.push(`${label}: не на початку`);
          // Те, куди точка приїхала, можна підтвердити; куди не можна їхати — підтвердити теж не можна.
          const target = { x: anchor.x + b.v.x * STEP, y: anchor.y + b.v.y * STEP, z: anchor.z + b.v.z * STEP };
          if (canAppendNode(anchor, target, previous) !== ok) wrong.push(`${label}: canAppendNode`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('diagonalOptions: чотири варіанти (дві інші осі × два боки); «дозволено» — рівно за правилом для всіх попередніх напрямків', () => {
    const wrong: string[] = [];
    for (const main of AXES) {
      for (const mainSign of SIGNS) {
        const free = diagonalOptions(main, mainSign, null);
        expect(free).toHaveLength(4);
        expect(free.every((o) => o.allowed && o.axis !== main)).toBe(true);
        expect(new Set(free.map((o) => `${o.axis}${o.sign}`)).size).toBe(4);
        for (const a of HEADINGS) {
          const options = diagonalOptions(main, mainSign, headingUnit(a.parts));
          expect(options).toHaveLength(4);
          for (const option of options) {
            const b = HEADINGS.find(
              (h) => h.parts.length === 2 && h.v[KEY[main]] === mainSign && h.v[KEY[option.axis]] === option.sign,
            )!;
            if (option.allowed !== ruleAllows(a, b)) wrong.push(`після ${a.name}: ${b.name} (${angleDeg(a, b)}°)`);
          }
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe('етап 4.1 (tester): точність діагоналі при довгому русі дрібними кроками', () => {
  /** Усі 24 способи: основна вісь × її бік × друга вісь × її бік. */
  const COMBOS: Array<{ main: Axis; mainSign: 1 | -1; choice: DiagonalChoice }> = [];
  for (const main of AXES) {
    for (const mainSign of SIGNS) {
      for (const axis of AXES) {
        if (axis === main) continue;
        for (const s of SIGNS) COMBOS.push({ main, mainSign, choice: { axis, sign: s } });
      }
    }
  }
  /** «Незручні» координати початку (м): далеко від нуля, з довгими дробами. */
  const ANCHOR: P3 = { x: 12.3456789, y: 2.7001, z: -48.7654321 };

  it('24 способи × 30 000 кроків туди-назад: зміщення по двох осях однакові (значно точніше за 0,1 мм), третя координата — рівно як у початку', () => {
    expect(COMBOS).toHaveLength(24);
    COMBOS.forEach(({ main, mainSign, choice }, index) => {
      const rnd = lcg(1000 + index);
      const third = AXES.find((a) => a !== main && a !== choice.axis)!;
      const label = `${main}${sign(mainSign)} + ${choice.axis}${sign(choice.sign)}`;
      let p = ANCHOR;
      let worst = 0;
      for (let k = 0; k < 30_000; k++) {
        // 700 кроків уперед, 400 назад; кроки 0,05…3 мм.
        const forward = k % 1100 < 700;
        const step = (forward ? 1 : -1) * mainSign * (0.00005 + rnd() * 0.003);
        p = stepAlongSegment(ANCHOR, p, main, step, null, choice);
        const d = offset(ANCHOR, p);
        worst = Math.max(worst, Math.abs(Math.abs(d[KEY[main]]) - Math.abs(d[KEY[choice.axis]])));
        if (p[KEY[third]] !== ANCHOR[KEY[third]]) throw new Error(`${label}: третя координата змінилась на кроці ${k}`);
        if (d[KEY[choice.axis]] !== 0 && Math.sign(d[KEY[choice.axis]]) !== choice.sign) throw new Error(`${label}: друга вісь пішла не в той бік на кроці ${k}`);
      }
      const d = offset(ANCHOR, p);
      // Точка справді далеко від початку (десятки метрів).
      expect(Math.abs(d[KEY[main]]), label).toBeGreaterThan(5);
      expect(Math.sign(d[KEY[main]]), label).toBe(mainSign);
      // Похибка — лише округлення чисел (метри): на багато порядків менша за 0,1 мм = 1e-4 м.
      expect(worst, label).toBeLessThan(1e-11);
      // У мм — рівно 45° за правилами траси, і точку можна підтвердити.
      const mm = { a: toMm(ANCHOR), p: toMm(p) };
      const dm = offset(mm.a, mm.p);
      expect(Math.abs(Math.abs(dm[KEY[main]]) - Math.abs(dm[KEY[choice.axis]])), label).toBeLessThan(0.1);
      expect(dm[KEY[third]], label).toBe(0);
      expect(segmentHeading(mm.a, mm.p, NODE_TOLERANCE_MM)?.parts, label).toHaveLength(2);
      expect(canAppendNode(ANCHOR, p), label).toBe(true);
    });
  });

  it('повернення через початок: точка зупиняється рівно на початку; далі їде на інший бік — друга вісь усе одно у вибраний бік', () => {
    for (const { main, mainSign, choice } of COMBOS) {
      const label = `${main}${sign(mainSign)} + ${choice.axis}${sign(choice.sign)}`;
      let p = ANCHOR;
      for (let k = 0; k < 40; k++) p = stepAlongSegment(ANCHOR, p, main, mainSign * 0.0123, null, choice);
      expect(Math.abs(offset(ANCHOR, p)[KEY[main]]), label).toBeCloseTo(40 * 0.0123, 9);
      // Назад дрібними кроками, поки не проскочимо початок.
      let steps = 0;
      while ((p.x !== ANCHOR.x || p.y !== ANCHOR.y || p.z !== ANCHOR.z) && steps < 200) {
        p = stepAlongSegment(ANCHOR, p, main, -mainSign * 0.0071, null, choice);
        steps += 1;
      }
      expect(p, label).toEqual(ANCHOR);
      expect(steps, label).toBeLessThan(200);
      // Далі — на інший бік по основній осі.
      p = stepAlongSegment(ANCHOR, p, main, -mainSign * 0.3, null, choice);
      const d = offset(ANCHOR, p);
      expect(d[KEY[main]], label).toBeCloseTo(-mainSign * 0.3, 12);
      expect(d[KEY[choice.axis]], label).toBeCloseTo(choice.sign * 0.3, 12);
    }
  });

  it('«45°» на вже витягнутому прямому відрізку (крок 0): хід по основній осі зберігається, по другій стає таким самим', () => {
    for (const { main, mainSign, choice } of COMBOS) {
      const straight = stepAlongSegment(ANCHOR, ANCHOR, main, mainSign * 0.7315, null);
      const diag = stepAlongSegment(ANCHOR, straight, main, 0, null, choice);
      expect(diag[KEY[main]]).toBe(straight[KEY[main]]);
      expect(offset(ANCHOR, diag)[KEY[choice.axis]]).toBeCloseTo(choice.sign * 0.7315, 12);
      const third = AXES.find((a) => a !== main && a !== choice.axis)!;
      expect(diag[KEY[third]]).toBe(ANCHOR[KEY[third]]);
    }
  });

  it('некоректний крок (NaN, нескінченність) і друга вісь = основна — точка не змінюється', () => {
    const p = stepAlongSegment(ANCHOR, ANCHOR, 'X', 0.4, null, { axis: 'Z', sign: -1 });
    expect(stepAlongSegment(ANCHOR, p, 'X', Number.NaN, null, { axis: 'Z', sign: -1 })).toEqual(p);
    expect(stepAlongSegment(ANCHOR, p, 'X', Number.POSITIVE_INFINITY, null, { axis: 'Z', sign: -1 })).toEqual(p);
    expect(stepAlongSegment(ANCHOR, p, 'X', 0.1, null, { axis: 'X', sign: 1 })).toEqual(p);
  });
});

describe('етап 4.1 (tester): довгі траси й траси, побудовані раніше', () => {
  /** Випадкова траса: кожен наступний напрямок — будь-який дозволений правилом; довжини 150…2500 мм з дробами. */
  function randomRoute(count: number, seed: number, pool: Heading[]): { nodes: P3[]; headings: Heading[] } {
    const rnd = lcg(seed);
    const nodes: P3[] = [{ x: -1500.5, y: 2400.25, z: 730.125 }];
    const headings: Heading[] = [];
    let previous: Heading | null = null;
    while (nodes.length < count) {
      const options = pool.filter((h) => !previous || ruleAllows(previous, h));
      const h = options[Math.floor(rnd() * options.length)]!;
      const length = Math.round((150 + rnd() * 2350) * 10) / 10;
      nodes.push(along(nodes.at(-1)!, h, length));
      headings.push(h);
      previous = h;
    }
    return { nodes, headings };
  }

  it('траса на 600 точок з діагоналями в усіх трьох площинах: за правилами, додається, швидко', () => {
    const { nodes, headings } = randomRoute(600, 7, HEADINGS);
    // У трасі справді є всі види: осьові й діагональні в кожній площині.
    const diagonal = headings.filter((h) => h.parts.length === 2);
    expect(diagonal.length).toBeGreaterThan(100);
    for (const plane of ['XY', 'XZ', 'YZ']) {
      expect(diagonal.some((h) => h.parts.map((p) => p.axis).join('') === plane), plane).toBe(true);
    }
    const started = performance.now();
    expect(isValidRoute(nodes)).toBe(true);
    const { route } = addRoute(emptyRouteSet(), nodes);
    const elapsed = performance.now() - started;
    expect(route.nodes).toEqual(nodes);
    expect(elapsed).toBeLessThan(200);
    // Кожен відрізок: зміщення по двох осях однакові ±0,1 мм, третя координата не змінюється.
    for (let i = 1; i < nodes.length; i++) {
      const d = offset(nodes[i - 1]!, nodes[i]!);
      const moved = AXES.filter((a) => Math.abs(d[KEY[a]]) > 0.1);
      expect(moved.length, `відрізок ${i}`).toBe(headings[i - 1]!.parts.length);
      if (moved.length === 2) expect(Math.abs(Math.abs(d[KEY[moved[0]!]]) - Math.abs(d[KEY[moved[1]!]]))).toBeLessThan(0.1);
    }
  });

  it('у довгій трасі зіпсований вузол (0,5 мм убік) робить її неправильною; відхилення 0,04 мм — у межах допуску', () => {
    const { nodes, headings } = randomRoute(520, 21, HEADINGS);
    const rnd = lcg(99);
    for (let trial = 0; trial < 60; trial++) {
      const i = 1 + Math.floor(rnd() * (nodes.length - 2));
      // Зсув по осі, якої немає в жодному із сусідніх відрізків чи є лише в одному, — завжди ламає 45° або вісь.
      const axis = AXES[Math.floor(rnd() * 3)]!;
      const bump = (delta: number) => nodes.map((n, k) => (k === i ? { ...n, [KEY[axis]]: n[KEY[axis]] + delta } : n));
      expect(isValidRoute(bump(0.04)), `вузол ${i}, ${axis} +0,04`).toBe(true);
      const before = headings[i - 1]!;
      const after = headings[i]!;
      // 0,5 мм ламає трасу, якщо хоч один із сусідніх відрізків не йде суто вздовж цієї осі.
      const pureAlong = (h: Heading) => h.parts.length === 1 && h.parts[0]!.axis === axis;
      if (!pureAlong(before) || !pureAlong(after)) expect(isValidRoute(bump(0.5)), `вузол ${i}, ${axis} +0,5`).toBe(false);
    }
  });

  it('траси, побудовані до етапу 4.1 (лише вздовж осей, повороти 90° і пряме продовження) — лишаються правильними', () => {
    const axial = HEADINGS.filter((h) => h.parts.length === 1);
    for (const seed of [1, 2, 3, 4, 5]) {
      const { nodes } = randomRoute(550, seed, axial);
      expect(isValidRoute(nodes), `seed ${seed}`).toBe(true);
      expect(() => addRoute(emptyRouteSet(), nodes)).not.toThrow();
    }
    // Допуск етапів 2–4: на відрізку «інші» координати змінюються не більше ніж на 0,1 мм
    // (рахується між сусідніми вузлами, а не від ідеальної сітки) — такі траси теж приймаються.
    const wobbly = [
      { x: 0, y: 1200, z: 0 },
      { x: 1000, y: 1200.08, z: -0.07 },
      { x: 1000.06, y: 1200, z: 2000 },
      { x: 999.97, y: 1700, z: 2000.09 },
      { x: 2500, y: 1700.05, z: 2000 },
      { x: 4000, y: 1700, z: 2000.04 },
    ];
    expect(isValidRoute(wobbly)).toBe(true);
    // Назад по тому самому відрізку — як і раніше, не можна.
    expect(isValidRoute([wobbly[0]!, { x: 1000, y: 1200, z: 0 }, { x: 400, y: 1200, z: 0 }])).toBe(false);
  });

  it('траса з діагоналями, побудована кроками в метрах (як у редакторі), після переведення в мм — за правилами', () => {
    // Початки далеко від нуля (скан може бути не біля початку координат): похибка округлення не псує 45°.
    const rnd = lcg(5);
    for (let trial = 0; trial < 40; trial++) {
      const anchor = { x: (rnd() - 0.5) * 200, y: (rnd() - 0.5) * 60, z: (rnd() - 0.5) * 200 };
      const nodes: P3[] = [anchor];
      let previous: Heading | null = null;
      for (let k = 0; k < 12; k++) {
        const options = HEADINGS.filter((h) => !previous || ruleAllows(previous, h));
        const h = options[Math.floor(rnd() * options.length)]!;
        const main = h.parts[0]!;
        const choice = h.parts[1] ?? null;
        let p = nodes.at(-1)!;
        const start = p;
        const steps = 20 + Math.floor(rnd() * 200);
        for (let s = 0; s < steps; s++) {
          p = stepAlongSegment(start, p, main.axis, main.sign * (0.0002 + rnd() * 0.008), previous ? headingUnit(previous.parts) : null, choice);
        }
        expect(canAppendNode(start, p, previous ? headingUnit(previous.parts) : null), `спроба ${trial}, відрізок ${k} (${h.name})`).toBe(true);
        nodes.push(p);
        previous = h;
      }
      expect(isValidRoute(nodes.map(toMm)), `спроба ${trial}`).toBe(true);
    }
  });
});
